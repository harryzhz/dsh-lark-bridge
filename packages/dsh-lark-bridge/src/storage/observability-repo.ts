import { buildGroupKey } from '@dsh-lark/lark-core'
import type {
  ObservabilityChatFilterOption,
  ObservabilityChatRow,
  ObservabilityErrorBreakdown,
  ObservabilityHeatmapCell,
  ObservabilityLatencyBucket,
  ObservabilityModelBreakdown,
  ObservabilitySeriesPoint,
  ObservabilityTriggerBreakdown,
  ObservabilityWindow,
  TelemetryUsageEventInput,
} from '../observability-types.js'
import type { ConfigRepo } from './config-repo.js'
import type { BridgeDatabase } from './database.js'

const DETAIL_RETENTION_MS = 90 * 24 * 60 * 60_000
const MAX_DETAIL_ROWS = 150_000
const ROLLUP_RETENTION_DAYS = 365
const PRUNE_EVERY_INSERTS = 200

export const P2P_CHAT_FILTER_VALUE = '__p2p__'

export interface WindowSpec {
  readonly window: ObservabilityWindow
  readonly spanMs: number
  readonly bucketSpanMs: number
  readonly bucketCount: number
}

const WINDOW_SPECS: Record<ObservabilityWindow, WindowSpec> = {
  '24h': {
    window: '24h',
    spanMs: 24 * 3_600_000,
    bucketSpanMs: 3_600_000,
    bucketCount: 24,
  },
  '7d': {
    window: '7d',
    spanMs: 7 * 24 * 3_600_000,
    bucketSpanMs: 6 * 3_600_000,
    bucketCount: 28,
  },
  '30d': {
    window: '30d',
    spanMs: 30 * 24 * 3_600_000,
    bucketSpanMs: 24 * 3_600_000,
    bucketCount: 30,
  },
  '90d': {
    window: '90d',
    spanMs: 90 * 24 * 3_600_000,
    bucketSpanMs: 3 * 24 * 3_600_000,
    bucketCount: 30,
  },
}

export function resolveWindowSpec(raw?: string): WindowSpec {
  if (raw === '7d' || raw === '30d' || raw === '90d' || raw === '24h') {
    return WINDOW_SPECS[raw]
  }
  return WINDOW_SPECS['24h']
}

export function formatDayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatBucketLabel(
  startMs: number,
  endMs: number,
  window: ObservabilityWindow,
): { readonly label: string; readonly fullLabel: string } {
  const s = new Date(startMs)
  const e = new Date(Math.max(startMs, endMs - 1))
  if (window === '24h') {
    const hh = pad2(s.getHours())
    return {
      label: `${hh}:00`,
      fullLabel: `${s.getMonth() + 1}/${s.getDate()} ${hh}:00–${hh}:59`,
    }
  }
  if (window === '7d') {
    const md = `${s.getMonth() + 1}/${s.getDate()}`
    const sh = pad2(s.getHours())
    const eh = pad2(e.getHours())
    return {
      label: s.getHours() === 0 ? md : `${sh}:00`,
      fullLabel: `${md} ${sh}:00–${eh}:59`,
    }
  }
  if (window === '30d') {
    const md = `${s.getMonth() + 1}/${s.getDate()}`
    return {
      label: md,
      fullLabel: `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`,
    }
  }
  const smd = `${s.getMonth() + 1}/${s.getDate()}`
  const emd = `${e.getMonth() + 1}/${e.getDate()}`
  return {
    label: smd,
    fullLabel: `${smd}–${emd}`,
  }
}

export function calcPercentiles(values: readonly number[]): {
  readonly samples: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p75Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly maxMs: number
} {
  if (values.length === 0) {
    return { samples: 0, avgMs: 0, p50Ms: 0, p75Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q: number) => {
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1))
    return sorted[idx] ?? 0
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    samples: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    p50Ms: Math.round(pick(0.5)),
    p75Ms: Math.round(pick(0.75)),
    p95Ms: Math.round(pick(0.95)),
    p99Ms: Math.round(pick(0.99)),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
  }
}

export function calcDeltaPct(current: number, previous: number): number | null {
  if (previous <= 0) {
    return current === 0 ? 0 : null
  }
  return Math.round(((current - previous) / previous) * 1000) / 10
}

function buildLatencyHistogram(values: readonly number[]): ObservabilityLatencyBucket[] {
  const bins = [
    { id: 'lt_1s', label: '<1s', min: 0, max: 1_000, count: 0 },
    { id: '1_3s', label: '1–3s', min: 1_000, max: 3_000, count: 0 },
    { id: '3_10s', label: '3–10s', min: 3_000, max: 10_000, count: 0 },
    { id: '10_30s', label: '10–30s', min: 10_000, max: 30_000, count: 0 },
    { id: '30_60s', label: '30–60s', min: 30_000, max: 60_000, count: 0 },
    { id: 'gt_60s', label: '>60s', min: 60_000, max: Number.POSITIVE_INFINITY, count: 0 },
  ]
  for (const v of values) {
    for (const b of bins) {
      if (v >= b.min && v < b.max) {
        b.count += 1
        break
      }
    }
  }
  const total = values.length
  return bins.map((b) => ({
    id: b.id,
    label: b.label,
    count: b.count,
    pct: total > 0 ? Math.round((b.count / total) * 1000) / 10 : 0,
  }))
}

interface RawUsageEventRow {
  timestamp_ms: number
  record_kind: string
  bot_id: string
  chat_id: string
  chat_type: string
  session_id: string
  trigger: string
  agent_preset: string
  provider: string
  model: string
  outcome: string
  error_code: string
  latency_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  total_tokens: number
  tool_calls: number
  tool_errors: number
}

interface WindowTotals {
  inbound: number
  replied: number
  silentSkipped: number
  ignored: number
  errors: number
  abortedTurns: number
  llmSteps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  triageTotal: number
  triageSilent: number
  triageQuickReply: number
  triageHandoff: number
  triageFallback: number
  triageTokens: number
  scheduleRuns: number
  reminderRuns: number
  dreamRuns: number
  sessions: Set<string>
  latencies: number[]
  triageLatencies: number[]
}

function emptyWindowTotals(): WindowTotals {
  return {
    inbound: 0,
    replied: 0,
    silentSkipped: 0,
    ignored: 0,
    errors: 0,
    abortedTurns: 0,
    llmSteps: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    triageTotal: 0,
    triageSilent: 0,
    triageQuickReply: 0,
    triageHandoff: 0,
    triageFallback: 0,
    triageTokens: 0,
    scheduleRuns: 0,
    reminderRuns: 0,
    dreamRuns: 0,
    sessions: new Set<string>(),
    latencies: [],
    triageLatencies: [],
  }
}

function accumulateRow(target: WindowTotals, row: RawUsageEventRow): void {
  const inTok = Number(row.input_tokens) || 0
  const outTok = Number(row.output_tokens) || 0
  const crTok = Number(row.cache_read_tokens) || 0
  const cwTok = Number(row.cache_write_tokens) || 0
  const rTok = Number(row.reasoning_tokens) || 0
  const totTok = Number(row.total_tokens) || inTok + outTok + crTok + cwTok

  target.inputTokens += inTok
  target.outputTokens += outTok
  target.cacheReadTokens += crTok
  target.cacheWriteTokens += cwTok
  target.reasoningTokens += rTok
  target.totalTokens += totTok
  target.toolCalls += Number(row.tool_calls) || 0
  target.toolErrors += Number(row.tool_errors) || 0

  if (row.session_id) {
    target.sessions.add(row.session_id)
  }

  const kind = row.record_kind
  const outcome = row.outcome

  if (kind === 'llm_step') {
    target.llmSteps += 1
    return
  }

  if (kind === 'inbound') {
    if (outcome === 'ignored') {
      target.ignored += 1
    } else {
      target.inbound += 1
    }
    return
  }

  if (kind === 'triage') {
    target.triageTotal += 1
    target.triageTokens += totTok
    if (outcome === 'silent') target.triageSilent += 1
    else if (outcome === 'quick_reply') target.triageQuickReply += 1
    else if (outcome === 'handoff') target.triageHandoff += 1
    else if (outcome === 'fallback') {
      target.triageFallback += 1
      target.triageHandoff += 1
    }
    if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
      target.triageLatencies.push(Number(row.latency_ms))
    }
    return
  }

  // kind === 'turn' | 'proactive'
  if (row.trigger === 'schedule') target.scheduleRuns += 1
  else if (row.trigger === 'reminder') target.reminderRuns += 1
  else if (row.trigger === 'dreaming') target.dreamRuns += 1

  if (outcome === 'replied' || outcome === 'quick_reply' || outcome === 'completed') {
    target.replied += 1
    if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
      target.latencies.push(Number(row.latency_ms))
    }
  } else if (outcome === 'silent_skip') {
    target.silentSkipped += 1
  } else if (outcome === 'ignored') {
    target.ignored += 1
  } else if (outcome === 'aborted') {
    target.abortedTurns += 1
  } else if (outcome === 'error') {
    target.errors += 1
  }
}

export interface ObservabilityRepoAggregate {
  readonly window: ObservabilityWindow
  readonly fromMs: number
  readonly toMs: number
  readonly bucketSpanMs: number
  readonly current: WindowTotals
  readonly previous: WindowTotals
  readonly createdSessionsInWindow: number
  readonly prevCreatedSessions: number
  readonly archivedSessionsInWindow: number
  readonly series: readonly ObservabilitySeriesPoint[]
  readonly latencyHistogram: readonly ObservabilityLatencyBucket[]
  readonly models: readonly ObservabilityModelBreakdown[]
  readonly triggers: readonly ObservabilityTriggerBreakdown[]
  readonly errors: readonly ObservabilityErrorBreakdown[]
  readonly heatmap: { readonly maxCount: number; readonly cells: readonly ObservabilityHeatmapCell[] }
  readonly botStats: ReadonlyMap<
    string,
    {
      readonly sessions: number
      readonly inbound: number
      readonly replied: number
      readonly silentSkipped: number
      readonly errors: number
      readonly totalTokens: number
      readonly promptTokens: number
      readonly cacheReadTokens: number
      readonly latencies: number[]
    }
  >
  readonly chatRanking: readonly ObservabilityChatRow[]
  readonly chatFilterOptions: readonly ObservabilityChatFilterOption[]
}

const AGGREGATE_CACHE_TTL_MS = 5_000
const MAX_AGGREGATE_CACHE_ENTRIES = 16

export class ObservabilityRepo {
  private insertCounter = 0
  private readonly aggregateCache = new Map<
    string,
    { readonly expiresAtMs: number; readonly result: ObservabilityRepoAggregate }
  >()

  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: ConfigRepo,
  ) {}

  private invalidateAggregateCache(): void {
    if (this.aggregateCache.size > 0) this.aggregateCache.clear()
  }

  recordUsageEvent(input: TelemetryUsageEventInput): boolean {
    const id = input.id.trim()
    if (!id) return false
    const ts = Number.isFinite(input.timestampMs) ? Math.round(input.timestampMs) : Date.now()
    const inTok = Math.max(0, Math.round(input.inputTokens ?? 0))
    const outTok = Math.max(0, Math.round(input.outputTokens ?? 0))
    const crTok = Math.max(0, Math.round(input.cacheReadTokens ?? 0))
    const cwTok = Math.max(0, Math.round(input.cacheWriteTokens ?? 0))
    const rTok = Math.max(0, Math.round(input.reasoningTokens ?? 0))
    const computedTotal = inTok + outTok + crTok + cwTok
    const totTok = Math.max(computedTotal, Math.round(input.totalTokens ?? computedTotal))
    const toolCalls = Math.max(0, Math.round(input.toolCalls ?? 0))
    const toolErrors = Math.max(0, Math.round(input.toolErrors ?? 0))
    const latencyMs =
      input.latencyMs !== undefined && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
        ? Math.round(input.latencyMs)
        : null

    const botId = input.botId || 'unknown'
    const chatId = input.chatId ?? ''
    const chatType = input.chatType ?? ''
    const sessionId = input.sessionId ?? ''
    const trigger = input.trigger ?? ''
    const agentPreset = input.agentPreset ?? ''
    const provider = input.provider ?? ''
    const model = input.model ?? ''
    const outcome = input.outcome ?? ''
    const errorCode = input.errorCode ?? ''

    const inserted = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO telemetry_usage_events (
             id, timestamp_ms, record_kind, bot_id, chat_id, chat_type, session_id,
             trigger, agent_preset, provider, model, outcome, error_code, latency_ms,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens, total_tokens, tool_calls, tool_errors
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ts,
          input.recordKind,
          botId,
          chatId,
          chatType,
          sessionId,
          trigger,
          agentPreset,
          provider,
          model,
          outcome,
          errorCode,
          latencyMs,
          inTok,
          outTok,
          crTok,
          cwTok,
          rTok,
          totTok,
          toolCalls,
          toolErrors,
        )
      if (Number(res.changes) === 0) return false

      const dayKey = formatDayKey(ts)
      const isReplied =
        (input.recordKind === 'turn' || input.recordKind === 'proactive') &&
        (outcome === 'replied' || outcome === 'quick_reply' || outcome === 'completed')
      const isLatencyCounted = isReplied && latencyMs !== null
      this.db
        .prepare(
          `INSERT INTO telemetry_daily_rollups (
             day_key, bot_id, chat_id, model, trigger,
             inbound_count, replied_count, silent_count, ignored_count, error_count,
             triage_count, triage_quick_count, triage_handoff_count, triage_silent_count, triage_fallback_count,
             llm_steps, tool_calls, tool_errors,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
             latency_sum_ms, latency_count, latency_max_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day_key, bot_id, chat_id, model, trigger) DO UPDATE SET
             inbound_count = inbound_count + excluded.inbound_count,
             replied_count = replied_count + excluded.replied_count,
             silent_count = silent_count + excluded.silent_count,
             ignored_count = ignored_count + excluded.ignored_count,
             error_count = error_count + excluded.error_count,
             triage_count = triage_count + excluded.triage_count,
             triage_quick_count = triage_quick_count + excluded.triage_quick_count,
             triage_handoff_count = triage_handoff_count + excluded.triage_handoff_count,
             triage_silent_count = triage_silent_count + excluded.triage_silent_count,
             triage_fallback_count = triage_fallback_count + excluded.triage_fallback_count,
             llm_steps = llm_steps + excluded.llm_steps,
             tool_calls = tool_calls + excluded.tool_calls,
             tool_errors = tool_errors + excluded.tool_errors,
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
             cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
             reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
             total_tokens = total_tokens + excluded.total_tokens,
             latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
             latency_count = latency_count + excluded.latency_count,
             latency_max_ms = MAX(latency_max_ms, excluded.latency_max_ms)`,
        )
        .run(
          dayKey,
          botId,
          chatId,
          model,
          trigger,
          input.recordKind === 'inbound' && outcome !== 'ignored' ? 1 : 0,
          isReplied ? 1 : 0,
          (input.recordKind === 'turn' || input.recordKind === 'proactive') && outcome === 'silent_skip'
            ? 1
            : 0,
          outcome === 'ignored' ? 1 : 0,
          (input.recordKind === 'turn' || input.recordKind === 'proactive') && outcome === 'error'
            ? 1
            : 0,
          input.recordKind === 'triage' ? 1 : 0,
          input.recordKind === 'triage' && outcome === 'quick_reply' ? 1 : 0,
          input.recordKind === 'triage' && (outcome === 'handoff' || outcome === 'fallback') ? 1 : 0,
          input.recordKind === 'triage' && outcome === 'silent' ? 1 : 0,
          input.recordKind === 'triage' && outcome === 'fallback' ? 1 : 0,
          input.recordKind === 'llm_step' ? 1 : 0,
          toolCalls,
          toolErrors,
          inTok,
          outTok,
          crTok,
          cwTok,
          rTok,
          totTok,
          isLatencyCounted ? latencyMs! : 0,
          isLatencyCounted ? 1 : 0,
          isLatencyCounted ? latencyMs! : 0,
        )
      return true
    })

    if (inserted) {
      this.invalidateAggregateCache()
      this.insertCounter += 1
      if (this.insertCounter >= PRUNE_EVERY_INSERTS) {
        this.insertCounter = 0
        this.prune(ts)
      }
    }
    return inserted
  }

  recordUsageEventsBatch(events: readonly TelemetryUsageEventInput[]): number {
    if (events.length === 0) return 0
    let inserted = 0
    this.db.transaction(() => {
      for (const ev of events) {
        if (this.recordUsageEvent(ev)) {
          inserted += 1
        }
      }
    })
    return inserted
  }

  getSessionWatermark(sessionId: string): number {
    const row = this.db
      .prepare('SELECT last_seq FROM telemetry_session_watermarks WHERE session_id = ?')
      .get(sessionId) as { last_seq?: number } | undefined
    return row?.last_seq !== undefined ? Number(row.last_seq) : -1
  }

  setSessionWatermark(sessionId: string, lastSeq: number, updatedAtMs = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO telemetry_session_watermarks (session_id, last_seq, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seq = MAX(last_seq, excluded.last_seq),
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(sessionId, Math.floor(lastSeq), updatedAtMs)
  }

  listSessionWatermarks(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT session_id, last_seq FROM telemetry_session_watermarks')
      .all() as Array<{ session_id: string; last_seq: number }>
    const map = new Map<string, number>()
    for (const r of rows) {
      map.set(r.session_id, Number(r.last_seq))
    }
    return map
  }

  prune(nowMs = Date.now()): void {
    const detailCutoff = nowMs - DETAIL_RETENTION_MS
    this.db.prepare('DELETE FROM telemetry_usage_events WHERE timestamp_ms < ?').run(detailCutoff)
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM telemetry_usage_events')
      .get() as { cnt?: number }
    const excess = Number(countRow?.cnt ?? 0) - MAX_DETAIL_ROWS
    if (excess > 0) {
      this.db
        .prepare(
          `DELETE FROM telemetry_usage_events WHERE id IN (
             SELECT id FROM telemetry_usage_events ORDER BY timestamp_ms ASC LIMIT ?
           )`,
        )
        .run(excess)
    }
    const rollupCutoffDay = formatDayKey(nowMs - ROLLUP_RETENTION_DAYS * 24 * 3_600_000)
    this.db
      .prepare('DELETE FROM telemetry_daily_rollups WHERE day_key < ?')
      .run(rollupCutoffDay)
  }

  queryAggregate(options: {
    readonly window?: ObservabilityWindow
    readonly botId?: string
    readonly chatId?: string
    readonly nowMs?: number
  }): ObservabilityRepoAggregate {
    const spec = resolveWindowSpec(options.window)
    const nowMs = options.nowMs ?? Date.now()
    // Align bucket end to the end of the current hour (for 24h/7d) or current day (for 30d/90d)
    const alignedEndMs = this.alignWindowEnd(nowMs, spec)
    const fromMs = alignedEndMs - spec.spanMs
    const prevFromMs = fromMs - spec.spanMs
    const botId = options.botId?.trim() || ''
    const chatId = options.chatId?.trim() || ''
    const cacheKey = `${spec.window}|${botId}|${chatId}|${alignedEndMs}`
    const wallNow = Date.now()
    const isLiveNow = options.nowMs === undefined
    if (isLiveNow) {
      const hit = this.aggregateCache.get(cacheKey)
      if (hit && wallNow < hit.expiresAtMs) {
        return hit.result
      }
    }

    // Fetch current + previous window in a single indexed range scan, then partition in memory.
    const combinedRows = this.fetchUsageEvents(prevFromMs, alignedEndMs, botId, chatId)
    const currentRows: RawUsageEventRow[] = []
    const previousRows: RawUsageEventRow[] = []
    for (const row of combinedRows) {
      if (Number(row.timestamp_ms) >= fromMs) {
        currentRows.push(row)
      } else {
        previousRows.push(row)
      }
    }

    const current = emptyWindowTotals()
    for (const row of currentRows) accumulateRow(current, row)

    const previous = emptyWindowTotals()
    for (const row of previousRows) accumulateRow(previous, row)

    const series = this.buildTimeSeries(currentRows, fromMs, alignedEndMs, spec)
    const latencyHistogram = buildLatencyHistogram(current.latencies)
    const models = this.buildModelBreakdown(currentRows, current.totalTokens)
    const triggers = this.buildTriggerBreakdown(currentRows)
    const errors = this.buildErrorBreakdown(currentRows)
    const heatmap = this.buildHeatmap(currentRows)
    const botStats = this.buildBotStatsMap(currentRows)
    const chatRanking = this.buildChatRanking(currentRows)
    const chatFilterOptions = this.buildChatFilterOptions(botId)

    const sessionCounts = this.countManagedSessionsInRanges(
      fromMs,
      alignedEndMs,
      prevFromMs,
      botId,
      chatId,
    )

    const result: ObservabilityRepoAggregate = {
      window: spec.window,
      fromMs,
      toMs: alignedEndMs,
      bucketSpanMs: spec.bucketSpanMs,
      current,
      previous,
      createdSessionsInWindow: sessionCounts.createdCurrent,
      prevCreatedSessions: sessionCounts.createdPrevious,
      archivedSessionsInWindow: sessionCounts.archivedCurrent,
      series,
      latencyHistogram,
      models,
      triggers,
      errors,
      heatmap,
      botStats,
      chatRanking,
      chatFilterOptions,
    }
    if (isLiveNow) {
      if (this.aggregateCache.size >= MAX_AGGREGATE_CACHE_ENTRIES) {
        const oldestKey = this.aggregateCache.keys().next().value
        if (oldestKey !== undefined) this.aggregateCache.delete(oldestKey)
      }
      this.aggregateCache.set(cacheKey, {
        expiresAtMs: wallNow + AGGREGATE_CACHE_TTL_MS,
        result,
      })
    }
    return result
  }

  private alignWindowEnd(nowMs: number, spec: WindowSpec): number {
    const d = new Date(nowMs)
    if (spec.window === '24h') {
      d.setMinutes(0, 0, 0)
      return d.getTime() + 3_600_000
    }
    if (spec.window === '7d') {
      const hourFloor = Math.floor(d.getHours() / 6) * 6
      d.setHours(hourFloor, 0, 0, 0)
      return d.getTime() + 6 * 3_600_000
    }
    d.setHours(0, 0, 0, 0)
    return d.getTime() + 24 * 3_600_000
  }

  private fetchUsageEvents(
    fromMs: number,
    toMs: number,
    botId: string,
    chatId: string,
  ): RawUsageEventRow[] {
    const clauses: string[] = ['timestamp_ms >= ?', 'timestamp_ms < ?']
    const params: Array<string | number> = [fromMs, toMs]
    if (botId) {
      clauses.push('bot_id = ?')
      params.push(botId)
    }
    if (chatId === P2P_CHAT_FILTER_VALUE) {
      clauses.push("chat_type = 'p2p'")
    } else if (chatId) {
      clauses.push('chat_id = ?')
      params.push(chatId)
    }
    const sql = `SELECT timestamp_ms, record_kind, bot_id, chat_id, chat_type, session_id,
                        trigger, agent_preset, provider, model, outcome, error_code, latency_ms,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, total_tokens, tool_calls, tool_errors
                 FROM telemetry_usage_events
                 WHERE ${clauses.join(' AND ')}
                 ORDER BY timestamp_ms ASC`
    return this.db.prepare(sql).all(...params) as unknown as RawUsageEventRow[]
  }

  private countManagedSessionsInRanges(
    fromMs: number,
    toMs: number,
    prevFromMs: number,
    botId: string,
    chatId: string,
  ): {
    readonly createdCurrent: number
    readonly createdPrevious: number
    readonly archivedCurrent: number
  } {
    const baseClauses: string[] = []
    const baseParams: Array<string | number> = []
    if (botId) {
      baseClauses.push('bot_id = ?')
      baseParams.push(botId)
    }
    if (chatId === P2P_CHAT_FILTER_VALUE) {
      baseClauses.push("trigger = 'p2p'")
    } else if (chatId) {
      baseClauses.push('chat_id = ?')
      baseParams.push(chatId)
    }
    const prefix = baseClauses.length > 0 ? `${baseClauses.join(' AND ')} AND ` : ''

    const createdCurrentRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM managed_sessions WHERE ${prefix}created_at_ms >= ? AND created_at_ms < ?`,
      )
      .get(...baseParams, fromMs, toMs) as { cnt?: number }
    const createdPrevRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM managed_sessions WHERE ${prefix}created_at_ms >= ? AND created_at_ms < ?`,
      )
      .get(...baseParams, prevFromMs, fromMs) as { cnt?: number }
    const archivedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM managed_sessions WHERE ${prefix}archived_at_ms IS NOT NULL AND archived_at_ms >= ? AND archived_at_ms < ?`,
      )
      .get(...baseParams, fromMs, toMs) as { cnt?: number }

    return {
      createdCurrent: Number(createdCurrentRow?.cnt ?? 0),
      createdPrevious: Number(createdPrevRow?.cnt ?? 0),
      archivedCurrent: Number(archivedRow?.cnt ?? 0),
    }
  }

  private buildTimeSeries(
    rows: readonly RawUsageEventRow[],
    fromMs: number,
    toMs: number,
    spec: WindowSpec,
  ): ObservabilitySeriesPoint[] {
    const buckets = Array.from({ length: spec.bucketCount }, (_, idx) => {
      const startMs = fromMs + idx * spec.bucketSpanMs
      const endMs = Math.min(toMs, startMs + spec.bucketSpanMs)
      return {
        startMs,
        endMs,
        totals: emptyWindowTotals(),
      }
    })

    for (const row of rows) {
      const idx = Math.floor((Number(row.timestamp_ms) - fromMs) / spec.bucketSpanMs)
      if (idx < 0 || idx >= buckets.length) continue
      accumulateRow(buckets[idx]!.totals, row)
    }

    return buckets.map((b) => {
      const { label, fullLabel } = formatBucketLabel(b.startMs, b.endMs, spec.window)
      const lat = calcPercentiles(b.totals.latencies)
      return {
        bucketStartMs: b.startMs,
        bucketEndMs: b.endMs,
        label,
        fullLabel,
        inbound: b.totals.inbound,
        replied: b.totals.replied,
        silentSkipped: b.totals.silentSkipped,
        errors: b.totals.errors,
        sessions: b.totals.sessions.size,
        llmSteps: b.totals.llmSteps,
        toolCalls: b.totals.toolCalls,
        inputTokens: b.totals.inputTokens,
        cacheReadTokens: b.totals.cacheReadTokens,
        cacheWriteTokens: b.totals.cacheWriteTokens,
        outputTokens: b.totals.outputTokens,
        reasoningTokens: b.totals.reasoningTokens,
        totalTokens: b.totals.totalTokens,
        latencyP50Ms: lat.p50Ms,
        latencyP95Ms: lat.p95Ms,
        avgLatencyMs: lat.avgMs,
      }
    })
  }

  private buildModelBreakdown(
    rows: readonly RawUsageEventRow[],
    grandTotalTokens: number,
  ): ObservabilityModelBreakdown[] {
    const map = new Map<
      string,
      {
        model: string
        provider: string
        agentPreset: string
        steps: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        outputTokens: number
        reasoningTokens: number
        totalTokens: number
      }
    >()

    for (const row of rows) {
      const tot = Number(row.total_tokens) || 0
      const isStep = row.record_kind === 'llm_step' || row.record_kind === 'triage'
      if (!isStep && tot === 0) continue
      const model = row.model.trim() || (row.agent_preset ? `${row.agent_preset} (default)` : 'unknown')
      const provider = row.provider.trim()
      const key = `${provider}::${model}`
      const cur = map.get(key) ?? {
        model,
        provider,
        agentPreset: row.agent_preset.trim(),
        steps: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      }
      if (!cur.agentPreset && row.agent_preset.trim()) {
        cur.agentPreset = row.agent_preset.trim()
      }
      if (isStep) cur.steps += 1
      cur.inputTokens += Number(row.input_tokens) || 0
      cur.cacheReadTokens += Number(row.cache_read_tokens) || 0
      cur.cacheWriteTokens += Number(row.cache_write_tokens) || 0
      cur.outputTokens += Number(row.output_tokens) || 0
      cur.reasoningTokens += Number(row.reasoning_tokens) || 0
      cur.totalTokens += tot
      map.set(key, cur)
    }

    return [...map.values()]
      .filter((m) => m.totalTokens > 0 || m.steps > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens || b.steps - a.steps)
      .slice(0, 12)
      .map((m) => {
        const promptTotal = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens
        const cacheHitRate =
          promptTotal > 0 ? Math.round((m.cacheReadTokens / promptTotal) * 1000) / 10 : 0
        const sharePct =
          grandTotalTokens > 0 ? Math.round((m.totalTokens / grandTotalTokens) * 1000) / 10 : 0
        return { ...m, cacheHitRate, sharePct }
      })
  }

  private buildTriggerBreakdown(rows: readonly RawUsageEventRow[]): ObservabilityTriggerBreakdown[] {
    const map = new Map<
      string,
      {
        count: number
        sessions: Set<string>
        replied: number
        errors: number
        totalTokens: number
      }
    >()
    let grandCount = 0
    let grandTokens = 0

    for (const row of rows) {
      const trigger =
        row.record_kind === 'triage'
          ? 'triage'
          : row.trigger.trim() || (row.chat_type === 'p2p' ? 'p2p' : 'mention')
      const cur = map.get(trigger) ?? {
        count: 0,
        sessions: new Set<string>(),
        replied: 0,
        errors: 0,
        totalTokens: 0,
      }
      const tok = Number(row.total_tokens) || 0
      cur.totalTokens += tok
      grandTokens += tok
      if (row.session_id) cur.sessions.add(row.session_id)
      if (row.record_kind === 'turn' || row.record_kind === 'proactive' || row.record_kind === 'triage') {
        cur.count += 1
        grandCount += 1
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
        }
        if (row.outcome === 'error' || row.outcome === 'fallback') {
          cur.errors += 1
        }
      }
      map.set(trigger, cur)
    }

    return [...map.entries()]
      .filter(([, v]) => v.count > 0 || v.totalTokens > 0 || v.sessions.size > 0)
      .sort((a, b) => b[1].totalTokens - a[1].totalTokens || b[1].count - a[1].count)
      .map(([trigger, v]) => {
        const sharePct =
          grandTokens > 0
            ? Math.round((v.totalTokens / grandTokens) * 1000) / 10
            : grandCount > 0
              ? Math.round((v.count / grandCount) * 1000) / 10
              : 0
        return {
          trigger,
          count: v.count,
          sessions: v.sessions.size,
          replied: v.replied,
          errors: v.errors,
          totalTokens: v.totalTokens,
          sharePct,
        }
      })
  }

  private buildErrorBreakdown(rows: readonly RawUsageEventRow[]): ObservabilityErrorBreakdown[] {
    const map = new Map<string, { count: number; latestAtMs: number }>()
    let total = 0
    for (const row of rows) {
      const isErr =
        row.outcome === 'error' ||
        row.outcome === 'fallback' ||
        row.outcome === 'aborted' ||
        (Number(row.tool_errors) || 0) > 0
      if (!isErr) continue
      const code =
        row.error_code.trim() ||
        (row.outcome === 'fallback'
          ? 'triage_fallback'
          : row.outcome === 'aborted'
            ? 'turn_aborted'
            : Number(row.tool_errors) > 0
              ? 'tool_error'
              : 'turn_error')
      const weight =
        row.record_kind === 'llm_step' && Number(row.tool_errors) > 0
          ? Number(row.tool_errors)
          : 1
      const prev = map.get(code) ?? { count: 0, latestAtMs: 0 }
      prev.count += weight
      prev.latestAtMs = Math.max(prev.latestAtMs, Number(row.timestamp_ms))
      map.set(code, prev)
      total += weight
    }
    return [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count || b[1].latestAtMs - a[1].latestAtMs)
      .slice(0, 10)
      .map(([code, v]) => ({
        code,
        count: v.count,
        sharePct: total > 0 ? Math.round((v.count / total) * 1000) / 10 : 0,
        latestAtMs: v.latestAtMs,
      }))
  }

  private buildHeatmap(rows: readonly RawUsageEventRow[]): {
    readonly maxCount: number
    readonly cells: readonly ObservabilityHeatmapCell[]
  } {
    const grid = new Map<string, { count: number; tokens: number }>()
    let maxCount = 0
    for (const row of rows) {
      if (row.record_kind === 'inbound' && row.outcome === 'ignored') continue
      const d = new Date(Number(row.timestamp_ms))
      const dow = (d.getDay() + 6) % 7 // Mon=0 .. Sun=6
      const hour = d.getHours()
      const key = `${dow}:${hour}`
      const cur = grid.get(key) ?? { count: 0, tokens: 0 }
      if (row.record_kind === 'inbound' || row.record_kind === 'turn' || row.record_kind === 'proactive') {
        cur.count += 1
      }
      cur.tokens += Number(row.total_tokens) || 0
      if (cur.count > maxCount) maxCount = cur.count
      grid.set(key, cur)
    }
    const cells: ObservabilityHeatmapCell[] = []
    for (let dow = 0; dow < 7; dow += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const entry = grid.get(`${dow}:${hour}`)
        cells.push({
          dayOfWeek: dow,
          hour,
          count: entry?.count ?? 0,
          tokens: entry?.tokens ?? 0,
        })
      }
    }
    return { maxCount, cells }
  }

  private buildBotStatsMap(rows: readonly RawUsageEventRow[]) {
    const map = new Map<
      string,
      {
        sessions: Set<string>
        inbound: number
        replied: number
        silentSkipped: number
        errors: number
        totalTokens: number
        promptTokens: number
        cacheReadTokens: number
        latencies: number[]
      }
    >()

    for (const row of rows) {
      if (!row.bot_id || row.bot_id === 'system') continue
      const cur = map.get(row.bot_id) ?? {
        sessions: new Set<string>(),
        inbound: 0,
        replied: 0,
        silentSkipped: 0,
        errors: 0,
        totalTokens: 0,
        promptTokens: 0,
        cacheReadTokens: 0,
        latencies: [],
      }
      if (row.session_id) cur.sessions.add(row.session_id)
      const inTok = Number(row.input_tokens) || 0
      const crTok = Number(row.cache_read_tokens) || 0
      const cwTok = Number(row.cache_write_tokens) || 0
      cur.totalTokens += Number(row.total_tokens) || 0
      cur.promptTokens += inTok + crTok + cwTok
      cur.cacheReadTokens += crTok

      if (row.record_kind === 'inbound' && row.outcome !== 'ignored') {
        cur.inbound += 1
      } else if (row.record_kind === 'turn' || row.record_kind === 'proactive') {
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
          if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
            cur.latencies.push(Number(row.latency_ms))
          }
        } else if (row.outcome === 'silent_skip') {
          cur.silentSkipped += 1
        } else if (row.outcome === 'error') {
          cur.errors += 1
        }
      }
      map.set(row.bot_id, cur)
    }

    const out = new Map<
      string,
      {
        readonly sessions: number
        readonly inbound: number
        readonly replied: number
        readonly silentSkipped: number
        readonly errors: number
        readonly totalTokens: number
        readonly promptTokens: number
        readonly cacheReadTokens: number
        readonly latencies: number[]
      }
    >()
    for (const [botId, v] of map.entries()) {
      out.set(botId, {
        sessions: v.sessions.size,
        inbound: v.inbound,
        replied: v.replied,
        silentSkipped: v.silentSkipped,
        errors: v.errors,
        totalTokens: v.totalTokens,
        promptTokens: v.promptTokens,
        cacheReadTokens: v.cacheReadTokens,
        latencies: v.latencies,
      })
    }
    return out
  }

  private buildChatRanking(rows: readonly RawUsageEventRow[]): ObservabilityChatRow[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const groupsByKey = new Map(this.config.listGroups().map((g) => [g.key, g]))
    const discovered = this.config.getDiscoveredChats()

    const map = new Map<
      string,
      {
        botId: string
        chatId: string
        chatType: 'group' | 'p2p' | 'internal'
        sessions: Set<string>
        inbound: number
        replied: number
        errors: number
        totalTokens: number
        promptTokens: number
        cacheReadTokens: number
        latencySum: number
        latencyCount: number
        lastActiveMs: number
      }
    >()

    for (const row of rows) {
      if (!row.chat_id || !row.bot_id || row.bot_id === 'system') continue
      const key = buildGroupKey(row.bot_id, row.chat_id)
      const inferredType: 'group' | 'p2p' | 'internal' =
        row.chat_type === 'p2p' || row.trigger === 'p2p'
          ? 'p2p'
          : row.chat_id.startsWith('dream:') || row.chat_type === 'internal'
            ? 'internal'
            : 'group'
      const cur = map.get(key) ?? {
        botId: row.bot_id,
        chatId: row.chat_id,
        chatType: inferredType,
        sessions: new Set<string>(),
        inbound: 0,
        replied: 0,
        errors: 0,
        totalTokens: 0,
        promptTokens: 0,
        cacheReadTokens: 0,
        latencySum: 0,
        latencyCount: 0,
        lastActiveMs: 0,
      }
      if (row.session_id) cur.sessions.add(row.session_id)
      const inTok = Number(row.input_tokens) || 0
      const crTok = Number(row.cache_read_tokens) || 0
      const cwTok = Number(row.cache_write_tokens) || 0
      cur.totalTokens += Number(row.total_tokens) || 0
      cur.promptTokens += inTok + crTok + cwTok
      cur.cacheReadTokens += crTok
      cur.lastActiveMs = Math.max(cur.lastActiveMs, Number(row.timestamp_ms))

      if (row.record_kind === 'inbound' && row.outcome !== 'ignored') {
        cur.inbound += 1
      } else if (row.record_kind === 'turn' || row.record_kind === 'proactive') {
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
          if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
            cur.latencySum += Number(row.latency_ms)
            cur.latencyCount += 1
          }
        } else if (row.outcome === 'error') {
          cur.errors += 1
        }
      }
      map.set(key, cur)
    }

    return [...map.entries()]
      .filter(([, v]) => v.chatType !== 'internal')
      .sort(
        (a, b) =>
          b[1].totalTokens - a[1].totalTokens ||
          b[1].inbound - a[1].inbound ||
          b[1].lastActiveMs - a[1].lastActiveMs,
      )
      .slice(0, 16)
      .map(([key, v]) => {
        const bot = botsById.get(v.botId)
        const grp = groupsByKey.get(key)
        const disc = discovered.get(key)
        const resolvedName =
          v.chatType === 'p2p'
            ? `私聊 · ${v.chatId.slice(-6)}`
            : grp?.chatName ||
              disc?.name ||
              this.config.resolveChatName(v.botId, v.chatId) ||
              v.chatId
        const cacheHitRate =
          v.promptTokens > 0 ? Math.round((v.cacheReadTokens / v.promptTokens) * 1000) / 10 : 0
        return {
          key,
          botId: v.botId,
          botName: bot?.name ?? v.botId,
          chatId: v.chatId,
          chatName: resolvedName,
          chatType: v.chatType,
          sessions: v.sessions.size,
          activeBindings: 0,
          inbound: v.inbound,
          replied: v.replied,
          errors: v.errors,
          totalTokens: v.totalTokens,
          cacheHitRate,
          avgLatencyMs: v.latencyCount > 0 ? Math.round(v.latencySum / v.latencyCount) : 0,
          lastActiveMs: v.lastActiveMs,
        }
      })
  }

  private buildChatFilterOptions(filterBotId: string): ObservabilityChatFilterOption[] {
    const byChatId = new Map<string, { name: string; bots: Set<string> }>()
    for (const grp of this.config.listGroups(filterBotId || undefined)) {
      const cur = byChatId.get(grp.chatId) ?? { name: grp.chatName || grp.chatId, bots: new Set() }
      if (grp.chatName && cur.name === grp.chatId) cur.name = grp.chatName
      cur.bots.add(grp.botId)
      byChatId.set(grp.chatId, cur)
    }
    for (const disc of this.config.getDiscoveredChats().values()) {
      if (filterBotId && disc.botId !== filterBotId) continue
      const cur = byChatId.get(disc.chatId) ?? { name: disc.name || disc.chatId, bots: new Set() }
      if (disc.name && cur.name === disc.chatId) cur.name = disc.name
      cur.bots.add(disc.botId)
      byChatId.set(disc.chatId, cur)
    }

    return [...byChatId.entries()]
      .map(([chatId, v]) => ({
        chatId,
        chatName: v.name,
        chatType: 'group' as const,
        botIds: [...v.bots],
      }))
      .sort((a, b) => a.chatName.localeCompare(b.chatName, 'zh-CN'))
  }
}
