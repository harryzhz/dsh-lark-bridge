import { randomUUID } from 'node:crypto'
import { buildGroupKey } from '@dsh-lark/lark-core'
import type {
  LarkAuditEvent,
  LarkBotMetrics,
  LarkGroupTraffic,
  LarkHourlyBucket,
} from '../types.js'
import type { ConfigRepo } from './config-repo.js'
import type { BridgeDatabase } from './database.js'

const MAX_LATENCY_SAMPLES = 80
const MAX_HOURLY_BUCKETS = 48
const AUDIT_PRUNE_INTERVAL = 50

export function formatHourKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}`
}

export class TelemetryRepo {
  private auditInsertCounter = 0

  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: ConfigRepo,
    private readonly maxAuditEvents = 2000,
  ) {}

  recordMetric(input: {
    readonly botId: string
    readonly chatId?: string
    readonly chatName?: string
    readonly kind: 'inbound' | 'replied' | 'listener' | 'silent_skip' | 'ignored' | 'error'
    readonly latencyMs?: number
    readonly now?: number
  }): void {
    const now = input.now ?? Date.now()
    const hourKey = formatHourKey(now)
    const latency =
      input.kind === 'replied' && input.latencyMs !== undefined && input.latencyMs >= 0
        ? Math.round(input.latencyMs)
        : undefined

    this.db.transaction(() => {
      // 1. Hourly bucket upsert
      this.db
        .prepare(
          `INSERT INTO hourly_buckets (
             hour_key, inbound, replied, listener_triggered, silent_skipped,
             ignored, errors, total_latency_ms, latency_samples
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hour_key) DO UPDATE SET
             inbound = inbound + excluded.inbound,
             replied = replied + excluded.replied,
             listener_triggered = listener_triggered + excluded.listener_triggered,
             silent_skipped = silent_skipped + excluded.silent_skipped,
             ignored = ignored + excluded.ignored,
             errors = errors + excluded.errors,
             total_latency_ms = total_latency_ms + excluded.total_latency_ms,
             latency_samples = latency_samples + excluded.latency_samples`,
        )
        .run(
          hourKey,
          input.kind === 'inbound' ? 1 : 0,
          input.kind === 'replied' ? 1 : 0,
          input.kind === 'listener' ? 1 : 0,
          input.kind === 'silent_skip' ? 1 : 0,
          input.kind === 'ignored' ? 1 : 0,
          input.kind === 'error' ? 1 : 0,
          latency ?? 0,
          latency !== undefined ? 1 : 0,
        )
      this.pruneHourlyBuckets()

      // 2. Bot metrics upsert
      const existingBotMetrics = this.db
        .prepare('SELECT latencies_json FROM bot_metrics WHERE bot_id = ?')
        .get(input.botId) as { latencies_json?: string } | undefined
      let latencies: number[] = []
      if (existingBotMetrics?.latencies_json) {
        try {
          const parsed = JSON.parse(existingBotMetrics.latencies_json)
          if (Array.isArray(parsed)) {
            latencies = parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
          }
        } catch {
          latencies = []
        }
      }
      if (latency !== undefined) {
        latencies.push(latency)
        if (latencies.length > MAX_LATENCY_SAMPLES) {
          latencies.splice(0, latencies.length - MAX_LATENCY_SAMPLES)
        }
      }

      this.db
        .prepare(
          `INSERT INTO bot_metrics (
             bot_id, inbound_total, replied_total, listener_triggered_total,
             silent_skipped_total, ignored_total, error_total, latencies_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bot_id) DO UPDATE SET
             inbound_total = inbound_total + excluded.inbound_total,
             replied_total = replied_total + excluded.replied_total,
             listener_triggered_total = listener_triggered_total + excluded.listener_triggered_total,
             silent_skipped_total = silent_skipped_total + excluded.silent_skipped_total,
             ignored_total = ignored_total + excluded.ignored_total,
             error_total = error_total + excluded.error_total,
             latencies_json = excluded.latencies_json`,
        )
        .run(
          input.botId,
          input.kind === 'inbound' ? 1 : 0,
          input.kind === 'replied' ? 1 : 0,
          input.kind === 'listener' ? 1 : 0,
          input.kind === 'silent_skip' ? 1 : 0,
          input.kind === 'ignored' ? 1 : 0,
          input.kind === 'error' ? 1 : 0,
          JSON.stringify(latencies),
        )

      // 3. Group traffic upsert
      if (input.chatId && (input.kind === 'inbound' || input.kind === 'replied')) {
        const gKey = buildGroupKey(input.botId, input.chatId)
        const knownName =
          input.chatName || this.config.resolveChatName(input.botId, input.chatId) || input.chatId
        this.db
          .prepare(
            `INSERT INTO group_traffic (
               key, bot_id, chat_id, chat_name, inbound_total, replied_total, last_active_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               chat_name = CASE WHEN ? != '' THEN ? ELSE group_traffic.chat_name END,
               inbound_total = inbound_total + excluded.inbound_total,
               replied_total = replied_total + excluded.replied_total,
               last_active_ms = excluded.last_active_ms`,
          )
          .run(
            gKey,
            input.botId,
            input.chatId,
            knownName,
            input.kind === 'inbound' ? 1 : 0,
            input.kind === 'replied' ? 1 : 0,
            now,
            input.chatName ?? '',
            input.chatName ?? knownName,
          )
      }
    })
  }

  recordEvent(input: Omit<LarkAuditEvent, 'id' | 'timestampMs'>): LarkAuditEvent {
    const bot = this.config.getBot(input.botId)
    const chatName =
      input.chatName ?? (input.chatId ? this.config.resolveChatName(input.botId, input.chatId) : undefined)
    const event: LarkAuditEvent = {
      id: randomUUID(),
      timestampMs: Date.now(),
      botName: input.botName ?? bot?.name,
      chatName,
      ...input,
    }
    this.db
      .prepare(
        `INSERT INTO audit_events (
           id, timestamp_ms, bot_id, bot_name, chat_id, chat_name,
           route_key, session_id, trace_id, duration_ms, kind, summary
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.timestampMs,
        event.botId,
        event.botName ?? null,
        event.chatId ?? null,
        event.chatName ?? null,
        event.routeKey ?? null,
        event.sessionId ?? null,
        event.traceId ?? null,
        event.durationMs ?? null,
        event.kind,
        event.summary,
      )
    this.auditInsertCounter += 1
    if (this.auditInsertCounter >= AUDIT_PRUNE_INTERVAL) {
      this.auditInsertCounter = 0
      this.pruneAuditEvents()
    }
    return event
  }

  listEvents(limit = 100): LarkAuditEvent[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit) || 100, this.maxAuditEvents))
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY timestamp_ms DESC, seq DESC LIMIT ?')
      .all(bounded) as unknown as AuditEventRow[]
    return rows.map((r) => this.hydrateEvent(r))
  }

  listEventsByTrace(traceId: string): LarkAuditEvent[] {
    const clean = traceId.trim()
    if (!clean) return []
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE trace_id = ? ORDER BY timestamp_ms ASC, seq ASC')
      .all(clean) as unknown as AuditEventRow[]
    return rows.map((r) => this.hydrateEvent(r))
  }

  pruneAuditEvents(): number {
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM audit_events').get() as {
      cnt?: number
    }
    const excess = Number(countRow?.cnt ?? 0) - this.maxAuditEvents
    if (excess <= 0) return 0
    return Number(
      this.db
        .prepare(
          `DELETE FROM audit_events WHERE seq IN (
             SELECT seq FROM audit_events ORDER BY timestamp_ms ASC, seq ASC LIMIT ?
           )`,
        )
        .run(excess).changes,
    )
  }

  listHourlyBucketsMap(): Map<string, LarkHourlyBucket> {
    const rows = this.db.prepare('SELECT * FROM hourly_buckets').all() as Array<{
      hour_key: string
      inbound: number
      replied: number
      listener_triggered: number
      silent_skipped: number
      ignored: number
      errors: number
      total_latency_ms: number
      latency_samples: number
    }>
    const map = new Map<string, LarkHourlyBucket>()
    for (const r of rows) {
      map.set(r.hour_key, {
        hourKey: r.hour_key,
        inbound: Number(r.inbound),
        replied: Number(r.replied),
        listenerTriggered: Number(r.listener_triggered),
        silentSkipped: Number(r.silent_skipped),
        ignored: Number(r.ignored),
        errors: Number(r.errors),
        totalLatencyMs: Number(r.total_latency_ms),
        latencySamples: Number(r.latency_samples),
      })
    }
    return map
  }

  listBotMetricsMap(): Map<string, LarkBotMetrics> {
    const rows = this.db.prepare('SELECT * FROM bot_metrics').all() as Array<{
      bot_id: string
      inbound_total: number
      replied_total: number
      listener_triggered_total: number
      silent_skipped_total: number
      ignored_total: number
      error_total: number
      latencies_json: string
    }>
    const map = new Map<string, LarkBotMetrics>()
    for (const r of rows) {
      let latenciesMs: number[] = []
      try {
        const parsed = JSON.parse(r.latencies_json)
        if (Array.isArray(parsed)) {
          latenciesMs = parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        }
      } catch {
        latenciesMs = []
      }
      map.set(r.bot_id, {
        botId: r.bot_id,
        inboundTotal: Number(r.inbound_total),
        repliedTotal: Number(r.replied_total),
        listenerTriggeredTotal: Number(r.listener_triggered_total),
        silentSkippedTotal: Number(r.silent_skipped_total),
        ignoredTotal: Number(r.ignored_total),
        errorTotal: Number(r.error_total),
        latenciesMs,
      })
    }
    return map
  }

  listGroupTrafficMap(): Map<string, LarkGroupTraffic> {
    const rows = this.db.prepare('SELECT * FROM group_traffic').all() as Array<{
      key: string
      bot_id: string
      chat_id: string
      chat_name: string
      inbound_total: number
      replied_total: number
      last_active_ms: number
    }>
    const map = new Map<string, LarkGroupTraffic>()
    for (const r of rows) {
      map.set(r.key, {
        key: r.key,
        botId: r.bot_id,
        chatId: r.chat_id,
        chatName: r.chat_name,
        inboundTotal: Number(r.inbound_total),
        repliedTotal: Number(r.replied_total),
        lastActiveMs: Number(r.last_active_ms),
      })
    }
    return map
  }

  private pruneHourlyBuckets(): void {
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM hourly_buckets').get() as {
      cnt?: number
    }
    const excess = Number(countRow?.cnt ?? 0) - MAX_HOURLY_BUCKETS
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM hourly_buckets WHERE hour_key IN (
           SELECT hour_key FROM hourly_buckets ORDER BY hour_key ASC LIMIT ?
         )`,
      )
      .run(excess)
  }

  private hydrateEvent(row: AuditEventRow): LarkAuditEvent {
    return {
      id: row.id,
      timestampMs: Number(row.timestamp_ms),
      botId: row.bot_id,
      ...(row.bot_name ? { botName: row.bot_name } : {}),
      ...(row.chat_id ? { chatId: row.chat_id } : {}),
      ...(row.chat_name ? { chatName: row.chat_name } : {}),
      ...(row.route_key ? { routeKey: row.route_key } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.trace_id ? { traceId: row.trace_id } : {}),
      ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
      kind: row.kind as LarkAuditEvent['kind'],
      summary: row.summary,
    }
  }
}

interface AuditEventRow {
  seq: number
  id: string
  timestamp_ms: number
  bot_id: string
  bot_name: string | null
  chat_id: string | null
  chat_name: string | null
  route_key: string | null
  session_id: string | null
  trace_id: string | null
  duration_ms: number | null
  kind: string
  summary: string
}
