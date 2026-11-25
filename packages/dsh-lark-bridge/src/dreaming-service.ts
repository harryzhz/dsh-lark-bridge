import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  composeDreamExecutionPrompt,
  detectDreamingMemoryWriteFailure,
  expandWorkingDir,
  extractPureUserIntent,
  normalizeReplyText,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  type LarkMemoryMutationStats,
} from '@dsh-lark/lark-core'
import type { MemoryService } from './memory-service.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { LarkBridgeStore } from './store.js'
import {
  LARK_ORIGIN_RECORD_TYPE,
  type LarkDreamRunState,
  type LarkManagedSession,
} from './types.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

const TICK_INTERVAL_MS = 60_000
const MAX_SESSIONS_PER_DREAM = 20
const MAX_SCAN_CANDIDATES_PER_DREAM = 120
const READ_EVENTS_PAGE_SIZE = 200
const MAX_EVENTS_PER_SESSION = 2000
const MAX_TRANSCRIPT_CHARS_PER_SESSION = 2800
const MAX_DREAM_NOTE_CHARS = 160

export interface DreamingHost {
  readonly ctx: Context
  readonly dataDir: string
  readonly store: LarkBridgeStore
  readonly memory?: MemoryService
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  readonly onActivityChange?: () => void
  runTurn(agent: Agent, content: ContentBlock[]): Promise<string>
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

function formatDateKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseMinutesOfDay(hhmm: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  if (!match) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

interface SessionDigestEntry {
  readonly markdown: string
  readonly hasSubstantiveAgentReply: boolean
  readonly fingerprint: string
}

interface PreparedDigestItem {
  readonly session: LarkManagedSession
  readonly digest: SessionDigestEntry
  readonly workingDir?: string
  readonly duplicateCount: number
}

interface PreparedDreamBatch {
  readonly selected: readonly PreparedDigestItem[]
  readonly consumedSessionIds: readonly string[]
  readonly skippedNoiseSessionIds: readonly string[]
  readonly activeWorkingDirs: readonly string[]
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

function summarizeSessionEvents(events: readonly SessionEvent[]): SessionDigestEntry {
  const lines: string[] = []
  let firstUserText = ''
  let substantiveAgentCount = 0
  let currentTurnUsedSilenceCli = false
  let currentTurnAgentLines: string[] = []

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
      const clean = extractPureUserIntent(raw)
      if (clean && clean !== '[空消息]') {
        if (!firstUserText) firstUserText = clean
        lines.push(`- **User**: ${clean.slice(0, 500)}`)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      const msgData = ev.data as {
        interrupted?: boolean
        message?: { content?: ReadonlyArray<{ type?: string; text?: string }> }
      }
      if (msgData.interrupted) continue
      const content = msgData.message?.content ?? []
      if (content.some((b) => b.type === 'tool-call')) continue
      const rawText = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!.trim())
        .filter(Boolean)
        .join('\n')
      const cleanAgentText = normalizeReplyText(rawText, { allowSilentSentinel: true })
      if (cleanAgentText) {
        currentTurnAgentLines.push(`- **Agent**: ${cleanAgentText.slice(0, 700)}`)
      }
    }
  }
  flushTurn()
  const joined = lines.join('\n')
  const markdown =
    joined.length > MAX_TRANSCRIPT_CHARS_PER_SESSION
      ? `${joined.slice(0, MAX_TRANSCRIPT_CHARS_PER_SESSION)}\n  …`
      : joined
  return {
    markdown,
    hasSubstantiveAgentReply: substantiveAgentCount > 0,
    fingerprint: firstUserText ? normalizeFingerprint(firstUserText) : '',
  }
}

/**
 * Orchestrates offline Dreaming memory consolidation using a dual-gate trigger
 * (scheduled window + minimum new sessions). Writes transcript digests strictly
 * under `<dataDir>/dreaming/<botId>/` (`~/.dsh/lark-bridge/dreaming/<botId>/`)
 * and instructs the Agent to update its own native Memory mechanism.
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
    const prev = this.host.store.getDreamState(botId) ?? {
      botId,
      status: 'idle' as const,
      processedSessionIds: [],
    }
    const processedSet = new Set(prev.processedSessionIds)

    const candidateSessions = this.collectNewSessions(botId, processedSet)
    const prepared = await this.prepareTranscriptBatch(bot, candidateSessions)
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
    const workingDir = expandWorkingDir(bot.defaultWorkingDir) || bot.defaultWorkingDir
    const workspaceName =
      typeof this.host.store.resolveBotWorkspaceName === 'function'
        ? this.host.store.resolveBotWorkspaceName(bot)
        : resolveEffectiveWorkspaceName(bot)
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    let createdSession = false
    const mutationTracker = this.host.memory?.beginMutationTracker(bot.id)

    try {
      const digestPath = this.writeTranscriptDigest(bot.id, dateKey, prepared.selected)
      const memoryMarkdownPath = this.host.memory?.ensureMarkdownMirror(bot.id, now.getTime())
      const activeMemoryCount = this.host.memory?.countActiveForBot(bot.id) ?? 0
      const prompt = composeDreamExecutionPrompt({
        botId: bot.id,
        botName: bot.name,
        workingDir,
        ...(prepared.activeWorkingDirs.length > 0
          ? { activeWorkingDirs: prepared.activeWorkingDirs }
          : {}),
        currentDateIso: dateKey,
        transcriptDigestPath: digestPath,
        ...(memoryMarkdownPath ? { memoryMarkdownPath, activeMemoryCount } : {}),
        sessionCount: prepared.selected.length,
        config: cfg,
        proactive: bot.experimental.proactive,
      })

      const launch = await this.host.runtimes.resolveAgentLaunch({
        agentPreset: bot.agentPreset,
        ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(bot.provider ? { explicitProvider: bot.provider } : {}),
        ...(bot.model ? { explicitModel: bot.model } : {}),
        ...(bot.reasoningEffort ? { explicitReasoningEffort: bot.reasoningEffort } : {}),
        requireNativeModel: true,
      })
      const handle = await this.host.ctx.agents.create({
        sessionId,
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
      createdSession = true

      const titleSvc = this.host.ctx.get('sessionTitle' as never) as
        | { rename?: (s: Session, t: string) => unknown }
        | undefined
      try {
        titleSvc?.rename?.(handle.agent.session, `Dreaming · 记忆整理 (${dateKey})`)
      } catch {
        // Best-effort session title.
      }
      await this.host.workspaces.attachSession(workingDir, workspaceName, sessionId)

      this.host.store.upsertManagedSession?.({
        sessionId,
        botId: bot.id,
        chatId: 'dream:internal',
        routeKey: `dream:${bot.id}`,
        trigger: 'dreaming',
        createdAtMs: startedMs,
        lastActivityMs: startedMs,
      })
      this.host.store.upsertDreamSession?.({
        sessionId,
        botId: bot.id,
        botName: bot.name,
        workspaceName,
        workingDir,
        agentPreset: bot.agentPreset,
        ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(launch.model ?? bot.model ? { model: launch.model ?? bot.model } : {}),
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
        lastSessionId: sessionId,
        lastSummary: '正在盘点增量会话与代码库并整理记忆…',
      })

      let replyText = ''
      try {
        replyText = await this.host.runTurn(handle.agent, [{ type: 'text', text: prompt }])
      } finally {
        await handle.dispose().catch(() => {})
      }

      await this.host.workspaces.archiveSession(sessionId)
      this.host.store.markSessionArchived?.(sessionId)

      const finishedMs = Date.now()
      const durationMs = finishedMs - startedMs
      const memoryStats = mutationTracker?.snapshot()
      const totalMutations = mutationTracker?.totalMutations() ?? 0
      const normalizedReply = replyText.replace(/\s+/g, ' ').trim()

      if (totalMutations === 0) {
        const writeFailure = detectDreamingMemoryWriteFailure(normalizedReply)
        if (writeFailure) {
          throw new Error(`记忆写入未完成：${writeFailure}`)
        }
      }

      const newlyProcessed = [
        ...prepared.consumedSessionIds,
        ...prepared.skippedNoiseSessionIds,
      ].filter((id) => !processedSet.has(id))
      const nextProcessed = [...prev.processedSessionIds, ...newlyProcessed]
      const cleanNote =
        normalizedReply.length > MAX_DREAM_NOTE_CHARS
          ? `${normalizedReply.slice(0, MAX_DREAM_NOTE_CHARS).trimEnd()}…`
          : normalizedReply
      const outcome: 'memory_updated' | 'no_change' =
        totalMutations > 0 ? 'memory_updated' : 'no_change'
      const statsBadge = formatMemoryStatsBadge(memoryStats)
      const mutationDescriptor = statsBadge || (memoryStats ? '无新增记忆' : '')
      const headerLabel = mutationDescriptor
        ? `已整理 ${prepared.selected.length} 个会话（${mutationDescriptor}）`
        : `已整理 ${prepared.selected.length} 个会话`
      const summaryNote = cleanNote ? `${headerLabel} · ${cleanNote}` : headerLabel

      this.host.store.upsertDreamSession?.({
        sessionId,
        botId: bot.id,
        botName: bot.name,
        workspaceName,
        workingDir,
        agentPreset: bot.agentPreset,
        ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(launch.model ?? bot.model ? { model: launch.model ?? bot.model } : {}),
        status: 'succeeded',
        outcome,
        ...(memoryStats ? { memoryStats } : {}),
        dateKey,
        processedCount: prepared.selected.length,
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
        lastSessionId: sessionId,
        lastProcessedCount: prepared.selected.length,
        lastSummary: summaryNote,
        processedSessionIds: nextProcessed,
      })

      this.host.store.recordEvent({
        botId,
        sessionId,
        durationMs,
        kind: 'lifecycle',
        summary: `Dreaming 完成：${headerLabel}`,
      })
      return updated
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const finishedMs = Date.now()
      const memoryStats = mutationTracker?.snapshot()
      this.host.ctx.logger.error(`[lark-bridge] dreaming failed for "${bot.name}": ${msg}`)
      if (createdSession) {
        await this.host.workspaces.archiveSession(sessionId).catch(() => {})
        this.host.store.markSessionArchived?.(sessionId)
        this.host.store.upsertDreamSession?.({
          sessionId,
          botId: bot.id,
          botName: bot.name,
          workspaceName,
          workingDir,
          agentPreset: bot.agentPreset,
          ...(bot.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
          ...(bot.model ? { model: bot.model } : {}),
          status: 'failed',
          outcome: 'failed',
          ...(memoryStats ? { memoryStats } : {}),
          dateKey,
          processedCount: prepared.selected.length,
          summary: msg,
          createdAtMs: startedMs,
          lastActivityMs: finishedMs,
          durationMs: finishedMs - startedMs,
        })
      }
      const failed = this.host.store.upsertDreamState({
        ...prev,
        status: 'failed',
        lastCheckedDateKey: dateKey,
        ...(createdSession ? { lastSessionId: sessionId } : {}),
        lastSummary: `整理失败：${msg}`,
      })
      this.host.store.recordEvent({
        botId,
        ...(createdSession ? { sessionId } : {}),
        kind: 'error',
        summary: `Dreaming 失败：${msg}`,
      })
      return failed
    } finally {
      mutationTracker?.dispose()
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
    bot: NonNullable<ReturnType<LarkBridgeStore['getBot']>>,
    candidates: readonly LarkManagedSession[],
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

    const scanLimit = Math.min(candidates.length, MAX_SCAN_CANDIDATES_PER_DREAM)
    for (let i = 0; i < scanLimit && selected.length < MAX_SESSIONS_PER_DREAM; i += 1) {
      const ms = candidates[i]!
      const { events, cwd } = await this.readSessionEvents(ms.sessionId, liveSessionsSvc, persistence)
      const digest = summarizeSessionEvents(events)

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
      })
    }

    return {
      selected,
      consumedSessionIds,
      skippedNoiseSessionIds,
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
      writeFileSync(
        digestPath,
        `# Dreaming Transcript Digest (${dateKey})\n\n（本次为手动触发，暂无未处理的新增会话记录；请结合当前代码库核查并清理你自身记忆中的过期内容。）\n`,
        'utf8',
      )
      return digestPath
    }

    const sections: string[] = [`# Dreaming Transcript Digest (${dateKey})\n`]
    for (const item of items) {
      const ms = item.session
      const chatLabel = this.host.store.resolveChatName(ms.botId, ms.chatId) || ms.chatId
      const dateStr = new Date(ms.lastActivityMs).toISOString().slice(0, 16).replace('T', ' ')
      const dupSuffix =
        item.duplicateCount > 1 ? ` · 同主题重复 ${item.duplicateCount} 次已折叠` : ''
      sections.push(
        `## Session ${ms.sessionId} · chat_id=${ms.chatId} (${chatLabel}) · ${dateStr}${dupSuffix}\n\n${item.digest.markdown}\n`,
      )
    }

    writeFileSync(digestPath, sections.join('\n'), 'utf8')
    return digestPath
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
