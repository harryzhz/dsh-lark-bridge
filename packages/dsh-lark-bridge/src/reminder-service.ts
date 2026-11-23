import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord,
  pluginRecordOf,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  buildReminderConfirmCard,
  buildReminderNoticeCard,
  buildReminderStatusCard,
  composeReminderTriggerPrompt,
  expandWorkingDir,
  extractReminderTriggerOutput,
  leafDirectoryName,
  resolveEffectiveAgentRuntime,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  type LarkBotConfig,
  type LarkReminderItem,
  type LarkReminderMention,
  type LarkReminderOrigin,
  type LarkReminderWorktreeMeta,
  type ReminderCreationMode,
} from '@dsh-lark/lark-core'
import { assertExistingWorkingDirectory } from './fs-browser.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { LarkBridgeStore } from './store.js'
import { LARK_ORIGIN_RECORD_TYPE, type LarkOriginRecord } from './types.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

const SWEEP_INTERVAL_MS = 30_000

export interface CreateReminderInput {
  readonly sessionId?: string
  readonly botId?: string
  readonly chatId?: string
  readonly userOpenId?: string
  readonly userName?: string
  readonly replyToMessageId?: string
  readonly deliveryMode?: 'thread' | 'chat' | 'p2p'
  readonly title: string
  readonly prompt: string
  readonly reason?: string
  readonly at?: string
  readonly afterSeconds?: number
  readonly workingDir?: string
  readonly mentions?: readonly LarkReminderMention[]
  readonly worktree?: LarkReminderWorktreeMeta
  readonly creationMode?: ReminderCreationMode
}

export interface UpdateReminderInput {
  readonly title?: string
  readonly prompt?: string
  readonly reason?: string
  readonly at?: string
}

export interface ReminderServiceHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  runTurn(agent: Agent, content: ContentBlock[]): Promise<string>
  sendOriginCard(
    origin: LarkReminderOrigin,
    card: Record<string, unknown>,
  ): Promise<{ readonly messageId?: string }>
  patchOriginCard(botId: string, messageId: string, card: Record<string, unknown>): Promise<void>
  deliverReminderOutput(input: {
    readonly item: LarkReminderItem
    readonly sessionId: string
    readonly markdown: string
    readonly isError: boolean
  }): Promise<{ readonly messageId?: string }>
}

export function parseReminderTargetIso(
  input: { readonly at?: string; readonly afterSeconds?: number },
  nowMs = Date.now(),
): string {
  if (input.afterSeconds !== undefined) {
    if (!Number.isFinite(input.afterSeconds) || input.afterSeconds <= 0) {
      throw new Error('afterSeconds 必须为正数')
    }
    return new Date(nowMs + Math.round(input.afterSeconds * 1000)).toISOString()
  }
  const raw = input.at?.trim() ?? ''
  if (!raw) throw new Error('必须提供触发时间（at 或 afterSeconds）')
  // Support "YYYY-MM-DD HH:mm" in local timezone as well as full ISO strings
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(:\d{2})?$/.test(raw)
    ? raw.replace(/\s+/, 'T')
    : raw
  const parsedMs = Date.parse(normalized)
  if (!Number.isFinite(parsedMs)) {
    throw new Error(`无法解析触发时间 "${raw}"，请使用 YYYY-MM-DD HH:mm 或 ISO 格式`)
  }
  if (parsedMs <= nowMs - 5_000) {
    throw new Error('提醒触发时间必须在当前时间之后')
  }
  return new Date(parsedMs).toISOString()
}

function formatFriendlyLocalTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function extractThreadReplyId(
  routeKey: string,
  aliasRouteKeys?: readonly string[],
): string | undefined {
  if (aliasRouteKeys) {
    for (let i = aliasRouteKeys.length - 1; i >= 0; i -= 1) {
      const parts = aliasRouteKeys[i]!.split(':')
      const scope = parts.slice(2).join(':')
      if (scope.startsWith('om_')) return scope
    }
  }
  const parts = routeKey.split(':')
  const scope = parts.slice(2).join(':')
  return scope.startsWith('om_') ? scope : undefined
}

/**
 * Manages one-shot proactive follow-up reminders:
 * - Auto-derives origin (group thread / group chat / P2P user) from the creating session
 * - Supports `silent`, `notify`, and `confirm` creation policies
 * - Wakes the Agent at `scheduledAt`, suppresses noise when `<no_reminder_needed/>`,
 *   and automatically archives every reminder upon completion.
 */
export class ProactiveReminderService {
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private nextDueTimer: ReturnType<typeof setTimeout> | null = null
  private readonly runningIds = new Set<string>()
  private readonly sessionHandles = new Map<string, AgentHandle>()
  private disposed = false

  constructor(private readonly host: ReminderServiceHost) {}

  start(sweepMs = SWEEP_INTERVAL_MS): void {
    this.rearmNextDueTimer()
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.tick()
      }, sweepMs)
      this.sweepTimer.unref?.()
    }
  }

  async stop(): Promise<void> {
    this.disposed = true
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    if (this.nextDueTimer) {
      clearTimeout(this.nextDueTimer)
      this.nextDueTimer = null
    }
    const handles = [...this.sessionHandles.values()]
    this.sessionHandles.clear()
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})))
  }

  /**
   * Transitions any reminder left in `running` from a prior process restart/crash
   * into `archived` (`error`) while preserving or backfilling its `lastSessionId`.
   */
  async recoverStaleRunningReminders(nowMs = Date.now()): Promise<number> {
    const stale = this.host.store
      .listReminders('active')
      .filter((r) => r.status === 'running' && !this.runningIds.has(r.id))
    if (stale.length === 0) return 0

    for (const item of stale) {
      const sessionId = item.lastSessionId || (await this.findSessionIdForReminder(item.id))
      this.host.store.upsertReminder({
        ...item,
        status: 'archived',
        resolution: 'error',
        ...(sessionId ? { lastSessionId: sessionId } : {}),
        resultSummary: '执行因服务重启中断，已归档',
        updatedAtMs: nowMs,
        archivedAtMs: nowMs,
      })
      this.host.store.recordEvent({
        botId: item.origin.botId,
        ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
        ...(sessionId ? { sessionId } : {}),
        kind: 'error',
        summary: `提醒事项「${item.title}」因服务重启中断，已归档`,
      })
    }
    this.rearmNextDueTimer(nowMs)
    return stale.length
  }

  async create(input: CreateReminderInput, nowMs = Date.now()): Promise<LarkReminderItem> {
    const title = input.title.trim()
    const prompt = input.prompt.trim()
    if (!title || !prompt) throw new Error('提醒事项标题（title）与指令（prompt）不能为空')

    const scheduledAt = parseReminderTargetIso(input, nowMs)
    const origin = await this.resolveOrigin(input)
    const bot = this.host.store.getBot(origin.botId)
    if (!bot) throw new Error(`未找到智能体 "${origin.botId}"`)

    const mode: ReminderCreationMode =
      input.creationMode ?? bot.experimental.proactive.reminderCreationMode ?? 'silent'
    const id = `rem-${randomUUID().slice(0, 12)}`
    const initialStatus = mode === 'confirm' ? 'pending_confirm' : 'scheduled'
    const validatedWorkingDir = input.workingDir?.trim()
      ? assertExistingWorkingDirectory(input.workingDir)
      : undefined

    let item: LarkReminderItem = this.host.store.upsertReminder({
      id,
      title,
      prompt,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      scheduledAt,
      status: initialStatus,
      origin,
      ...(validatedWorkingDir ? { workingDir: validatedWorkingDir } : {}),
      mentions: input.mentions ?? [],
      ...(input.worktree ? { worktree: input.worktree } : {}),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    })

    const timeStr = formatFriendlyLocalTime(scheduledAt)
    if (mode === 'confirm') {
      const sent = await this.host
        .sendOriginCard(origin, buildReminderConfirmCard(item, timeStr))
        .catch(() => ({ messageId: undefined }))
      if (sent.messageId) {
        item = this.host.store.upsertReminder({ ...item, confirmMessageId: sent.messageId })
      }
    } else {
      if (mode === 'notify') {
        const sent = await this.host
          .sendOriginCard(origin, buildReminderNoticeCard(item, timeStr))
          .catch(() => ({ messageId: undefined }))
        if (sent.messageId) {
          item = this.host.store.upsertReminder({ ...item, confirmMessageId: sent.messageId })
        }
      }
      this.rearmNextDueTimer()
    }

    this.host.store.recordEvent({
      botId: bot.id,
      ...(origin.chatId ? { chatId: origin.chatId } : {}),
      kind: 'lifecycle',
      summary: `${mode === 'confirm' ? '待确认提醒事项' : '创建提醒事项'}「${title}」（${timeStr}）`,
    })
    return item
  }

  update(id: string, patch: UpdateReminderInput, nowMs = Date.now()): LarkReminderItem {
    const existing = this.host.store.getReminder(id)
    if (!existing) throw new Error('未找到该提醒事项')
    if (existing.status === 'running') throw new Error('提醒事项正在执行中，无法修改')

    const nextScheduledAt = patch.at
      ? parseReminderTargetIso({ at: patch.at }, nowMs)
      : existing.scheduledAt
    const nextStatus =
      existing.status === 'archived' && patch.at ? 'scheduled' : existing.status

    const updated = this.host.store.upsertReminder({
      ...existing,
      ...(patch.title?.trim() ? { title: patch.title.trim() } : {}),
      ...(patch.prompt?.trim() ? { prompt: patch.prompt.trim() } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason.trim() || undefined } : {}),
      scheduledAt: nextScheduledAt,
      status: nextStatus,
      ...(nextStatus === 'scheduled' ? { resolution: undefined, archivedAtMs: undefined } : {}),
      updatedAtMs: nowMs,
    })
    this.rearmNextDueTimer()
    return updated
  }

  async approve(id: string, nowMs = Date.now()): Promise<LarkReminderItem> {
    const existing = this.host.store.getReminder(id)
    if (!existing) throw new Error('未找到该提醒事项')
    if (existing.status !== 'pending_confirm') return existing

    // Ensure scheduledAt is still in the future; if it elapsed while waiting for confirmation, fire in 5s
    const dueMs = Math.max(Date.parse(existing.scheduledAt), nowMs + 5_000)
    const scheduledAt = new Date(dueMs).toISOString()
    const updated = this.host.store.upsertReminder({
      ...existing,
      status: 'scheduled',
      scheduledAt,
      updatedAtMs: nowMs,
    })
    if (existing.confirmMessageId) {
      await this.host.patchOriginCard(
        existing.origin.botId,
        existing.confirmMessageId,
        buildReminderStatusCard(
          `已启用跟进提醒 · ${existing.title}`,
          `将于 **${formatFriendlyLocalTime(scheduledAt)}** 自动跟进执行。`,
          'green',
        ),
      )
    }
    this.rearmNextDueTimer()
    return updated
  }

  async cancel(
    id: string,
    resolution: 'cancelled' | 'rejected' = 'cancelled',
    nowMs = Date.now(),
  ): Promise<LarkReminderItem> {
    const existing = this.host.store.getReminder(id)
    if (!existing) throw new Error('未找到该提醒事项')
    const updated = this.host.store.upsertReminder({
      ...existing,
      status: 'archived',
      resolution,
      resultSummary: resolution === 'rejected' ? '已忽略未启用' : '已取消并归档',
      updatedAtMs: nowMs,
      archivedAtMs: nowMs,
    })
    if (existing.confirmMessageId) {
      await this.host.patchOriginCard(
        existing.origin.botId,
        existing.confirmMessageId,
        buildReminderStatusCard(
          `已取消跟进提醒 · ${existing.title}`,
          resolution === 'rejected' ? '已忽略本次跟进提醒建议。' : '该提醒事项已取消并归档。',
          'grey',
        ),
      )
    }
    this.rearmNextDueTimer()
    return updated
  }

  async handleCardAction(
    actionValue: Record<string, unknown>,
    options: { readonly operatorOpenId?: string } = {},
  ): Promise<string | undefined> {
    const kind = actionValue.kind
    const reminderId = typeof actionValue.reminderId === 'string' ? actionValue.reminderId : ''
    if (!reminderId) return undefined
    if (kind !== 'lark_reminder_confirm' && kind !== 'lark_reminder_cancel') {
      return undefined
    }

    const existing = this.host.store.getReminder(reminderId)
    if (!existing) {
      return '该提醒事项不存在或已删除'
    }
    const authError = this.authorizeCardAction(existing, options.operatorOpenId)
    if (authError) {
      return authError
    }

    if (kind === 'lark_reminder_confirm') {
      const decision = actionValue.decision === 'approve' ? 'approve' : 'reject'
      if (decision === 'approve') {
        await this.approve(reminderId)
        return '已确认开启跟进提醒'
      }
      await this.cancel(reminderId, 'rejected')
      return '已忽略该提醒事项'
    }
    await this.cancel(reminderId, 'cancelled')
    return '已取消该提醒事项'
  }

  private authorizeCardAction(
    item: LarkReminderItem,
    operatorOpenId: string | undefined,
  ): string | undefined {
    const operator = operatorOpenId?.trim()
    if (!operator) {
      return '无法确认操作者身份，请在 DSH 控制台处理提醒事项'
    }
    const bot = this.host.store.getBot(item.origin.botId)
    const admins = bot?.adminUsers ?? []
    if (admins.includes(operator)) {
      return undefined
    }
    if (item.origin.chatType === 'p2p') {
      if (item.origin.userOpenId && item.origin.userOpenId === operator) {
        return undefined
      }
      return '仅本人或智能体管理员可操作该私聊提醒'
    }
    if (admins.length === 0) {
      return '未配置智能体管理员，请在 DSH 控制台处理提醒事项'
    }
    return '仅智能体管理员可操作群内提醒事项'
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (this.disposed) return
    const active = this.host.store.listReminders('active')
    for (const item of active) {
      if (item.status !== 'scheduled') continue
      if (this.runningIds.has(item.id)) continue
      if (Date.parse(item.scheduledAt) <= nowMs) {
        const { completion } = await this.startReminderExecution(item, nowMs)
        await completion
      }
    }
    this.rearmNextDueTimer(nowMs)
  }

  /**
   * Starts reminder execution immediately and resolves as soon as the session is
   * created, attached to its workspace, and `lastSessionId` is persisted.
   */
  async triggerNow(id: string, nowMs = Date.now()): Promise<LarkReminderItem> {
    const item = this.host.store.getReminder(id)
    if (!item) throw new Error('未找到该提醒事项')
    if (this.runningIds.has(id)) throw new Error('该提醒事项正在执行中')
    const { runningItem } = await this.startReminderExecution(item, nowMs)
    return runningItem
  }

  async runNow(id: string, nowMs = Date.now()): Promise<LarkReminderItem> {
    const item = this.host.store.getReminder(id)
    if (!item) throw new Error('未找到该提醒事项')
    if (this.runningIds.has(id)) throw new Error('该提醒事项正在执行中')
    const { completion } = await this.startReminderExecution(item, nowMs)
    return completion
  }

  private async startReminderExecution(
    item: LarkReminderItem,
    nowMs = Date.now(),
  ): Promise<{ readonly runningItem: LarkReminderItem; readonly completion: Promise<LarkReminderItem> }> {
    const bot = this.host.store.getBot(item.origin.botId)
    if (!bot) {
      const missingBot = this.host.store.upsertReminder({
        ...item,
        status: 'archived',
        resolution: 'error',
        resultSummary: `所属智能体 ${item.origin.botId} 不存在`,
        updatedAtMs: nowMs,
        archivedAtMs: nowMs,
      })
      return { runningItem: missingBot, completion: Promise.resolve(missingBot) }
    }

    this.runningIds.add(item.id)
    this.host.store.upsertReminder({ ...item, status: 'running', updatedAtMs: nowMs })

    const startedMs = Date.now()
    const group =
      item.origin.chatType === 'group' && item.origin.chatId
        ? this.host.store.getGroup(bot.id, item.origin.chatId)
        : undefined
    const runtime = resolveEffectiveAgentRuntime(bot, group)
    const defaultWorkingDir = resolveEffectiveWorkingDir(bot, group)
    const rawCwd = item.workingDir || defaultWorkingDir
    const workingDir = expandWorkingDir(rawCwd) || rawCwd
    const groupChatName =
      item.origin.chatType === 'group'
        ? item.origin.chatName ||
          (item.origin.chatId
            ? this.host.store.resolveChatName(bot.id, item.origin.chatId)
            : undefined)
        : undefined
    const hasCustomDir = Boolean(item.workingDir && workingDir !== defaultWorkingDir)
    const workspaceName = hasCustomDir
      ? leafDirectoryName(workingDir) || resolveEffectiveWorkspaceName(bot, group)
      : item.origin.chatType === 'group'
        ? this.host.store.resolveGroupWorkspaceName(bot, group, groupChatName)
        : typeof this.host.store.resolveBotWorkspaceName === 'function'
          ? this.host.store.resolveBotWorkspaceName(bot)
          : resolveEffectiveWorkspaceName(bot)
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    let createdSession = false

    try {
      const siblingActiveReminders = this.host.store
        .listReminders('active')
        .filter(
          (r) =>
            r.id !== item.id &&
            r.status === 'scheduled' &&
            r.origin.botId === item.origin.botId &&
            (item.origin.chatType === 'p2p'
              ? r.origin.userOpenId === item.origin.userOpenId
              : r.origin.chatId === item.origin.chatId),
        )
        .map((r) => ({
          id: r.id,
          title: r.title,
          scheduledAt: formatFriendlyLocalTime(r.scheduledAt),
        }))

      const prompt = composeReminderTriggerPrompt({
        item,
        currentLocalTimeStr: formatFriendlyLocalTime(new Date(nowMs).toISOString()),
        ...(siblingActiveReminders.length > 0 ? { siblingActiveReminders } : {}),
      })

      const launch = await this.host.runtimes.resolveAgentLaunch({
        agentPreset: runtime.agentPreset,
        ...(runtime.provider ? { explicitProvider: runtime.provider } : {}),
        ...(runtime.model ? { explicitModel: runtime.model } : {}),
        ...(runtime.reasoningEffort ? { explicitReasoningEffort: runtime.reasoningEffort } : {}),
        requireNativeModel: true,
      })
      const handle = await this.host.ctx.agents.create({
        sessionId,
        meta: { cwd: workingDir, agentPreset: runtime.agentPreset },
        agentOptions: {
          ...(launch.provider ? { provider: launch.provider } : {}),
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
        },
        setup: async (agentCtx, agent) => {
          await launch.mountPreset(agentCtx)
          appendPluginRecord(agent.session, LARK_ORIGIN_RECORD_TYPE, {
            botId: bot.id,
            botName: bot.name,
            larkAppId: bot.larkAppId,
            chatType: item.origin.chatType,
            chatId: item.origin.chatId ?? `p2p:${item.origin.userOpenId ?? ''}`,
            ...(item.origin.chatName ? { chatName: item.origin.chatName } : {}),
            ...(item.origin.replyToMessageId
              ? { replyToMessageId: item.origin.replyToMessageId }
              : {}),
            ...(item.origin.userOpenId ? { userOpenId: item.origin.userOpenId } : {}),
            ...(item.origin.userName ? { userName: item.origin.userName } : {}),
            workspaceName,
            routeKey: `reminder:${item.id}`,
            trigger: 'reminder',
          })
        },
      })
      createdSession = true
      this.sessionHandles.set(sessionId, handle)

      const titleSvc = this.host.ctx.get('sessionTitle' as never) as
        | { rename?: (s: Session, t: string) => unknown }
        | undefined
      try {
        titleSvc?.rename?.(handle.agent.session, `提醒 · ${item.title}`)
      } catch {
        // Ignore title errors.
      }
      await this.host.workspaces.attachSession(workingDir, workspaceName, sessionId)

      const runningItem = this.host.store.upsertReminder({
        ...item,
        status: 'running',
        lastSessionId: sessionId,
        updatedAtMs: Date.now(),
      })

      const idleMinutes = group?.idleCloseMinutes ?? bot.idleCloseMinutes
      this.host.store.upsertManagedSession?.({
        sessionId,
        botId: bot.id,
        chatId: item.origin.chatId ?? `p2p:${item.origin.userOpenId ?? ''}`,
        routeKey: `reminder:${item.id}`,
        trigger: 'reminder',
        createdAtMs: startedMs,
        lastActivityMs: startedMs,
        ...(idleMinutes > 0 ? { idleCloseMs: idleMinutes * 60_000 } : {}),
      })
      this.host.store.recordEvent({
        botId: bot.id,
        ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
        sessionId,
        kind: 'lifecycle',
        summary: `提醒事项「${item.title}」开始执行`,
      })

      const completion = this.finishReminderExecution({
        item: runningItem,
        bot,
        handle,
        sessionId,
        prompt,
        startedMs,
      })
      completion.catch(() => {})
      return { runningItem, completion }
    } catch (err) {
      this.runningIds.delete(item.id)
      const msg = err instanceof Error ? err.message : String(err)
      const finishedMs = Date.now()
      const failed = this.host.store.upsertReminder({
        ...item,
        status: 'archived',
        resolution: 'error',
        ...(createdSession ? { lastSessionId: sessionId } : {}),
        resultSummary: `执行异常：${msg}`,
        updatedAtMs: finishedMs,
        archivedAtMs: finishedMs,
      })
      this.host.store.recordEvent({
        botId: bot.id,
        ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
        ...(createdSession ? { sessionId } : {}),
        kind: 'error',
        summary: `提醒事项「${item.title}」失败：${msg}`,
      })
      return { runningItem: failed, completion: Promise.resolve(failed) }
    }
  }

  private async finishReminderExecution(input: {
    readonly item: LarkReminderItem
    readonly bot: LarkBotConfig
    readonly handle: AgentHandle
    readonly sessionId: string
    readonly prompt: string
    readonly startedMs: number
  }): Promise<LarkReminderItem> {
    const { item, bot, handle, sessionId, prompt, startedMs } = input
    try {
      const replyText = await this.host.runTurn(handle.agent, [{ type: 'text', text: prompt }])
      const finishedMs = Date.now()
      const durationMs = finishedMs - startedMs
      this.host.store.touchManagedSession?.(sessionId, finishedMs)

      const output = extractReminderTriggerOutput(replyText)
      if (!output) {
        const silentArchived = this.host.store.upsertReminder({
          ...item,
          status: 'archived',
          resolution: 'silent_ok',
          lastSessionId: sessionId,
          resultSummary: '无需打扰，已静默归档',
          updatedAtMs: finishedMs,
          archivedAtMs: finishedMs,
        })
        this.host.store.recordMetric({
          botId: bot.id,
          ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
          kind: 'silent_skip',
        })
        this.host.store.recordEvent({
          botId: bot.id,
          ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
          sessionId,
          durationMs,
          kind: 'silent_skip',
          summary: `提醒事项「${item.title}」无需打扰，已静默归档`,
        })
        return silentArchived
      }

      await this.host.deliverReminderOutput({
        item,
        sessionId,
        markdown: output,
        isError: false,
      })

      const archived = this.host.store.upsertReminder({
        ...item,
        status: 'archived',
        resolution: 'reminded',
        lastSessionId: sessionId,
        resultSummary: output.replace(/\s+/g, ' ').slice(0, 100),
        updatedAtMs: finishedMs,
        archivedAtMs: finishedMs,
      })
      this.host.store.recordMetric({
        botId: bot.id,
        ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
        kind: 'replied',
        latencyMs: durationMs,
      })
      this.host.store.recordEvent({
        botId: bot.id,
        ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
        sessionId,
        durationMs,
        kind: 'reply',
        summary: `提醒事项「${item.title}」已推送并归档`,
      })
      return archived
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const finishedMs = Date.now()
      const failed = this.host.store.upsertReminder({
        ...item,
        status: 'archived',
        resolution: 'error',
        lastSessionId: sessionId,
        resultSummary: `执行异常：${msg}`,
        updatedAtMs: finishedMs,
        archivedAtMs: finishedMs,
      })
      this.host.store.recordEvent({
        botId: bot.id,
        ...(item.origin.chatId ? { chatId: item.origin.chatId } : {}),
        sessionId,
        kind: 'error',
        summary: `提醒事项「${item.title}」失败：${msg}`,
      })
      return failed
    } finally {
      this.runningIds.delete(item.id)
    }
  }

  private async resolveOrigin(input: CreateReminderInput): Promise<LarkReminderOrigin> {
    const sid = input.sessionId?.trim() || undefined
    let sessionOrigin: LarkOriginRecord | undefined

    if (sid) {
      const binding = this.host.store.listBindings().find((b) => b.sessionId === sid)
      if (binding) {
        const isP2p = binding.chatType === 'p2p' || binding.trigger === 'p2p'
        const threadReply = extractThreadReplyId(binding.routeKey, binding.aliasRouteKeys)
        sessionOrigin = {
          botId: binding.botId,
          botName: binding.botName ?? binding.botId,
          larkAppId: binding.larkAppId,
          chatType: isP2p ? 'p2p' : 'group',
          chatId: binding.chatId,
          ...(binding.chatName ? { chatName: binding.chatName } : {}),
          ...(threadReply ? { replyToMessageId: threadReply } : {}),
          ...(binding.userOpenId ? { userOpenId: binding.userOpenId } : {}),
          ...(binding.userName ? { userName: binding.userName } : {}),
          workspaceName: binding.workspaceName,
          routeKey: binding.routeKey,
          trigger: binding.trigger,
        }
      } else {
        sessionOrigin = await this.readPersistedOrigin(sid)
      }
    }

    const botId =
      input.botId?.trim() ||
      sessionOrigin?.botId ||
      this.host.store.listBots().find((b) => b.enabled)?.id ||
      this.host.store.listBots()[0]?.id
    if (!botId) throw new Error('未找到可用智能体（请指定 botId）')
    const bot = this.host.store.getBot(botId)
    if (!bot) throw new Error(`未找到智能体 "${botId}"`)

    const explicitUser = input.userOpenId?.trim()
    const explicitChat = input.chatId?.trim()

    if (
      explicitUser ||
      (!explicitChat && sessionOrigin?.chatType === 'p2p' && sessionOrigin.userOpenId)
    ) {
      const userOpenId = explicitUser || sessionOrigin!.userOpenId!
      const userName = input.userName?.trim() || sessionOrigin?.userName
      return {
        botId: bot.id,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatType: 'p2p',
        ...(sessionOrigin?.chatId ? { chatId: sessionOrigin.chatId } : {}),
        deliveryMode: 'p2p',
        userOpenId,
        ...(userName ? { userName } : {}),
        ...(sid ? { sourceSessionId: sid } : {}),
      }
    }

    const chatId =
      explicitChat ||
      (sessionOrigin?.chatId && sessionOrigin.chatId !== 'dream:internal'
        ? sessionOrigin.chatId
        : undefined)
    if (!chatId) {
      throw new Error('请指定目标群聊（--chat oc_xxx）或私聊成员（--user ou_xxx），或在飞书会话内创建')
    }
    const replyToMessageId =
      input.replyToMessageId?.trim() ||
      (!explicitChat ? sessionOrigin?.replyToMessageId : undefined)
    const deliveryMode: 'thread' | 'chat' =
      input.deliveryMode === 'chat'
        ? 'chat'
        : input.deliveryMode === 'thread' || replyToMessageId
          ? 'thread'
          : 'chat'
    const chatName =
      this.host.store.resolveChatName(bot.id, chatId) || sessionOrigin?.chatName || chatId

    return {
      botId: bot.id,
      botName: bot.name,
      larkAppId: bot.larkAppId,
      chatType: 'group',
      chatId,
      chatName,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      deliveryMode,
      ...(sid ? { sourceSessionId: sid } : {}),
    }
  }

  private async readPersistedOrigin(sessionId: string): Promise<LarkOriginRecord | undefined> {
    const extractOrigin = (ev: unknown): LarkOriginRecord | undefined => {
      const rec = pluginRecordOf(ev as never) as
        | { type?: string; data?: unknown; payload?: unknown }
        | undefined
      if (rec?.type === LARK_ORIGIN_RECORD_TYPE) {
        const value = rec.data ?? rec.payload
        if (value && typeof value === 'object') return value as LarkOriginRecord
      }
      return undefined
    }

    const live = (
      this.host.ctx.sessions as unknown as { get?: (id: SessionId) => Session | undefined }
    )?.get?.(brandString<SessionId>(sessionId))
    if (live && typeof live.snapshotEvents === 'function') {
      for (const ev of live.snapshotEvents()) {
        const origin = extractOrigin(ev)
        if (origin) return origin
      }
    }
    const persistence = this.host.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (!persistence) return undefined
    try {
      const handle = await persistence.open(brandString<SessionId>(sessionId), 'read')
      try {
        const res = await handle.read(0, 30)
        for (const ev of res.events) {
          const origin = extractOrigin(ev)
          if (origin) return origin
        }
      } finally {
        await handle.close().catch(() => {})
      }
    } catch {
      // Ignore unreadable session.
    }
    return undefined
  }

  private async findSessionIdForReminder(reminderId: string): Promise<string | undefined> {
    const targetRoute = `reminder:${reminderId}`
    const candidateIds = this.host.workspaces.listWorkspaceSessionIds?.() ?? []
    for (const sid of candidateIds) {
      const origin = await this.readPersistedOrigin(sid)
      if (origin?.routeKey === targetRoute) return sid
    }
    return undefined
  }

  private rearmNextDueTimer(nowMs = Date.now()): void {
    if (this.nextDueTimer) {
      clearTimeout(this.nextDueTimer)
      this.nextDueTimer = null
    }
    if (this.disposed) return
    const scheduled = this.host.store
      .listReminders('active')
      .filter((r) => r.status === 'scheduled')
    if (scheduled.length === 0) return
    const earliestMs = Math.min(...scheduled.map((r) => Date.parse(r.scheduledAt)))
    if (!Number.isFinite(earliestMs)) return
    const delay = Math.min(Math.max(50, earliestMs - nowMs), 60 * 60_000)
    this.nextDueTimer = setTimeout(() => {
      void this.tick()
    }, delay)
    this.nextDueTimer.unref?.()
  }
}
