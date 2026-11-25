import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  DiscoveredLarkChat,
  LarkBotConfig,
  LarkBotStatus,
  LarkGroupConfig,
  LarkMemoryEntry,
  LarkReminderItem,
  ListenerTemplate,
  SeenMessageEntry,
} from '@dsh-lark/lark-core'
import type { ObservabilityWindow, TelemetryUsageEventInput } from './observability-types.js'
import { CockpitProjector } from './storage/cockpit-projector.js'
import { ConfigRepo } from './storage/config-repo.js'
import {
  BridgeDatabase,
  DB_FILENAME,
  type IntegrityCheckResult,
  type StorageStats,
  type WalCheckpointMode,
  type WalCheckpointResult,
} from './storage/database.js'
import {
  migrateLegacyJsonToSqlite,
  type MigrationVerificationReport,
} from './storage/legacy-migrator.js'
import {
  MemoryRepo,
  type MemoryQueryOptions,
  type MemorySupersedeOutcome,
  type MemoryUpdateInput,
  type MemoryUpsertInput,
  type MemoryUpsertOutcome,
} from './storage/memory-repo.js'
import {
  ObservabilityRepo,
  type ObservabilityRepoAggregate,
} from './storage/observability-repo.js'
import { RuntimeRepo } from './storage/runtime-repo.js'
import { TelemetryRepo } from './storage/telemetry-repo.js'
import type {
  LarkAuditEvent,
  LarkCockpitPayload,
  LarkDreamRunState,
  LarkDreamSession,
  LarkGroupView,
  LarkManagedSession,
  LarkPendingTurn,
  LarkScheduleBinding,
  LarkSessionBinding,
  LarkTriageSession,
} from './types.js'

/**
 * Facade over SQLite WAL storage repositories (`ConfigRepo`, `RuntimeRepo`,
 * `TelemetryRepo`) and `CockpitProjector`. Preserves full backwards compatibility
 * with existing service/test consumers while eliminating full-file JSON write amplification.
 */
export class LarkBridgeStore {
  readonly db: BridgeDatabase
  readonly configRepo: ConfigRepo
  readonly runtimeRepo: RuntimeRepo
  readonly memoryRepo: MemoryRepo
  readonly telemetryRepo: TelemetryRepo
  readonly observabilityRepo: ObservabilityRepo
  readonly projector: CockpitProjector
  private lastMigrationReport?: MigrationVerificationReport

  constructor(
    private readonly dataDir: string,
    maxAuditEvents = 2000,
  ) {
    this.lastMigrationReport = migrateLegacyJsonToSqlite(dataDir, {
      onWarn: (msg) => console.warn(msg),
    })
    this.db = new BridgeDatabase(join(dataDir, DB_FILENAME))
    this.configRepo = new ConfigRepo(this.db, dataDir)
    this.runtimeRepo = new RuntimeRepo(this.db)
    this.memoryRepo = new MemoryRepo(this.db)
    this.telemetryRepo = new TelemetryRepo(this.db, this.configRepo, maxAuditEvents)
    this.observabilityRepo = new ObservabilityRepo(this.db, this.configRepo)
    this.projector = new CockpitProjector(this.configRepo, this.runtimeRepo, this.telemetryRepo)
    if (!this.db.getMeta('observability_v7_installed_at_ms')) {
      this.db.setMeta('observability_v7_installed_at_ms', String(Date.now()))
    }
    this.runtimeRepo.recoverInterruptedDreamSessions()
  }

  // ── Lifecycle, Backup & Introspection ────────────────────────────────────

  close(): void {
    this.configRepo.dispose()
    this.db.close({ checkpoint: true })
  }

  flushConfigSnapshot(): void {
    this.configRepo.flushConfigSnapshot()
  }

  getStorageStats(): StorageStats {
    return this.db.getStats()
  }

  checkpointWal(options?: {
    readonly mode?: WalCheckpointMode
    readonly truncateAboveBytes?: number
  }): WalCheckpointResult {
    return this.db.checkpointWal(options)
  }

  runIntegrityCheck(): IntegrityCheckResult {
    return this.db.integrityCheck()
  }

  backupTo(destPath: string): void {
    this.db.backupTo(destPath)
  }

  getMigrationReport(): MigrationVerificationReport | undefined {
    if (this.lastMigrationReport) return this.lastMigrationReport
    const raw = this.db.getMeta('migration_report_json')
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as MigrationVerificationReport
    } catch {
      return undefined
    }
  }

  // ── Seen Messages ────────────────────────────────────────────────────────

  listSeenMessages(now = Date.now()): SeenMessageEntry[] {
    return this.runtimeRepo.listSeenMessages(now)
  }

  rememberSeenMessage(
    key: string,
    seenAtMs = Date.now(),
    _options: { readonly persist?: boolean } = {},
  ): void {
    this.runtimeRepo.rememberSeenMessage(key, seenAtMs)
  }

  flushSeenMessages(): void {
    this.runtimeRepo.pruneSeenMessages(Date.now())
  }

  // ── Secrets & Configuration ──────────────────────────────────────────────

  getViewerTicketSecret(): string {
    return this.configRepo.getViewerTicketSecret()
  }

  rotateViewerTicketSecret(): string {
    return this.configRepo.rotateViewerTicketSecret()
  }

  listBots(): LarkBotConfig[] {
    return this.configRepo.listBots()
  }

  getBot(id: string): LarkBotConfig | undefined {
    return this.configRepo.getBot(id)
  }

  upsertBot(raw: unknown): LarkBotConfig {
    return this.configRepo.upsertBot(raw)
  }

  updateBotAvatar(botId: string, avatarUrl: string): void {
    this.configRepo.updateBotProfile(botId, { avatarUrl })
  }

  updateBotProfile(
    botId: string,
    patch: { readonly avatarUrl?: string; readonly description?: string },
    options: { readonly preserveNonEmptyDescription?: boolean } = {},
  ): void {
    this.configRepo.updateBotProfile(botId, patch, options)
  }

  deleteBot(id: string): boolean {
    return this.configRepo.deleteBot(id)
  }

  listListenerTemplates(): ListenerTemplate[] {
    return this.configRepo.listListenerTemplates()
  }

  resetListenerTemplates(): ListenerTemplate[] {
    return this.configRepo.resetListenerTemplates()
  }

  listGroups(botId?: string): LarkGroupConfig[] {
    return this.configRepo.listGroups(botId)
  }

  getGroup(botId: string, chatId: string): LarkGroupConfig | undefined {
    return this.configRepo.getGroup(botId, chatId)
  }

  upsertGroup(raw: unknown): LarkGroupConfig {
    return this.configRepo.upsertGroup(raw)
  }

  deleteGroup(botId: string, chatId: string): boolean {
    return this.configRepo.deleteGroup(botId, chatId)
  }

  mergeDiscoveredChats(botId: string, chats: readonly DiscoveredLarkChat[]): void {
    this.configRepo.mergeDiscoveredChats(botId, chats)
  }

  resolveChatName(botId: string, chatId: string): string | undefined {
    return this.configRepo.resolveChatName(botId, chatId)
  }

  listScheduleBindings(): LarkScheduleBinding[] {
    return this.configRepo.listScheduleBindings()
  }

  getScheduleBinding(scheduleId: string): LarkScheduleBinding | undefined {
    return this.configRepo.getScheduleBinding(scheduleId)
  }

  upsertScheduleBinding(raw: unknown): LarkScheduleBinding {
    return this.configRepo.upsertScheduleBinding(raw)
  }

  deleteScheduleBinding(scheduleId: string): boolean {
    return this.configRepo.deleteScheduleBinding(scheduleId)
  }

  // ── Runtime State (Bindings, Sessions, Dreaming, Reminders, Pending) ─────

  listBindings(): LarkSessionBinding[] {
    return this.projector.listBindings()
  }

  getBinding(routeKey: string): LarkSessionBinding | undefined {
    return this.runtimeRepo.getBinding(routeKey)
  }

  getBindingBySessionId(sessionId: string): LarkSessionBinding | undefined {
    return this.runtimeRepo.getBindingBySessionId(sessionId)
  }

  upsertBinding(binding: LarkSessionBinding): void {
    this.runtimeRepo.upsertBinding(binding)
  }

  bindRouteAlias(routeKey: string, aliasRouteKey: string): boolean {
    return this.runtimeRepo.bindRouteAlias(routeKey, aliasRouteKey)
  }

  promoteBindingRoute(
    oldRouteKey: string,
    newPrimaryRouteKey: string,
  ): LarkSessionBinding | undefined {
    return this.runtimeRepo.promoteBindingRoute(oldRouteKey, newPrimaryRouteKey)
  }

  touchBinding(routeKey: string, now = Date.now()): void {
    this.runtimeRepo.touchBinding(routeKey, now)
  }

  markBindingReplied(routeKey: string, now = Date.now()): void {
    this.runtimeRepo.markBindingReplied(routeKey, now)
  }

  deleteBinding(routeKey: string): LarkSessionBinding | undefined {
    return this.runtimeRepo.deleteBinding(routeKey)
  }

  getManagedSession(sessionId: string): LarkManagedSession | undefined {
    return this.runtimeRepo.getManagedSession(sessionId)
  }

  upsertManagedSession(entry: LarkManagedSession): void {
    this.runtimeRepo.upsertManagedSession(entry)
  }

  touchManagedSession(sessionId: string, now = Date.now()): void {
    this.runtimeRepo.touchManagedSession(sessionId, now)
  }

  markSessionArchived(sessionId: string, now = Date.now()): void {
    this.runtimeRepo.markSessionArchived(sessionId, now)
  }

  listActiveManagedSessions(): LarkManagedSession[] {
    return this.runtimeRepo.listActiveManagedSessions()
  }

  listExpiredManagedSessions(now = Date.now()): LarkManagedSession[] {
    return this.runtimeRepo.listExpiredManagedSessions(now)
  }

  listManagedSessionsForBot(botId: string): LarkManagedSession[] {
    return this.runtimeRepo.listManagedSessionsForBot(botId)
  }

  listAllManagedSessions(limit = 600): LarkManagedSession[] {
    return this.runtimeRepo.listAllManagedSessions(limit)
  }

  getDreamState(botId: string): LarkDreamRunState | undefined {
    return this.runtimeRepo.getDreamState(botId)
  }

  upsertDreamState(state: LarkDreamRunState): LarkDreamRunState {
    return this.runtimeRepo.upsertDreamState(state)
  }

  listDreamSessions(botId?: string): LarkDreamSession[] {
    return this.projector.listDreamSessions(botId)
  }

  upsertDreamSession(entry: LarkDreamSession): LarkDreamSession {
    return this.runtimeRepo.upsertDreamSession(entry)
  }

  deleteDreamSession(sessionId: string): boolean {
    return this.runtimeRepo.deleteDreamSession(sessionId)
  }

  listTriageSessions(botId?: string): LarkTriageSession[] {
    return this.projector.listTriageSessions(botId)
  }

  upsertTriageSession(entry: LarkTriageSession): LarkTriageSession {
    return this.runtimeRepo.upsertTriageSession(entry)
  }

  linkTriageHandoffSession(triageSessionId: string, handoffSessionId: string): boolean {
    return this.runtimeRepo.linkTriageHandoffSession(triageSessionId, handoffSessionId)
  }

  deleteTriageSession(sessionId: string): boolean {
    return this.runtimeRepo.deleteTriageSession(sessionId)
  }

  clearTriageSessions(botId?: string): number {
    return this.runtimeRepo.clearTriageSessions(botId)
  }

  listReminders(filter: 'active' | 'archived' | 'all' = 'all'): LarkReminderItem[] {
    return this.runtimeRepo.listReminders(filter)
  }

  getReminder(id: string): LarkReminderItem | undefined {
    return this.runtimeRepo.getReminder(id)
  }

  upsertReminder(raw: unknown): LarkReminderItem {
    return this.runtimeRepo.upsertReminder(raw)
  }

  deleteReminder(id: string): boolean {
    return this.runtimeRepo.deleteReminder(id)
  }

  listPendingTurns(): LarkPendingTurn[] {
    return this.runtimeRepo.listPendingTurns()
  }

  countPendingTurns(): number {
    return this.runtimeRepo.countPendingTurns()
  }

  upsertPendingTurn(turn: LarkPendingTurn): LarkPendingTurn {
    return this.runtimeRepo.upsertPendingTurn(turn)
  }

  deletePendingTurn(id: string): boolean {
    return this.runtimeRepo.deletePendingTurn(id)
  }

  resolvePrimaryRouteKey(routeKey: string): string {
    return this.runtimeRepo.resolvePrimaryRouteKey(routeKey)
  }

  loadTriageContextScopes(minUpdatedAtMs = 0) {
    return this.runtimeRepo.loadTriageContextScopes(minUpdatedAtMs)
  }

  upsertTriageContextScope(
    scopeKey: string,
    kind: 'history' | 'worker_reply' | 'ephemeral_thread',
    payloadJson: string,
    updatedAtMs: number,
  ): void {
    this.runtimeRepo.upsertTriageContextScope(scopeKey, kind, payloadJson, updatedAtMs)
  }

  deleteTriageContextScope(
    scopeKey: string,
    kind?: 'history' | 'worker_reply' | 'ephemeral_thread',
  ): number {
    return this.runtimeRepo.deleteTriageContextScope(scopeKey, kind)
  }

  pruneTriageContextScopes(cutoffMs: number): number {
    return this.runtimeRepo.pruneTriageContextScopes(cutoffMs)
  }

  // ── Memory (Runtime-Agnostic Long-Term Memory) ───────────────────────────

  getMemoryEntry(id: string): LarkMemoryEntry | undefined {
    return this.memoryRepo.get(id)
  }

  listMemoryEntries(options: MemoryQueryOptions = {}): LarkMemoryEntry[] {
    return this.memoryRepo.list(options)
  }

  countActiveMemoryByBot(): Map<string, number> {
    return this.memoryRepo.countActiveByBot()
  }

  countActiveMemoryForBot(botId: string): number {
    return this.memoryRepo.countActiveForBot(botId)
  }

  upsertMemoryEntry(input: MemoryUpsertInput, nowMs = Date.now()): MemoryUpsertOutcome {
    return this.memoryRepo.upsert(input, nowMs)
  }

  updateMemoryEntry(
    id: string,
    patch: MemoryUpdateInput,
    nowMs = Date.now(),
  ): LarkMemoryEntry | undefined {
    return this.memoryRepo.update(id, patch, nowMs)
  }

  supersedeMemoryEntry(
    oldId: string,
    input: {
      readonly reason: string
      readonly replacement?: Omit<MemoryUpsertInput, 'botId' | 'supersedesId' | 'supersedeReason'>
    },
    nowMs = Date.now(),
  ): MemorySupersedeOutcome | undefined {
    return this.memoryRepo.supersede(oldId, input, nowMs)
  }

  archiveMemoryEntry(id: string, reason?: string, nowMs = Date.now()): LarkMemoryEntry | undefined {
    return this.memoryRepo.archive(id, reason, nowMs)
  }

  deleteMemoryEntryHard(id: string): LarkMemoryEntry | undefined {
    return this.memoryRepo.deleteHard(id)
  }

  recordMemoryRecalls(ids: readonly string[], nowMs = Date.now()): void {
    this.memoryRepo.recordRecalls(ids, nowMs)
  }

  getMemorySummaryStats(botId?: string): {
    readonly activeCount: number
    readonly pinnedCount: number
    readonly totalRecalls: number
  } {
    return this.memoryRepo.getSummaryStats(botId)
  }

  // ── Telemetry, Audit & View Projections ──────────────────────────────────

  getObservabilityInstalledAtMs(): number {
    const raw = this.db.getMeta('observability_v7_installed_at_ms')
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now()
  }

  recordUsageEvent(input: TelemetryUsageEventInput): boolean {
    return this.observabilityRepo.recordUsageEvent(input)
  }

  recordUsageEventsBatch(events: readonly TelemetryUsageEventInput[]): number {
    return this.observabilityRepo.recordUsageEventsBatch(events)
  }

  queryObservabilityAggregate(options: {
    readonly window?: ObservabilityWindow
    readonly botId?: string
    readonly chatId?: string
    readonly nowMs?: number
  }): ObservabilityRepoAggregate {
    return this.observabilityRepo.queryAggregate(options)
  }

  recordMetric(input: {
    readonly botId: string
    readonly chatId?: string
    readonly chatName?: string
    readonly chatType?: string
    readonly sessionId?: string
    readonly trigger?: string
    readonly errorCode?: string
    readonly kind: 'inbound' | 'replied' | 'listener' | 'silent_skip' | 'ignored' | 'error'
    readonly latencyMs?: number
    readonly now?: number
  }): void {
    this.telemetryRepo.recordMetric(input)
    if (input.kind === 'listener') return
    const ts = input.now ?? Date.now()
    const normalizedChatType: 'group' | 'p2p' | 'internal' | '' =
      input.chatType === 'p2p' || input.trigger === 'p2p'
        ? 'p2p'
        : input.chatType === 'internal'
          ? 'internal'
          : input.chatId
            ? 'group'
            : ''
    const recordKind =
      input.kind === 'inbound' || input.kind === 'ignored'
        ? 'inbound'
        : input.trigger === 'schedule' || input.trigger === 'reminder' || input.trigger === 'dreaming'
          ? 'proactive'
          : 'turn'
    const outcome =
      input.kind === 'inbound'
        ? 'received'
        : input.kind === 'replied'
          ? 'replied'
          : input.kind === 'silent_skip'
            ? 'silent_skip'
            : input.kind === 'ignored'
              ? 'ignored'
              : 'error'
    this.observabilityRepo.recordUsageEvent({
      id: `metric:${ts}:${randomUUID()}`,
      timestampMs: ts,
      recordKind,
      botId: input.botId,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(normalizedChatType ? { chatType: normalizedChatType } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      outcome,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    })
  }

  recordEvent(input: Omit<LarkAuditEvent, 'id' | 'timestampMs'>): LarkAuditEvent {
    return this.telemetryRepo.recordEvent(input)
  }

  listEvents(limit = 100): LarkAuditEvent[] {
    return this.telemetryRepo.listEvents(limit)
  }

  listEventsByTrace(traceId: string): LarkAuditEvent[] {
    return this.telemetryRepo.listEventsByTrace(traceId)
  }

  listGroupViews(filterBotId?: string): LarkGroupView[] {
    return this.projector.listGroupViews(filterBotId)
  }

  resolveBotWorkspaceName(bot: LarkBotConfig): string {
    return this.projector.resolveBotWorkspaceName(bot)
  }

  resolveGroupWorkspaceName(
    bot: LarkBotConfig,
    group?: LarkGroupConfig,
    fallbackChatName?: string,
  ): string {
    return this.projector.resolveGroupWorkspaceName(bot, group, fallbackChatName)
  }

  buildCockpit(
    statuses: readonly LarkBotStatus[],
    sessionUrlBuilder: (sessionId: string) => string,
    now = Date.now(),
  ): LarkCockpitPayload {
    return this.projector.buildCockpit(statuses, sessionUrlBuilder, now)
  }
}
