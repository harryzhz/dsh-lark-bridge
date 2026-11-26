import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { expandWorkingDir, type LarkBotConfig } from '@dsh-lark/lark-core'
import type { LarkBridgeStore } from './store.js'
import type { LarkManagedSession } from './types.js'

type Workspace = Awaited<ReturnType<WorkspaceRegistry['create']>>

interface PendingAttachment {
  readonly workingDir: string
  readonly title: string
  readonly attempts: number
}

interface HeaderCwdLookup {
  readonly cwd?: string
  readonly missing: boolean
}

const MAX_PENDING_QUEUE = 256
const MAX_DEFERRED_WARNINGS = 5
const MAX_RETRY_ATTEMPTS = 5

/**
 * Keeps Lark-originated sessions inside their configured DSH sidebar workspace
 * and archives expired sessions through DSH's durable `workspaceRegistry`.
 *
 * Because `dsh-workspace` initializes asynchronously (scanning stored session
 * headers before Cordis marks `workspaceRegistry` active) and may be absent in
 * headless profiles, attachments/archives requested before readiness — or those
 * hitting transient failures — are queued and retried automatically on readiness
 * and periodic reconciliation sweeps.
 */
export class WorkspaceGrouping {
  private readonly pendingAttachments = new Map<string, PendingAttachment>()
  private readonly pendingArchives = new Map<string, number>()
  private activeRegistry?: WorkspaceRegistry
  private reconcileTail: Promise<void> = Promise.resolve()
  private deferredWarnCount = 0
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly store: LarkBridgeStore,
  ) {}

  install(): () => void {
    this.disposed = false
    let localDisposed = false
    const handle =
      typeof this.ctx.inject === 'function'
        ? this.ctx.inject(['workspaceRegistry' as never], (wsCtx) => {
            if (localDisposed || this.disposed) return
            const reg =
              ((wsCtx as Context).get?.('workspaceRegistry' as never) as
                | WorkspaceRegistry
                | undefined) ??
              (wsCtx as unknown as { workspaceRegistry?: WorkspaceRegistry }).workspaceRegistry
            if (reg) {
              this.activeRegistry = reg
            }
            if (typeof (wsCtx as Context).effect === 'function') {
              ;(wsCtx as Context).effect(() => () => {
                if (this.activeRegistry === reg) {
                  this.activeRegistry = undefined
                }
              })
            }
            void this.onRegistryReady().catch((err) => {
              this.warn('workspaceRegistry ready reconcile', err)
            })
          })
        : undefined

    return () => {
      localDisposed = true
      this.disposed = true
      this.activeRegistry = undefined
      const fiber = handle as { dispose?: () => void } | undefined
      fiber?.dispose?.()
    }
  }

  async attachSession(workingDir: string, title: string, sessionId: string): Promise<void> {
    const resolvedDir = expandWorkingDir(workingDir)
    if (!resolvedDir) return
    const registry = this.registry()
    if (!registry) {
      this.enqueuePendingAttachment(sessionId, resolvedDir, title, 0, true)
      return
    }
    const ok = await this.attachNow(registry, resolvedDir, title, sessionId)
    if (!ok) {
      this.enqueuePendingAttachment(sessionId, resolvedDir, title, 1, false)
    }
  }

  async archiveSession(sessionId: string): Promise<boolean> {
    const registry = this.registry()
    if (!registry) {
      this.enqueuePendingArchive(sessionId, 0, true)
      return false
    }
    const result = await this.archiveNow(registry, sessionId)
    if (result === 'failed') {
      this.enqueuePendingArchive(sessionId, 1, false)
      return false
    }
    return result === 'archived'
  }

  listArchivedSessionIds(): string[] {
    const registry = this.registry()
    return [...(registry?.archivedSessionIds ?? [])]
  }

  listWorkspaceSessionIds(): string[] {
    const registry = this.registry()
    if (!registry?.list) return []
    const archived = new Set<string>(registry.archivedSessionIds ?? [])
    const ids = new Set<string>()
    for (const ws of registry.list()) {
      for (const sid of ws.sessionIds ?? []) {
        if (!archived.has(sid)) ids.add(sid)
      }
    }
    return [...ids]
  }

  async syncBot(bot: LarkBotConfig): Promise<void> {
    await this.open(bot.defaultWorkingDir, this.store.resolveBotWorkspaceName(bot))
    for (const group of this.store.listGroups(bot.id)) {
      await this.open(
        group.workingDir.trim() || bot.defaultWorkingDir,
        this.store.resolveGroupWorkspaceName(bot, group),
      )
    }
  }

  async syncGroup(botId: string, chatId: string): Promise<void> {
    const bot = this.store.getBot(botId)
    const group = this.store.getGroup(botId, chatId)
    if (!bot || !group) return
    await this.open(
      group.workingDir.trim() || bot.defaultWorkingDir,
      this.store.resolveGroupWorkspaceName(bot, group),
    )
  }

  reconcileBindings(): Promise<void> {
    return this.enqueueReconcile(() => this.runReconcile())
  }

  private onRegistryReady(): Promise<void> {
    return this.enqueueReconcile(async () => {
      if (this.disposed || !this.registry()) return
      for (const bot of this.store.listBots?.() ?? []) {
        if (bot.enabled) {
          await this.syncBot(bot)
        }
      }
      await this.runReconcile()
    })
  }

  private enqueueReconcile(task: () => Promise<void>): Promise<void> {
    const next = this.reconcileTail.then(task, task)
    this.reconcileTail = next.then(
      () => {},
      () => {},
    )
    return next
  }

  private async runReconcile(): Promise<void> {
    if (this.disposed) return
    const registry = this.registry()
    if (!registry) return

    const { attachedIds, archivedIds } = this.snapshotMembership(registry)

    // 1. Flush attachments deferred before `workspaceRegistry` became ready or after transient errors.
    const deferredAttachments = [...this.pendingAttachments.entries()]
    this.pendingAttachments.clear()
    for (const [sessionId, entry] of deferredAttachments) {
      if (attachedIds.has(sessionId)) continue
      const ok = await this.attachNow(registry, entry.workingDir, entry.title, sessionId)
      if (ok) {
        attachedIds.add(sessionId)
      } else {
        const nextAttempts = entry.attempts + 1
        if (nextAttempts < MAX_RETRY_ATTEMPTS) {
          const header = nextAttempts >= 2 ? await this.readSessionHeaderCwd(sessionId) : undefined
          if (!header?.missing) {
            this.enqueuePendingAttachment(
              sessionId,
              entry.workingDir,
              entry.title,
              nextAttempts,
              false,
            )
          }
        }
      }
    }

    // 2. Reconcile active route bindings (skipping sessions already accounted in a workspace).
    const seenSessionIds = new Set<string>()
    for (const binding of this.store.listBindings()) {
      seenSessionIds.add(binding.sessionId)
      if (attachedIds.has(binding.sessionId)) continue
      const ok = await this.attachNow(
        registry,
        binding.workingDir,
        binding.workspaceName,
        binding.sessionId,
      )
      if (ok) {
        attachedIds.add(binding.sessionId)
      }
    }

    // 3. Repair unarchived managed sessions (reminders, ephemeral listeners, etc.)
    //    that have no `session_bindings` row and are absent from every workspace.
    const activeManaged = this.store.listActiveManagedSessions?.() ?? []
    for (const ms of activeManaged) {
      if (seenSessionIds.has(ms.sessionId)) continue
      if (attachedIds.has(ms.sessionId) || archivedIds.has(ms.sessionId)) continue
      const target = await this.resolveManagedSessionTarget(ms)
      if (!target) continue
      const ok = await this.attachNow(registry, target.workingDir, target.title, ms.sessionId)
      if (ok) {
        attachedIds.add(ms.sessionId)
        this.ctx.logger?.info?.(
          `[lark-bridge] reconciled ungrouped managed session ${ms.sessionId} (${ms.trigger ?? 'managed'}) -> "${target.title || target.workingDir}"`,
        )
      }
    }

    // 4. Flush archives deferred before `workspaceRegistry` became ready or after transient errors
    //    (after attaching so archived sessions preserve their workspace slot).
    const deferredArchives = [...this.pendingArchives.entries()]
    this.pendingArchives.clear()
    for (const [sessionId, attempts] of deferredArchives) {
      if (archivedIds.has(sessionId)) continue
      const result = await this.archiveNow(registry, sessionId)
      if (result === 'archived' || result === 'already_archived') {
        archivedIds.add(sessionId)
      } else if (attempts + 1 < MAX_RETRY_ATTEMPTS) {
        this.enqueuePendingArchive(sessionId, attempts + 1, false)
      }
    }
  }

  private snapshotMembership(registry: WorkspaceRegistry): {
    attachedIds: Set<string>
    archivedIds: Set<string>
  } {
    const attachedIds = new Set<string>()
    for (const ws of registry.list?.() ?? []) {
      for (const sid of ws.sessionIds ?? []) {
        attachedIds.add(sid)
      }
    }
    const archivedIds = new Set<string>(registry.archivedSessionIds ?? [])
    return { attachedIds, archivedIds }
  }

  private async resolveManagedSessionTarget(
    ms: LarkManagedSession,
  ): Promise<PendingAttachment | undefined> {
    const header = await this.readSessionHeaderCwd(ms.sessionId)
    if (header.missing) return undefined

    const bot = this.store.getBot?.(ms.botId)
    const isP2p = ms.chatId.startsWith('p2p:')
    const isGroupChat = Boolean(ms.chatId) && !isP2p && ms.chatId !== 'dream:internal'
    const group = isGroupChat ? this.store.getGroup?.(ms.botId, ms.chatId) : undefined
    const reminderId = ms.routeKey?.startsWith('reminder:')
      ? ms.routeKey.slice('reminder:'.length)
      : undefined
    const reminder = reminderId ? this.store.getReminder?.(reminderId) : undefined

    const defaultConfiguredRaw = group?.workingDir.trim() || bot?.defaultWorkingDir || ''
    const defaultConfiguredDir = defaultConfiguredRaw ? expandWorkingDir(defaultConfiguredRaw) : ''
    const reminderDir = reminder?.workingDir?.trim()
      ? expandWorkingDir(reminder.workingDir)
      : ''
    const headerDir = header.cwd ? expandWorkingDir(header.cwd) : ''
    const targetDir = headerDir || reminderDir || defaultConfiguredDir
    if (!targetDir) return undefined

    const matchesConfiguredWorkspace =
      Boolean(bot) && Boolean(defaultConfiguredDir) && targetDir === defaultConfiguredDir
    const title = matchesConfiguredWorkspace
      ? isGroupChat
        ? this.store.resolveGroupWorkspaceName(
            bot!,
            group,
            this.store.resolveChatName?.(bot!.id, ms.chatId),
          )
        : this.store.resolveBotWorkspaceName(bot!)
      : ''

    return { workingDir: targetDir, title, attempts: 0 }
  }

  private async readSessionHeaderCwd(sessionId: string): Promise<HeaderCwdLookup> {
    const branded = brandString<SessionId>(sessionId)
    const live = (
      this.ctx.sessions as unknown as { get?: (id: SessionId) => Session | undefined } | undefined
    )?.get?.(branded)
    if (live) {
      const cwd = (live as unknown as { header?: { cwd?: string } }).header?.cwd
      return { ...(cwd ? { cwd } : {}), missing: false }
    }

    const persistence = this.ctx.get('sessionPersistence' as never) as
      | SessionPersistence
      | undefined
    if (!persistence?.open) {
      return { missing: false }
    }
    try {
      const handle = await persistence.open(branded, 'read')
      try {
        const cwd = handle.header?.cwd
        return { ...(cwd ? { cwd } : {}), missing: false }
      } finally {
        await handle.close().catch(() => {})
      }
    } catch {
      return { missing: true }
    }
  }

  private async attachNow(
    registry: WorkspaceRegistry,
    workingDir: string,
    title: string,
    sessionId: string,
  ): Promise<boolean> {
    const ws = await this.open(workingDir, title, registry)
    if (!ws) return false
    try {
      await ws.attachSession(brandString<SessionId>(sessionId))
      this.pendingAttachments.delete(sessionId)
      return true
    } catch (err) {
      this.warn(`attachSession(${sessionId}) to "${title}"`, err)
      return false
    }
  }

  private async archiveNow(
    registry: WorkspaceRegistry,
    sessionId: string,
  ): Promise<'archived' | 'already_archived' | 'failed'> {
    const branded = brandString<SessionId>(sessionId)
    if (registry.archivedSessionIds?.includes(branded)) {
      this.pendingArchives.delete(sessionId)
      return 'already_archived'
    }
    try {
      await registry.archiveSession(branded, { stopActivity: true })
      this.pendingArchives.delete(sessionId)
      return 'archived'
    } catch (err) {
      this.warn(`archiveSession(${sessionId})`, err)
      return 'failed'
    }
  }

  private enqueuePendingAttachment(
    sessionId: string,
    workingDir: string,
    title: string,
    attempts: number,
    warnDeferred: boolean,
  ): void {
    if (!this.pendingAttachments.has(sessionId) && this.pendingAttachments.size >= MAX_PENDING_QUEUE) {
      const oldest = this.pendingAttachments.keys().next().value
      if (oldest !== undefined) this.pendingAttachments.delete(oldest)
    }
    this.pendingAttachments.set(sessionId, { workingDir, title, attempts })
    if (warnDeferred && this.deferredWarnCount < MAX_DEFERRED_WARNINGS) {
      this.deferredWarnCount += 1
      this.ctx.logger?.warn?.(
        `[lark-bridge] workspaceRegistry not ready; deferred attachSession(${sessionId}) to "${title || workingDir}"`,
      )
    }
  }

  private enqueuePendingArchive(sessionId: string, attempts: number, warnDeferred: boolean): void {
    if (!this.pendingArchives.has(sessionId) && this.pendingArchives.size >= MAX_PENDING_QUEUE) {
      const oldest = this.pendingArchives.keys().next().value
      if (oldest !== undefined) this.pendingArchives.delete(oldest)
    }
    this.pendingArchives.set(sessionId, attempts)
    if (warnDeferred && this.deferredWarnCount < MAX_DEFERRED_WARNINGS) {
      this.deferredWarnCount += 1
      this.ctx.logger?.warn?.(
        `[lark-bridge] workspaceRegistry not ready; deferred archiveSession(${sessionId})`,
      )
    }
  }

  private registry(): WorkspaceRegistry | undefined {
    return (
      this.activeRegistry ??
      (this.ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined)
    )
  }

  private async open(
    workingDir: string,
    title: string,
    explicitRegistry?: WorkspaceRegistry,
  ): Promise<Workspace | undefined> {
    const registry = explicitRegistry ?? this.registry()
    const resolvedDir = expandWorkingDir(workingDir)
    if (!registry || !resolvedDir) return undefined
    const desired = title.trim()
    try {
      const ws = await registry.create(resolvedDir, desired || undefined)
      if (desired && ws.title !== desired) {
        await ws.setTitle(desired)
      }
      return ws
    } catch (err) {
      this.warn(`workspace "${resolvedDir}"`, err)
      return undefined
    }
  }

  private warn(subject: string, err: unknown): void {
    this.ctx.logger?.warn?.(
      `[lark-bridge] ${subject} skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
