import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  DEFAULT_DREAMING_MAX_CHARS_PER_SESSION,
  DEFAULT_DREAMING_MAX_DURATION_MINUTES,
  DEFAULT_DREAMING_MAX_REMINDERS_PER_RUN,
  DEFAULT_DREAMING_MAX_SESSIONS_PER_RUN,
  composeDreamDeepConsolidationPrompt,
  composeDreamExecutionPrompt,
  composeDreamProactivePrompt,
  detectDreamingMemoryWriteFailure,
  expandWorkingDir,
  extractLarkContextMeta,
  extractPureUserIntent,
  normalizeReplyText,
  renderMemoryAuditReport,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  truncateSessionTranscriptHeadTail,
  type LarkBotConfig,
  type LarkDreamProactiveStats,
  type LarkMemoryMutationStats,
} from '@dsh-lark/lark-core'
import type { MemoryService } from './memory-service.js'
import type { DreamingReminderBudgetTracker, ProactiveReminderService } from './reminder-service.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import {
  buildRuntimeConcurrencyKey,
  type ConcurrencyLease,
  type RuntimeConcurrencyLimiter,
} from './runtime-concurrency.js'
import type { LarkBridgeStore } from './store.js'
import {
  LARK_ORIGIN_RECORD_TYPE,
  type LarkDreamRunState,
  type LarkManagedSession,
} from './types.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

const execFileAsync = promisify(execFile)

const TICK_INTERVAL_MS = 60_000
const MAX_SESSIONS_PER_BATCH = 15
const MAX_BATCH_DIGEST_CHARS = 75_000
const READ_EVENTS_PAGE_SIZE = 200
const MAX_EVENTS_PER_SESSION = 2000
const MAX_USER_LINE_CHARS = 900
const MAX_AGENT_LINE_CHARS = 1200
const MAX_DREAM_NOTE_CHARS = 220
const MAX_JOURNAL_ENTRIES = 30
const GIT_INSPECT_TIMEOUT_MS = 3_000
const RECENT_LOOP_WINDOW_MS = 48 * 60 * 60_000

export interface DreamingHost {
  readonly ctx: Context
  readonly dataDir: string
  readonly store: LarkBridgeStore
  readonly memory?: MemoryService
  readonly getReminders?: () => ProactiveReminderService | undefined
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  readonly runtimeLimiter?: RuntimeConcurrencyLimiter
  readonly shutdownSignal?: AbortSignal
  readonly onActivityChange?: () => void
  runTurn(agent: Agent, content: ContentBlock[]): Promise<string>
}

function atomicWritePrivate(filePath: string, content: string): void {
  const dir = join(filePath, '..')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(tmpPath, 0o600)
    } catch {
      // Best-effort on non-POSIX filesystems.
    }
  }
  renameSync(tmpPath, filePath)
}

function stripMarkdownForSummary(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?:^|\s)-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatMemoryStatsBadge(stats?: LarkMemoryMutationStats): string {
  if (!stats) return ''
  const parts: string[] = []
  if (stats.created > 0) parts.push(`新增 ${stats.created}`)
  if (stats.updated > 0) parts.push(`更新 ${stats.updated}`)
  if (stats.superseded > 0) parts.push(`纠偏 ${stats.superseded}`)
  if (stats.archived > 0) parts.push(`归档 ${stats.archived}`)
  return parts.join(' · ')
}

function formatProactiveStatsBadge(stats?: LarkDreamProactiveStats): string {
  if (!stats) return ''
  const parts: string[] = []
  if (stats.remindersCreated > 0) parts.push(`提醒 +${stats.remindersCreated}`)
  if (stats.worktreesCreated > 0) parts.push(`分支 +${stats.worktreesCreated}`)
  if (stats.backlogRemaining > 0) parts.push(`剩余积压 ${stats.backlogRemaining}`)
  return parts.join(' · ')
}

function formatDateKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatLocalDateTime(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}`
}

function parseMinutesOfDay(hhmm: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  if (!match) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Computes a sensible daytime local timestamp (`YYYY-MM-DD HH:mm`) for Dreaming-created
 * follow-up reminders so overnight runs naturally schedule for the coming morning
 * and daytime manual runs schedule 2 hours ahead (or next morning if entering quiet hours).
 */
export function computeNextWorkdayMorning(
  now: Date,
  quietHoursEnd = '08:00',
  skipWeekends = false,
): string {
  const endMins = parseMinutesOfDay(quietHoursEnd) ?? 8 * 60
  const preferredMorningMins = Math.max(9 * 60 + 30, Math.min(11 * 60, endMins + 30))
  const curMins = now.getHours() * 60 + now.getMinutes()

  const applyWeekendSkip = (d: Date): Date => {
    if (!skipWeekends) return d
    const day = d.getDay()
    if (day === 0 || day === 6) {
      d.setDate(d.getDate() + (day === 6 ? 2 : 1))
      d.setHours(Math.floor(preferredMorningMins / 60), preferredMorningMins % 60, 0, 0)
    }
    return d
  }

  const target = new Date(now.getTime())
  if (curMins < preferredMorningMins - 15) {
    target.setHours(Math.floor(preferredMorningMins / 60), preferredMorningMins % 60, 0, 0)
    return formatLocalDateTime(applyWeekendSkip(target))
  }

  const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60_000)
  const laterMins = twoHoursLater.getHours() * 60 + twoHoursLater.getMinutes()
  if (twoHoursLater.getDate() === now.getDate() && laterMins < 20 * 60) {
    twoHoursLater.setSeconds(0, 0)
    return formatLocalDateTime(applyWeekendSkip(twoHoursLater))
  }

  target.setDate(target.getDate() + 1)
  target.setHours(Math.floor(preferredMorningMins / 60), preferredMorningMins % 60, 0, 0)
  return formatLocalDateTime(applyWeekendSkip(target))
}

interface SessionParticipant {
  readonly openId: string
  readonly name: string
}

interface SessionDigestEntry {
  readonly markdown: string
  readonly hasSubstantiveAgentReply: boolean
  readonly fingerprint: string
  readonly rootMessageId?: string
  readonly participants: readonly SessionParticipant[]
  readonly wasInterrupted: boolean
}

interface PreparedDigestItem {
  readonly session: LarkManagedSession
  readonly digest: SessionDigestEntry
  readonly workingDir?: string
  readonly duplicateCount: number
  readonly foldedSessionIds: readonly string[]
}

interface PreparedDreamBatch {
  readonly selected: readonly PreparedDigestItem[]
  readonly consumedSessionIds: readonly string[]
  readonly skippedNoiseSessionIds: readonly string[]
  readonly backlogRemaining: number
  readonly activeWorkingDirs: readonly string[]
}

interface WorktreeInspectItem {
  readonly repoDir: string
  readonly worktreePath: string
  readonly branch: string
  readonly dirtyFiles: number
}

function normalizeFingerprint(raw: string): string {
  return raw
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?\b/g, '<ts>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function triggerPriorityTier(trigger?: string): number {
  if (
    trigger === 'p2p' ||
    trigger === 'mention' ||
    trigger === 'active-thread' ||
    trigger === 'substitute'
  ) {
    return 0
  }
  return 1
}

function summarizeSessionEvents(
  events: readonly SessionEvent[],
  maxCharsPerSession: number,
): SessionDigestEntry {
  const lines: string[] = []
  let firstUserText = ''
  let substantiveAgentCount = 0
  let currentTurnUsedSilenceCli = false
  let currentTurnAgentLines: string[] = []
  let rootMessageId: string | undefined
  let wasInterrupted = false
  const participants = new Map<string, string>()

  const rememberParticipant = (openId?: string, name?: string) => {
    const id = openId?.trim()
    if (!id) return
    const cleanName = name?.trim() || participants.get(id) || ''
    participants.set(id, cleanName)
  }

  const flushTurn = () => {
    if (!currentTurnUsedSilenceCli && currentTurnAgentLines.length > 0) {
      substantiveAgentCount += currentTurnAgentLines.length
      lines.push(...currentTurnAgentLines)
    }
    currentTurnUsedSilenceCli = false
    currentTurnAgentLines = []
  }

  for (const ev of events) {
    if (ev.type === 'turn/start') {
      flushTurn()
      continue
    }
    if (ev.type === 'tool/call') {
      const args = (ev.data as { arguments?: unknown }).arguments
      if (typeof args === 'string' && args.includes('lark-bridge silence')) {
        currentTurnUsedSilenceCli = true
      }
      continue
    }
    if (ev.type === 'user/message') {
      flushTurn()
      const blocks = (ev.data as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content ?? []
      const raw = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
      const ctxMeta = extractLarkContextMeta(raw)
      if (!rootMessageId) {
        rootMessageId = ctxMeta.threadId || ctxMeta.messageId
      }
      if (ctxMeta.senderOpenId) {
        rememberParticipant(ctxMeta.senderOpenId, ctxMeta.senderName)
      }
      for (const peer of ctxMeta.peerMentions) {
        rememberParticipant(peer.openId, peer.name)
      }
      const clean = extractPureUserIntent(raw)
      if (clean && clean !== '[空消息]') {
        if (!firstUserText) firstUserText = clean
        const speakerLabel = ctxMeta.senderName
          ? ctxMeta.senderOpenId
            ? `User [${ctxMeta.senderName} | open_id=${ctxMeta.senderOpenId}]`
            : `User [${ctxMeta.senderName}]`
          : ctxMeta.senderOpenId
            ? `User [open_id=${ctxMeta.senderOpenId}]`
            : 'User'
        lines.push(`- **${speakerLabel}**: ${clean.slice(0, MAX_USER_LINE_CHARS)}`)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const msgData = ev.data as {
        interrupted?: boolean
        message?: { content?: ReadonlyArray<{ type?: string; text?: string }> }
      }
      if (msgData.interrupted) {
        wasInterrupted = true
        continue
      }
      const content = msgData.message?.content ?? []
      if (content.some((b) => b.type === 'tool-call')) continue
      const rawText = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!.trim())
        .filter(Boolean)
        .join('\n')
      const cleanAgentText = normalizeReplyText(rawText, { allowSilentSentinel: true })
      if (cleanAgentText) {
        currentTurnAgentLines.push(`- **Agent**: ${cleanAgentText.slice(0, MAX_AGENT_LINE_CHARS)}`)
      }
    }
  }
  flushTurn()

  const markdown = truncateSessionTranscriptHeadTail(lines, maxCharsPerSession)
  const participantList: SessionParticipant[] = [...participants.entries()].map(([openId, name]) => ({
    openId,
    name: name || openId,
  }))

  return {
    markdown,
    hasSubstantiveAgentReply: substantiveAgentCount > 0,
    fingerprint: firstUserText ? normalizeFingerprint(firstUserText) : '',
    ...(rootMessageId ? { rootMessageId } : {}),
    participants: participantList,
    wasInterrupted,
  }
}

function splitPreparedIntoBatches(items: readonly PreparedDigestItem[]): PreparedDigestItem[][] {
  if (items.length === 0) return []
  const batches: PreparedDigestItem[][] = []
  let current: PreparedDigestItem[] = []
  let currentChars = 0

  for (const item of items) {
    const itemChars = item.digest.markdown.length + 220
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= MAX_SESSIONS_PER_BATCH || currentChars + itemChars > MAX_BATCH_DIGEST_CHARS)
    if (wouldOverflow) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += itemChars
  }
  if (current.length > 0) batches.push(current)
  return batches
}

async function inspectRepoWorktrees(repoDir: string): Promise<WorktreeInspectItem[]> {
  if (!repoDir || !existsSync(repoDir)) return []
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoDir,
      timeout: GIT_INSPECT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    })
    const blocks = stdout.trim().split(/\n\s*\n/)
    const items: WorktreeInspectItem[] = []
    for (const block of blocks) {
      let wtPath = ''
      let branch = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim()
      }
      if (!wtPath || !wtPath.includes(`${join('.worktrees', '')}`) && !wtPath.includes('/.worktrees/') && !wtPath.includes('\\.worktrees\\')) {
        continue
      }
      let dirtyFiles = 0
      try {
        const st = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: wtPath,
          timeout: GIT_INSPECT_TIMEOUT_MS,
          maxBuffer: 128 * 1024,
        })
        dirtyFiles = st.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean).length
      } catch {
        // Ignore individual worktree status failures.
      }
      items.push({
        repoDir,
        worktreePath: wtPath,
        branch: branch || basename(wtPath),
        dirtyFiles,
      })
    }
    return items
  } catch {
    return []
  }
}

async function inspectAllActiveWorktrees(dirs: readonly string[]): Promise<WorktreeInspectItem[]> {
  const uniqueDirs = Array.from(new Set(dirs.map((d) => expandWorkingDir(d) || d.trim()).filter(Boolean)))
  const seenWorktrees = new Set<string>()
  const out: WorktreeInspectItem[] = []
  for (const dir of uniqueDirs) {
    const list = await inspectRepoWorktrees(dir)
    for (const item of list) {
      if (seenWorktrees.has(item.worktreePath)) continue
      seenWorktrees.add(item.worktreePath)
      out.push(item)
    }
  }
  return out
}

/**
 * Orchestrates Auto-Dream v2 multi-stage overnight sleep cycles:
 * - Stage 1 (Light Sleep / Drain): head+tail sampled incremental batches with speaker open_id & thread metadata,
 *   advancing watermarks per completed batch so large backlogs drain safely without context overflow.
 * - Stage 2 (Deep Sleep / Rethink): full-library codebase verification, cold-memory curation & SOP synthesis.
 * - Stage 3 & 4 (Prospective Sleep): open-loop audit against live reminders/worktrees/errors, creating strictly
 *   capped daytime follow-up reminders and optional isolated `.worktrees/` pre-fixes.
 */
export class DreamingService {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly runningBots = new Set<string>()
  private disposed = false
  private dispatchPaused = false

  constructor(private readonly host: DreamingHost) {}

  getActiveCount(): number {
    return this.runningBots.size
  }

  pauseDispatch(): void {
    this.dispatchPaused = true
  }

  resumeDispatch(): void {
    if (this.disposed) return
    this.dispatchPaused = false
  }

  start(intervalMs = TICK_INTERVAL_MS): void {
    if (intervalMs <= 0) return
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.disposed || this.dispatchPaused) return
    const dateKey = formatDateKey(now)
    const curMins = now.getHours() * 60 + now.getMinutes()

    for (const bot of this.host.store.listBots()) {
      if (!bot.enabled || !bot.experimental.dreaming.enabled) continue
      if (this.runningBots.has(bot.id)) continue

      const latestState = this.host.store.getDreamState(bot.id)
      if (latestState?.lastCheckedDateKey === dateKey) continue
      const targetMins = parseMinutesOfDay(bot.experimental.dreaming.scheduleTime)
      if (targetMins === undefined) continue
      if (curMins >= targetMins && curMins < targetMins + 30) {
        await this.runForBot(bot.id, { force: false, now })
      }
    }
  }

  async runForBot(
    botId: string,
    options: { readonly force?: boolean; readonly now?: Date } = {},
  ): Promise<LarkDreamRunState> {
    const bot = this.host.store.getBot(botId)
    if (!bot) throw new Error(`未找到智能体 "${botId}"`)
    if (this.runningBots.has(botId)) {
      throw new Error(`智能体「${bot.name}」正在执行 Dreaming 整理，请稍候`)
    }

    const now = options.now ?? new Date()
    const dateKey = formatDateKey(now)
    const cfg = bot.experimental.dreaming
    const maxCharsPerSession = cfg.maxCharsPerSession ?? DEFAULT_DREAMING_MAX_CHARS_PER_SESSION
    const maxSessionsPerRun = cfg.maxSessionsPerRun ?? DEFAULT_DREAMING_MAX_SESSIONS_PER_RUN
    const maxRemindersPerRun = cfg.maxRemindersPerRun ?? DEFAULT_DREAMING_MAX_REMINDERS_PER_RUN
    const maxDurationMs =
      (cfg.maxDurationMinutes ?? DEFAULT_DREAMING_MAX_DURATION_MINUTES) * 60_000
    const deepConsolidationEnabled = cfg.deepConsolidation !== false

    const prev = this.host.store.getDreamState(botId) ?? {
      botId,
      status: 'idle' as const,
      processedSessionIds: [],
    }
    const processedSet = new Set(prev.processedSessionIds)

    const candidateSessions = this.collectNewSessions(botId, processedSet)
    const prepared = await this.prepareTranscriptBatch(
      bot,
      candidateSessions,
      maxSessionsPerRun,
      maxCharsPerSession,
    )
    if (!options.force && prepared.selected.length < cfg.minNewSessions) {
      const mergedProcessed =
        prepared.skippedNoiseSessionIds.length > 0
          ? [
              ...prev.processedSessionIds,
              ...prepared.skippedNoiseSessionIds.filter((id) => !processedSet.has(id)),
            ]
          : prev.processedSessionIds
      const skippedSummary = `有效增量会话 ${prepared.selected.length} 个（未达阈值 ${cfg.minNewSessions}），已静默跳过`
      return this.host.store.upsertDreamState({
        ...prev,
        status: 'skipped',
        lastCheckedDateKey: dateKey,
        lastProcessedCount: 0,
        lastSummary: skippedSummary,
        processedSessionIds: mergedProcessed,
      })
    }

    this.runningBots.add(botId)
    this.host.onActivityChange?.()
    this.host.store.upsertDreamState({
      ...prev,
      status: 'running',
      lastCheckedDateKey: dateKey,
      lastSummary: '正在盘点增量会话与代码库并整理记忆…',
    })

    const startedMs = Date.now()
    const deadlineMs = startedMs + maxDurationMs
    const workingDir = expandWorkingDir(bot.defaultWorkingDir) || bot.defaultWorkingDir
    const workspaceName =
      typeof this.host.store.resolveBotWorkspaceName === 'function'
        ? this.host.store.resolveBotWorkspaceName(bot)
        : resolveEffectiveWorkspaceName(bot)
    const effectiveModel = cfg.model?.trim() || bot.model
    const effectiveReasoningEffort = cfg.reasoningEffort?.trim() || bot.reasoningEffort

    const mainSessionId = brandString<SessionId>(`session-${randomUUID()}`)
    let createdMainSession = false
    const mutationTracker = this.host.memory?.beginMutationTracker(bot.id)
    const remindersSvc = this.host.getReminders?.()
    const reminderTracker: DreamingReminderBudgetTracker | undefined =
      remindersSvc?.beginDreamingReminderTracker(mainSessionId, {
        botId: bot.id,
        maxPerRun: maxRemindersPerRun,
      })

    const activeDirs =
      prepared.activeWorkingDirs.length > 0 ? prepared.activeWorkingDirs : [workingDir]
    const initialWorktrees = await inspectAllActiveWorktrees(activeDirs)
    const initialWorktreePaths = new Set(initialWorktrees.map((w) => w.worktreePath))

    // Track watermark incrementally so completed batches survive later errors or budget cutoffs.
    const processedIdsSoFar = new Set(prev.processedSessionIds)
    for (const noiseId of prepared.skippedNoiseSessionIds) {
      processedIdsSoFar.add(noiseId)
    }

    const batches = splitPreparedIntoBatches(prepared.selected)
    const activeMemoryBefore = this.host.memory?.countActiveForBot(bot.id) ?? 0
    const runDeepStage =
      Boolean(this.host.memory) &&
      deepConsolidationEnabled &&
      (activeMemoryBefore > 0 || prepared.selected.length > 0)
    const runProactiveStage =
      (bot.experimental.proactive.remindersEnabled && maxRemindersPerRun > 0) ||
      bot.experimental.proactive.autoCodeEnabled
    const useStagedMode = runDeepStage || runProactiveStage

    let batchesCompleted = 0
    let sessionsProcessedCount = 0
    let deepConsolidated = false
    let openLoopsAudited = false
    const stageSummaries: string[] = []
    const stage1NotesSections: string[] = []
    let lastDigestPath = ''

    try {
      const launch = await this.host.runtimes.resolveAgentLaunch({
        agentPreset: bot.agentPreset,
        ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(bot.provider ? { explicitProvider: bot.provider } : {}),
        ...(effectiveModel ? { explicitModel: effectiveModel } : {}),
        ...(effectiveReasoningEffort ? { explicitReasoningEffort: effectiveReasoningEffort } : {}),
        requireNativeModel: true,
      })
      const resolvedModelLabel = launch.model ?? effectiveModel
      const concurrencyKey =
        typeof this.host.runtimes.resolveConcurrencyKey === 'function'
          ? this.host.runtimes.resolveConcurrencyKey(bot.agentPreset, bot.runtimeProfileId)
          : buildRuntimeConcurrencyKey(bot.agentPreset, bot.runtimeProfileId)

      const createDreamAgentHandle = async (sid: SessionId, title: string) => {
        const handle = await this.host.ctx.agents.create({
          sessionId: sid,
          meta: { cwd: workingDir, agentPreset: bot.agentPreset },
          agentOptions: {
            ...(launch.provider ? { provider: launch.provider } : {}),
            ...(launch.model ? { model: launch.model } : {}),
            ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
          },
          setup: async (agentCtx, agent) => {
            await launch.mountPreset(agentCtx, agent)
            appendPluginRecord(agent.session, LARK_ORIGIN_RECORD_TYPE, {
              botId: bot.id,
              botName: bot.name,
              larkAppId: bot.larkAppId,
              chatId: 'dream:internal',
              workspaceName,
              routeKey: `dream:${bot.id}`,
              trigger: 'dreaming',
            })
          },
        })
        const titleSvc = this.host.ctx.get('sessionTitle' as never) as
          | { rename?: (s: Session, t: string) => unknown }
          | undefined
        try {
          titleSvc?.rename?.(handle.agent.session, title)
        } catch {
          // Best-effort session title.
        }
        return handle
      }

      const runControlledTurn = async (agent: Agent, promptText: string): Promise<string> => {
        let lease: ConcurrencyLease | undefined
        try {
          if (this.host.runtimeLimiter) {
            lease = await this.host.runtimeLimiter.acquire({
              runtimeKey: concurrencyKey,
              priority: 'background',
              ...(this.host.shutdownSignal ? { signal: this.host.shutdownSignal } : {}),
              isAborted: () => this.disposed,
            })
            if (!lease) {
              throw new Error('Dreaming 因服务停止或排空已取消')
            }
          }
          return await this.host.runTurn(agent, [{ type: 'text', text: promptText }])
        } finally {
          lease?.release()
        }
      }

      const markBatchConsumed = (batchItems: readonly PreparedDigestItem[]) => {
        for (const item of batchItems) {
          for (const sid of item.foldedSessionIds) {
            processedIdsSoFar.add(sid)
          }
        }
        this.host.store.upsertDreamState({
          ...prev,
          status: 'running',
          lastCheckedDateKey: dateKey,
          ...(createdMainSession ? { lastSessionId: mainSessionId } : {}),
          lastProcessedCount: sessionsProcessedCount,
          lastSummary: `正在执行 Dreaming（已处理 ${sessionsProcessedCount}/${prepared.selected.length} 个会话）…`,
          processedSessionIds: [...processedIdsSoFar],
        })
      }

      const checkBatchWriteIntegrity = (replyText: string, prevMutations: number) => {
        const currentMutations = mutationTracker?.totalMutations() ?? 0
        if (currentMutations === prevMutations) {
          const writeFailure = detectDreamingMemoryWriteFailure(replyText)
          if (writeFailure) {
            throw new Error(`记忆写入未完成：${writeFailure}`)
          }
        }
      }

      // Multi-batch drain: run earlier batches in short-lived isolated sessions to avoid context overflow,
      // keeping the final main Dreaming session clean and auditable in the Sessions view.
      const drainBatchesSeparately = batches.length > 1
      const separateBatchCount = drainBatchesSeparately
        ? useStagedMode
          ? batches.length
          : batches.length - 1
        : 0

      for (let idx = 0; idx < separateBatchCount; idx += 1) {
        if (idx > 0 && Date.now() >= deadlineMs) {
          break
        }
        const batchItems = batches[idx]!
        const batchSid = brandString<SessionId>(`session-${randomUUID()}`)
        reminderTracker?.bindSessionId(batchSid)
        lastDigestPath = this.writeTranscriptDigest(bot.id, dateKey, batchItems)
        const memoryMarkdownPath = this.host.memory?.ensureMarkdownMirror(bot.id, Date.now())
        const activeMemoryCount = this.host.memory?.countActiveForBot(bot.id) ?? 0
        const batchPrompt = composeDreamExecutionPrompt({
          botId: bot.id,
          botName: bot.name,
          workingDir,
          ...(prepared.activeWorkingDirs.length > 0
            ? { activeWorkingDirs: prepared.activeWorkingDirs }
            : {}),
          currentDateIso: dateKey,
          transcriptDigestPath: lastDigestPath,
          ...(memoryMarkdownPath ? { memoryMarkdownPath, activeMemoryCount } : {}),
          sessionCount: batchItems.length,
          config: cfg,
          proactive: bot.experimental.proactive,
          batchIndex: idx + 1,
          totalBatches: batches.length,
          stagedMode: useStagedMode,
        })

        const preMutations = mutationTracker?.totalMutations() ?? 0
        const batchHandle = await createDreamAgentHandle(
          batchSid,
          `Dreaming · 增量整理 ${idx + 1}/${batches.length} (${dateKey})`,
        )
        let batchReply = ''
        try {
          batchReply = await runControlledTurn(batchHandle.agent, batchPrompt)
        } finally {
          await batchHandle.dispose().catch(() => {})
        }
        await this.host.workspaces.archiveSession(batchSid).catch(() => {})

        checkBatchWriteIntegrity(batchReply, preMutations)
        batchesCompleted += 1
        sessionsProcessedCount += batchItems.length
        markBatchConsumed(batchItems)

        const cleanReply = batchReply.replace(/\s+/g, ' ').trim()
        if (cleanReply) {
          stage1NotesSections.push(
            `## 第 ${idx + 1}/${batches.length} 批（${batchItems.length} 个会话）\n\n${batchReply.trim()}\n`,
          )
        }
      }

      // Create the main auditable Dreaming session registered in `dream_sessions`.
      const mainHandle = await createDreamAgentHandle(
        mainSessionId,
        `Dreaming · 记忆整理 (${dateKey})`,
      )
      createdMainSession = true
      await this.host.workspaces.attachSession(workingDir, workspaceName, mainSessionId)

      this.host.store.upsertManagedSession?.({
        sessionId: mainSessionId,
        botId: bot.id,
        chatId: 'dream:internal',
        routeKey: `dream:${bot.id}`,
        trigger: 'dreaming',
        createdAtMs: startedMs,
        lastActivityMs: startedMs,
      })
      this.host.store.upsertDreamSession?.({
        sessionId: mainSessionId,
        botId: bot.id,
        botName: bot.name,
        workspaceName,
        workingDir,
        agentPreset: bot.agentPreset,
        ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(resolvedModelLabel ? { model: resolvedModelLabel } : {}),
        status: 'running',
        dateKey,
        processedCount: prepared.selected.length,
        summary: '正在盘点增量会话与代码库并整理记忆…',
        createdAtMs: startedMs,
        lastActivityMs: startedMs,
      })
      this.host.store.upsertDreamState({
        ...prev,
        status: 'running',
        lastCheckedDateKey: dateKey,
        lastSessionId: mainSessionId,
        lastProcessedCount: sessionsProcessedCount,
        lastSummary: '正在盘点增量会话与代码库并整理记忆…',
        processedSessionIds: [...processedIdsSoFar],
      })

      try {
        // Stage 1 inside the main session when 0 batches (manual audit) or 1 remaining batch.
        const runStage1InMain = batches.length === 0 || separateBatchCount < batches.length
        if (runStage1InMain) {
          const mainBatch =
            batches.length === 0 ? [] : batches[batches.length - 1]!
          lastDigestPath = this.writeTranscriptDigest(bot.id, dateKey, mainBatch)
          const memoryMarkdownPath = this.host.memory?.ensureMarkdownMirror(bot.id, Date.now())
          const activeMemoryCount = this.host.memory?.countActiveForBot(bot.id) ?? 0
          const stage1Prompt = composeDreamExecutionPrompt({
            botId: bot.id,
            botName: bot.name,
            workingDir,
            ...(prepared.activeWorkingDirs.length > 0
              ? { activeWorkingDirs: prepared.activeWorkingDirs }
              : {}),
            currentDateIso: dateKey,
            transcriptDigestPath: lastDigestPath,
            ...(memoryMarkdownPath ? { memoryMarkdownPath, activeMemoryCount } : {}),
            sessionCount: mainBatch.length,
            config: cfg,
            proactive: bot.experimental.proactive,
            ...(batches.length > 1
              ? { batchIndex: batches.length, totalBatches: batches.length }
              : {}),
            stagedMode: useStagedMode,
          })

          const preMutations = mutationTracker?.totalMutations() ?? 0
          const stage1Reply = await runControlledTurn(mainHandle.agent, stage1Prompt)
          checkBatchWriteIntegrity(stage1Reply, preMutations)

          batchesCompleted += 1
          sessionsProcessedCount += mainBatch.length
          if (mainBatch.length > 0) {
            markBatchConsumed(mainBatch)
          }
          const trimmed = stage1Reply.trim()
          if (trimmed) {
            stageSummaries.push(trimmed)
            stage1NotesSections.push(
              `## 增量阶段（${mainBatch.length} 个会话）\n\n${trimmed}\n`,
            )
          }
        }

        const stage1NotesPath =
          stage1NotesSections.length > 0
            ? this.writeStage1Notes(bot.id, dateKey, stage1NotesSections)
            : undefined

        // Stage 2: Deep Sleep (full-library codebase verification, cold-memory curation & SOP synthesis).
        if (runDeepStage && Date.now() < deadlineMs) {
          const refreshedNowMs = Date.now()
          const memoryMarkdownPath = this.host.memory?.ensureMarkdownMirror(bot.id, refreshedNowMs)
          const allActive =
            this.host.memory?.list({ botId: bot.id, status: 'active', limit: 200 }) ?? []
          if (allActive.length > 0) {
            const auditPath = this.writeMemoryAudit(bot, allActive, refreshedNowMs)
            const deepPrompt = composeDreamDeepConsolidationPrompt({
              botId: bot.id,
              botName: bot.name,
              workingDir,
              ...(prepared.activeWorkingDirs.length > 0
                ? { activeWorkingDirs: prepared.activeWorkingDirs }
                : {}),
              currentDateIso: dateKey,
              ...(memoryMarkdownPath ? { memoryMarkdownPath } : {}),
              memoryAuditPath: auditPath,
              ...(stage1NotesPath ? { stage1NotesPath } : {}),
              activeMemoryCount: allActive.length,
              config: cfg,
            })
            const deepReply = await runControlledTurn(mainHandle.agent, deepPrompt)
            deepConsolidated = true
            const trimmed = deepReply.trim()
            if (trimmed) stageSummaries.push(trimmed)
          }
        }

        // Stage 3 & 4: Prospective Sleep (open-loop audit, daytime reminders & optional isolated fixes).
        if (runProactiveStage && Date.now() < deadlineMs) {
          const snapshotPath = await this.writeOpenLoopsSnapshot({
            bot,
            dateKey,
            nowMs: Date.now(),
            activeDirs,
            preparedItems: prepared.selected,
          })
          const nextMorningIso = computeNextWorkdayMorning(
            now,
            bot.experimental.proactive.quietHoursEnd,
            bot.experimental.proactive.skipWeekends,
          )
          const proactivePrompt = composeDreamProactivePrompt({
            botId: bot.id,
            botName: bot.name,
            workingDir,
            ...(prepared.activeWorkingDirs.length > 0
              ? { activeWorkingDirs: prepared.activeWorkingDirs }
              : {}),
            currentDateIso: dateKey,
            nextWorkdayMorningIso: nextMorningIso,
            openLoopsSnapshotPath: snapshotPath,
            ...(stage1NotesPath ? { stage1NotesPath } : {}),
            ...(lastDigestPath ? { transcriptDigestPath: lastDigestPath } : {}),
            config: cfg,
            proactive: bot.experimental.proactive,
          })
          const proactiveReply = await runControlledTurn(mainHandle.agent, proactivePrompt)
          openLoopsAudited = true
          const trimmed = proactiveReply.trim()
          if (trimmed) stageSummaries.push(trimmed)
        }
      } finally {
        await mainHandle.dispose().catch(() => {})
      }

      await this.host.workspaces.archiveSession(mainSessionId)
      this.host.store.markSessionArchived?.(mainSessionId)

      const finalWorktrees = await inspectAllActiveWorktrees(activeDirs)
      const worktreesCreated = finalWorktrees.filter(
        (w) => !initialWorktreePaths.has(w.worktreePath),
      ).length

      const finishedMs = Date.now()
      const durationMs = finishedMs - startedMs
      const memoryStats = mutationTracker?.snapshot()
      const totalMutations = mutationTracker?.totalMutations() ?? 0
      const createdReminders = reminderTracker?.createdItems() ?? []
      const remindersCreated = createdReminders.length

      // Unconsumed sessions from either `maxSessionsPerRun` cap or wall-clock budget cutoff.
      const unconsumedSelectedCount = Math.max(0, prepared.selected.length - sessionsProcessedCount)
      const totalBacklogRemaining = prepared.backlogRemaining + unconsumedSelectedCount

      const proactiveStats: LarkDreamProactiveStats = {
        batchesRun: Math.max(1, batchesCompleted),
        backlogRemaining: totalBacklogRemaining,
        remindersCreated,
        worktreesCreated,
        deepConsolidated,
        openLoopsAudited,
      }

      const uniqueSummaries = Array.from(
        new Set(stageSummaries.map((s) => stripMarkdownForSummary(s)).filter(Boolean)),
      )
      const combinedReply = uniqueSummaries.join(' ')
      const cleanNote =
        combinedReply.length > MAX_DREAM_NOTE_CHARS
          ? `${combinedReply.slice(0, MAX_DREAM_NOTE_CHARS).trimEnd()}…`
          : combinedReply

      const hasAnyOutput = totalMutations > 0 || remindersCreated > 0 || worktreesCreated > 0
      const outcome: 'memory_updated' | 'no_change' = hasAnyOutput ? 'memory_updated' : 'no_change'
      const memBadge = formatMemoryStatsBadge(memoryStats)
      const proactiveBadge = formatProactiveStatsBadge(proactiveStats)
      const badgeParts = [memBadge, proactiveBadge].filter(Boolean)
      const descriptor = badgeParts.length > 0 ? badgeParts.join(' · ') : memoryStats ? '无新增变更' : ''
      const batchNote = proactiveStats.batchesRun > 1 ? `（${proactiveStats.batchesRun} 批）` : ''
      const headerLabel = descriptor
        ? `已整理 ${sessionsProcessedCount} 个会话${batchNote}（${descriptor}）`
        : `已整理 ${sessionsProcessedCount} 个会话${batchNote}`
      const summaryNote = cleanNote ? `${headerLabel} · ${cleanNote}` : headerLabel

      this.appendDreamJournal({
        bot,
        dateKey,
        finishedMs,
        durationMs,
        sessionsProcessed: sessionsProcessedCount,
        memoryStats,
        proactiveStats,
        createdReminders: createdReminders.map((r) => ({
          id: r.id,
          title: r.title,
          scheduledAt: r.scheduledAt,
        })),
        stageSummaries,
      })

      this.host.store.upsertDreamSession?.({
        sessionId: mainSessionId,
        botId: bot.id,
        botName: bot.name,
        workspaceName,
        workingDir,
        agentPreset: bot.agentPreset,
        ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(resolvedModelLabel ? { model: resolvedModelLabel } : {}),
        status: 'succeeded',
        outcome,
        ...(memoryStats ? { memoryStats } : {}),
        proactiveStats,
        dateKey,
        processedCount: sessionsProcessedCount,
        ...(cleanNote ? { summary: cleanNote } : {}),
        createdAtMs: startedMs,
        lastActivityMs: finishedMs,
        durationMs,
      })

      const updated = this.host.store.upsertDreamState({
        botId,
        status: 'succeeded',
        lastDreamAtMs: now.getTime(),
        lastCheckedDateKey: dateKey,
        lastSessionId: mainSessionId,
        lastProcessedCount: sessionsProcessedCount,
        lastSummary: summaryNote,
        processedSessionIds: [...processedIdsSoFar],
        proactiveStats,
        backlogRemaining: totalBacklogRemaining,
      })

      this.host.store.recordUsageEvent?.({
        id: `dream:${mainSessionId}`,
        timestampMs: startedMs,
        recordKind: 'proactive',
        botId,
        chatId: 'dream:internal',
        chatType: 'internal',
        sessionId: mainSessionId,
        trigger: 'dreaming',
        agentPreset: bot.agentPreset,
        ...(resolvedModelLabel ? { model: resolvedModelLabel } : {}),
        outcome: 'completed',
        latencyMs: durationMs,
      })

      this.host.store.recordEvent({
        botId,
        sessionId: mainSessionId,
        durationMs,
        kind: 'lifecycle',
        summary: `Dreaming 完成：${headerLabel}`,
      })
      return updated
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const finishedMs = Date.now()
      const memoryStats = mutationTracker?.snapshot()
      const remindersCreated = reminderTracker?.createdCount() ?? 0
      const proactiveStats: LarkDreamProactiveStats = {
        batchesRun: batchesCompleted,
        backlogRemaining:
          prepared.backlogRemaining + Math.max(0, prepared.selected.length - sessionsProcessedCount),
        remindersCreated,
        worktreesCreated: 0,
        deepConsolidated,
        openLoopsAudited,
      }

      this.host.ctx.logger.error(`[lark-bridge] dreaming failed for "${bot.name}": ${msg}`)
      if (createdMainSession) {
        await this.host.workspaces.archiveSession(mainSessionId).catch(() => {})
        this.host.store.markSessionArchived?.(mainSessionId)
        this.host.store.upsertDreamSession?.({
          sessionId: mainSessionId,
          botId: bot.id,
          botName: bot.name,
          workspaceName,
          workingDir,
          agentPreset: bot.agentPreset,
          ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
          status: 'failed',
          outcome: 'failed',
          ...(memoryStats ? { memoryStats } : {}),
          proactiveStats,
          dateKey,
          processedCount: sessionsProcessedCount,
          summary: msg,
          createdAtMs: startedMs,
          lastActivityMs: finishedMs,
          durationMs: finishedMs - startedMs,
        })
      }

      // Preserve any already-completed earlier batch watermarks; never advance the failing batch.
      const failedProcessedIds =
        batchesCompleted > 0 ? [...processedIdsSoFar] : prev.processedSessionIds
      const failed = this.host.store.upsertDreamState({
        ...prev,
        status: 'failed',
        lastCheckedDateKey: dateKey,
        ...(createdMainSession ? { lastSessionId: mainSessionId } : {}),
        lastSummary: `整理失败：${msg}`,
        processedSessionIds: failedProcessedIds,
        proactiveStats,
        backlogRemaining: proactiveStats.backlogRemaining,
      })
      this.host.store.recordUsageEvent?.({
        id: `dream:${createdMainSession ? mainSessionId : `${botId}:${startedMs}`}`,
        timestampMs: startedMs,
        recordKind: 'proactive',
        botId,
        chatId: 'dream:internal',
        chatType: 'internal',
        ...(createdMainSession ? { sessionId: mainSessionId } : {}),
        trigger: 'dreaming',
        agentPreset: bot.agentPreset,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        outcome: 'error',
        errorCode: 'dream_error',
        latencyMs: finishedMs - startedMs,
      })
      this.host.store.recordEvent({
        botId,
        ...(createdMainSession ? { sessionId: mainSessionId } : {}),
        kind: 'error',
        summary: `Dreaming 失败：${msg}`,
      })
      return failed
    } finally {
      mutationTracker?.dispose()
      reminderTracker?.dispose()
      this.runningBots.delete(botId)
      this.host.onActivityChange?.()
    }
  }

  private collectNewSessions(
    botId: string,
    processedSet: ReadonlySet<string>,
  ): LarkManagedSession[] {
    return this.host.store
      .listManagedSessionsForBot(botId)
      .filter(
        (ms) =>
          !processedSet.has(ms.sessionId) &&
          ms.trigger !== 'dreaming' &&
          ms.trigger !== 'reminder' &&
          ms.chatId !== 'dream:internal',
      )
      .sort((a, b) => {
        const tierDiff = triggerPriorityTier(a.trigger) - triggerPriorityTier(b.trigger)
        if (tierDiff !== 0) return tierDiff
        return a.lastActivityMs - b.lastActivityMs
      })
  }

  private async prepareTranscriptBatch(
    bot: LarkBotConfig,
    candidates: readonly LarkManagedSession[],
    maxSessionsPerRun: number,
    maxCharsPerSession: number,
  ): Promise<PreparedDreamBatch> {
    const persistence = this.host.ctx.get('sessionPersistence') as SessionPersistence | undefined
    const liveSessionsSvc = this.host.ctx.sessions as unknown as
      | { get?: (id: SessionId) => Session | undefined }
      | undefined

    const selected: PreparedDigestItem[] = []
    const consumedSessionIds: string[] = []
    const skippedNoiseSessionIds: string[] = []
    const activeWorkingDirSet = new Set<string>()
    const listenerFingerprintIndex = new Map<string, number>()

    const limit = maxSessionsPerRun > 0 ? maxSessionsPerRun : Number.POSITIVE_INFINITY
    let scannedIndex = 0

    for (; scannedIndex < candidates.length && selected.length < limit; scannedIndex += 1) {
      const ms = candidates[scannedIndex]!
      const { events, cwd } = await this.readSessionEvents(ms.sessionId, liveSessionsSvc, persistence)
      const digest = summarizeSessionEvents(events, maxCharsPerSession)

      if (!digest.markdown || (ms.trigger === 'listener' && !digest.hasSubstantiveAgentReply)) {
        skippedNoiseSessionIds.push(ms.sessionId)
        continue
      }

      const group = ms.chatId ? this.host.store.getGroup(bot.id, ms.chatId) : undefined
      const effectiveDir =
        (cwd ? expandWorkingDir(cwd) || cwd : '') ||
        resolveEffectiveWorkingDir(bot, group)
      if (effectiveDir) activeWorkingDirSet.add(effectiveDir)

      consumedSessionIds.push(ms.sessionId)

      if (ms.trigger === 'listener' && digest.fingerprint) {
        const dedupKey = `${ms.chatId}::${digest.fingerprint}`
        const existingIdx = listenerFingerprintIndex.get(dedupKey)
        if (existingIdx !== undefined) {
          const prevItem = selected[existingIdx]!
          selected[existingIdx] = {
            session: ms,
            digest,
            ...(effectiveDir ? { workingDir: effectiveDir } : {}),
            duplicateCount: prevItem.duplicateCount + 1,
            foldedSessionIds: [...prevItem.foldedSessionIds, ms.sessionId],
          }
          continue
        }
        listenerFingerprintIndex.set(dedupKey, selected.length)
      }

      selected.push({
        session: ms,
        digest,
        ...(effectiveDir ? { workingDir: effectiveDir } : {}),
        duplicateCount: 1,
        foldedSessionIds: [ms.sessionId],
      })
    }

    const backlogRemaining = Math.max(0, candidates.length - scannedIndex)

    return {
      selected,
      consumedSessionIds,
      skippedNoiseSessionIds,
      backlogRemaining,
      activeWorkingDirs: [...activeWorkingDirSet],
    }
  }

  private writeTranscriptDigest(
    botId: string,
    dateKey: string,
    items: readonly PreparedDigestItem[],
  ): string {
    const dreamDir = join(this.host.dataDir, 'dreaming', botId)
    mkdirSync(dreamDir, { recursive: true, mode: 0o700 })
    const digestPath = join(dreamDir, 'recent-transcripts.md')

    if (items.length === 0) {
      atomicWritePrivate(
        digestPath,
        `# Dreaming Transcript Digest (${dateKey})\n\n（本次为手动触发，暂无未处理的新增会话记录；请结合当前代码库核查并清理长期记忆中的过期内容。）\n`,
      )
      return digestPath
    }

    const sections: string[] = [`# Dreaming Transcript Digest (${dateKey})\n`]
    for (const item of items) {
      const ms = item.session
      const chatLabel = this.host.store.resolveChatName(ms.botId, ms.chatId) || ms.chatId
      const dateStr = formatLocalDateTime(new Date(ms.lastActivityMs))
      const dupSuffix =
        item.duplicateCount > 1 ? ` · 同主题重复 ${item.duplicateCount} 次已折叠` : ''
      const threadSuffix = item.digest.rootMessageId
        ? ` · thread_reply_to=${item.digest.rootMessageId}`
        : ''
      const stateSuffix = item.digest.wasInterrupted ? ' · 状态:曾中断' : ''
      const participantsLine =
        item.digest.participants.length > 0
          ? `参与成员：${item.digest.participants.map((p) => `${p.name}(open_id="${p.openId}")`).join('、')}\n\n`
          : ''
      sections.push(
        `## Session ${ms.sessionId} · chat_id=${ms.chatId} (${chatLabel})${threadSuffix} · ${dateStr}${stateSuffix}${dupSuffix}\n\n${participantsLine}${item.digest.markdown}\n`,
      )
    }

    atomicWritePrivate(digestPath, sections.join('\n'))
    return digestPath
  }

  private writeStage1Notes(botId: string, dateKey: string, sections: readonly string[]): string {
    const notesPath = join(this.host.dataDir, 'dreaming', botId, 'stage1-notes.md')
    const content = [
      `# Dreaming Stage 1 Notes (${dateKey})`,
      '',
      ...sections,
    ].join('\n')
    atomicWritePrivate(notesPath, content)
    return notesPath
  }

  private writeMemoryAudit(
    bot: LarkBotConfig,
    entries: ReturnType<MemoryService['list']>,
    nowMs: number,
  ): string {
    const auditPath = join(this.host.dataDir, 'dreaming', bot.id, 'memory-audit.md')
    const report = renderMemoryAuditReport({
      botId: bot.id,
      botName: bot.name,
      entries,
      nowMs,
    })
    atomicWritePrivate(auditPath, report)
    return auditPath
  }

  private async writeOpenLoopsSnapshot(input: {
    readonly bot: LarkBotConfig
    readonly dateKey: string
    readonly nowMs: number
    readonly activeDirs: readonly string[]
    readonly preparedItems: readonly PreparedDigestItem[]
  }): Promise<string> {
    const { bot, dateKey, nowMs, activeDirs, preparedItems } = input
    const snapshotPath = join(this.host.dataDir, 'dreaming', bot.id, 'open-loops-snapshot.md')
    const cutoffMs = nowMs - RECENT_LOOP_WINDOW_MS

    const allReminders = this.host.store.listReminders?.('all') ?? []
    const botReminders = allReminders.filter((r) => r.origin.botId === bot.id)
    const activeReminders = botReminders.filter(
      (r) => r.status === 'scheduled' || r.status === 'pending_confirm' || r.status === 'running',
    )
    const recentErrorOrReminded = botReminders
      .filter(
        (r) =>
          r.status === 'archived' &&
          (r.archivedAtMs ?? r.updatedAtMs) >= cutoffMs &&
          (r.resolution === 'error' || r.resolution === 'reminded'),
      )
      .slice(0, 12)

    const worktrees = await inspectAllActiveWorktrees(activeDirs)
    const interruptedItems = preparedItems.filter((item) => item.digest.wasInterrupted)
    const recentErrorEvents = (this.host.store.listEvents?.() ?? [])
      .filter((e) => e.botId === bot.id && e.kind === 'error' && e.timestampMs >= cutoffMs)
      .slice(0, 10)

    const lines: string[] = [
      `# Open Loops & Live Workspace Snapshot (${dateKey})`,
      '',
      `- 智能体：${bot.name} (\`${bot.id}\`)`,
      `- 快照生成时间：${formatLocalDateTime(new Date(nowMs))}`,
      '',
      '## 1. 当前已有活跃提醒（创建前务必去重，勿重复建单）',
    ]

    if (activeReminders.length === 0) {
      lines.push('- 当前无活跃提醒。')
    } else {
      for (const r of activeReminders.slice(0, 25)) {
        const target =
          r.origin.chatType === 'p2p'
            ? `私聊:${r.origin.userName || r.origin.userOpenId || ''}`
            : `群:${r.origin.chatName || r.origin.chatId || ''}`
        const owners = r.mentions.map((m) => `${m.name || m.openId}(${m.openId})`).join('、')
        const threadNote = r.origin.replyToMessageId ? ` · reply_to=${r.origin.replyToMessageId}` : ''
        const wtNote = r.worktree ? ` · branch=${r.worktree.branch}` : ''
        lines.push(
          `- \`${r.id}\` [${r.status}] **${r.title}** · 触发 ${formatLocalDateTime(new Date(r.scheduledAt))} · ${target}${threadNote}${owners ? ` · 负责人 ${owners}` : ''}${wtNote}`,
        )
      }
    }

    lines.push('', '## 2. 近 48h 异常或已触发提醒（检查是否遗留未闭环）')
    if (recentErrorOrReminded.length === 0) {
      lines.push('- 近期无异常或需复查提醒。')
    } else {
      for (const r of recentErrorOrReminded) {
        lines.push(
          `- \`${r.id}\` [${r.resolution}] **${r.title}** · ${r.origin.chatName || r.origin.chatId || r.origin.userName || ''} · 结果：${(r.resultSummary || '无摘要').slice(0, 120)}`,
        )
      }
    }

    lines.push('', '## 3. 活跃工作区未清理 `.worktrees/` 分支')
    if (worktrees.length === 0) {
      lines.push('- 当前活跃仓库下无残留 `.worktrees/` 分支。')
    } else {
      for (const wt of worktrees.slice(0, 15)) {
        const dirtyNote = wt.dirtyFiles > 0 ? `（含 ${wt.dirtyFiles} 处未提交改动）` : '（工作区干净）'
        lines.push(`- 分支 \`${wt.branch}\` · 路径 \`${wt.worktreePath}\` ${dirtyNote}`)
      }
    }

    lines.push('', '## 4. 近期中断会话与异常事件')
    if (interruptedItems.length === 0 && recentErrorEvents.length === 0) {
      lines.push('- 无近期中断会话或报错记录。')
    } else {
      for (const item of interruptedItems.slice(0, 10)) {
        const ms = item.session
        const chatLabel = this.host.store.resolveChatName(ms.botId, ms.chatId) || ms.chatId
        const owners = item.digest.participants.map((p) => `${p.name}(${p.openId})`).join('、')
        lines.push(
          `- [曾中断会话] \`${ms.sessionId}\` · chat_id=${ms.chatId} (${chatLabel})${item.digest.rootMessageId ? ` · thread_reply_to=${item.digest.rootMessageId}` : ''}${owners ? ` · 成员 ${owners}` : ''}`,
        )
      }
      for (const ev of recentErrorEvents) {
        lines.push(
          `- [异常日志 ${formatLocalDateTime(new Date(ev.timestampMs))}] ${ev.chatName || ev.chatId || ''} · ${ev.summary.slice(0, 140)}`,
        )
      }
    }

    lines.push('')
    atomicWritePrivate(snapshotPath, lines.join('\n'))
    return snapshotPath
  }

  private appendDreamJournal(input: {
    readonly bot: LarkBotConfig
    readonly dateKey: string
    readonly finishedMs: number
    readonly durationMs: number
    readonly sessionsProcessed: number
    readonly memoryStats?: LarkMemoryMutationStats
    readonly proactiveStats: LarkDreamProactiveStats
    readonly createdReminders: ReadonlyArray<{
      readonly id: string
      readonly title: string
      readonly scheduledAt: string
    }>
    readonly stageSummaries: readonly string[]
  }): void {
    try {
      const journalPath = join(this.host.dataDir, 'dreaming', input.bot.id, 'DREAMS.md')
      const header = `# Dreaming Journal — ${input.bot.name} (${input.bot.id})\n\n> Auto-Dream 离线整理复盘日志（按时间倒序保留最近 ${MAX_JOURNAL_ENTRIES} 次）。\n`
      const memBadge = formatMemoryStatsBadge(input.memoryStats) || '无记忆变更'
      const durationSec = Math.max(1, Math.round(input.durationMs / 1000))
      const entryLines: string[] = [
        `## ${input.dateKey} · ${formatLocalDateTime(new Date(input.finishedMs))}`,
        '',
        `- 覆盖：整理 ${input.sessionsProcessed} 个会话（${input.proactiveStats.batchesRun} 批，剩余积压 ${input.proactiveStats.backlogRemaining}）· 耗时 ${durationSec}s`,
        `- 产出：记忆（${memBadge}）· 深度验真 ${input.proactiveStats.deepConsolidated ? '是' : '否'} · 前瞻盘点 ${input.proactiveStats.openLoopsAudited ? '是' : '否'} · 新建提醒 ${input.proactiveStats.remindersCreated} 条 · 新建隔离分支 ${input.proactiveStats.worktreesCreated} 个`,
      ]
      if (input.createdReminders.length > 0) {
        entryLines.push('- 新建提醒：')
        for (const r of input.createdReminders) {
          entryLines.push(
            `  - \`${r.id}\` **${r.title}**（触发 ${formatLocalDateTime(new Date(r.scheduledAt))}）`,
          )
        }
      }
      if (input.stageSummaries.length > 0) {
        entryLines.push(
          '- 摘要：',
          ...input.stageSummaries.map((s) => `  > ${s.replace(/\s+/g, ' ').trim().slice(0, 320)}`),
        )
      }
      const newSection = entryLines.join('\n')

      let existingSections: string[] = []
      if (existsSync(journalPath)) {
        const raw = readFileSync(journalPath, 'utf8')
        const idx = raw.indexOf('\n## ')
        if (idx >= 0) {
          existingSections = raw
            .slice(idx + 1)
            .split(/\n(?=## )/)
            .map((s) => s.trim())
            .filter(Boolean)
        }
      }
      const combined = [newSection, ...existingSections].slice(0, MAX_JOURNAL_ENTRIES)
      atomicWritePrivate(journalPath, `${header}\n${combined.join('\n\n')}\n`)
    } catch {
      // Journal output is best-effort and must never fail a completed Dreaming run.
    }
  }

  private async readSessionEvents(
    sessionId: string,
    liveSessionsSvc: { get?: (id: SessionId) => Session | undefined } | undefined,
    persistence: SessionPersistence | undefined,
  ): Promise<{ readonly events: readonly SessionEvent[]; readonly cwd?: string }> {
    const sid = brandString<SessionId>(sessionId)
    const live = liveSessionsSvc?.get?.(sid)
    if (live && typeof live.snapshotEvents === 'function') {
      const snap = live.snapshotEvents()
      const liveCwd = (live as { header?: { cwd?: string } }).header?.cwd
      if (snap.length > 0) {
        return {
          events: snap.slice(-MAX_EVENTS_PER_SESSION),
          ...(liveCwd ? { cwd: liveCwd } : {}),
        }
      }
    }
    if (!persistence) return { events: [] }
    try {
      const handle = await persistence.open(sid, 'read')
      try {
        const allEvents: SessionEvent[] = []
        let offset = 0
        while (allEvents.length < MAX_EVENTS_PER_SESSION) {
          const remaining = MAX_EVENTS_PER_SESSION - allEvents.length
          const pageSize = Math.min(READ_EVENTS_PAGE_SIZE, remaining)
          const res = await handle.read(offset, pageSize)
          if (!res.events || res.events.length === 0) break
          allEvents.push(...res.events)
          offset += res.events.length
          if (res.events.length < pageSize) break
        }
        const persistedCwd = handle.header?.cwd
        return {
          events: allEvents,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
        }
      } finally {
        await handle.close().catch(() => {})
      }
    } catch {
      return { events: [] }
    }
  }
}
