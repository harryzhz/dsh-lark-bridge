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
  expandWorkingDir,
  extractPureUserIntent,
  resolveEffectiveWorkspaceName,
} from '@dsh-lark/lark-core'
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
const MAX_EVENTS_PER_SESSION = 120
const MAX_TRANSCRIPT_CHARS_PER_SESSION = 2800

export interface DreamingHost {
  readonly ctx: Context
  readonly dataDir: string
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  runTurn(agent: Agent, content: ContentBlock[]): Promise<string>
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

function summarizeSessionEvents(events: readonly SessionEvent[]): string {
  const lines: string[] = []
  for (const ev of events) {
    if (ev.type === 'user/message') {
      const blocks = (ev.data as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content ?? []
      const raw = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
      const clean = extractPureUserIntent(raw)
      if (clean && clean !== '[空消息]') {
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
      const text = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!.trim())
        .filter(Boolean)
        .join('\n')
      if (text) {
        lines.push(`- **Agent**: ${text.slice(0, 700)}`)
      }
    }
  }
  const joined = lines.join('\n')
  return joined.length > MAX_TRANSCRIPT_CHARS_PER_SESSION
    ? `${joined.slice(0, MAX_TRANSCRIPT_CHARS_PER_SESSION)}\n  …`
    : joined
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

  constructor(private readonly host: DreamingHost) {}

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
    if (this.disposed) return
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
    if (!options.force && candidateSessions.length < cfg.minNewSessions) {
      const skippedSummary = `增量会话 ${candidateSessions.length} 个（未达阈值 ${cfg.minNewSessions}），已静默跳过`
      return this.host.store.upsertDreamState({
        ...prev,
        status: 'skipped',
        lastCheckedDateKey: dateKey,
        lastProcessedCount: 0,
        lastSummary: skippedSummary,
      })
    }

    this.runningBots.add(botId)
    this.host.store.upsertDreamState({
      ...prev,
      status: 'running',
      lastCheckedDateKey: dateKey,
      lastSummary: '正在盘点增量会话与代码库并整理记忆…',
    })

    const startedMs = Date.now()
    const batch = candidateSessions.slice(0, MAX_SESSIONS_PER_DREAM)
    const workingDir = expandWorkingDir(bot.defaultWorkingDir) || bot.defaultWorkingDir
    const workspaceName =
      typeof this.host.store.resolveBotWorkspaceName === 'function'
        ? this.host.store.resolveBotWorkspaceName(bot)
        : resolveEffectiveWorkspaceName(bot)
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)

    try {
      const digestPath = await this.writeTranscriptDigest(bot.id, dateKey, batch)
      const prompt = composeDreamExecutionPrompt({
        botId: bot.id,
        botName: bot.name,
        workingDir,
        currentDateIso: dateKey,
        transcriptDigestPath: digestPath,
        sessionCount: batch.length,
        config: cfg,
        proactive: bot.experimental.proactive,
      })

      const launch = await this.host.runtimes.resolveAgentLaunch({
        agentPreset: bot.agentPreset,
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
          await launch.mountPreset(agentCtx)
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
        titleSvc?.rename?.(handle.agent.session, `Dreaming · 记忆整理 (${dateKey})`)
      } catch {
        // Best-effort session title.
      }
      await this.host.workspaces.attachSession(workingDir, workspaceName, sessionId)

      let replyText = ''
      try {
        replyText = await this.host.runTurn(handle.agent, [{ type: 'text', text: prompt }])
      } finally {
        await handle.dispose().catch(() => {})
      }

      await this.host.workspaces.archiveSession(sessionId)

      const nextProcessed = [
        ...prev.processedSessionIds,
        ...batch.map((s) => s.sessionId).filter((id) => !processedSet.has(id)),
      ]
      const cleanNote = replyText.replace(/\s+/g, ' ').trim().slice(0, 80)
      const summaryNote = cleanNote
        ? `已整理 ${batch.length} 个会话 · ${cleanNote}`
        : `已整理 ${batch.length} 个会话`

      const updated = this.host.store.upsertDreamState({
        botId,
        status: 'succeeded',
        lastDreamAtMs: now.getTime(),
        lastCheckedDateKey: dateKey,
        lastSessionId: sessionId,
        lastProcessedCount: batch.length,
        lastSummary: summaryNote,
        processedSessionIds: nextProcessed,
      })

      this.host.store.recordEvent({
        botId,
        sessionId,
        durationMs: Date.now() - startedMs,
        kind: 'lifecycle',
        summary: `Dreaming 完成：已整理 ${batch.length} 个会话`,
      })
      return updated
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.host.ctx.logger.error(`[lark-bridge] dreaming failed for "${bot.name}": ${msg}`)
      const failed = this.host.store.upsertDreamState({
        ...prev,
        status: 'failed',
        lastCheckedDateKey: dateKey,
        lastSessionId: sessionId,
        lastSummary: `整理失败：${msg}`,
      })
      this.host.store.recordEvent({
        botId,
        sessionId,
        kind: 'error',
        summary: `Dreaming 失败：${msg}`,
      })
      return failed
    } finally {
      this.runningBots.delete(botId)
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
  }

  private async writeTranscriptDigest(
    botId: string,
    dateKey: string,
    sessions: readonly LarkManagedSession[],
  ): Promise<string> {
    const dreamDir = join(this.host.dataDir, 'dreaming', botId)
    mkdirSync(dreamDir, { recursive: true, mode: 0o700 })
    const digestPath = join(dreamDir, 'recent-transcripts.md')

    if (sessions.length === 0) {
      writeFileSync(
        digestPath,
        `# Dreaming Transcript Digest (${dateKey})\n\n（本次为手动触发，暂无未处理的新增会话记录；请结合当前代码库核查并清理你自身记忆中的过期内容。）\n`,
        'utf8',
      )
      return digestPath
    }

    const sections: string[] = [`# Dreaming Transcript Digest (${dateKey})\n`]
    const persistence = this.host.ctx.get('sessionPersistence') as SessionPersistence | undefined
    const liveSessionsSvc = this.host.ctx.sessions as unknown as
      | { get?: (id: SessionId) => Session | undefined }
      | undefined

    for (const ms of sessions) {
      const events = await this.readSessionEvents(ms.sessionId, liveSessionsSvc, persistence)
      const summary = summarizeSessionEvents(events)
      if (!summary) continue
      const chatLabel = this.host.store.resolveChatName(ms.botId, ms.chatId) || ms.chatId
      const dateStr = new Date(ms.lastActivityMs).toISOString().slice(0, 16).replace('T', ' ')
      sections.push(
        `## Session ${ms.sessionId} · chat_id=${ms.chatId} (${chatLabel}) · ${dateStr}\n\n${summary}\n`,
      )
    }

    if (sections.length === 1) {
      sections.push('（近期会话均为空或纯命令交互，无可提炼正文。）\n')
    }

    writeFileSync(digestPath, sections.join('\n'), 'utf8')
    return digestPath
  }

  private async readSessionEvents(
    sessionId: string,
    liveSessionsSvc: { get?: (id: SessionId) => Session | undefined } | undefined,
    persistence: SessionPersistence | undefined,
  ): Promise<readonly SessionEvent[]> {
    const sid = brandString<SessionId>(sessionId)
    const live = liveSessionsSvc?.get?.(sid)
    if (live && typeof live.snapshotEvents === 'function') {
      const snap = live.snapshotEvents()
      if (snap.length > 0) return snap.slice(-MAX_EVENTS_PER_SESSION)
    }
    if (!persistence) return []
    try {
      const handle = await persistence.open(sid, 'read')
      try {
        const res = await handle.read(0, MAX_EVENTS_PER_SESSION)
        return res.events
      } finally {
        await handle.close().catch(() => {})
      }
    } catch {
      return []
    }
  }
}
