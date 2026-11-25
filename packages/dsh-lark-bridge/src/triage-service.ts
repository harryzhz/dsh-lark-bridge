import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  type AssistantStreamRecord,
  type ContentBlock,
  type ReasoningEffortId,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  ROUTE_MESSAGE_TOOL_SCHEMA,
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  extractPeerUserMentions,
  parseTriageVerdict,
  type AgentRoutingDecision,
  type EffectiveRouterConfig,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkGroupConfig,
  type RouterHandoffTurn,
  type TriageHistoryEntry,
  type TriageQuotedMessage,
  type TriageVerdict,
} from '@dsh-lark/lark-core'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { TriageSessionRecorder } from './triage-session-recorder.js'

const DEFAULT_CONTEXT_TTL_MS = 30 * 60_000
const MAX_RETAINED_CONTEXT_TTL_MS = 24 * 60 * 60_000
const MAX_SCOPE_ENTRIES = 200
const MAX_MESSAGES_PER_SCOPE = 50
const MAX_EPHEMERAL_TURNS = 12

interface ScopedHistoryBucket {
  readonly entries: TriageHistoryEntry[]
  updatedAtMs: number
}

interface WorkerReplyRecord {
  readonly text: string
  readonly updatedAtMs: number
}

export interface EphemeralRouterThread {
  readonly primaryRouteKey: string
  readonly aliasRouteKeys: string[]
  readonly trigger: AgentRoutingDecision['trigger']
  readonly turns: RouterHandoffTurn[]
  updatedAtMs: number
}

const MULTIMODAL_TRIAGE_MIN_TIMEOUT_MS = 8_000

export interface EvaluateTriageInput {
  readonly bot: LarkBotConfig
  readonly group?: LarkGroupConfig
  readonly msg: InboundLarkMessage
  readonly decision: AgentRoutingDecision
  readonly routerConfig: EffectiveRouterConfig
  readonly senderName?: string
  readonly resolvedChatName?: string
  readonly quotedMessage?: TriageQuotedMessage
  readonly totalImageCount?: number
  readonly loadImages?: (
    signal?: AbortSignal,
  ) => Promise<{ readonly blocks: readonly ContentBlock[]; readonly failedCount: number }>
  readonly hasActiveWorker: boolean
  readonly workerBusy: boolean
  readonly traceId: string
  readonly signal?: AbortSignal
}

export interface TriageEvaluationResult {
  readonly verdict: TriageVerdict
  readonly provider?: string
  readonly model?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly durationMs: number
  readonly triageSessionId?: string
  readonly usage?: TokenUsage
}

const TRIAGE_ERROR_REDACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]'],
  [
    /"?(?:api_?key|app_secret|larkAppSecret|client_secret|access_token|refresh_token|authorization|token|secret)"?\s*[:=]\s*"?[^",\s}]+"?/gi,
    '[REDACTED_SECRET]',
  ],
  [/\b(?:sk|t|u)-[A-Za-z0-9._-]{16,}\b/g, '[REDACTED_TOKEN]'],
]

export interface ClassifiedTriageError {
  readonly errorCode: string
  readonly errorMessage: string
}

export function classifyTriageError(
  rawError: string | undefined,
  timedOut = false,
): ClassifiedTriageError {
  let sanitized = (rawError ?? '').replace(/\s+/g, ' ').trim()
  for (const [pattern, replacement] of TRIAGE_ERROR_REDACT_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  if (sanitized.length > 200) {
    sanitized = `${sanitized.slice(0, 200)}…`
  }

  let errorCode = 'llm_error'
  if (timedOut || /\b(?:timeout|timed?\s*out|ETIMEDOUT)\b/i.test(sanitized)) {
    errorCode = 'timeout'
  } else if (/\b429\b|rate[\s_-]?limit|too\s+many\s+requests|quota/i.test(sanitized)) {
    errorCode = 'rate_limited'
  } else if (
    /\b(?:401|403)\b|unauthoriz|forbidden|auth(?:entication)?[\s_-]*(?:required|failed|error)|invalid[\s_-]*api[\s_-]*key/i.test(
      sanitized,
    )
  ) {
    errorCode = 'auth_error'
  } else if (
    /\b5\d\d\b|service\s+unavailable|bad\s+gateway|gateway\s+timeout|overloaded|internal\s+server\s+error/i.test(
      sanitized,
    )
  ) {
    errorCode = 'upstream_5xx'
  } else if (/\b4\d\d\b|bad\s+request|invalid_request/i.test(sanitized)) {
    errorCode = 'upstream_4xx'
  } else if (
    /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\b|fetch\s+failed|socket\s+hang\s+up|network/i.test(
      sanitized,
    )
  ) {
    errorCode = 'network_error'
  } else if (/\babort(?:ed|error)?\b/i.test(sanitized)) {
    errorCode = 'aborted'
  }

  return {
    errorCode,
    errorMessage: sanitized || (timedOut ? 'triage timeout' : 'unknown triage error'),
  }
}

export interface TriageContextPersistence {
  loadTriageContextScopes(minUpdatedAtMs?: number): ReadonlyArray<{
    readonly scopeKey: string
    readonly kind: 'history' | 'worker_reply' | 'ephemeral_thread'
    readonly payloadJson: string
    readonly updatedAtMs: number
  }>
  upsertTriageContextScope(
    scopeKey: string,
    kind: 'history' | 'worker_reply' | 'ephemeral_thread',
    payloadJson: string,
    updatedAtMs: number,
  ): void
  deleteTriageContextScope(
    scopeKey: string,
    kind?: 'history' | 'worker_reply' | 'ephemeral_thread',
  ): number
  pruneTriageContextScopes(cutoffMs: number): number
}

const DEFAULT_HISTORY_PERSIST_DEBOUNCE_MS = 1_500
const MAX_HYDRATED_SCOPES = MAX_SCOPE_ENTRIES * 2

export interface TriageContextStoreOptions {
  readonly persistence?: TriageContextPersistence
  readonly resolvePrimaryRouteKey?: (routeKey: string) => string
  readonly historyPersistDebounceMs?: number
}

/**
 * Bounded sliding context and ephemeral quick-reply thread store with optional
 * SQLite WAL persistence and route-alias normalization.
 * Retains full, untruncated recent messages up to `MAX_MESSAGES_PER_SCOPE` per scope
 * so configurable `recentMessageCount` and `contextTtlMinutes` slice cleanly without loss.
 */
export class TriageContextStore {
  private readonly recentByScope = new Map<string, ScopedHistoryBucket>()
  private readonly workerSummaryByRoute = new Map<string, WorkerReplyRecord>()
  private readonly ephemeralThreads = new Map<string, EphemeralRouterThread>()
  private readonly ephemeralAliases = new Map<string, string>()
  private readonly hydratedScopes = new Set<string>()
  private readonly dirtyHistoryScopes = new Set<string>()
  private readonly persistence?: TriageContextPersistence
  private readonly resolveBindingPrimary?: (routeKey: string) => string
  private readonly historyPersistDebounceMs: number
  private historyFlushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TriageContextStoreOptions = {}) {
    this.persistence = options.persistence
    this.resolveBindingPrimary = options.resolvePrimaryRouteKey
    this.historyPersistDebounceMs =
      typeof options.historyPersistDebounceMs === 'number' && options.historyPersistDebounceMs >= 0
        ? options.historyPersistDebounceMs
        : DEFAULT_HISTORY_PERSIST_DEBOUNCE_MS
    this.hydrateFromPersistence()
  }

  private normalizeRouteKey(routeKey: string): string {
    return this.resolveBindingPrimary ? this.resolveBindingPrimary(routeKey) : routeKey
  }

  hasHydratedScope(scopeKey: string): boolean {
    return this.hydratedScopes.has(scopeKey)
  }

  markScopeHydrated(scopeKey: string): void {
    if (!scopeKey) return
    this.hydratedScopes.delete(scopeKey)
    this.hydratedScopes.add(scopeKey)
    while (this.hydratedScopes.size > MAX_HYDRATED_SCOPES) {
      const oldest = this.hydratedScopes.values().next().value
      if (!oldest) break
      this.hydratedScopes.delete(oldest)
    }
  }

  resolveEphemeralPrimary(routeKey: string, now = Date.now()): string | undefined {
    const normalized = this.normalizeRouteKey(routeKey)
    const primaryKey =
      this.ephemeralAliases.get(routeKey) ??
      this.ephemeralAliases.get(normalized) ??
      normalized
    const thread = this.ephemeralThreads.get(primaryKey) ?? this.ephemeralThreads.get(routeKey)
    if (!thread) return undefined
    if (now - thread.updatedAtMs > DEFAULT_CONTEXT_TTL_MS) {
      this.deleteEphemeralThread(thread.primaryRouteKey)
      return undefined
    }
    return thread.primaryRouteKey
  }

  hasEphemeralThread(routeKey: string, now = Date.now()): boolean {
    return this.resolveEphemeralPrimary(routeKey, now) !== undefined
  }

  getEphemeralThreadTrigger(routeKey: string, now = Date.now()): string | undefined {
    const primary = this.resolveEphemeralPrimary(routeKey, now)
    return primary ? this.ephemeralThreads.get(primary)?.trigger : undefined
  }

  recordEphemeralQuickReply(input: {
    readonly routeKey: string
    readonly chatScopeKey?: string
    readonly aliasRouteKeys?: readonly string[]
    readonly trigger: AgentRoutingDecision['trigger']
    readonly senderName?: string
    readonly userText: string
    readonly routerReply: string
    readonly nowMs?: number
  }): void {
    const now = input.nowMs ?? Date.now()
    this.pruneExpired(now)
    const primaryKey =
      this.resolveEphemeralPrimary(input.routeKey, now) ?? this.normalizeRouteKey(input.routeKey)
    let thread = this.ephemeralThreads.get(primaryKey)
    if (!thread) {
      thread = {
        primaryRouteKey: primaryKey,
        aliasRouteKeys: [],
        trigger: input.trigger,
        turns: [],
        updatedAtMs: now,
      }
      this.ephemeralThreads.set(primaryKey, thread)
    }

    thread.turns.push({
      ...(input.senderName ? { senderName: input.senderName } : {}),
      userText: input.userText,
      routerReply: input.routerReply,
      timestampMs: now,
    })
    if (thread.turns.length > MAX_EPHEMERAL_TURNS) {
      thread.turns.splice(0, thread.turns.length - MAX_EPHEMERAL_TURNS)
    }
    thread.updatedAtMs = now

    for (const alias of input.aliasRouteKeys ?? []) {
      if (!alias || alias === primaryKey) continue
      if (!thread.aliasRouteKeys.includes(alias)) {
        thread.aliasRouteKeys.push(alias)
      }
      this.ephemeralAliases.set(alias, primaryKey)
    }
    this.persistScope(primaryKey, 'ephemeral_thread', thread, now)

    const routerEntry: TriageHistoryEntry = {
      role: 'router',
      text: input.routerReply,
      timestampMs: now,
    }
    this.appendHistory(primaryKey, routerEntry, now)
    if (input.chatScopeKey && input.chatScopeKey !== primaryKey) {
      this.appendHistory(input.chatScopeKey, routerEntry, now)
    }
    this.enforceBounds()
  }

  peekEphemeralHandoff(
    routeKey: string,
    now = Date.now(),
  ): { readonly turns: readonly RouterHandoffTurn[] } | undefined {
    const primary = this.resolveEphemeralPrimary(routeKey, now)
    if (!primary) return undefined
    const thread = this.ephemeralThreads.get(primary)
    if (!thread) return undefined
    return { turns: [...thread.turns] }
  }

  consumeEphemeralHandoff(
    routeKey: string,
    now = Date.now(),
  ): { readonly turns: readonly RouterHandoffTurn[]; readonly aliasRouteKeys: readonly string[] } | undefined {
    const primary = this.resolveEphemeralPrimary(routeKey, now)
    if (!primary) return undefined
    const thread = this.ephemeralThreads.get(primary)
    if (!thread) return undefined
    const result = {
      turns: [...thread.turns],
      aliasRouteKeys: [primary, ...thread.aliasRouteKeys].filter((k) => k !== routeKey),
    }
    this.deleteEphemeralThread(primary)
    return result
  }

  recordInboundMessage(
    chatScopeKey: string,
    routeKey: string,
    entry: TriageHistoryEntry,
    now = entry.timestampMs,
  ): void {
    const targetRouteKey =
      this.resolveEphemeralPrimary(routeKey, now) ?? this.normalizeRouteKey(routeKey)
    this.appendHistory(targetRouteKey, entry, now)
    if (chatScopeKey && chatScopeKey !== targetRouteKey) {
      this.appendHistory(chatScopeKey, entry, now)
    }
    this.enforceBounds()
  }

  /** Records a group-level message (e.g. ignored by trigger rules) without creating a thread bucket. */
  recordChatMessage(
    chatScopeKey: string,
    entry: TriageHistoryEntry,
    options: { readonly routeKey?: string; readonly now?: number } = {},
  ): void {
    const now = options.now ?? entry.timestampMs
    if (chatScopeKey) {
      this.appendHistory(chatScopeKey, entry, now)
    }
    if (options.routeKey) {
      const targetRouteKey =
        this.resolveEphemeralPrimary(options.routeKey, now) ??
        this.normalizeRouteKey(options.routeKey)
      if (targetRouteKey && targetRouteKey !== chatScopeKey) {
        this.appendHistory(targetRouteKey, entry, now)
      }
    }
    this.enforceBounds()
  }

  /**
   * Merges historical messages fetched from Feishu (e.g. cold-start backfill after restart)
   * into the target scope without duplicating existing `messageId` entries or overwriting newer items.
   */
  hydrateScopeHistory(
    scopeKey: string,
    entries: readonly TriageHistoryEntry[],
    now = Date.now(),
  ): void {
    if (!scopeKey) return
    this.hydratedScopes.add(scopeKey)
    if (entries.length === 0) return

    let bucket = this.recentByScope.get(scopeKey)
    if (!bucket || now - bucket.updatedAtMs > MAX_RETAINED_CONTEXT_TTL_MS) {
      bucket = { entries: [], updatedAtMs: now }
      this.recentByScope.set(scopeKey, bucket)
    }

    const existingIds = new Set<string>()
    for (const item of bucket.entries) {
      if (item.messageId) existingIds.add(item.messageId)
    }

    let changed = false
    for (const entry of entries) {
      if (!entry.text.trim()) continue
      if (entry.messageId && existingIds.has(entry.messageId)) continue
      if (entry.messageId) existingIds.add(entry.messageId)
      bucket.entries.push(entry)
      changed = true
    }

    if (!changed) return
    bucket.entries.sort((a, b) => a.timestampMs - b.timestampMs)
    if (bucket.entries.length > MAX_MESSAGES_PER_SCOPE) {
      bucket.entries.splice(0, bucket.entries.length - MAX_MESSAGES_PER_SCOPE)
    }
    const latestTs = bucket.entries[bucket.entries.length - 1]?.timestampMs ?? now
    bucket.updatedAtMs = Math.max(bucket.updatedAtMs, latestTs)
    this.persistScope(scopeKey, 'history', bucket, bucket.updatedAtMs)
    this.enforceBounds()
  }

  recordWorkerReply(
    routeKey: string,
    replyText: string,
    now = Date.now(),
    options: { readonly chatScopeKey?: string; readonly messageId?: string } = {},
  ): void {
    const trimmed = replyText.trim()
    if (!trimmed) return
    const targetRouteKey = this.normalizeRouteKey(routeKey)
    const summary: WorkerReplyRecord = { text: trimmed, updatedAtMs: now }
    this.workerSummaryByRoute.set(targetRouteKey, summary)
    this.persistScope(targetRouteKey, 'worker_reply', summary, now)

    const entry: TriageHistoryEntry = {
      role: 'worker',
      text: trimmed,
      timestampMs: now,
      ...(options.messageId ? { messageId: options.messageId } : {}),
    }
    this.appendHistory(targetRouteKey, entry, now)
    if (options.chatScopeKey && options.chatScopeKey !== targetRouteKey) {
      this.appendHistory(options.chatScopeKey, entry, now)
    }
    this.enforceBounds()
  }

  getRecentMessages(
    routeKey: string,
    chatScopeKey: string,
    options: { readonly ttlMs?: number; readonly maxCount?: number; readonly now?: number } = {},
  ): readonly TriageHistoryEntry[] {
    const now = options.now ?? Date.now()
    const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_TTL_MS
    const maxCount = options.maxCount ?? MAX_MESSAGES_PER_SCOPE
    if (maxCount <= 0) return []

    const resolvedRoute =
      this.resolveEphemeralPrimary(routeKey, now) ?? this.normalizeRouteKey(routeKey)
    const pickFrom = (scopeKey: string): TriageHistoryEntry[] => {
      const bucket = this.recentByScope.get(scopeKey)
      if (!bucket) return []
      const fresh = bucket.entries.filter((e) => now - e.timestampMs <= ttlMs)
      return fresh.slice(-maxCount)
    }

    const fromRoute = pickFrom(resolvedRoute)
    if (fromRoute.length > 0) return fromRoute
    return pickFrom(chatScopeKey)
  }

  getLastWorkerReply(
    routeKey: string,
    options: { readonly ttlMs?: number; readonly now?: number } = {},
  ): string | undefined {
    const now = options.now ?? Date.now()
    const ttlMs = options.ttlMs ?? DEFAULT_CONTEXT_TTL_MS
    const normalized = this.normalizeRouteKey(routeKey)
    const summary =
      this.workerSummaryByRoute.get(normalized) ?? this.workerSummaryByRoute.get(routeKey)
    if (!summary) return undefined
    if (now - summary.updatedAtMs > ttlMs) {
      return undefined
    }
    return summary.text
  }

  removeMessage(messageId: string): boolean {
    const targetId = messageId.trim()
    if (!targetId) return false
    let removed = false
    for (const [scopeKey, bucket] of [...this.recentByScope.entries()]) {
      const nextEntries = bucket.entries.filter((e) => e.messageId !== targetId)
      if (nextEntries.length === bucket.entries.length) continue
      removed = true
      if (nextEntries.length === 0) {
        this.recentByScope.delete(scopeKey)
        this.dirtyHistoryScopes.delete(scopeKey)
        this.hydratedScopes.delete(scopeKey)
        this.deletePersistedScope(scopeKey, 'history')
      } else {
        bucket.entries.splice(0, bucket.entries.length, ...nextEntries)
        this.scheduleHistoryPersist(scopeKey)
      }
    }
    return removed
  }

  clearRoute(routeKey: string): void {
    const normalized = this.normalizeRouteKey(routeKey)
    const primary =
      this.ephemeralAliases.get(routeKey) ?? this.ephemeralAliases.get(normalized) ?? normalized
    this.deleteEphemeralThread(primary)
    this.workerSummaryByRoute.delete(routeKey)
    this.workerSummaryByRoute.delete(normalized)
    this.recentByScope.delete(routeKey)
    this.recentByScope.delete(normalized)
    this.dirtyHistoryScopes.delete(routeKey)
    this.dirtyHistoryScopes.delete(normalized)
    this.hydratedScopes.delete(routeKey)
    this.hydratedScopes.delete(normalized)
    this.deletePersistedScope(routeKey)
    if (normalized !== routeKey) {
      this.deletePersistedScope(normalized)
    }
  }

  flushPersisted(): void {
    if (this.historyFlushTimer) {
      clearTimeout(this.historyFlushTimer)
      this.historyFlushTimer = null
    }
    if (this.dirtyHistoryScopes.size === 0) return
    const pending = [...this.dirtyHistoryScopes]
    this.dirtyHistoryScopes.clear()
    for (const scopeKey of pending) {
      const bucket = this.recentByScope.get(scopeKey)
      if (!bucket || bucket.entries.length === 0) continue
      this.persistScope(scopeKey, 'history', bucket, bucket.updatedAtMs)
    }
  }

  prunePersisted(now = Date.now()): void {
    this.flushPersisted()
    this.pruneExpired(now)
    try {
      this.persistence?.pruneTriageContextScopes(now - MAX_RETAINED_CONTEXT_TTL_MS)
    } catch {
      // Best-effort persistence prune.
    }
  }

  private hydrateFromPersistence(now = Date.now()): void {
    if (!this.persistence) return
    let rows: ReturnType<TriageContextPersistence['loadTriageContextScopes']>
    try {
      rows = this.persistence.loadTriageContextScopes(now - MAX_RETAINED_CONTEXT_TTL_MS)
    } catch {
      return
    }
    for (const row of rows) {
      try {
        if (row.kind === 'history') {
          const parsed = JSON.parse(row.payloadJson) as Partial<ScopedHistoryBucket>
          if (!Array.isArray(parsed.entries)) continue
          const entries = parsed.entries
            .filter(
              (e): e is TriageHistoryEntry =>
                Boolean(e) &&
                typeof e === 'object' &&
                (e.role === 'user' || e.role === 'router' || e.role === 'worker') &&
                typeof e.text === 'string' &&
                typeof e.timestampMs === 'number',
            )
            .slice(-MAX_MESSAGES_PER_SCOPE)
          if (entries.length === 0) continue
          this.recentByScope.set(row.scopeKey, {
            entries,
            updatedAtMs:
              typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : row.updatedAtMs,
          })
        } else if (row.kind === 'worker_reply') {
          const parsed = JSON.parse(row.payloadJson) as Partial<WorkerReplyRecord>
          if (typeof parsed.text !== 'string' || !parsed.text.trim()) continue
          this.workerSummaryByRoute.set(row.scopeKey, {
            text: parsed.text,
            updatedAtMs:
              typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : row.updatedAtMs,
          })
        } else if (row.kind === 'ephemeral_thread') {
          if (now - row.updatedAtMs > DEFAULT_CONTEXT_TTL_MS) continue
          const parsed = JSON.parse(row.payloadJson) as Partial<EphemeralRouterThread>
          if (!parsed.primaryRouteKey || !Array.isArray(parsed.turns) || !parsed.trigger) continue
          const aliases = Array.isArray(parsed.aliasRouteKeys)
            ? parsed.aliasRouteKeys.filter((a): a is string => typeof a === 'string' && Boolean(a))
            : []
          const thread: EphemeralRouterThread = {
            primaryRouteKey: parsed.primaryRouteKey,
            aliasRouteKeys: aliases,
            trigger: parsed.trigger,
            turns: parsed.turns.slice(-MAX_EPHEMERAL_TURNS),
            updatedAtMs:
              typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : row.updatedAtMs,
          }
          this.ephemeralThreads.set(thread.primaryRouteKey, thread)
          for (const alias of aliases) {
            this.ephemeralAliases.set(alias, thread.primaryRouteKey)
          }
        }
      } catch {
        // Ignore malformed persisted row.
      }
    }
    this.enforceBounds()
  }

  private persistScope(
    scopeKey: string,
    kind: 'history' | 'worker_reply' | 'ephemeral_thread',
    payload: unknown,
    updatedAtMs: number,
  ): void {
    if (!this.persistence || !scopeKey) return
    try {
      this.persistence.upsertTriageContextScope(
        scopeKey,
        kind,
        JSON.stringify(payload),
        updatedAtMs,
      )
    } catch {
      // Never fail hot triage path on SQLite write error (e.g. closing DB during shutdown).
    }
  }

  private deletePersistedScope(
    scopeKey: string,
    kind?: 'history' | 'worker_reply' | 'ephemeral_thread',
  ): void {
    if (!this.persistence || !scopeKey) return
    try {
      this.persistence.deleteTriageContextScope(scopeKey, kind)
    } catch {
      // Ignore cleanup error during shutdown.
    }
  }

  private scheduleHistoryPersist(scopeKey: string): void {
    if (!this.persistence || !scopeKey) return
    if (this.historyPersistDebounceMs <= 0) {
      const bucket = this.recentByScope.get(scopeKey)
      if (bucket) this.persistScope(scopeKey, 'history', bucket, bucket.updatedAtMs)
      return
    }
    this.dirtyHistoryScopes.add(scopeKey)
    if (!this.historyFlushTimer) {
      this.historyFlushTimer = setTimeout(() => {
        this.historyFlushTimer = null
        this.flushPersisted()
      }, this.historyPersistDebounceMs)
      this.historyFlushTimer.unref?.()
    }
  }

  private appendHistory(scopeKey: string, entry: TriageHistoryEntry, now: number): void {
    let bucket = this.recentByScope.get(scopeKey)
    if (!bucket || now - bucket.updatedAtMs > MAX_RETAINED_CONTEXT_TTL_MS) {
      bucket = { entries: [], updatedAtMs: now }
      this.recentByScope.set(scopeKey, bucket)
    }
    if (entry.messageId) {
      const existingIdx = bucket.entries.findIndex((item) => item.messageId === entry.messageId)
      if (existingIdx >= 0) {
        // Upgrade senderName if previously missing, otherwise keep idempotent.
        const existing = bucket.entries[existingIdx]!
        if (!existing.senderName && entry.senderName) {
          bucket.entries[existingIdx] = { ...existing, senderName: entry.senderName }
          this.scheduleHistoryPersist(scopeKey)
        }
        return
      }
    }
    bucket.entries.push(entry)
    if (bucket.entries.length > MAX_MESSAGES_PER_SCOPE) {
      bucket.entries.splice(0, bucket.entries.length - MAX_MESSAGES_PER_SCOPE)
    }
    bucket.updatedAtMs = now
    this.scheduleHistoryPersist(scopeKey)
  }

  private deleteEphemeralThread(primaryKey: string): void {
    const existing = this.ephemeralThreads.get(primaryKey)
    if (!existing) return
    this.ephemeralThreads.delete(primaryKey)
    this.deletePersistedScope(primaryKey, 'ephemeral_thread')
    for (const alias of existing.aliasRouteKeys) {
      if (this.ephemeralAliases.get(alias) === primaryKey) {
        this.ephemeralAliases.delete(alias)
      }
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.recentByScope) {
      if (now - bucket.updatedAtMs > MAX_RETAINED_CONTEXT_TTL_MS) {
        this.recentByScope.delete(key)
        this.dirtyHistoryScopes.delete(key)
        this.hydratedScopes.delete(key)
        this.deletePersistedScope(key, 'history')
      }
    }
    for (const [key, summary] of this.workerSummaryByRoute) {
      if (now - summary.updatedAtMs > MAX_RETAINED_CONTEXT_TTL_MS) {
        this.workerSummaryByRoute.delete(key)
        this.deletePersistedScope(key, 'worker_reply')
      }
    }
    for (const [key, thread] of this.ephemeralThreads) {
      if (now - thread.updatedAtMs > DEFAULT_CONTEXT_TTL_MS) this.deleteEphemeralThread(key)
    }
  }

  private enforceBounds(): void {
    while (this.recentByScope.size > MAX_SCOPE_ENTRIES) {
      const oldest = this.recentByScope.keys().next().value
      if (!oldest) break
      this.recentByScope.delete(oldest)
      this.dirtyHistoryScopes.delete(oldest)
      this.hydratedScopes.delete(oldest)
      this.deletePersistedScope(oldest, 'history')
    }
    while (this.workerSummaryByRoute.size > MAX_SCOPE_ENTRIES) {
      const oldest = this.workerSummaryByRoute.keys().next().value
      if (!oldest) break
      this.workerSummaryByRoute.delete(oldest)
      this.deletePersistedScope(oldest, 'worker_reply')
    }
    while (this.ephemeralThreads.size > MAX_SCOPE_ENTRIES) {
      const oldest = this.ephemeralThreads.keys().next().value
      if (!oldest) break
      this.deleteEphemeralThread(oldest)
    }
  }
}

function normalizeChunkForRecording(chunk: StreamChunk, fallbackCallId: () => ToolCallId): StreamChunk {
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && !chunk.block.id) {
    return {
      ...chunk,
      block: { ...chunk.block, id: fallbackCallId() },
    }
  }
  return chunk
}

/**
 * Stateless, concurrent, Fail-Open fast triage gate backed by DSH native `ctx.llm.stream()`.
 * Optionally persists each invocation as a standard archived DSH v4 inspection session.
 */
export class LlmTriageService {
  readonly context: TriageContextStore
  private activeEvaluations = 0
  private readonly onActivityChange?: () => void

  constructor(
    private readonly ctx: Context,
    private readonly runtimes: RuntimeCatalog,
    private readonly recorder?: TriageSessionRecorder,
    options: TriageContextStoreOptions & { readonly onActivityChange?: () => void } = {},
  ) {
    this.context = new TriageContextStore(options)
    this.onActivityChange = options.onActivityChange
  }

  getActiveCount(): number {
    return this.activeEvaluations
  }

  async evaluate(input: EvaluateTriageInput): Promise<TriageEvaluationResult> {
    this.activeEvaluations += 1
    this.onActivityChange?.()
    try {
      return await this.evaluateInner(input)
    } finally {
      this.activeEvaluations = Math.max(0, this.activeEvaluations - 1)
      this.onActivityChange?.()
    }
  }

  private async evaluateInner(input: EvaluateTriageInput): Promise<TriageEvaluationResult> {
    const startedAtMs = Date.now()
    const failOpen = (
      reason: string,
      resolved?: { readonly provider?: string; readonly model?: string },
      triageSessionId?: string,
      diagnostic?: { readonly errorCode?: string; readonly errorMessage?: string },
    ): TriageEvaluationResult => ({
      verdict: { action: 'handoff', reason, fallback: true },
      ...(resolved?.provider ? { provider: resolved.provider } : {}),
      ...(resolved?.model ? { model: resolved.model } : {}),
      ...(diagnostic?.errorCode ? { errorCode: diagnostic.errorCode } : {}),
      ...(diagnostic?.errorMessage ? { errorMessage: diagnostic.errorMessage } : {}),
      durationMs: Date.now() - startedAtMs,
      ...(triageSessionId ? { triageSessionId } : {}),
    })

    if (!this.ctx.llm || typeof this.ctx.llm.stream !== 'function') {
      return failOpen('宿主原生 LLM 接口不可用，自动直通主运行时')
    }

    const target = await this.runtimes
      .resolveNativeLlmTarget({
        provider: input.routerConfig.provider,
        model: input.routerConfig.model,
      })
      .catch(() => undefined)
    if (!target) {
      return failOpen('未配置可用的原生分流模型，自动直通主运行时')
    }

    const modelCaps = await this.resolveTriageModelCapabilities(target.provider, target.model)
    const totalImageCount =
      input.totalImageCount ??
      Math.max(input.msg.imageKeys.length, input.msg.msgType === 'image' ? 1 : 0) +
        (input.quotedMessage?.imageCount ?? 0)

    let imageBlocks: readonly ContentBlock[] = []
    if (totalImageCount > 0) {
      if (!modelCaps.supportsImage) {
        return failOpen('分流模型不支持图片输入，自动直通主运行时', target)
      }
      const cap = Math.max(0, Math.floor(input.routerConfig.maxTriageImages))
      if (cap === 0) {
        return failOpen('分流图片上限为 0，直通主运行时', target)
      }
      if (totalImageCount > cap) {
        return failOpen(
          `图片数量（${totalImageCount} 张）超过分流上限（${cap} 张），直通主运行时`,
          target,
        )
      }
      if (!input.loadImages) {
        return failOpen('当前上下文未提供图片加载能力，自动直通主运行时', target)
      }
      const loaded = await input.loadImages(input.signal).catch(() => ({
        blocks: [] as readonly ContentBlock[],
        failedCount: totalImageCount,
      }))
      if (input.signal?.aborted) {
        return {
          verdict: { action: 'silent', reason: '原消息已撤回或服务正在关闭，已取消分流' },
          provider: target.provider,
          model: target.model,
          durationMs: Date.now() - startedAtMs,
        }
      }
      if (loaded.blocks.length === 0 || loaded.failedCount > 0) {
        return failOpen('图片加载失败，自动直通主运行时', target)
      }
      imageBlocks = loaded.blocks
    }

    const { system, userText } = this.buildTriagePrompts(input, imageBlocks.length)
    const userContent: readonly ContentBlock[] = [
      { type: 'text', text: userText },
      ...imageBlocks,
    ]
    const toolSchema: ToolSchema = {
      name: ROUTE_MESSAGE_TOOL_SCHEMA.name,
      description: ROUTE_MESSAGE_TOOL_SCHEMA.description,
      parameters: ROUTE_MESSAGE_TOOL_SCHEMA.parameters,
    }
    const maxTokens = modelCaps.reasoningActive ? 1024 : 256
    const temperature = modelCaps.reasoningActive ? undefined : 0.1
    const effectiveTimeoutMs =
      imageBlocks.length > 0
        ? Math.max(input.routerConfig.timeoutMs, MULTIMODAL_TRIAGE_MIN_TIMEOUT_MS)
        : input.routerConfig.timeoutMs

    if (input.signal?.aborted) {
      return {
        verdict: { action: 'silent', reason: '原消息已撤回或服务正在关闭，已取消分流' },
        provider: target.provider,
        model: target.model,
        durationMs: Date.now() - startedAtMs,
      }
    }

    const run = await this.executeTriageStream({
      target,
      reasoningEffort: modelCaps.effort,
      system,
      userContent,
      toolSchema,
      maxTokens,
      temperature,
      timeoutMs: effectiveTimeoutMs,
      parentSignal: input.signal,
    })

    const finishedAtMs = Date.now()
    const durationMs = finishedAtMs - startedAtMs

    if (input.signal?.aborted) {
      return {
        verdict: { action: 'silent', reason: '原消息已撤回或服务正在关闭，已取消分流' },
        provider: target.provider,
        model: target.model,
        durationMs,
      }
    }

    if (run.errorMessage) {
      const classified = classifyTriageError(run.errorMessage, run.timedOut)
      this.ctx.logger.warn(
        `[lark-bridge][trace=${input.traceId}][bot=${input.bot.id}] triage fail-open [${classified.errorCode}] (${target.provider}/${target.model}): ${classified.errorMessage}`,
      )
      const fallbackReason = run.timedOut
        ? '分流超时，自动直通主运行时'
        : '分流异常，自动直通主运行时'
      const fallbackVerdict: TriageVerdict = {
        action: 'handoff',
        reason: fallbackReason,
        fallback: true,
      }
      const triageSessionId = await this.recorder?.record({
        bot: input.bot,
        msg: input.msg,
        decision: input.decision,
        ...(input.senderName ? { senderName: input.senderName } : {}),
        ...(input.resolvedChatName ? { chatName: input.resolvedChatName } : {}),
        provider: target.provider,
        model: target.model,
        ...(modelCaps.effort ? { reasoningEffort: modelCaps.effort } : {}),
        maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        toolSchema,
        systemPrompt: system,
        userMessage: userText,
        userContent,
        blocks: run.blocks,
        stream: run.stream,
        ...(run.usage ? { usage: run.usage } : {}),
        verdict: fallbackVerdict,
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        timedOut: run.timedOut,
        startedAtMs,
        finishedAtMs,
        durationMs,
      })
      return failOpen(fallbackReason, target, triageSessionId, classified)
    }

    const verdict = parseTriageVerdict({
      toolCalls: run.toolCalls,
      text: run.assembledText,
      hasActiveWorker: input.hasActiveWorker,
      ...(input.decision.silentOnly ? { silentOnly: true } : {}),
    })
    const triageSessionId = await this.recorder?.record({
      bot: input.bot,
      msg: input.msg,
      decision: input.decision,
      ...(input.senderName ? { senderName: input.senderName } : {}),
      ...(input.resolvedChatName ? { chatName: input.resolvedChatName } : {}),
      provider: target.provider,
      model: target.model,
      ...(modelCaps.effort ? { reasoningEffort: modelCaps.effort } : {}),
      maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      toolSchema,
      systemPrompt: system,
      userMessage: userText,
      userContent,
      blocks: run.blocks,
      stream: run.stream,
      ...(run.usage ? { usage: run.usage } : {}),
      verdict,
      startedAtMs,
      finishedAtMs,
      durationMs,
    })

    return {
      verdict,
      provider: target.provider,
      model: target.model,
      durationMs,
      ...(triageSessionId ? { triageSessionId } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
    }
  }

  private buildTriagePrompts(
    input: EvaluateTriageInput,
    attachedImageCount = 0,
  ): {
    readonly system: string
    readonly userText: string
  } {
    const chatScopeKey = `chat:${input.bot.id}:${input.msg.chatId}`
    const ttlMs = input.routerConfig.contextTtlMinutes * 60_000
    const recentMessages = this.context.getRecentMessages(input.decision.routeKey, chatScopeKey, {
      ttlMs,
      maxCount: input.routerConfig.recentMessageCount,
    })
    const lastWorkerReply =
      input.hasActiveWorker && input.routerConfig.includeLastReply
        ? this.context.getLastWorkerReply(input.decision.routeKey, { ttlMs })
        : undefined

    const roleName =
      input.group?.role?.mode === 'override'
        ? input.group.role.name.trim()
        : input.group?.role?.name?.trim() || (input.bot.role.enabled ? input.bot.role.name.trim() : '')
    const roleSummary =
      input.group?.role?.mode === 'override'
        ? input.group.role.systemPrompt.trim()
        : [
            input.bot.role.enabled ? input.bot.role.systemPrompt.trim() : '',
            input.group?.role?.mode === 'append' ? input.group.role.systemPrompt.trim() : '',
          ]
            .filter(Boolean)
            .join('\n\n')

    const delegationFollowupEnabled = Boolean(
      input.bot.experimental.proactive.remindersEnabled &&
        input.bot.experimental.proactive.delegationFollowupEnabled,
    )
    const silentOnly = Boolean(input.decision.silentOnly)
    const peerMentions = extractPeerUserMentions(input.msg)
      .map((m) => m.name?.trim() || m.openId?.trim() || '')
      .filter(Boolean)

    const system = buildTriageSystemPrompt({
      botName: input.bot.name,
      ...(roleName ? { botRoleName: roleName } : {}),
      ...(roleSummary ? { botRoleSummary: roleSummary } : {}),
      ...(input.resolvedChatName ? { chatName: input.resolvedChatName } : {}),
      hasActiveWorker: input.hasActiveWorker,
      trigger: input.decision.trigger,
      ...(input.decision.listenerName ? { listenerName: input.decision.listenerName } : {}),
      ...(input.decision.trigger === 'listener' && !silentOnly && input.group?.listener?.prompt
        ? { listenerPrompt: input.group.listener.prompt }
        : {}),
      ...(input.routerConfig.systemPrompt
        ? { systemPromptTemplate: input.routerConfig.systemPrompt }
        : {}),
      ...(delegationFollowupEnabled ? { delegationFollowupEnabled: true } : {}),
      ...(silentOnly ? { silentOnly: true } : {}),
    })

    const userText = buildTriageUserMessage({
      botName: input.bot.name,
      ...(roleName ? { botRoleName: roleName } : {}),
      ...(roleSummary ? { botRoleSummary: roleSummary } : {}),
      ...(input.resolvedChatName ? { chatName: input.resolvedChatName } : {}),
      trigger: input.decision.trigger,
      ...(input.decision.listenerName ? { listenerName: input.decision.listenerName } : {}),
      ...(input.senderName ? { senderName: input.senderName } : {}),
      ...(peerMentions.length > 0 ? { peerMentions } : {}),
      senderType: input.msg.senderType,
      msgType: input.msg.msgType,
      userText: input.decision.userText,
      ...(input.quotedMessage ? { quotedMessage: input.quotedMessage } : {}),
      ...(attachedImageCount > 0 ? { attachedImageCount } : {}),
      hasActiveWorker: input.hasActiveWorker,
      workerBusy: input.workerBusy,
      ...(silentOnly ? { silentOnly: true } : {}),
      ...(delegationFollowupEnabled ? { delegationFollowupEnabled: true } : {}),
      ...(lastWorkerReply ? { lastWorkerReply } : {}),
      recentMessages,
      recentMessageCount: input.routerConfig.recentMessageCount,
      includeLastReply: input.routerConfig.includeLastReply,
    })

    return { system, userText }
  }

  private async executeTriageStream(params: {
    readonly target: { readonly provider: string; readonly model: string }
    readonly reasoningEffort?: ReasoningEffortId
    readonly system: string
    readonly userContent: readonly ContentBlock[]
    readonly toolSchema: ToolSchema
    readonly maxTokens: number
    readonly temperature?: number
    readonly timeoutMs: number
    readonly parentSignal?: AbortSignal
  }): Promise<{
    readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>
    readonly assembledText: string
    readonly blocks: readonly ContentBlock[]
    readonly stream: readonly AssistantStreamRecord[]
    readonly usage?: TokenUsage
    readonly errorMessage?: string
    readonly timedOut: boolean
  }> {
    const controller = new AbortController()
    let timedOut = false
    const onParentAbort = () => controller.abort()
    params.parentSignal?.addEventListener('abort', onParentAbort, { once: true })
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, params.timeoutMs)
    timeoutTimer.unref?.()

    const accumulator = new AssistantStreamAccumulator()
    const assembler = new BlockAssembler()
    let usage: TokenUsage | undefined
    let syntheticCallSeq = 0
    const nextCallId = () => brandString<ToolCallId>(`triage_call_${++syntheticCallSeq}`)

    const textChunks: string[] = []
    const blockTexts: string[] = []
    const finalizedToolCalls: Array<{ name: string; arguments: string }> = []
    const pendingToolCalls = new Map<number, { name: string; arguments: string }>()

    try {
      const stream = this.ctx.llm.stream({
        provider: params.target.provider,
        model: params.target.model,
        ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
        system: params.system,
        messages: [{ role: 'user', content: [...params.userContent] }],
        tools: [params.toolSchema],
        maxTokens: params.maxTokens,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        signal: controller.signal,
      })

      for await (const rawChunk of stream) {
        const chunk = normalizeChunkForRecording(rawChunk, nextCallId)
        try {
          accumulator.push({ time: Date.now(), chunk })
          assembler.push(chunk)
        } catch {
          // Never break triage parsing if a provider emits non-standard stream ordering.
        }

        if (chunk.type === 'usage') {
          usage = chunk.usage
        } else if (chunk.type === 'text-delta') {
          textChunks.push(chunk.text)
        } else if (chunk.type === 'tool-call-delta') {
          const entry = pendingToolCalls.get(chunk.index) ?? { name: '', arguments: '' }
          if (chunk.name) entry.name = chunk.name
          if (chunk.argumentsDelta) entry.arguments += chunk.argumentsDelta
          pendingToolCalls.set(chunk.index, entry)
        } else if (chunk.type === 'block-end') {
          if (chunk.block.type === 'tool-call') {
            finalizedToolCalls.push({ name: chunk.block.name, arguments: chunk.block.arguments })
            pendingToolCalls.delete(chunk.index)
          } else if (chunk.block.type === 'text' && chunk.block.text) {
            blockTexts.push(chunk.block.text)
          }
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') {
            throw new Error(chunk.reason.failure.message || 'triage llm error')
          }
          if (chunk.reason.kind === 'aborted') {
            throw new Error(timedOut ? 'triage timeout' : 'triage aborted')
          }
        }
      }

      for (const leftover of pendingToolCalls.values()) {
        if (leftover.name) finalizedToolCalls.push(leftover)
      }
      const assembledText = textChunks.join('') || blockTexts.join('')
      const blocks = this.collectRecordedBlocks(assembler, finalizedToolCalls, assembledText, nextCallId)
      return {
        toolCalls: finalizedToolCalls,
        assembledText,
        blocks,
        stream: accumulator.snapshot(),
        ...(usage ? { usage } : {}),
        timedOut: false,
      }
    } catch (err) {
      return {
        toolCalls: finalizedToolCalls,
        assembledText: textChunks.join('') || blockTexts.join(''),
        blocks: assembler.blocks(),
        stream: accumulator.snapshot(),
        ...(usage ? { usage } : {}),
        errorMessage: err instanceof Error ? err.message : String(err),
        timedOut,
      }
    } finally {
      clearTimeout(timeoutTimer)
      params.parentSignal?.removeEventListener('abort', onParentAbort)
    }
  }

  private collectRecordedBlocks(
    assembler: BlockAssembler,
    finalizedToolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>,
    assembledText: string,
    nextCallId: () => ToolCallId,
  ): ContentBlock[] {
    const assembled = assembler.blocks()
    if (assembled.length > 0) {
      return assembled.map((block) =>
        block.type === 'tool-call' && !block.id ? { ...block, id: nextCallId() } : block,
      )
    }
    const fallbackBlocks: ContentBlock[] = []
    if (assembledText.trim()) {
      fallbackBlocks.push({ type: 'text', text: assembledText })
    }
    for (const tc of finalizedToolCalls) {
      fallbackBlocks.push({
        type: 'tool-call',
        id: nextCallId(),
        name: tc.name,
        arguments: tc.arguments,
      })
    }
    return fallbackBlocks
  }

  private async resolveTriageModelCapabilities(
    provider: string,
    model: string,
  ): Promise<{
    readonly effort?: ReasoningEffortId
    readonly reasoningActive: boolean
    readonly supportsImage: boolean
  }> {
    if (typeof this.ctx.llm?.resolveModelInfo !== 'function') {
      return { reasoningActive: false, supportsImage: false }
    }
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      const supportsImage = Boolean(info?.inputModalities?.includes('image'))
      const efforts = info?.reasoning?.efforts
      if (!efforts || efforts.length === 0) {
        return { reasoningActive: false, supportsImage }
      }
      const least = efforts[0]?.id
      if (!least) {
        return { reasoningActive: false, supportsImage }
      }
      const normalized = String(least).trim().toLowerCase()
      const reasoningActive = normalized !== 'off' && normalized !== 'none'
      return { effort: least, reasoningActive, supportsImage }
    } catch {
      return { reasoningActive: false, supportsImage: false }
    }
  }
}
