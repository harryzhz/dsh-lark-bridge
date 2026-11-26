import {
  LarkReminderItemSchema,
  type LarkReminderItem,
  type SeenMessageEntry,
} from '@dsh-lark/lark-core'
import type {
  LarkDreamRunState,
  LarkDreamSession,
  LarkManagedSession,
  LarkPendingTurn,
  LarkSessionBinding,
  LarkTriageSession,
} from '../types.js'
import type { BridgeDatabase } from './database.js'

const MAX_MANAGED_SESSIONS = 600
const MAX_DREAM_SESSIONS = 100
const MAX_TRIAGE_SESSIONS = 200
const MAX_ARCHIVED_REMINDERS = 300
const MAX_SEEN_MESSAGES = 2000
const SEEN_MESSAGE_TTL_MS = 24 * 60 * 60_000
const SEEN_PRUNE_INTERVAL = 50
const MAX_EXTERNAL_SESSION_LINKS = 5000
const EXTERNAL_LINK_PRUNE_INTERVAL = 100

interface BindingRow {
  route_key: string
  session_id: string
  bot_id: string
  bot_name: string | null
  lark_app_id: string
  chat_type: string | null
  chat_id: string
  chat_name: string | null
  user_open_id: string | null
  user_name: string | null
  workspace_name: string
  agent_preset: string
  runtime_profile_id: string | null
  model: string | null
  reasoning_effort: string | null
  working_dir: string
  trigger: string
  listener_name: string | null
  has_replied: number | null
  created_at_ms: number
  last_activity_ms: number
  idle_close_ms: number | null
}

function normalizeAliases(primaryRouteKey: string, aliases?: readonly string[]): string[] {
  if (!aliases || aliases.length === 0) return []
  const out: string[] = []
  for (const raw of aliases) {
    const clean = raw.trim()
    if (!clean || clean === primaryRouteKey || out.includes(clean)) continue
    out.push(clean)
  }
  return out
}

export class RuntimeRepo {
  private seenInsertCounter = 0
  private externalLinkInsertCounter = 0

  constructor(private readonly db: BridgeDatabase) {}

  // ── Seen Messages (24h dedup) ───────────────────────────────────────────

  listSeenMessages(now = Date.now()): SeenMessageEntry[] {
    if (!this.db.readOnly) {
      this.pruneSeenMessages(now)
    }
    const cutoff = now - SEEN_MESSAGE_TTL_MS
    const rows = this.db
      .prepare('SELECT key, seen_at_ms FROM seen_messages WHERE seen_at_ms > ? ORDER BY seen_at_ms ASC')
      .all(cutoff) as Array<{ key: string; seen_at_ms: number }>
    return rows.map((r) => ({ key: r.key, seenAtMs: Number(r.seen_at_ms) }))
  }

  rememberSeenMessage(key: string, seenAtMs = Date.now()): void {
    if (!key) return
    this.db
      .prepare(
        `INSERT INTO seen_messages (key, seen_at_ms) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET seen_at_ms = excluded.seen_at_ms`,
      )
      .run(key, seenAtMs)
    this.seenInsertCounter += 1
    if (this.seenInsertCounter >= SEEN_PRUNE_INTERVAL) {
      this.seenInsertCounter = 0
      this.pruneSeenMessages(seenAtMs)
    }
  }

  pruneSeenMessages(now = Date.now()): number {
    const cutoff = now - SEEN_MESSAGE_TTL_MS
    let deleted = Number(
      this.db.prepare('DELETE FROM seen_messages WHERE seen_at_ms <= ?').run(cutoff).changes,
    )
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM seen_messages').get() as {
      cnt?: number
    }
    const excess = Number(countRow?.cnt ?? 0) - MAX_SEEN_MESSAGES
    if (excess > 0) {
      deleted += Number(
        this.db
          .prepare(
            `DELETE FROM seen_messages WHERE key IN (
               SELECT key FROM seen_messages ORDER BY seen_at_ms ASC LIMIT ?
             )`,
          )
          .run(excess).changes,
      )
    }
    return deleted
  }

  // ── Session Bindings & Route Aliases ────────────────────────────────────

  listRawBindings(): LarkSessionBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM session_bindings ORDER BY last_activity_ms DESC')
      .all() as unknown as BindingRow[]
    if (rows.length === 0) return []
    const aliasMap = this.loadAllAliasesByPrimary()
    return rows.map((row) => this.hydrateBinding(row, aliasMap.get(row.route_key)))
  }

  getBinding(routeKey: string): LarkSessionBinding | undefined {
    const primaryKey = this.resolvePrimaryRouteKey(routeKey)
    const row = this.db
      .prepare('SELECT * FROM session_bindings WHERE route_key = ?')
      .get(primaryKey) as unknown as BindingRow | undefined
    if (!row) return undefined
    const aliases = this.listAliasesForPrimary(primaryKey)
    return this.hydrateBinding(row, aliases)
  }

  getBindingBySessionId(sessionId: string): LarkSessionBinding | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_bindings WHERE session_id = ? LIMIT 1')
      .get(sessionId) as unknown as BindingRow | undefined
    if (!row) return undefined
    const aliases = this.listAliasesForPrimary(row.route_key)
    return this.hydrateBinding(row, aliases)
  }

  upsertBinding(binding: LarkSessionBinding): void {
    this.db.transaction(() => {
      const prevRow = this.db
        .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
        .get(binding.routeKey) as { session_id?: string } | undefined
      const prevAliases =
        prevRow && prevRow.session_id === binding.sessionId
          ? this.listAliasesForPrimary(binding.routeKey)
          : undefined

      // Detach this primary routeKey if it used to be an alias of another binding.
      this.db.prepare('DELETE FROM binding_aliases WHERE alias_route_key = ?').run(binding.routeKey)

      const rawAliases =
        binding.aliasRouteKeys !== undefined ? binding.aliasRouteKeys : prevAliases
      const validAliases = normalizeAliases(binding.routeKey, rawAliases).filter((alias) => {
        const directOwner = this.db
          .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
          .get(alias) as { session_id?: string } | undefined
        return !directOwner || directOwner.session_id === binding.sessionId
      })

      this.db
        .prepare(
          `INSERT INTO session_bindings (
             route_key, session_id, bot_id, bot_name, lark_app_id, chat_type, chat_id, chat_name,
             user_open_id, user_name, workspace_name, agent_preset, runtime_profile_id, model,
             reasoning_effort, working_dir, trigger, listener_name, has_replied, created_at_ms,
             last_activity_ms, idle_close_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(route_key) DO UPDATE SET
             session_id = excluded.session_id,
             bot_id = excluded.bot_id,
             bot_name = excluded.bot_name,
             lark_app_id = excluded.lark_app_id,
             chat_type = excluded.chat_type,
             chat_id = excluded.chat_id,
             chat_name = excluded.chat_name,
             user_open_id = excluded.user_open_id,
             user_name = excluded.user_name,
             workspace_name = excluded.workspace_name,
             agent_preset = excluded.agent_preset,
             runtime_profile_id = excluded.runtime_profile_id,
             model = excluded.model,
             reasoning_effort = excluded.reasoning_effort,
             working_dir = excluded.working_dir,
             trigger = excluded.trigger,
             listener_name = excluded.listener_name,
             has_replied = excluded.has_replied,
             created_at_ms = excluded.created_at_ms,
             last_activity_ms = excluded.last_activity_ms,
             idle_close_ms = excluded.idle_close_ms`,
        )
        .run(
          binding.routeKey,
          binding.sessionId,
          binding.botId,
          binding.botName ?? null,
          binding.larkAppId ?? '',
          binding.chatType ?? null,
          binding.chatId,
          binding.chatName ?? null,
          binding.userOpenId ?? null,
          binding.userName ?? null,
          binding.workspaceName ?? '',
          binding.agentPreset ?? 'codex',
          binding.runtimeProfileId ?? null,
          binding.model ?? null,
          binding.reasoningEffort ?? null,
          binding.workingDir ?? '',
          binding.trigger ?? 'mention',
          binding.listenerName ?? null,
          typeof binding.hasReplied === 'boolean' ? (binding.hasReplied ? 1 : 0) : null,
          binding.createdAtMs ?? Date.now(),
          binding.lastActivityMs ?? Date.now(),
          binding.idleCloseMs ?? null,
        )

      // Replace aliases cleanly.
      this.db
        .prepare('DELETE FROM binding_aliases WHERE primary_route_key = ?')
        .run(binding.routeKey)
      const insertAlias = this.db.prepare(
        `INSERT INTO binding_aliases (alias_route_key, primary_route_key)
         VALUES (?, ?)
         ON CONFLICT(alias_route_key) DO UPDATE SET primary_route_key = excluded.primary_route_key`,
      )
      for (const alias of validAliases) {
        insertAlias.run(alias, binding.routeKey)
      }

      const now = Date.now()
      const createdAtMs = binding.createdAtMs ?? now
      const lastActivityMs = binding.lastActivityMs ?? now
      this.upsertManagedSession({
        sessionId: binding.sessionId,
        botId: binding.botId,
        chatId: binding.chatId,
        routeKey: binding.routeKey,
        trigger: binding.trigger,
        createdAtMs,
        lastActivityMs,
        ...(binding.idleCloseMs ? { idleCloseMs: binding.idleCloseMs } : {}),
      })
    })
  }

  bindRouteAlias(routeKey: string, aliasRouteKey: string): boolean {
    const cleanAlias = aliasRouteKey.trim()
    if (!cleanAlias) return false
    return this.db.transaction(() => {
      const primaryKey = this.resolvePrimaryRouteKey(routeKey)
      const existing = this.db
        .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
        .get(primaryKey) as { session_id?: string } | undefined
      if (!existing || cleanAlias === primaryKey) return false

      const existingAliasOwner = this.db
        .prepare('SELECT primary_route_key FROM binding_aliases WHERE alias_route_key = ?')
        .get(cleanAlias) as { primary_route_key?: string } | undefined
      if (existingAliasOwner?.primary_route_key === primaryKey) return false

      const directOwner = this.db
        .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
        .get(cleanAlias) as { session_id?: string } | undefined
      if (directOwner && directOwner.session_id !== existing.session_id) {
        return false
      }

      // Invariant: one thread-scoped session binding may own at most one native Feishu thread (`omt_*`).
      const aliasScope = cleanAlias.split(':').slice(2).join(':')
      if (aliasScope.startsWith('omt_')) {
        const currentKeys = [primaryKey, ...this.listAliasesForPrimary(primaryKey)]
        const existingThreads = currentKeys
          .map((k) => k.split(':').slice(2).join(':'))
          .filter((scope) => scope.startsWith('omt_'))
        if (existingThreads.length > 0 && !existingThreads.includes(aliasScope)) {
          return false
        }
      }

      this.db
        .prepare(
          `INSERT INTO binding_aliases (alias_route_key, primary_route_key)
           VALUES (?, ?)
           ON CONFLICT(alias_route_key) DO UPDATE SET primary_route_key = excluded.primary_route_key`,
        )
        .run(cleanAlias, primaryKey)
      return true
    })
  }

  /**
   * Atomically transfers a binding's primary routeKey to a newly promoted native-thread root
   * (`newPrimaryRouteKey`) and detaches all pre-promotion main-stream route keys/aliases so
   * sibling quote replies on the old main-stream root can never hijack this promoted thread.
   */
  promoteBindingRoute(
    oldRouteKey: string,
    newPrimaryRouteKey: string,
  ): LarkSessionBinding | undefined {
    const cleanNext = newPrimaryRouteKey.trim()
    if (!cleanNext) return undefined
    return this.db.transaction(() => {
      const primaryKey = this.resolvePrimaryRouteKey(oldRouteKey)
      const row = this.db
        .prepare('SELECT * FROM session_bindings WHERE route_key = ?')
        .get(primaryKey) as unknown as BindingRow | undefined
      if (!row) return undefined
      if (primaryKey === cleanNext) {
        return this.hydrateBinding(row, this.listAliasesForPrimary(primaryKey))
      }

      const conflict = this.db
        .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
        .get(cleanNext) as { session_id?: string } | undefined
      if (conflict && conflict.session_id !== row.session_id) {
        return undefined
      }

      // Clear old pre-promotion aliases referencing `primaryKey` (and any stale alias for `cleanNext`).
      this.db.prepare('DELETE FROM binding_aliases WHERE primary_route_key = ?').run(primaryKey)
      this.db.prepare('DELETE FROM binding_aliases WHERE alias_route_key = ?').run(cleanNext)
      this.db
        .prepare('UPDATE session_bindings SET route_key = ? WHERE route_key = ?')
        .run(cleanNext, primaryKey)
      this.db
        .prepare(
          'UPDATE managed_sessions SET route_key = ? WHERE session_id = ? AND route_key = ?',
        )
        .run(cleanNext, row.session_id, primaryKey)

      const updated = this.db
        .prepare('SELECT * FROM session_bindings WHERE route_key = ?')
        .get(cleanNext) as unknown as BindingRow | undefined
      return updated ? this.hydrateBinding(updated, this.listAliasesForPrimary(cleanNext)) : undefined
    })
  }

  touchBinding(routeKey: string, now = Date.now()): void {
    this.db.transaction(() => {
      const primaryKey = this.resolvePrimaryRouteKey(routeKey)
      const existing = this.db
        .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
        .get(primaryKey) as { session_id?: string } | undefined
      if (!existing?.session_id) return
      this.db
        .prepare('UPDATE session_bindings SET last_activity_ms = ? WHERE route_key = ?')
        .run(now, primaryKey)
      this.db
        .prepare(
          'UPDATE managed_sessions SET last_activity_ms = ? WHERE session_id = ? AND archived_at_ms IS NULL',
        )
        .run(now, existing.session_id)
    })
  }

  markBindingReplied(routeKey: string, now = Date.now()): void {
    this.db.transaction(() => {
      const primaryKey = this.resolvePrimaryRouteKey(routeKey)
      const existing = this.db
        .prepare('SELECT session_id FROM session_bindings WHERE route_key = ?')
        .get(primaryKey) as { session_id?: string } | undefined
      if (!existing?.session_id) return
      this.db
        .prepare(
          'UPDATE session_bindings SET has_replied = 1, last_activity_ms = ? WHERE route_key = ?',
        )
        .run(now, primaryKey)
      this.db
        .prepare(
          'UPDATE managed_sessions SET last_activity_ms = ? WHERE session_id = ? AND archived_at_ms IS NULL',
        )
        .run(now, existing.session_id)
    })
  }

  deleteBinding(routeKey: string): LarkSessionBinding | undefined {
    return this.db.transaction(() => {
      const existing = this.getBinding(routeKey)
      if (!existing) return undefined
      // binding_aliases rows cascade automatically via FK ON DELETE CASCADE.
      this.db.prepare('DELETE FROM session_bindings WHERE route_key = ?').run(existing.routeKey)
      return existing
    })
  }

  // ── Managed Sessions ────────────────────────────────────────────────────

  getManagedSession(sessionId: string): LarkManagedSession | undefined {
    const row = this.db
      .prepare('SELECT * FROM managed_sessions WHERE session_id = ?')
      .get(sessionId) as
      | {
          session_id: string
          bot_id: string
          chat_id: string
          route_key: string | null
          trigger: string | null
          created_at_ms: number
          last_activity_ms: number
          idle_close_ms: number | null
          archived_at_ms: number | null
        }
      | undefined
    return row ? this.hydrateManagedSession(row) : undefined
  }

  upsertManagedSession(entry: LarkManagedSession): void {
    this.db.transaction(() => {
      const existing = this.getManagedSession(entry.sessionId)
      const merged: LarkManagedSession = {
        ...(existing ?? {}),
        ...entry,
      }
      const now = Date.now()
      this.db
        .prepare(
          `INSERT INTO managed_sessions (
             session_id, bot_id, chat_id, route_key, trigger, created_at_ms,
             last_activity_ms, idle_close_ms, archived_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             bot_id = excluded.bot_id,
             chat_id = excluded.chat_id,
             route_key = excluded.route_key,
             trigger = excluded.trigger,
             created_at_ms = excluded.created_at_ms,
             last_activity_ms = excluded.last_activity_ms,
             idle_close_ms = excluded.idle_close_ms,
             archived_at_ms = excluded.archived_at_ms`,
        )
        .run(
          merged.sessionId,
          merged.botId,
          merged.chatId ?? '',
          merged.routeKey ?? null,
          merged.trigger ?? null,
          merged.createdAtMs ?? now,
          merged.lastActivityMs ?? now,
          merged.idleCloseMs ?? null,
          merged.archivedAtMs ?? null,
        )
      this.pruneManagedSessions()
    })
  }

  touchManagedSession(sessionId: string, now = Date.now()): void {
    this.db
      .prepare(
        'UPDATE managed_sessions SET last_activity_ms = ? WHERE session_id = ? AND archived_at_ms IS NULL',
      )
      .run(now, sessionId)
  }

  markSessionArchived(sessionId: string, now = Date.now()): void {
    this.db
      .prepare(
        'UPDATE managed_sessions SET archived_at_ms = ? WHERE session_id = ? AND archived_at_ms IS NULL',
      )
      .run(now, sessionId)
  }

  listActiveManagedSessions(): LarkManagedSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM managed_sessions
         WHERE archived_at_ms IS NULL
         ORDER BY created_at_ms ASC`,
      )
      .all() as Array<{
      session_id: string
      bot_id: string
      chat_id: string
      route_key: string | null
      trigger: string | null
      created_at_ms: number
      last_activity_ms: number
      idle_close_ms: number | null
      archived_at_ms: number | null
    }>
    return rows.map((r) => this.hydrateManagedSession(r))
  }

  listExpiredManagedSessions(now = Date.now()): LarkManagedSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM managed_sessions
         WHERE archived_at_ms IS NULL
           AND idle_close_ms IS NOT NULL
           AND idle_close_ms > 0
           AND (? - last_activity_ms) >= idle_close_ms`,
      )
      .all(now) as Array<{
      session_id: string
      bot_id: string
      chat_id: string
      route_key: string | null
      trigger: string | null
      created_at_ms: number
      last_activity_ms: number
      idle_close_ms: number | null
      archived_at_ms: number | null
    }>
    return rows.map((r) => this.hydrateManagedSession(r))
  }

  listManagedSessionsForBot(botId: string): LarkManagedSession[] {
    const rows = this.db
      .prepare('SELECT * FROM managed_sessions WHERE bot_id = ? ORDER BY last_activity_ms DESC')
      .all(botId) as Array<{
      session_id: string
      bot_id: string
      chat_id: string
      route_key: string | null
      trigger: string | null
      created_at_ms: number
      last_activity_ms: number
      idle_close_ms: number | null
      archived_at_ms: number | null
    }>
    return rows.map((r) => this.hydrateManagedSession(r))
  }

  listAllManagedSessions(limit = 600): LarkManagedSession[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit) || 600, MAX_MANAGED_SESSIONS))
    const rows = this.db
      .prepare('SELECT * FROM managed_sessions ORDER BY last_activity_ms DESC LIMIT ?')
      .all(bounded) as Array<{
      session_id: string
      bot_id: string
      chat_id: string
      route_key: string | null
      trigger: string | null
      created_at_ms: number
      last_activity_ms: number
      idle_close_ms: number | null
      archived_at_ms: number | null
    }>
    return rows.map((r) => this.hydrateManagedSession(r))
  }

  // ── Dreaming States & Sessions ──────────────────────────────────────────

  getDreamState(botId: string): LarkDreamRunState | undefined {
    const row = this.db
      .prepare('SELECT * FROM dream_states WHERE bot_id = ?')
      .get(botId) as
      | {
          bot_id: string
          status: string
          last_dream_at_ms: number | null
          last_checked_date_key: string | null
          last_session_id: string | null
          last_processed_count: number | null
          last_summary: string | null
          processed_session_ids_json: string
        }
      | undefined
    if (!row) return undefined
    let ids: string[] = []
    try {
      const parsed = JSON.parse(row.processed_session_ids_json)
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string')
    } catch {
      ids = []
    }
    const status =
      row.status === 'running' ||
      row.status === 'succeeded' ||
      row.status === 'skipped' ||
      row.status === 'failed'
        ? row.status
        : 'idle'
    return {
      botId: row.bot_id,
      status,
      ...(row.last_dream_at_ms !== null ? { lastDreamAtMs: Number(row.last_dream_at_ms) } : {}),
      ...(row.last_checked_date_key ? { lastCheckedDateKey: row.last_checked_date_key } : {}),
      ...(row.last_session_id ? { lastSessionId: row.last_session_id } : {}),
      ...(row.last_processed_count !== null
        ? { lastProcessedCount: Number(row.last_processed_count) }
        : {}),
      ...(row.last_summary !== null ? { lastSummary: row.last_summary } : {}),
      processedSessionIds: ids,
    }
  }

  upsertDreamState(state: LarkDreamRunState): LarkDreamRunState {
    const cappedIds =
      state.processedSessionIds.length > 400
        ? state.processedSessionIds.slice(state.processedSessionIds.length - 400)
        : [...state.processedSessionIds]
    const normalized: LarkDreamRunState = {
      ...state,
      processedSessionIds: cappedIds,
    }
    this.db
      .prepare(
        `INSERT INTO dream_states (
           bot_id, status, last_dream_at_ms, last_checked_date_key, last_session_id,
           last_processed_count, last_summary, processed_session_ids_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           status = excluded.status,
           last_dream_at_ms = excluded.last_dream_at_ms,
           last_checked_date_key = excluded.last_checked_date_key,
           last_session_id = excluded.last_session_id,
           last_processed_count = excluded.last_processed_count,
           last_summary = excluded.last_summary,
           processed_session_ids_json = excluded.processed_session_ids_json`,
      )
      .run(
        normalized.botId,
        normalized.status,
        normalized.lastDreamAtMs ?? null,
        normalized.lastCheckedDateKey ?? null,
        normalized.lastSessionId ?? null,
        normalized.lastProcessedCount ?? null,
        normalized.lastSummary ?? null,
        JSON.stringify(normalized.processedSessionIds),
      )
    return normalized
  }

  recoverInterruptedDreamSessions(): number {
    const rows = this.db
      .prepare("SELECT session_id, payload_json FROM dream_sessions WHERE status = 'running'")
      .all() as Array<{ session_id: string; payload_json: string }>
    const runningStates = this.db
      .prepare("SELECT bot_id FROM dream_states WHERE status = 'running'")
      .all() as Array<{ bot_id: string }>
    if (rows.length === 0 && runningStates.length === 0) return 0
    this.db.transaction(() => {
      const updateStmt = this.db.prepare(
        "UPDATE dream_sessions SET status = 'failed', payload_json = ? WHERE session_id = ?",
      )
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payload_json) as LarkDreamSession
          const next: LarkDreamSession = {
            ...parsed,
            status: 'failed',
            summary: '执行因服务重启中断',
          }
          updateStmt.run(JSON.stringify(next), row.session_id)
        } catch {
          // Ignore malformed payload.
        }
      }
      if (runningStates.length > 0) {
        this.db
          .prepare(
            "UPDATE dream_states SET status = 'failed', last_summary = '执行因服务重启中断' WHERE status = 'running'",
          )
          .run()
      }
    })
    return rows.length || runningStates.length
  }

  hasDreamSession(sessionId: string): boolean {
    if (!sessionId) return false
    const row = this.db
      .prepare('SELECT 1 AS hit FROM dream_sessions WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { hit?: number } | undefined
    return Boolean(row?.hit)
  }

  listRawDreamSessions(botId?: string): LarkDreamSession[] {
    const rows = (
      botId
        ? this.db
            .prepare(
              'SELECT payload_json FROM dream_sessions WHERE bot_id = ? ORDER BY last_activity_ms DESC',
            )
            .all(botId)
        : this.db
            .prepare('SELECT payload_json FROM dream_sessions ORDER BY last_activity_ms DESC')
            .all()
    ) as Array<{ payload_json: string }>
    const out: LarkDreamSession[] = []
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payload_json) as LarkDreamSession)
      } catch {
        // Skip malformed entry.
      }
    }
    return out
  }

  upsertDreamSession(entry: LarkDreamSession): LarkDreamSession {
    return this.db.transaction(() => {
      const existingRow = this.db
        .prepare('SELECT payload_json FROM dream_sessions WHERE session_id = ?')
        .get(entry.sessionId) as { payload_json?: string } | undefined
      const existing = existingRow?.payload_json
        ? (JSON.parse(existingRow.payload_json) as LarkDreamSession)
        : undefined
      const next: LarkDreamSession = {
        ...(existing ?? {}),
        ...entry,
      }
      this.db
        .prepare(
          `INSERT INTO dream_sessions (session_id, bot_id, status, date_key, last_activity_ms, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             bot_id = excluded.bot_id,
             status = excluded.status,
             date_key = excluded.date_key,
             last_activity_ms = excluded.last_activity_ms,
             payload_json = excluded.payload_json`,
        )
        .run(
          next.sessionId,
          next.botId,
          next.status,
          next.dateKey,
          next.lastActivityMs,
          JSON.stringify(next),
        )
      this.pruneDreamSessions()
      return next
    })
  }

  deleteDreamSession(sessionId: string): boolean {
    const res = this.db.prepare('DELETE FROM dream_sessions WHERE session_id = ?').run(sessionId)
    return Number(res.changes) > 0
  }

  // ── Smart Triage Sessions ───────────────────────────────────────────────

  listRawTriageSessions(botId?: string): LarkTriageSession[] {
    const rows = (
      botId
        ? this.db
            .prepare(
              'SELECT payload_json FROM triage_sessions WHERE bot_id = ? ORDER BY last_activity_ms DESC',
            )
            .all(botId)
        : this.db
            .prepare('SELECT payload_json FROM triage_sessions ORDER BY last_activity_ms DESC')
            .all()
    ) as Array<{ payload_json: string }>
    const out: LarkTriageSession[] = []
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payload_json) as LarkTriageSession)
      } catch {
        // Skip malformed entry.
      }
    }
    return out
  }

  upsertTriageSession(entry: LarkTriageSession): LarkTriageSession {
    return this.db.transaction(() => {
      const existingRow = this.db
        .prepare('SELECT payload_json FROM triage_sessions WHERE session_id = ?')
        .get(entry.sessionId) as { payload_json?: string } | undefined
      const existing = existingRow?.payload_json
        ? (JSON.parse(existingRow.payload_json) as LarkTriageSession)
        : undefined
      const next: LarkTriageSession = {
        ...(existing ?? {}),
        ...entry,
      }
      this.db
        .prepare(
          `INSERT INTO triage_sessions (
             session_id, bot_id, chat_id, action, created_at_ms, last_activity_ms, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             bot_id = excluded.bot_id,
             chat_id = excluded.chat_id,
             action = excluded.action,
             created_at_ms = excluded.created_at_ms,
             last_activity_ms = excluded.last_activity_ms,
             payload_json = excluded.payload_json`,
        )
        .run(
          next.sessionId,
          next.botId,
          next.chatId,
          next.action,
          next.createdAtMs,
          next.lastActivityMs,
          JSON.stringify(next),
        )
      this.pruneTriageSessions()
      return next
    })
  }

  linkTriageHandoffSession(triageSessionId: string, handoffSessionId: string): boolean {
    const row = this.db
      .prepare('SELECT payload_json FROM triage_sessions WHERE session_id = ?')
      .get(triageSessionId) as { payload_json?: string } | undefined
    if (!row?.payload_json) return false
    try {
      const parsed = JSON.parse(row.payload_json) as LarkTriageSession
      const next: LarkTriageSession = { ...parsed, handoffSessionId }
      const res = this.db
        .prepare('UPDATE triage_sessions SET payload_json = ? WHERE session_id = ?')
        .run(JSON.stringify(next), triageSessionId)
      return Number(res.changes) > 0
    } catch {
      return false
    }
  }

  deleteTriageSession(sessionId: string): boolean {
    const res = this.db.prepare('DELETE FROM triage_sessions WHERE session_id = ?').run(sessionId)
    return Number(res.changes) > 0
  }

  clearTriageSessions(botId?: string): number {
    const res = botId
      ? this.db.prepare('DELETE FROM triage_sessions WHERE bot_id = ?').run(botId)
      : this.db.prepare('DELETE FROM triage_sessions').run()
    return Number(res.changes)
  }

  // ── Reminders ───────────────────────────────────────────────────────────

  listReminders(filter: 'active' | 'archived' | 'all' = 'all'): LarkReminderItem[] {
    let sql = 'SELECT payload_json FROM reminders'
    if (filter === 'active') sql += " WHERE status != 'archived'"
    if (filter === 'archived') sql += " WHERE status = 'archived'"
    const rows = this.db.prepare(sql).all() as Array<{ payload_json: string }>
    const items: LarkReminderItem[] = []
    for (const row of rows) {
      try {
        const parsed = LarkReminderItemSchema.safeParse(JSON.parse(row.payload_json))
        if (parsed.success) items.push(parsed.data)
      } catch {
        // Skip malformed row.
      }
    }
    return items.sort((a, b) => {
      if (a.status === 'archived' && b.status === 'archived') {
        return (b.archivedAtMs ?? b.updatedAtMs) - (a.archivedAtMs ?? a.updatedAtMs)
      }
      if (a.status === 'archived') return 1
      if (b.status === 'archived') return -1
      return Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)
    })
  }

  findReminderOriginBySessionId(
    sessionId: string,
  ): { readonly botId: string; readonly chatId?: string } | undefined {
    if (!sessionId) return undefined
    const row = this.db
      .prepare(
        `SELECT bot_id, json_extract(payload_json, '$.origin.chatId') AS chat_id
         FROM reminders
         WHERE json_extract(payload_json, '$.lastSessionId') = ?
         LIMIT 1`,
      )
      .get(sessionId) as { bot_id?: string; chat_id?: string | null } | undefined
    if (!row?.bot_id) return undefined
    return {
      botId: String(row.bot_id),
      ...(row.chat_id ? { chatId: String(row.chat_id) } : {}),
    }
  }

  getReminder(id: string): LarkReminderItem | undefined {
    const row = this.db
      .prepare('SELECT payload_json FROM reminders WHERE id = ?')
      .get(id) as { payload_json?: string } | undefined
    if (!row?.payload_json) return undefined
    try {
      const parsed = LarkReminderItemSchema.safeParse(JSON.parse(row.payload_json))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  upsertReminder(raw: unknown): LarkReminderItem {
    const parsed = LarkReminderItemSchema.parse(raw)
    const parsedSched = Date.parse(parsed.scheduledAt)
    const scheduledAtMs = Number.isFinite(parsedSched) ? parsedSched : parsed.updatedAtMs
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reminders (id, bot_id, status, scheduled_at, scheduled_at_ms, updated_at_ms, archived_at_ms, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             bot_id = excluded.bot_id,
             status = excluded.status,
             scheduled_at = excluded.scheduled_at,
             scheduled_at_ms = excluded.scheduled_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             archived_at_ms = excluded.archived_at_ms,
             payload_json = excluded.payload_json`,
        )
        .run(
          parsed.id,
          parsed.origin.botId,
          parsed.status,
          parsed.scheduledAt,
          scheduledAtMs,
          parsed.updatedAtMs,
          parsed.archivedAtMs ?? null,
          JSON.stringify(parsed),
        )
      if (parsed.status === 'archived') {
        this.pruneArchivedReminders()
      }
    })
    return parsed
  }

  deleteReminder(id: string): boolean {
    const res = this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  // ── Pending Turns ───────────────────────────────────────────────────────

  listPendingTurns(): LarkPendingTurn[] {
    const rows = this.db
      .prepare('SELECT * FROM pending_turns ORDER BY started_at_ms ASC')
      .all() as Array<{
      id: string
      bot_id: string
      chat_id: string
      chat_name: string | null
      message_id: string
      route_key: string
      reply_mode: string
      trigger: string
      allow_silent_empty_reply: number
      reaction_id: string | null
      session_id: string | null
      trace_id: string | null
      started_at_ms: number
      status: string | null
      inbound_msg_json: string | null
      sender_name: string | null
      intermediate_sent_count: number | null
      recovery_attempts: number | null
      graceful_recovery_attempts: number | null
      handoff_turns_json: string | null
      updated_at_ms: number | null
      interrupted_at_ms: number | null
      last_activity_at_ms: number | null
      interrupt_kind: string | null
    }>
    return rows.map((row) => {
      let inboundMsg: LarkPendingTurn['inboundMsg']
      if (row.inbound_msg_json) {
        try {
          inboundMsg = JSON.parse(row.inbound_msg_json) as LarkPendingTurn['inboundMsg']
        } catch {
          inboundMsg = undefined
        }
      }
      let handoffTurns: LarkPendingTurn['handoffTurns']
      if (row.handoff_turns_json) {
        try {
          const parsed = JSON.parse(row.handoff_turns_json)
          if (Array.isArray(parsed)) handoffTurns = parsed as LarkPendingTurn['handoffTurns']
        } catch {
          handoffTurns = undefined
        }
      }
      const status =
        row.status === 'interrupted' || row.status === 'recovering' || row.status === 'running'
          ? row.status
          : 'running'
      const interruptKind =
        row.interrupt_kind === 'graceful_shutdown' || row.interrupt_kind === 'crash'
          ? row.interrupt_kind
          : undefined
      return {
        id: row.id,
        botId: row.bot_id,
        chatId: row.chat_id,
        ...(row.chat_name ? { chatName: row.chat_name } : {}),
        messageId: row.message_id,
        routeKey: row.route_key,
        replyMode:
          row.reply_mode === 'chat' || row.reply_mode === 'reply' || row.reply_mode === 'new-topic'
            ? row.reply_mode
            : 'new-topic',
        trigger: row.trigger,
        allowSilentEmptyReply: row.allow_silent_empty_reply === 1,
        ...(row.reaction_id ? { reactionId: row.reaction_id } : {}),
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        ...(row.trace_id ? { traceId: row.trace_id } : {}),
        startedAtMs: Number(row.started_at_ms),
        status,
        ...(inboundMsg ? { inboundMsg } : {}),
        ...(row.sender_name ? { senderName: row.sender_name } : {}),
        ...(row.intermediate_sent_count ? { intermediateSentCount: Number(row.intermediate_sent_count) } : {}),
        ...(row.recovery_attempts ? { recoveryAttempts: Number(row.recovery_attempts) } : {}),
        ...(row.graceful_recovery_attempts
          ? { gracefulRecoveryAttempts: Number(row.graceful_recovery_attempts) }
          : {}),
        ...(handoffTurns && handoffTurns.length > 0 ? { handoffTurns } : {}),
        ...(row.updated_at_ms !== null ? { updatedAtMs: Number(row.updated_at_ms) } : {}),
        ...(row.interrupted_at_ms !== null ? { interruptedAtMs: Number(row.interrupted_at_ms) } : {}),
        ...(row.last_activity_at_ms !== null ? { lastActivityAtMs: Number(row.last_activity_at_ms) } : {}),
        ...(interruptKind ? { interruptKind } : {}),
      }
    })
  }

  upsertPendingTurn(turn: LarkPendingTurn): LarkPendingTurn {
    const updatedAtMs = turn.updatedAtMs ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO pending_turns (
           id, bot_id, chat_id, chat_name, message_id, route_key, reply_mode,
           trigger, allow_silent_empty_reply, reaction_id, session_id, trace_id, started_at_ms,
           status, inbound_msg_json, sender_name, intermediate_sent_count, recovery_attempts,
           graceful_recovery_attempts, handoff_turns_json, updated_at_ms, interrupted_at_ms,
           last_activity_at_ms, interrupt_kind
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           bot_id = excluded.bot_id,
           chat_id = excluded.chat_id,
           chat_name = excluded.chat_name,
           message_id = excluded.message_id,
           route_key = excluded.route_key,
           reply_mode = excluded.reply_mode,
           trigger = excluded.trigger,
           allow_silent_empty_reply = excluded.allow_silent_empty_reply,
           reaction_id = excluded.reaction_id,
           session_id = excluded.session_id,
           trace_id = excluded.trace_id,
           started_at_ms = excluded.started_at_ms,
           status = excluded.status,
           inbound_msg_json = excluded.inbound_msg_json,
           sender_name = excluded.sender_name,
           intermediate_sent_count = excluded.intermediate_sent_count,
           recovery_attempts = excluded.recovery_attempts,
           graceful_recovery_attempts = excluded.graceful_recovery_attempts,
           handoff_turns_json = excluded.handoff_turns_json,
           updated_at_ms = excluded.updated_at_ms,
           interrupted_at_ms = excluded.interrupted_at_ms,
           last_activity_at_ms = excluded.last_activity_at_ms,
           interrupt_kind = excluded.interrupt_kind`,
      )
      .run(
        turn.id,
        turn.botId,
        turn.chatId,
        turn.chatName ?? null,
        turn.messageId,
        turn.routeKey,
        turn.replyMode,
        turn.trigger,
        turn.allowSilentEmptyReply ? 1 : 0,
        turn.reactionId ?? null,
        turn.sessionId ?? null,
        turn.traceId ?? null,
        turn.startedAtMs,
        turn.status ?? 'running',
        turn.inboundMsg ? JSON.stringify(turn.inboundMsg) : null,
        turn.senderName ?? null,
        turn.intermediateSentCount ?? 0,
        turn.recoveryAttempts ?? 0,
        turn.gracefulRecoveryAttempts ?? 0,
        turn.handoffTurns && turn.handoffTurns.length > 0 ? JSON.stringify(turn.handoffTurns) : null,
        updatedAtMs,
        turn.interruptedAtMs ?? null,
        turn.lastActivityAtMs ?? null,
        turn.interruptKind ?? null,
      )
    return { ...turn, updatedAtMs }
  }

  deletePendingTurn(id: string): boolean {
    const res = this.db.prepare('DELETE FROM pending_turns WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  countPendingTurns(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM pending_turns').get() as
      | { cnt?: number }
      | undefined
    return Number(row?.cnt ?? 0)
  }

  // ── Smart Triage Context Persistence ────────────────────────────────────

  loadTriageContextScopes(minUpdatedAtMs = 0): Array<{
    readonly scopeKey: string
    readonly kind: 'history' | 'worker_reply' | 'ephemeral_thread'
    readonly payloadJson: string
    readonly updatedAtMs: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT scope_key, kind, payload_json, updated_at_ms
         FROM triage_context_scopes
         WHERE updated_at_ms >= ?
         ORDER BY updated_at_ms ASC`,
      )
      .all(minUpdatedAtMs) as Array<{
      scope_key: string
      kind: string
      payload_json: string
      updated_at_ms: number
    }>
    const out: Array<{
      readonly scopeKey: string
      readonly kind: 'history' | 'worker_reply' | 'ephemeral_thread'
      readonly payloadJson: string
      readonly updatedAtMs: number
    }> = []
    for (const row of rows) {
      if (
        row.kind !== 'history' &&
        row.kind !== 'worker_reply' &&
        row.kind !== 'ephemeral_thread'
      ) {
        continue
      }
      out.push({
        scopeKey: row.scope_key,
        kind: row.kind,
        payloadJson: row.payload_json,
        updatedAtMs: Number(row.updated_at_ms),
      })
    }
    return out
  }

  upsertTriageContextScope(
    scopeKey: string,
    kind: 'history' | 'worker_reply' | 'ephemeral_thread',
    payloadJson: string,
    updatedAtMs: number,
  ): void {
    if (!scopeKey) return
    this.db
      .prepare(
        `INSERT INTO triage_context_scopes (scope_key, kind, payload_json, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key, kind) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(scopeKey, kind, payloadJson, updatedAtMs)
  }

  deleteTriageContextScope(
    scopeKey: string,
    kind?: 'history' | 'worker_reply' | 'ephemeral_thread',
  ): number {
    const res = kind
      ? this.db
          .prepare('DELETE FROM triage_context_scopes WHERE scope_key = ? AND kind = ?')
          .run(scopeKey, kind)
      : this.db.prepare('DELETE FROM triage_context_scopes WHERE scope_key = ?').run(scopeKey)
    return Number(res.changes)
  }

  pruneTriageContextScopes(cutoffMs: number): number {
    const res = this.db
      .prepare('DELETE FROM triage_context_scopes WHERE updated_at_ms < ?')
      .run(cutoffMs)
    return Number(res.changes)
  }

  resolvePrimaryRouteKey(routeKey: string): string {
    const direct = this.db
      .prepare('SELECT 1 FROM session_bindings WHERE route_key = ?')
      .get(routeKey)
    if (direct) return routeKey
    const alias = this.db
      .prepare('SELECT primary_route_key FROM binding_aliases WHERE alias_route_key = ?')
      .get(routeKey) as { primary_route_key?: string } | undefined
    return alias?.primary_route_key ?? routeKey
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private listAliasesForPrimary(primaryRouteKey: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT alias_route_key FROM binding_aliases WHERE primary_route_key = ? ORDER BY rowid ASC',
      )
      .all(primaryRouteKey) as Array<{ alias_route_key: string }>
    return rows.map((r) => r.alias_route_key)
  }

  private loadAllAliasesByPrimary(): Map<string, string[]> {
    const rows = this.db
      .prepare('SELECT alias_route_key, primary_route_key FROM binding_aliases ORDER BY rowid ASC')
      .all() as Array<{ alias_route_key: string; primary_route_key: string }>
    const out = new Map<string, string[]>()
    for (const row of rows) {
      let list = out.get(row.primary_route_key)
      if (!list) {
        list = []
        out.set(row.primary_route_key, list)
      }
      list.push(row.alias_route_key)
    }
    return out
  }

  private hydrateBinding(row: BindingRow, aliases?: readonly string[]): LarkSessionBinding {
    return {
      routeKey: row.route_key,
      ...(aliases && aliases.length > 0 ? { aliasRouteKeys: [...aliases] } : {}),
      botId: row.bot_id,
      ...(row.bot_name ? { botName: row.bot_name } : {}),
      larkAppId: row.lark_app_id,
      ...(row.chat_type === 'p2p' || row.chat_type === 'group' ? { chatType: row.chat_type } : {}),
      chatId: row.chat_id,
      ...(row.chat_name ? { chatName: row.chat_name } : {}),
      ...(row.user_open_id ? { userOpenId: row.user_open_id } : {}),
      ...(row.user_name ? { userName: row.user_name } : {}),
      workspaceName: row.workspace_name,
      sessionId: row.session_id,
      agentPreset: row.agent_preset,
      ...(row.runtime_profile_id ? { runtimeProfileId: row.runtime_profile_id } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      workingDir: row.working_dir,
      trigger: row.trigger,
      ...(row.listener_name ? { listenerName: row.listener_name } : {}),
      ...(row.has_replied !== null ? { hasReplied: row.has_replied === 1 } : {}),
      createdAtMs: Number(row.created_at_ms),
      lastActivityMs: Number(row.last_activity_ms),
      ...(row.idle_close_ms !== null ? { idleCloseMs: Number(row.idle_close_ms) } : {}),
    }
  }

  private hydrateManagedSession(row: {
    session_id: string
    bot_id: string
    chat_id: string
    route_key: string | null
    trigger: string | null
    created_at_ms: number
    last_activity_ms: number
    idle_close_ms: number | null
    archived_at_ms: number | null
  }): LarkManagedSession {
    return {
      sessionId: row.session_id,
      botId: row.bot_id,
      chatId: row.chat_id,
      ...(row.route_key ? { routeKey: row.route_key } : {}),
      ...(row.trigger ? { trigger: row.trigger } : {}),
      createdAtMs: Number(row.created_at_ms),
      lastActivityMs: Number(row.last_activity_ms),
      ...(row.idle_close_ms !== null ? { idleCloseMs: Number(row.idle_close_ms) } : {}),
      ...(row.archived_at_ms !== null ? { archivedAtMs: Number(row.archived_at_ms) } : {}),
    }
  }

  private pruneManagedSessions(): void {
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM managed_sessions').get() as {
      cnt?: number
    }
    const excess = Number(countRow?.cnt ?? 0) - MAX_MANAGED_SESSIONS
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM managed_sessions WHERE session_id IN (
           SELECT session_id FROM managed_sessions ORDER BY last_activity_ms ASC LIMIT ?
         )`,
      )
      .run(excess)
  }

  private pruneDreamSessions(): void {
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM dream_sessions').get() as {
      cnt?: number
    }
    const excess = Number(countRow?.cnt ?? 0) - MAX_DREAM_SESSIONS
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM dream_sessions WHERE session_id IN (
           SELECT session_id FROM dream_sessions ORDER BY last_activity_ms ASC LIMIT ?
         )`,
      )
      .run(excess)
  }

  private pruneTriageSessions(): void {
    const countRow = this.db.prepare('SELECT COUNT(*) AS cnt FROM triage_sessions').get() as {
      cnt?: number
    }
    const excess = Number(countRow?.cnt ?? 0) - MAX_TRIAGE_SESSIONS
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM triage_sessions WHERE session_id IN (
           SELECT session_id FROM triage_sessions ORDER BY last_activity_ms ASC LIMIT ?
         )`,
      )
      .run(excess)
  }

  // ── External Runtime Session Links (durable ext:<id> -> sessionId) ─────

  upsertExternalSessionLink(
    externalId: string,
    sessionId: string,
    driver = '',
    updatedAtMs = Date.now(),
  ): void {
    const ext = externalId.trim()
    const sid = sessionId.trim()
    if (!ext || !sid) return
    this.db
      .prepare(
        `INSERT INTO external_session_links (external_id, session_id, driver, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           session_id = excluded.session_id,
           driver = CASE WHEN excluded.driver != '' THEN excluded.driver ELSE external_session_links.driver END,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(ext, sid, driver.trim(), updatedAtMs)
    this.externalLinkInsertCounter += 1
    if (this.externalLinkInsertCounter >= EXTERNAL_LINK_PRUNE_INTERVAL) {
      this.externalLinkInsertCounter = 0
      this.pruneExternalSessionLinks()
    }
  }

  resolveSessionIdByExternalId(externalId: string): string | undefined {
    const ext = externalId.trim()
    if (!ext) return undefined
    const row = this.db
      .prepare('SELECT session_id FROM external_session_links WHERE external_id = ?')
      .get(ext) as { session_id?: string } | undefined
    return row?.session_id
  }

  hasExternalSessionLinkForSession(sessionId: string): boolean {
    const sid = sessionId.trim()
    if (!sid) return false
    const row = this.db
      .prepare('SELECT 1 AS found FROM external_session_links WHERE session_id = ? LIMIT 1')
      .get(sid) as { found?: number } | undefined
    return Boolean(row?.found)
  }

  private pruneExternalSessionLinks(): void {
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM external_session_links')
      .get() as { cnt?: number }
    const excess = Number(countRow?.cnt ?? 0) - MAX_EXTERNAL_SESSION_LINKS
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM external_session_links WHERE external_id IN (
           SELECT external_id FROM external_session_links ORDER BY updated_at_ms ASC LIMIT ?
         )`,
      )
      .run(excess)
  }

  private pruneArchivedReminders(): void {
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM reminders WHERE status = 'archived'")
      .get() as { cnt?: number }
    const excess = Number(countRow?.cnt ?? 0) - MAX_ARCHIVED_REMINDERS
    if (excess <= 0) return
    this.db
      .prepare(
        `DELETE FROM reminders WHERE id IN (
           SELECT id FROM reminders
           WHERE status = 'archived'
           ORDER BY COALESCE(archived_at_ms, updated_at_ms) ASC
           LIMIT ?
         )`,
      )
      .run(excess)
  }
}
