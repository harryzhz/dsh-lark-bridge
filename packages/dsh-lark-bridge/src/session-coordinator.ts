import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type SessionId } from '@deepseek-ai/dsh-session'
import {
  decideLarkRouting,
  expandWorkingDir,
  isNativeThreadRouteKey,
  type InboundLarkMessage,
  type LarkBotConfig,
} from '@dsh-lark/lark-core'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { LarkBridgeStore } from './store.js'
import { LARK_ORIGIN_RECORD_TYPE, type LarkSessionBinding } from './types.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

export type AgentDecision = Extract<ReturnType<typeof decideLarkRouting>, { action: 'agent' }>

export type SessionActorState = 'creating' | 'idle' | 'running' | 'closing' | 'archived'

export type CoalescedTurnSlot<T> =
  | { readonly role: 'aborted' }
  | { readonly role: 'follower' }
  | {
      readonly role: 'leader'
      readonly items: readonly T[]
      readonly release: () => void
      readonly finishBatch: () => void
    }

interface WaitingBatchEntry<T> {
  readonly item: T
  readonly itemSignal?: AbortSignal
  readonly isAborted: () => boolean
  removed?: boolean
}

interface WaitingBatch<T> {
  readonly entries: WaitingBatchEntry<T>[]
  readonly followerResolvers: Array<(outcome: 'follower' | 'aborted') => void>
  readonly abortController: AbortController
  readonly checkEmpty: () => void
}

export interface AcquiredAgent {
  readonly agent: Agent
  readonly sessionId: string
  readonly routeKey: string
  readonly isNew: boolean
  readonly disposeAfter: boolean
}

export function bindingHasNativeThread(
  binding: Pick<LarkSessionBinding, 'routeKey' | 'aliasRouteKeys'>,
): boolean {
  if (isNativeThreadRouteKey(binding.routeKey)) return true
  return (binding.aliasRouteKeys ?? []).some((alias) => isNativeThreadRouteKey(alias))
}

export interface SessionCoordinatorHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  readonly instrumentAgent: (agent: Agent) => void
  readonly disposeReminderHandle: (sessionId: string) => Promise<void>
}

/**
 * Per-session actor owning an explicit 5-state lifecycle (`creating -> idle -> running -> closing -> archived`)
 * and a serialized command mailbox. Enforces key invariants:
 * - No idle archiving while a turn is running or queued.
 * - No reuse of a dying handle once entering `closing` or `archived`.
 */
export class SessionActor {
  state: SessionActorState = 'creating'
  handle?: AgentHandle
  pendingCount = 0
  private mailbox: Promise<void> = Promise.resolve()
  private waitingBatch: WaitingBatch<unknown> | null = null

  constructor(readonly sessionId: string) {}

  get isBusy(): boolean {
    return this.state === 'creating' || this.state === 'running' || this.pendingCount > 0
  }

  get isTerminated(): boolean {
    return this.state === 'closing' || this.state === 'archived'
  }

  abortWaitingBatch(): void {
    const batch = this.waitingBatch
    this.waitingBatch = null
    if (!batch) return
    batch.abortController.abort()
    while (batch.followerResolvers.length > 0) {
      batch.followerResolvers.shift()?.('follower')
    }
  }

  /**
   * Acquires an exclusive execution slot with optional busy-queue coalescing:
   * - Idle session or `coalesce: false`: enters FIFO mailbox immediately with zero added delay.
   * - Busy session (`state === 'running'`) with `coalesce: true`: the first waiting caller creates
   *   a pending batch; subsequent callers arriving before that batch starts merge into it as
   *   followers and settle once the leader completes the combined turn.
   * - Optional `itemSignal` cancels only the individual queued item without dropping healthy peers
   *   in the same coalesced batch; once all entries in a waiting batch are aborted, the leader wakes
   *   and exits immediately.
   */
  async acquireCoalescedTurnSlot<T>(
    item: T,
    options: {
      readonly coalesce: boolean
      readonly signal: AbortSignal
      readonly itemSignal?: AbortSignal
      readonly isAborted: () => boolean
      readonly onLeaderRegistered?: () => void
    },
  ): Promise<
    | { readonly role: 'aborted'; readonly orphanedItems: readonly T[] }
    | { readonly role: 'follower' }
    | {
        readonly role: 'leader'
        readonly items: readonly T[]
        readonly abandonedItems?: readonly T[]
        readonly release: () => void
        readonly finishBatch: () => void
      }
  > {
    if (
      this.isTerminated ||
      options.signal.aborted ||
      options.itemSignal?.aborted ||
      options.isAborted()
    ) {
      return { role: 'aborted', orphanedItems: [item] }
    }

    if (options.coalesce && this.state === 'running' && this.waitingBatch) {
      const batch = this.waitingBatch as WaitingBatch<T>
      const entry: WaitingBatchEntry<T> = {
        item,
        ...(options.itemSignal ? { itemSignal: options.itemSignal } : {}),
        isAborted: options.isAborted,
      }
      batch.entries.push(entry)
      const outcome = await new Promise<'follower' | 'aborted'>((resolve) => {
        let settled = false
        const done = (result: 'follower' | 'aborted') => {
          if (settled) return
          settled = true
          options.signal.removeEventListener('abort', onGlobalAbort)
          options.itemSignal?.removeEventListener('abort', onItemAbort)
          resolve(result)
        }
        const onGlobalAbort = () => {
          entry.removed = true
          batch.checkEmpty()
          done('follower')
        }
        const onItemAbort = () => {
          entry.removed = true
          batch.checkEmpty()
          done('aborted')
        }
        if (options.itemSignal?.aborted || options.isAborted()) {
          onItemAbort()
          return
        }
        if (options.signal.aborted || this.isTerminated) {
          onGlobalAbort()
          return
        }
        options.signal.addEventListener('abort', onGlobalAbort, { once: true })
        options.itemSignal?.addEventListener('abort', onItemAbort, { once: true })
        batch.followerResolvers.push(done)
      })
      if (outcome === 'aborted') {
        return { role: 'aborted', orphanedItems: [item] }
      }
      return { role: 'follower' }
    }

    const leaderEntry: WaitingBatchEntry<T> = {
      item,
      ...(options.itemSignal ? { itemSignal: options.itemSignal } : {}),
      isAborted: options.isAborted,
    }
    const batchController = new AbortController()
    let ownedBatch: WaitingBatch<T> | undefined
    const isEntryAlive = (e: WaitingBatchEntry<T>) =>
      !e.removed && !e.itemSignal?.aborted && !e.isAborted()
    const checkBatchEmpty = () => {
      if (batchController.signal.aborted) return
      const entries = ownedBatch ? ownedBatch.entries : [leaderEntry]
      if (!entries.some(isEntryAlive)) {
        batchController.abort()
      }
    }

    if (options.coalesce && this.state === 'running') {
      ownedBatch = {
        entries: [leaderEntry],
        followerResolvers: [],
        abortController: batchController,
        checkEmpty: checkBatchEmpty,
      }
      this.waitingBatch = ownedBatch as WaitingBatch<unknown>
    }

    const onGlobalAbort = () => {
      if (!batchController.signal.aborted) batchController.abort()
    }
    const onLeaderItemAbort = () => {
      leaderEntry.removed = true
      checkBatchEmpty()
    }
    options.signal.addEventListener('abort', onGlobalAbort, { once: true })
    options.itemSignal?.addEventListener('abort', onLeaderItemAbort, { once: true })
    if (options.signal.aborted) onGlobalAbort()
    if (options.itemSignal?.aborted) onLeaderItemAbort()

    options.onLeaderRegistered?.()

    let release: (() => void) | undefined
    try {
      release = await this.acquireTurnSlot(
        batchController.signal,
        () =>
          options.signal.aborted ||
          this.isTerminated ||
          !(ownedBatch ? ownedBatch.entries : [leaderEntry]).some(isEntryAlive),
      )
    } finally {
      options.signal.removeEventListener('abort', onGlobalAbort)
      options.itemSignal?.removeEventListener('abort', onLeaderItemAbort)
    }

    if (ownedBatch && this.waitingBatch === (ownedBatch as WaitingBatch<unknown>)) {
      this.waitingBatch = null
    }

    const finishBatch = () => {
      if (!ownedBatch) return
      while (ownedBatch.followerResolvers.length > 0) {
        ownedBatch.followerResolvers.shift()?.('follower')
      }
    }

    const allEntries = ownedBatch ? ownedBatch.entries : [leaderEntry]
    const survivingItems: T[] = []
    const abandonedItems: T[] = []
    for (const entry of allEntries) {
      if (isEntryAlive(entry)) {
        survivingItems.push(entry.item)
      } else {
        abandonedItems.push(entry.item)
      }
    }

    if (!release || survivingItems.length === 0) {
      release?.()
      finishBatch()
      return {
        role: 'aborted',
        orphanedItems: allEntries.map((e) => e.item),
      }
    }

    return {
      role: 'leader',
      items: survivingItems,
      ...(abandonedItems.length > 0 ? { abandonedItems } : {}),
      release,
      finishBatch,
    }
  }

  /**
   * Acquires exclusive execution slot in FIFO order on this session's mailbox,
   * honoring abort signals while queued.
   */
  async acquireTurnSlot(
    signal: AbortSignal,
    isAborted: () => boolean,
  ): Promise<(() => void) | undefined> {
    if (this.isTerminated || signal.aborted || isAborted()) return undefined
    const prev = this.mailbox
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(() => next)
    this.mailbox = tail

    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted || isAborted() || this.isTerminated) {
        resolve('aborted')
        return
      }
      onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
    })

    const outcome = await Promise.race([prev.then(() => 'ready' as const), aborted])
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }

    let released = false
    const releaseOnce = () => {
      if (released) return
      released = true
      if (this.state === 'running' && this.pendingCount <= 1) {
        this.state = 'idle'
      }
      release()
    }

    if (outcome === 'aborted' || signal.aborted || isAborted() || this.isTerminated) {
      releaseOnce()
      return undefined
    }
    this.state = 'running'
    return releaseOnce
  }

  enqueueLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mailbox.catch(() => {}).then(fn)
    this.mailbox = run.then(
      () => {},
      () => {},
    )
    return run
  }
}

export class SessionCoordinator {
  private readonly actors = new Map<string, SessionActor>()
  private readonly pendingAcquires = new Map<string, Promise<AcquiredAgent>>()
  /** Live in-flight (queued + active) turn counts per sessionId. */
  readonly inFlightTurns = new Map<string, number>()

  constructor(private readonly host: SessionCoordinatorHost) {}

  getActor(sessionId: string): SessionActor | undefined {
    return this.actors.get(sessionId)
  }

  getActorState(sessionId: string): SessionActorState | undefined {
    return this.actors.get(sessionId)?.state
  }

  getRuntimeConcurrencyStats(): { readonly activeActors: number; readonly queuedTurns: number } {
    let activeActors = 0
    let queuedTurns = 0
    for (const actor of this.actors.values()) {
      if (actor.isBusy) activeActors += 1
      if (actor.pendingCount > 1) queuedTurns += actor.pendingCount - 1
    }
    return { activeActors, queuedTurns }
  }

  markTurnRegistered(sessionId: string): void {
    const actor = this.ensureActor(sessionId, 'idle')
    actor.pendingCount += 1
    this.inFlightTurns.set(sessionId, actor.pendingCount)
  }

  markTurnFinished(sessionId: string): boolean {
    const actor = this.actors.get(sessionId)
    if (!actor) {
      const next = (this.inFlightTurns.get(sessionId) ?? 1) - 1
      if (next <= 0) {
        this.inFlightTurns.delete(sessionId)
        return false
      }
      this.inFlightTurns.set(sessionId, next)
      return true
    }
    actor.pendingCount = Math.max(0, actor.pendingCount - 1)
    if (actor.pendingCount === 0) {
      this.inFlightTurns.delete(sessionId)
      if (actor.state === 'running') {
        actor.state = 'idle'
      }
      return false
    }
    this.inFlightTurns.set(sessionId, actor.pendingCount)
    return true
  }

  async acquireTurnSlot(
    sessionId: string,
    signal: AbortSignal,
    isAborted: () => boolean,
  ): Promise<(() => void) | undefined> {
    const actor = this.ensureActor(sessionId, 'idle')
    return actor.acquireTurnSlot(signal, isAborted)
  }

  async acquireCoalescedTurnSlot<T>(
    sessionId: string,
    item: T,
    options: {
      readonly coalesce: boolean
      readonly signal: AbortSignal
      readonly itemSignal?: AbortSignal
      readonly isAborted: () => boolean
      readonly onLeaderRegistered?: () => void
    },
  ): Promise<
    | { readonly role: 'aborted'; readonly orphanedItems: readonly T[] }
    | { readonly role: 'follower' }
    | {
        readonly role: 'leader'
        readonly items: readonly T[]
        readonly abandonedItems?: readonly T[]
        readonly release: () => void
        readonly finishBatch: () => void
      }
  > {
    const actor = this.ensureActor(sessionId, 'idle')
    return actor.acquireCoalescedTurnSlot(item, options)
  }

  async acquireAgent(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
  ): Promise<AcquiredAgent> {
    const reuseSession = decision.sessionMode !== 'per_message'
    if (!reuseSession) {
      return this.acquireAgentUnlocked(bot, msg, decision, false)
    }

    while (true) {
      const lockKey = this.host.store.getBinding(decision.routeKey)?.routeKey ?? decision.routeKey
      const inflight = this.pendingAcquires.get(lockKey)
      if (inflight) {
        await inflight.catch(() => undefined)
        continue
      }
      const task = this.acquireAgentUnlocked(bot, msg, decision, true)
      this.pendingAcquires.set(lockKey, task)
      try {
        return await task
      } finally {
        if (this.pendingAcquires.get(lockKey) === task) {
          this.pendingAcquires.delete(lockKey)
        }
      }
    }
  }

  async unbindRoute(routeKey: string, options: { archive?: boolean } = {}): Promise<boolean> {
    const removed = this.host.store.deleteBinding(routeKey)
    if (!removed) return false
    await this.closeSessionActor(removed.sessionId, Boolean(options.archive))
    return true
  }

  async replaceRouteBinding(next: LarkSessionBinding): Promise<void> {
    const prev = this.host.store.getBinding(next.routeKey)
    this.host.store.upsertBinding(next)
    if (
      prev &&
      prev.routeKey === next.routeKey &&
      prev.sessionId !== next.sessionId &&
      (this.inFlightTurns.get(prev.sessionId) ?? 0) === 0
    ) {
      await this.closeSessionActor(prev.sessionId, false)
    }
  }

  async disposeEphemeral(
    sessionId: string,
    routeKey: string,
    options: { readonly archive: boolean },
  ): Promise<void> {
    if ((this.inFlightTurns.get(sessionId) ?? 0) > 0) return
    if (this.host.store.getBinding(routeKey)?.sessionId === sessionId) {
      this.host.store.deleteBinding(routeKey)
    }
    await this.closeSessionActor(sessionId, options.archive)
  }

  async archiveManagedSession(sessionId: string): Promise<boolean> {
    await this.host.disposeReminderHandle(sessionId).catch(() => {})
    const archived = await this.host.workspaces.archiveSession(sessionId)
    this.host.store.markSessionArchived(sessionId)
    const actor = this.actors.get(sessionId)
    if (actor) {
      actor.state = 'archived'
      this.actors.delete(sessionId)
    }
    return archived
  }

  async sweepIdleBindings(now = Date.now()): Promise<number> {
    let archivedCount = 0

    for (const binding of this.host.store.listBindings()) {
      if (!binding.idleCloseMs || now - binding.lastActivityMs < binding.idleCloseMs) continue
      const actor = this.actors.get(binding.sessionId)
      // Actor invariant: never idle-archive a creating/running/queued session.
      if (actor?.isBusy || (this.inFlightTurns.get(binding.sessionId) ?? 0) > 0) continue

      const unbound = await this.unbindRoute(binding.routeKey, { archive: true })
      if (!unbound) continue
      archivedCount += 1
      this.host.store.recordEvent({
        botId: binding.botId,
        chatId: binding.chatId,
        routeKey: binding.routeKey,
        sessionId: binding.sessionId,
        kind: 'lifecycle',
        summary: '会话空闲超时，已自动归档',
      })
    }

    const activeBoundSessionIds = new Set(this.host.store.listBindings().map((b) => b.sessionId))
    for (const ms of this.host.store.listExpiredManagedSessions(now)) {
      if (activeBoundSessionIds.has(ms.sessionId)) continue
      const actor = this.actors.get(ms.sessionId)
      if (actor?.isBusy || (this.inFlightTurns.get(ms.sessionId) ?? 0) > 0) continue

      const didArchive = await this.archiveManagedSession(ms.sessionId)
      if (didArchive) {
        archivedCount += 1
        this.host.store.recordEvent({
          botId: ms.botId,
          chatId: ms.chatId,
          ...(ms.routeKey ? { routeKey: ms.routeKey } : {}),
          sessionId: ms.sessionId,
          kind: 'lifecycle',
          summary: '过期会话已自动归档',
        })
      }
    }

    return archivedCount
  }

  async disposeAll(): Promise<void> {
    const actors = [...this.actors.values()]
    this.actors.clear()
    this.inFlightTurns.clear()
    await Promise.all(
      actors.map(async (actor) => {
        actor.state = 'closing'
        actor.abortWaitingBatch()
        const handle = actor.handle
        actor.handle = undefined
        if (handle) {
          await handle.dispose().catch(() => {})
        }
        actor.state = 'archived'
      }),
    )
  }

  private ensureActor(sessionId: string, initialState: SessionActorState): SessionActor {
    let actor = this.actors.get(sessionId)
    if (!actor || actor.isTerminated) {
      actor = new SessionActor(sessionId)
      actor.state = initialState
      this.actors.set(sessionId, actor)
    }
    return actor
  }

  private async closeSessionActor(sessionId: string, archive: boolean): Promise<void> {
    const actor = this.actors.get(sessionId)
    if (!actor) {
      if (archive) await this.archiveManagedSession(sessionId)
      return
    }
    if (actor.state === 'archived') return
    actor.state = 'closing'
    actor.abortWaitingBatch()
    const handle = actor.handle
    actor.handle = undefined
    if (handle) {
      await handle.dispose().catch(() => {})
    }
    if (archive) {
      await this.archiveManagedSession(sessionId)
    } else {
      actor.state = 'archived'
      this.actors.delete(sessionId)
    }
  }

  private async acquireAgentUnlocked(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    reuseSession: boolean,
  ): Promise<AcquiredAgent> {
    const existing = reuseSession ? this.host.store.getBinding(decision.routeKey) : undefined
    if (existing) {
      const existingActor = this.actors.get(existing.sessionId)
      const targetCwd = expandWorkingDir(decision.workingDir) || decision.workingDir
      const existingCwd = expandWorkingDir(existing.workingDir) || existing.workingDir
      const profileChanged = (existing.runtimeProfileId ?? '') !== (decision.runtimeProfileId ?? '')
      if (
        existingActor?.isTerminated ||
        existing.agentPreset !== decision.agentPreset ||
        profileChanged ||
        existingCwd !== targetCwd
      ) {
        await this.unbindRoute(existing.routeKey, { archive: false })
      } else {
        const resumed = await this.resumeAgent(bot, existing, decision)
        if (resumed) return resumed
      }
    }

    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const actor = new SessionActor(sessionId)
    actor.state = 'creating'
    this.actors.set(sessionId, actor)

    try {
      const launch = await this.host.runtimes.resolveAgentLaunch({
        agentPreset: decision.agentPreset,
        ...(decision.runtimeProfileId ? { runtimeProfileId: decision.runtimeProfileId } : {}),
        ...(bot.provider ? { explicitProvider: bot.provider } : {}),
        ...(decision.model ? { explicitModel: decision.model } : {}),
        ...(decision.reasoningEffort ? { explicitReasoningEffort: decision.reasoningEffort } : {}),
        requireNativeModel: true,
      })
      const resolvedCwd = expandWorkingDir(decision.workingDir) || decision.workingDir
      const handle = await this.host.ctx.agents.create({
        sessionId,
        meta: { cwd: resolvedCwd, agentPreset: decision.agentPreset },
        agentOptions: {
          ...(launch.provider ? { provider: launch.provider } : {}),
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
        },
        setup: async (agentCtx, agent) => {
          await launch.mountPreset(agentCtx, agent)
          const isP2p = msg.chatType === 'p2p'
          const replyAnchor = msg.threadId
            ? (msg.rootId ?? (msg.threadId.startsWith('om_') ? msg.threadId : undefined) ?? msg.messageId)
            : decision.replyMode === 'new-topic'
              ? msg.messageId
              : (msg.rootId ?? msg.messageId)
          appendPluginRecord(agent.session, LARK_ORIGIN_RECORD_TYPE, {
            botId: bot.id,
            botName: bot.name,
            larkAppId: bot.larkAppId,
            chatType: isP2p ? 'p2p' : 'group',
            chatId: msg.chatId,
            ...(decision.chatName ? { chatName: decision.chatName } : {}),
            ...(!isP2p && decision.replyMode !== 'chat' ? { replyToMessageId: replyAnchor } : {}),
            ...(isP2p && msg.senderOpenId ? { userOpenId: msg.senderOpenId } : {}),
            workspaceName: decision.workspaceName,
            routeKey: decision.routeKey,
            trigger: decision.trigger,
            ...(decision.listenerName ? { listenerName: decision.listenerName } : {}),
          })
        },
      })
      this.host.instrumentAgent(handle.agent)
      await this.host.workspaces.attachSession(resolvedCwd, decision.workspaceName, sessionId)
      actor.handle = handle
      actor.state = 'idle'

      const now = Date.now()
      const idleCloseMs = decision.idleCloseMs
      this.host.store.upsertManagedSession({
        sessionId,
        botId: bot.id,
        chatId: msg.chatId,
        routeKey: decision.routeKey,
        trigger: decision.trigger,
        createdAtMs: now,
        lastActivityMs: now,
        ...(idleCloseMs ? { idleCloseMs } : {}),
      })
      if (reuseSession) {
        this.host.store.upsertBinding(this.createBinding(bot, msg, decision, sessionId, resolvedCwd))
      }
      return {
        agent: handle.agent,
        sessionId,
        routeKey: decision.routeKey,
        isNew: true,
        disposeAfter: !reuseSession,
      }
    } catch (err) {
      actor.state = 'archived'
      this.actors.delete(sessionId)
      throw err
    }
  }

  private async resumeAgent(
    bot: LarkBotConfig,
    binding: LarkSessionBinding,
    decision: AgentDecision,
  ): Promise<AcquiredAgent | undefined> {
    const sessionId = brandString<SessionId>(binding.sessionId)
    const launch = await this.host.runtimes.resolveAgentLaunch({
      agentPreset: decision.agentPreset,
      ...(decision.runtimeProfileId ? { runtimeProfileId: decision.runtimeProfileId } : {}),
      ...(bot.provider ? { explicitProvider: bot.provider } : {}),
      ...(decision.model ? { explicitModel: decision.model } : {}),
      ...(decision.reasoningEffort ? { explicitReasoningEffort: decision.reasoningEffort } : {}),
      requireNativeModel: true,
    })

    const actor = this.ensureActor(binding.sessionId, 'idle')
    let agent = this.host.ctx.agents.get(sessionId)
    if (!agent) {
      actor.state = 'creating'
      try {
        const agentOptions = {
          ...(launch.provider ? { provider: launch.provider } : {}),
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
        }
        const handle = await this.host.ctx.agents.resume(
          launch.isExternal
            ? {
                resumeSessionId: sessionId,
                ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
              }
            : {
                resumeSessionId: sessionId,
                agentOptions,
                setup: async (agentCtx) => {
                  await launch.mountPreset(agentCtx)
                },
              },
        )
        actor.handle = handle
        actor.state = 'idle'
        agent = handle.agent
      } catch {
        actor.state = 'archived'
        this.actors.delete(binding.sessionId)
        this.host.store.deleteBinding(binding.routeKey)
        return undefined
      }
    }

    const modelChanged = (binding.model ?? '') !== (decision.model ?? '')
    const effortChanged = (binding.reasoningEffort ?? '') !== (decision.reasoningEffort ?? '')
    const currentSel = agent.model?.current?.()
    const expectedProvider =
      launch.provider ??
      this.host.runtimes.providerFor(decision.agentPreset) ??
      bot.provider
    const selectionMissingOrMismatched =
      !currentSel || Boolean(expectedProvider && currentSel.provider !== expectedProvider)

    if ((modelChanged || effortChanged || selectionMissingOrMismatched) && agent.model?.select) {
      const provider =
        (selectionMissingOrMismatched ? expectedProvider : currentSel?.provider) ??
        expectedProvider
      const targetModel = decision.model ?? launch.model ?? currentSel?.model
      const targetEffort = decision.reasoningEffort ?? launch.reasoningEffort
      if (provider && targetModel) {
        try {
          agent.model.select({
            provider,
            model: targetModel,
            ...(targetEffort
              ? { reasoningEffort: brandString<ReasoningEffortId>(targetEffort) }
              : {}),
          })
        } catch {
          // Ignore if native adapter does not support runtime hot-select.
        }
      }
      if (modelChanged || effortChanged) {
        this.host.store.upsertBinding({
          ...binding,
          ...(decision.model ? { model: decision.model } : { model: undefined }),
          ...(decision.reasoningEffort
            ? { reasoningEffort: decision.reasoningEffort }
            : { reasoningEffort: undefined }),
        })
      }
    }

    this.host.instrumentAgent(agent)
    await this.host.workspaces.attachSession(
      decision.workingDir,
      decision.workspaceName,
      binding.sessionId,
    )
    return {
      agent,
      sessionId: binding.sessionId,
      routeKey: decision.routeKey,
      isNew: false,
      disposeAfter: false,
    }
  }

  private createBinding(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sessionId: string,
    workingDir: string,
  ): LarkSessionBinding {
    const now = Date.now()
    const isP2p = msg.chatType === 'p2p'
    return {
      routeKey: decision.routeKey,
      botId: bot.id,
      botName: bot.name,
      larkAppId: bot.larkAppId,
      chatType: isP2p ? 'p2p' : 'group',
      chatId: msg.chatId,
      ...(decision.chatName ? { chatName: decision.chatName } : {}),
      ...(isP2p && msg.senderOpenId ? { userOpenId: msg.senderOpenId } : {}),
      workspaceName: decision.workspaceName,
      sessionId,
      agentPreset: decision.agentPreset,
      ...(decision.runtimeProfileId ? { runtimeProfileId: decision.runtimeProfileId } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      ...(decision.reasoningEffort ? { reasoningEffort: decision.reasoningEffort } : {}),
      workingDir,
      trigger: decision.trigger,
      ...(decision.listenerName ? { listenerName: decision.listenerName } : {}),
      hasReplied: decision.trigger !== 'listener',
      createdAtMs: now,
      lastActivityMs: now,
      ...(decision.idleCloseMs ? { idleCloseMs: decision.idleCloseMs } : {}),
    }
  }
}
