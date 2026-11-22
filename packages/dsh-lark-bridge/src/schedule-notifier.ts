import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  composeScheduleContextReminder,
  composeSystemReminder,
  expandWorkingDir,
  resolveEffectiveAgentRuntime,
  resolveEffectiveWorkingDir,
  type ScheduleTargetContextItem,
} from '@dsh-lark/lark-core'
import { assertExistingWorkingDirectory } from './fs-browser.js'
import type { LarkBridgeStore } from './store.js'
import { TurnFinalReplyTracker } from './turn-runner.js'
import {
  LARK_ORIGIN_RECORD_TYPE,
  type LarkOriginRecord,
  type LarkScheduleBinding,
  type LarkScheduleDeliveryMode,
  type LarkScheduleNotifyOn,
  type LarkScheduleOriginHint,
  type LarkScheduleTarget,
  type LarkScheduleView,
} from './types.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

/** Minimal structural contract of `@deepseek-ai/dsh-schedule`'s `ctx.schedule`. */
export interface ScheduleEntryLike {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
  readonly status: 'active' | 'paused' | 'ended'
  readonly scheduledAt: string
  readonly afterSeconds?: number
  readonly everySeconds?: number
  readonly time?: string
  readonly weekdays?: readonly number[]
  readonly expression?: string
  readonly rrule?: string
  readonly executionActive?: boolean
  readonly target:
    | { readonly kind: 'session'; readonly sessionId: string }
    | { readonly kind: 'new_once'; readonly sessionId: string; readonly create?: { readonly cwd?: string; readonly agentPreset?: string } }
    | { readonly kind: 'new'; readonly create?: { readonly cwd?: string; readonly agentPreset?: string } }
  readonly involvedSessionIds: readonly string[]
  readonly lastDelivery?: {
    readonly scheduledAt: string
    readonly deliveredAt: string
    readonly messageId: string
    readonly targetSessionId: string
  }
}

export interface ScheduleCreateInputLike {
  readonly title: string
  readonly prompt: string
  readonly timing:
    | { readonly kind: 'cron'; readonly cron: { readonly expression: string; readonly time_zone: string } }
    | { readonly kind: 'weekly'; readonly weekly: { readonly time: string; readonly time_zone: string; readonly weekdays: readonly number[] } }
    | { readonly kind: 'daily'; readonly daily: { readonly time: string; readonly time_zone: string } }
    | { readonly kind: 'every'; readonly every_seconds: number }
    | { readonly kind: 'after'; readonly after_seconds: number }
  readonly target?: {
    readonly kind: 'new'
    readonly create?: { readonly cwd?: string; readonly agentPreset?: string }
  }
}

export interface HostScheduleService {
  catalog(): Promise<readonly ScheduleEntryLike[]>
  create?(request: ScheduleCreateInputLike): Promise<ScheduleEntryLike>
  edit?(request: { readonly id: string; readonly action: 'update'; readonly patch: { readonly active?: boolean } }): Promise<unknown>
  view(request: { readonly id: string }): Promise<ScheduleEntryLike | { readonly code: string }>
  history?(request: { readonly id: string; readonly limit: number }): Promise<
    | { readonly records: readonly { readonly messageId: string; readonly targetSessionId: string }[] }
    | { readonly code: string }
  >
  run(request: { readonly id: string }): Promise<ScheduleEntryLike | { readonly code: string }>
}

export interface ScheduleDeliveryHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly workspaces: WorkspaceGrouping
  getBotOpenId?(botId: string): string | undefined
  sendScheduleMessage(input: {
    readonly botId: string
    readonly chatId: string
    readonly deliveryMode: LarkScheduleDeliveryMode
    readonly replyToMessageId?: string
    readonly scheduleTitle: string
    readonly markdown: string
    readonly isError: boolean
    readonly isIntermediate?: boolean
    readonly sessionId: string
  }): Promise<void>
}

export interface ActiveScheduleSessionContext {
  readonly scheduleId: string
  readonly title: string
  readonly deliveryMode: LarkScheduleDeliveryMode
  readonly notifyOn: LarkScheduleNotifyOn
  readonly sendIntermediateMessages?: boolean
  readonly targets: readonly LarkScheduleTarget[]
}

interface ActiveScheduleTurn {
  readonly sessionId: string
  readonly turn: number
  readonly messageId: string
  readonly replyTracker: TurnFinalReplyTracker
  readonly startedMs: number
}

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function formatClockShort(hhmmss?: string): string {
  return hhmmss ? hhmmss.slice(0, 5) : ''
}

export function formatScheduleRuleSummary(entry: ScheduleEntryLike): string {
  switch (entry.kind) {
    case 'daily':
      return `每天 ${formatClockShort(entry.time)}`
    case 'weekly': {
      const wd = entry.weekdays ?? []
      if (wd.length === 5 && wd[0] === 1 && wd[4] === 5) {
        return `每周一至周五 ${formatClockShort(entry.time)}`
      }
      const days = wd.map((d) => WEEKDAY_NAMES[d] ?? String(d)).join('、')
      return `每${days} ${formatClockShort(entry.time)}`
    }
    case 'every': {
      const sec = entry.everySeconds ?? 0
      if (sec % 3600 === 0 && sec >= 3600) return `每 ${sec / 3600} 小时`
      if (sec % 60 === 0 && sec >= 60) return `每 ${sec / 60} 分钟`
      return `每 ${sec} 秒`
    }
    case 'cron':
      return `Cron ${entry.expression ?? ''}`.trim()
    case 'rrule':
      return '自定义日历规则'
    case 'after':
    case 'at':
      return '单次定时'
    default:
      return entry.kind
  }
}

function extractReplyToMessageId(routeKey: string): string | undefined {
  const idx = routeKey.indexOf(':')
  if (idx < 0) return undefined
  const secondIdx = routeKey.indexOf(':', idx + 1)
  if (secondIdx < 0) return undefined
  const scope = routeKey.slice(secondIdx + 1)
  return scope.startsWith('om_') ? scope : undefined
}

function extractScheduleIdsFromFraming(text: string): string[] {
  if (!text || text.startsWith('[SCHEDULE CHANGE]')) return []
  const ids: string[] = []
  const singleMatch = /schedule_id_json:\s*("(?:\\.|[^"\\])*")/.exec(text)
  if (singleMatch?.[1]) {
    try {
      const parsed = JSON.parse(singleMatch[1])
      if (typeof parsed === 'string' && parsed) ids.push(parsed)
    } catch {
      // Ignore malformed id.
    }
  }
  const batchMatch = /reminders_json:\s*(\[[\s\S]*\])\s*$/.exec(text)
  if (batchMatch?.[1]) {
    try {
      const arr = JSON.parse(batchMatch[1]) as Array<{ schedule_id?: unknown }>
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item?.schedule_id === 'string' && item.schedule_id && !ids.includes(item.schedule_id)) {
            ids.push(item.schedule_id)
          }
        }
      }
    } catch {
      // Ignore malformed batch payload.
    }
  }
  return ids
}

/**
 * Bridges DSH's `schedule` service to Lark notification groups:
 * 1. Injects two-level `<system_reminder><schedule ...>...</schedule></system_reminder>`
 *    (target bot, chat, and delivery rules) into every scheduled turn.
 * 2. Automatically pushes scheduled turn output as a Lark card to bound groups.
 */
export class ScheduleNotifier {
  private readonly activeTurns = new Map<string, ActiveScheduleTurn>()
  private readonly currentTurnBySession = new Map<string, number>()
  private readonly activeSessionContexts = new Map<string, ActiveScheduleSessionContext>()
  private readonly catalogById = new Map<string, ScheduleEntryLike>()
  private readonly inferredOriginById = new Map<string, LarkScheduleOriginHint>()
  private readonly originCache = new Map<string, LarkOriginRecord | null>()
  private readonly instrumentedAgents = new WeakSet<object>()
  private readonly disposers: Array<() => void> = []

  constructor(private readonly host: ScheduleDeliveryHost) {}

  start(): void {
    const offEvent = this.host.ctx.on(
      'session/event',
      (session: Session, event: SessionEvent) => {
        this.onSessionEvent(session, event)
      },
      { global: true },
    )
    const offChanged = this.host.ctx.on(
      'schedule/changed' as never,
      (() => {
        void this.refreshScheduleContextCache()
        void this.pruneDeletedBindings()
      }) as never,
      { global: true },
    )
    const offResolve = this.host.ctx.on(
      'schedule/resolve-agent' as never,
      (async (sessionId: string, next: () => Promise<Agent>) => {
        const agent = await next()
        if (agent) {
          await this.prepareAgentForScheduleDelivery(sessionId, agent)
        }
        return agent
      }) as never,
      { global: true },
    )
    this.disposers.push(offEvent, offChanged, offResolve)

    void this.refreshScheduleContextCache()
  }

  stop(): void {
    while (this.disposers.length > 0) {
      this.disposers.pop()?.()
    }
    this.activeTurns.clear()
    this.currentTurnBySession.clear()
    this.activeSessionContexts.clear()
  }

  service(): HostScheduleService | undefined {
    return this.host.ctx.get('schedule' as never) as HostScheduleService | undefined
  }

  getActiveSessionContext(sessionId: string): ActiveScheduleSessionContext | undefined {
    return this.activeSessionContexts.get(sessionId)
  }

  async prepareAgentForScheduleDelivery(_sessionId: string, agent: Agent): Promise<void> {
    await this.refreshScheduleContextCache()
    this.instrumentAgent(agent)
  }

  instrumentAgent(agent: Pick<Agent, 'session' | 'followup'> & Partial<Pick<Agent, 'send'>>): void {
    const ref = agent as unknown as object
    if (this.instrumentedAgents.has(ref)) return
    this.instrumentedAgents.add(ref)

    const origFollowup = agent.followup.bind(agent)
    agent.followup = ((message: UserMessage) => {
      const enriched = this.enrichScheduleUserMessage(agent.session.id, message)
      return origFollowup(enriched)
    }) as Agent['followup']
  }

  enrichScheduleUserMessage(sessionId: string, message: UserMessage): UserMessage {
    const sourceKind = (message as { source?: { kind?: string } }).source?.kind
    if (sourceKind !== 'schedule') return message

    const rawText = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (
      !rawText ||
      rawText.startsWith('[SCHEDULE CHANGE]') ||
      rawText.includes('<schedule ') ||
      rawText.includes('source="lark_schedule"')
    ) {
      return message
    }

    const scheduleIds = extractScheduleIdsFromFraming(rawText)
    const reminderBlocks: string[] = []
    for (const scheduleId of scheduleIds) {
      const built = this.buildScheduleReminderSync(sessionId, scheduleId)
      if (built) reminderBlocks.push(built)
    }

    const systemBlock = composeSystemReminder(reminderBlocks)
    if (!systemBlock) return message
    const prefix = `${systemBlock}\n\n`
    let injected = false
    const nextContent = message.content.map((block) => {
      if (!injected && block.type === 'text') {
        injected = true
        return { ...block, text: `${prefix}${block.text}` }
      }
      return block
    })
    return { ...message, content: nextContent }
  }

  async refreshScheduleContextCache(): Promise<void> {
    const service = this.service()
    if (!service) return
    let entries: readonly ScheduleEntryLike[] = []
    try {
      entries = await service.catalog()
    } catch {
      return
    }

    this.catalogById.clear()
    for (const entry of entries) {
      this.catalogById.set(entry.id, entry)
      const inferred = await this.resolveInferredOrigin(entry)
      if (inferred) this.inferredOriginById.set(entry.id, inferred)
    }
  }

  private buildScheduleReminderSync(sessionId: string, scheduleId: string): string | undefined {
    const entry = this.catalogById.get(scheduleId)
    const explicit = this.host.store.getScheduleBinding(scheduleId)
    const inferred = this.inferredOriginById.get(scheduleId)
    const title = entry?.title ?? scheduleId
    const deliveryMode: LarkScheduleDeliveryMode =
      explicit?.deliveryMode ??
      (entry?.kind === 'after' || entry?.kind === 'at' ? 'thread' : 'chat')
    const notifyOn: LarkScheduleNotifyOn = explicit?.notifyOn ?? 'non_empty'
    const enabled = explicit ? explicit.enabled : Boolean(inferred)

    const rawTargets: readonly LarkScheduleTarget[] =
      explicit && explicit.targets.length > 0
        ? explicit.targets
        : inferred
          ? [{ botId: inferred.botId, chatId: inferred.chatId }]
          : []

    if (enabled && rawTargets.length > 0) {
      this.activeSessionContexts.set(sessionId, {
        scheduleId,
        title,
        deliveryMode,
        notifyOn,
        sendIntermediateMessages: Boolean(explicit?.sendIntermediateMessages),
        targets: rawTargets,
      })
    }

    const richTargets: ScheduleTargetContextItem[] = []
    for (const t of rawTargets) {
      const bot = this.host.store.getBot(t.botId)
      if (!bot) continue
      const chatName =
        this.host.store.resolveChatName(t.botId, t.chatId) ||
        (inferred?.chatId === t.chatId ? inferred.chatName : undefined) ||
        t.chatId
      const botOpenId = this.host.getBotOpenId?.(t.botId)
      const replyToMessageId =
        deliveryMode === 'thread' && inferred?.botId === t.botId && inferred.chatId === t.chatId
          ? inferred.replyToMessageId
          : undefined
      richTargets.push({
        botId: bot.id,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        ...(botOpenId ? { botOpenId } : {}),
        chatId: t.chatId,
        chatName,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      })
    }

    return composeScheduleContextReminder({
      scheduleId,
      title,
      enabled,
      deliveryMode,
      notifyOn,
      targets: richTargets,
    })
  }

  async listViews(): Promise<{ readonly available: boolean; readonly schedules: LarkScheduleView[] }> {
    const service = this.service()
    if (!service) return { available: false, schedules: [] }
    const entries = await service.catalog()
    const views: LarkScheduleView[] = []
    for (const entry of entries) {
      this.catalogById.set(entry.id, entry)
      const explicit = this.host.store.getScheduleBinding(entry.id)
      const inferredOrigin = await this.resolveInferredOrigin(entry)
      if (inferredOrigin) this.inferredOriginById.set(entry.id, inferredOrigin)
      const binding: LarkScheduleBinding = explicit ?? {
        scheduleId: entry.id,
        enabled: Boolean(inferredOrigin),
        targets: [],
        deliveryMode: entry.kind === 'after' || entry.kind === 'at' ? 'thread' : 'chat',
        notifyOn: 'non_empty',
      }
      views.push({
        id: entry.id,
        title: entry.title,
        prompt: entry.prompt,
        kind: entry.kind,
        ruleSummary: formatScheduleRuleSummary(entry),
        status: entry.status,
        scheduledAt: entry.scheduledAt,
        executionActive: Boolean(entry.executionActive),
        ...(entry.lastDelivery?.deliveredAt ? { lastDeliveredAt: entry.lastDelivery.deliveredAt } : {}),
        ...(entry.lastDelivery?.targetSessionId ? { lastTargetSessionId: entry.lastDelivery.targetSessionId } : {}),
        ...(inferredOrigin ? { inferredOrigin } : {}),
        configured: Boolean(explicit),
        binding,
      })
    }
    return { available: true, schedules: views }
  }

  async createAndBind(input: {
    readonly title: string
    readonly prompt: string
    readonly timing: ScheduleCreateInputLike['timing']
    readonly cwd?: string
    readonly agentPreset?: string
    readonly botId?: string
    readonly targets?: readonly LarkScheduleTarget[]
    readonly deliveryMode?: LarkScheduleDeliveryMode
    readonly notifyOn?: LarkScheduleNotifyOn
  }): Promise<{ readonly entry: ScheduleEntryLike; readonly binding?: LarkScheduleBinding }> {
    const service = this.service()
    if (!service?.create) {
      throw new Error('当前宿主未启用自动化任务创建能力')
    }
    const primaryTarget = input.targets?.[0]
    const resolvedBotId = input.botId?.trim() || primaryTarget?.botId
    const bot = resolvedBotId ? this.host.store.getBot(resolvedBotId) : undefined
    const group =
      bot && primaryTarget && primaryTarget.botId === bot.id
        ? this.host.store.getGroup(bot.id, primaryTarget.chatId)
        : undefined
    const rawCwd =
      input.cwd?.trim() || (bot ? resolveEffectiveWorkingDir(bot, group) : undefined)
    const resolvedCwd = rawCwd ? assertExistingWorkingDirectory(rawCwd) : undefined
    const resolvedPreset =
      input.agentPreset?.trim() ||
      (bot ? resolveEffectiveAgentRuntime(bot, group).agentPreset : undefined)
    const createSpec =
      resolvedCwd || resolvedPreset
        ? {
            ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
            ...(resolvedPreset ? { agentPreset: resolvedPreset } : {}),
          }
        : undefined
    const entry = await service.create({
      title: input.title,
      prompt: input.prompt,
      timing: input.timing,
      target: {
        kind: 'new',
        ...(createSpec ? { create: createSpec } : {}),
      },
    })
    this.catalogById.set(entry.id, entry)
    let binding: LarkScheduleBinding | undefined
    if (input.targets && input.targets.length > 0) {
      binding = this.host.store.upsertScheduleBinding({
        scheduleId: entry.id,
        enabled: true,
        targets: input.targets,
        deliveryMode: input.deliveryMode ?? 'chat',
        notifyOn: input.notifyOn ?? 'non_empty',
      })
      void this.refreshScheduleContextCache()
    }
    return { entry, ...(binding ? { binding } : {}) }
  }

  async runNow(scheduleId: string): Promise<{ readonly ok: boolean; readonly error?: string }> {
    const service = this.service()
    if (!service) return { ok: false, error: '当前宿主未启用自动化任务服务' }
    await this.refreshScheduleContextCache()
    const res = await service.run({ id: scheduleId })
    if ('code' in res) {
      const friendly =
        res.code === 'schedule_execution_pending'
          ? '任务正在执行或处于 60 秒触发冷却期内，请稍后再试'
          : res.code === 'schedule_not_found'
            ? '未找到该自动化任务'
            : res.code
      return { ok: false, error: friendly }
    }
    return { ok: true }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const sid = session.id
    if (event.type === 'turn/start') {
      this.currentTurnBySession.set(sid, event.data.turn)
      return
    }
    if (event.type === 'user/message') {
      const source = (event.data as { source?: { kind?: string }; id?: string }).source
      const messageId = (event.data as { id?: string }).id
      const turn = this.currentTurnBySession.get(sid)
      if (source?.kind === 'schedule' && messageId && turn !== undefined) {
        this.activeTurns.set(`${sid}:${turn}`, {
          sessionId: sid,
          turn,
          messageId,
          replyTracker: new TurnFinalReplyTracker({
            onIntermediate: (stepText) =>
              this.deliverIntermediateScheduledStep(session, messageId, stepText),
          }),
          startedMs: Date.now(),
        })
      }
      return
    }
    if (event.type === 'assistant/message' || event.type === 'tool/call') {
      const active = this.activeTurns.get(`${sid}:${event.data.turn}`)
      if (!active) return
      active.replyTracker.onEvent(event)
      return
    }
    if (event.type === 'turn/end') {
      const key = `${sid}:${event.data.turn}`
      const active = this.activeTurns.get(key)
      if (!active) return
      this.activeTurns.delete(key)
      if (event.data.reason.kind === 'aborted') return
      const errorMessage =
        event.data.reason.kind === 'error'
          ? event.data.reason.error.message || '自动化任务执行失败'
          : undefined
      void this.finalizeScheduledTurn(session, active, errorMessage)
    }
  }

  private async deliverIntermediateScheduledStep(
    session: Session,
    messageId: string,
    stepText: string,
  ): Promise<void> {
    const entry = await this.findMatchingSchedule(messageId, session.id)
    if (!entry) return
    const explicit = this.host.store.getScheduleBinding(entry.id)
    if (!explicit?.enabled || !explicit.sendIntermediateMessages) return

    const inferredOrigin = await this.resolveInferredOrigin(entry)
    const targets: readonly LarkScheduleTarget[] =
      explicit.targets.length > 0
        ? explicit.targets
        : inferredOrigin
          ? [{ botId: inferredOrigin.botId, chatId: inferredOrigin.chatId }]
          : []
    if (targets.length === 0) return

    const deliveryMode: LarkScheduleDeliveryMode = explicit.deliveryMode
    for (const target of targets) {
      const replyToMessageId =
        deliveryMode === 'thread' &&
        inferredOrigin?.botId === target.botId &&
        inferredOrigin.chatId === target.chatId
          ? inferredOrigin.replyToMessageId
          : undefined
      try {
        await this.host.sendScheduleMessage({
          botId: target.botId,
          chatId: target.chatId,
          deliveryMode,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          scheduleTitle: entry.title,
          markdown: stepText,
          isError: false,
          isIntermediate: true,
          sessionId: session.id,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.host.ctx.logger.warn(
          `[lark-bridge] intermediate schedule step notify failed (${entry.title}): ${msg}`,
        )
      }
    }
  }

  private async finalizeScheduledTurn(
    session: Session,
    turn: ActiveScheduleTurn,
    errorMessage?: string,
  ): Promise<void> {
    await turn.replyTracker.flush()

    const entry = await this.findMatchingSchedule(turn.messageId, turn.sessionId)
    if (!entry) return

    const inferredOrigin = await this.resolveInferredOrigin(entry)
    const explicit = this.host.store.getScheduleBinding(entry.id)
    if (explicit && !explicit.enabled) return

    const targets: readonly LarkScheduleTarget[] =
      explicit && explicit.targets.length > 0
        ? explicit.targets
        : inferredOrigin
          ? [{ botId: inferredOrigin.botId, chatId: inferredOrigin.chatId }]
          : []
    if (targets.length === 0) return

    const deliveryMode: LarkScheduleDeliveryMode =
      explicit?.deliveryMode ?? (entry.kind === 'after' || entry.kind === 'at' ? 'thread' : 'chat')
    const notifyOn = explicit?.notifyOn ?? 'non_empty'

    const primaryTarget = targets[0]!
    const primaryBot = this.host.store.getBot(primaryTarget.botId)
    const primaryGroup = this.host.store.getGroup(primaryTarget.botId, primaryTarget.chatId)
    if (primaryBot && session.header.cwd) {
      const chatName =
        this.host.store.resolveChatName(primaryTarget.botId, primaryTarget.chatId) ||
        (inferredOrigin?.chatId === primaryTarget.chatId ? inferredOrigin.chatName : undefined)
      const sessionDir = expandWorkingDir(session.header.cwd) || session.header.cwd
      const syntheticGroup =
        primaryGroup ??
        ({
          key: `${primaryBot.id}:${primaryTarget.chatId}`,
          botId: primaryBot.id,
          chatId: primaryTarget.chatId,
          chatName: chatName ?? '',
          enabled: true,
          workingDir: sessionDir,
          workspaceName: '',
        } as never)
      const workspaceName = this.host.store.resolveGroupWorkspaceName(
        primaryBot,
        syntheticGroup,
        chatName,
      )
      await this.host.workspaces.attachSession(session.header.cwd, workspaceName, session.id)
    }
    this.maybeTitleScheduleSession(session, entry.title)

    const replyText = turn.replyTracker.result()
    const isError = Boolean(errorMessage)
    const latencyMs = Date.now() - turn.startedMs

    if (!isError) {
      if (notifyOn === 'error_only') return
      if (replyText.length === 0 && turn.replyTracker.intermediateCount > 0) {
        return
      }
      if (notifyOn === 'non_empty' && replyText.length === 0) {
        this.host.store.recordMetric({
          botId: primaryTarget.botId,
          chatId: primaryTarget.chatId,
          kind: 'silent_skip',
        })
        this.host.store.recordEvent({
          botId: primaryTarget.botId,
          chatId: primaryTarget.chatId,
          sessionId: session.id,
          durationMs: latencyMs,
          kind: 'silent_skip',
          summary: `自动化任务「${entry.title}」输出为空，已静默`,
        })
        if (entry.target.kind === 'new') {
          await this.host.workspaces.archiveSession(session.id)
        }
        return
      }
    }

    const markdown = isError
      ? `**执行异常**：${errorMessage}${replyText ? `\n\n${replyText}` : ''}`
      : replyText || '（已完成执行，无文本输出）'

    for (const target of targets) {
      const replyToMessageId =
        deliveryMode === 'thread' &&
        inferredOrigin?.botId === target.botId &&
        inferredOrigin.chatId === target.chatId
          ? inferredOrigin.replyToMessageId
          : undefined
      try {
        await this.host.sendScheduleMessage({
          botId: target.botId,
          chatId: target.chatId,
          deliveryMode,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          scheduleTitle: entry.title,
          markdown,
          isError,
          sessionId: session.id,
        })
        this.host.store.recordMetric({
          botId: target.botId,
          chatId: target.chatId,
          kind: isError ? 'error' : 'replied',
          latencyMs,
        })
        this.host.store.recordEvent({
          botId: target.botId,
          chatId: target.chatId,
          sessionId: session.id,
          durationMs: latencyMs,
          kind: isError ? 'error' : 'reply',
          summary: `自动化任务「${entry.title}」已推送通知`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.host.ctx.logger.error(`[lark-bridge] schedule notify failed (${entry.title}): ${msg}`)
        this.host.store.recordEvent({
          botId: target.botId,
          chatId: target.chatId,
          sessionId: session.id,
          kind: 'error',
          summary: `自动化任务「${entry.title}」推送失败：${msg}`,
        })
      }
    }
  }

  private async findMatchingSchedule(
    messageId: string,
    sessionId: string,
  ): Promise<ScheduleEntryLike | undefined> {
    const service = this.service()
    if (!service) return undefined

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entries = await service.catalog()
      const direct = entries.find((e) => e.lastDelivery?.messageId === messageId)
      if (direct) return direct

      if (service.history) {
        for (const entry of entries) {
          if (
            entry.lastDelivery?.targetSessionId !== sessionId &&
            !entry.involvedSessionIds.includes(sessionId) &&
            entry.target.kind !== 'new'
          ) {
            continue
          }
          const hist = await service.history({ id: entry.id, limit: 5 })
          if ('records' in hist && hist.records.some((r) => r.messageId === messageId)) {
            return entry
          }
        }
      }

      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 80))
      }
    }
    return undefined
  }

  private async resolveInferredOrigin(
    entry: ScheduleEntryLike,
  ): Promise<LarkScheduleOriginHint | undefined> {
    const candidates: string[] = []
    if (entry.target.kind === 'session' || entry.target.kind === 'new_once') {
      candidates.push(entry.target.sessionId)
    }
    for (const sid of entry.involvedSessionIds) {
      if (!candidates.includes(sid)) candidates.push(sid)
    }

    for (const sid of candidates) {
      const origin = await this.readSessionOrigin(sid)
      if (!origin) continue
      const bot = this.host.store.getBot(origin.botId)
      if (!bot) continue
      const chatName =
        this.host.store.resolveChatName(origin.botId, origin.chatId) ||
        origin.chatName ||
        origin.chatId
      const replyToMessageId = extractReplyToMessageId(origin.routeKey)
      return {
        botId: origin.botId,
        botName: bot.name,
        chatId: origin.chatId,
        chatName,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      }
    }
    return undefined
  }

  private async readSessionOrigin(sessionId: string): Promise<LarkOriginRecord | undefined> {
    if (this.originCache.has(sessionId)) {
      return this.originCache.get(sessionId) ?? undefined
    }

    const fromBinding = this.host.store.listBindings().find((b) => b.sessionId === sessionId)
    if (fromBinding) {
      const rec: LarkOriginRecord = {
        botId: fromBinding.botId,
        botName: fromBinding.botName ?? fromBinding.botId,
        larkAppId: fromBinding.larkAppId,
        chatId: fromBinding.chatId,
        ...(fromBinding.chatName ? { chatName: fromBinding.chatName } : {}),
        workspaceName: fromBinding.workspaceName,
        routeKey: fromBinding.routeKey,
        trigger: fromBinding.trigger,
      }
      this.originCache.set(sessionId, rec)
      return rec
    }

    const liveSession = (
      this.host.ctx.sessions as unknown as { get?: (id: SessionId) => Session | undefined }
    ).get?.(brandString<SessionId>(sessionId))
    if (liveSession) {
      const found = this.scanEventsForOrigin(liveSession.snapshotEvents())
      if (found) {
        this.originCache.set(sessionId, found)
        return found
      }
    }

    const persistence = this.host.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence) {
      try {
        const handle = await persistence.open(brandString<SessionId>(sessionId), 'read')
        try {
          const cold = await handle.read(0, 30)
          const found = this.scanEventsForOrigin(cold.events)
          this.originCache.set(sessionId, found ?? null)
          return found
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        // Session log unavailable or not yet created.
      }
    }
    return undefined
  }

  private scanEventsForOrigin(events: readonly SessionEvent[]): LarkOriginRecord | undefined {
    for (const ev of events) {
      const rec = pluginRecordOf(ev as never) as { type?: string; data?: Record<string, unknown> } | undefined
      if (rec?.type === LARK_ORIGIN_RECORD_TYPE && rec.data) {
        return rec.data as unknown as LarkOriginRecord
      }
    }
    return undefined
  }

  private maybeTitleScheduleSession(session: Session, scheduleTitle: string): void {
    const titleService = this.host.ctx.get('sessionTitle' as never) as
      | {
          get?: (s: Session) => { source?: { kind?: string } } | undefined
          rename?: (s: Session, t: string) => unknown
        }
      | undefined
    if (!titleService?.rename) return
    const existing = titleService.get?.(session)
    if (existing?.source?.kind === 'user') return
    try {
      titleService.rename(session, `定时 · ${scheduleTitle}`.slice(0, 60))
    } catch {
      // Ignore if session is already closed.
    }
  }

  private async pruneDeletedBindings(): Promise<void> {
    const service = this.service()
    if (!service) return
    for (const binding of this.host.store.listScheduleBindings()) {
      try {
        const res = await service.view({ id: binding.scheduleId })
        if ('code' in res && res.code === 'schedule_not_found') {
          this.host.store.deleteScheduleBinding(binding.scheduleId)
        }
      } catch {
        // Keep binding on transient error.
      }
    }
  }
}
