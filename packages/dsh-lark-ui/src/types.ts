/** Wire DTOs served by `/api/lark-bridge/*`. Mirrors the host payloads without importing them. */

export type GroupReplyMode = 'new-topic' | 'reply' | 'chat'
export type GroupSessionMode = 'thread' | 'per_message' | 'chat'
export type MentionTriggerMode = 'mention_and_active_thread' | 'mention_only'
export type Inheritable<T extends string> = 'inherit' | T

export interface RoleDefinition {
  enabled: boolean
  name: string
  systemPrompt: string
  presetKey?: string
}

export interface SubstituteTarget {
  openId: string
  name: string
  email?: string
  avatarUrl?: string
  note?: string
}

export interface SubstituteMode {
  enabled: boolean
  targets: SubstituteTarget[]
  disclosure: 'none' | 'subtle' | 'explicit'
  activeThreadFollowup: boolean
}

export type ReminderCreationMode = 'silent' | 'notify' | 'confirm'
export type RouterScopeMode = 'passive_only' | 'active_thread_only' | 'all_group'
export type GroupRouterMode = 'inherit' | 'override' | 'off'
export type RouterBypassMsgType = 'interactive' | 'text' | 'post' | 'image'

export interface RouterBypassConfig {
  senderTypes: ListenerSenderType[]
  msgTypes: RouterBypassMsgType[]
  keywords: string[]
}

export interface BotDreamingConfig {
  enabled: boolean
  scheduleTime: string
  minNewSessions: number
  scopes: string[]
  cleanupAndCorrect: boolean
}

export interface BotProactiveConfig {
  remindersEnabled: boolean
  reminderCreationMode: ReminderCreationMode
  delegationFollowupEnabled?: boolean
  quietHoursEnabled?: boolean
  quietHoursStart?: string
  quietHoursEnd?: string
  autoCodeEnabled: boolean
  branchPrefix: string
}

export type TriageAction = 'silent' | 'quick_reply' | 'handoff'

export interface TriagePromptVariable {
  key: string
  token: string
  label: string
  desc: string
}

export interface TriageToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TriageDefaultsPayload {
  defaultSystemPrompt: string
  variables: TriagePromptVariable[]
  toolName: string
  toolSchema?: TriageToolSchema
}

export interface BotRouterConfig {
  enabled: boolean
  provider: string
  model: string
  scope: RouterScopeMode
  bypass?: RouterBypassConfig
  timeoutMs: number
  maxTriageImages?: number
  systemPrompt: string
  recentMessageCount: number
  contextTtlMinutes: number
  includeLastReply: boolean
  coalesceQueuedMessages: boolean
}

export interface GroupRouterConfig {
  mode: GroupRouterMode
  provider: string
  model: string
  scope: RouterScopeMode
  bypass?: RouterBypassConfig
  timeoutMs: number
  maxTriageImages?: number
  systemPrompt: string
  recentMessageCount: number
  contextTtlMinutes: number
  includeLastReply: boolean
  coalesceQueuedMessages: boolean
}

export interface BotExperimentalConfig {
  dreaming: BotDreamingConfig
  proactive: BotProactiveConfig
}

export interface DreamRunState {
  botId: string
  status: 'idle' | 'running' | 'succeeded' | 'skipped' | 'failed'
  lastDreamAtMs?: number
  lastCheckedDateKey?: string
  lastSessionId?: string
  lastProcessedCount?: number
  lastSummary?: string
  processedSessionIds: string[]
}

export type MemoryType = 'feedback' | 'user' | 'project' | 'reference'
export type MemoryScope = 'bot' | 'chat' | 'workspace'
export type MemoryStatus = 'active' | 'superseded' | 'archived'
export type MemoryConfidence = 'high' | 'medium'

export interface MemoryEntry {
  id: string
  botId: string
  scope: MemoryScope
  scopeId: string
  type: MemoryType
  title: string
  content: string
  tags: string[]
  confidence: MemoryConfidence
  pinned: boolean
  status: MemoryStatus
  sourceSessionId?: string
  supersededBy?: string
  supersededAtMs?: number
  supersedeReason?: string
  createdAtMs: number
  updatedAtMs: number
  lastVerifiedAtMs: number
  lastRecalledAtMs?: number
  recallCount: number
}

export interface MemoryMutationStats {
  created: number
  updated: number
  superseded: number
  archived: number
}

export interface DreamSession {
  sessionId: string
  botId: string
  botName?: string
  workspaceName: string
  workingDir: string
  agentPreset: string
  runtimeProfileId?: string
  model?: string
  status: 'running' | 'succeeded' | 'failed'
  outcome?: 'memory_updated' | 'no_change' | 'failed'
  memoryStats?: MemoryMutationStats
  dateKey: string
  processedCount: number
  summary?: string
  createdAtMs: number
  lastActivityMs: number
  durationMs?: number
  sessionUrl?: string
}

export interface TriageSession {
  sessionId: string
  botId: string
  botName?: string
  chatId: string
  chatName?: string
  workspaceName: string
  workingDir: string
  routeKey: string
  trigger: string
  listenerName?: string
  senderName?: string
  action: TriageAction
  fallback?: boolean
  reason: string
  errorCode?: string
  errorMessage?: string
  replyText?: string
  provider?: string
  model?: string
  durationMs: number
  handoffSessionId?: string
  createdAtMs: number
  lastActivityMs: number
  sessionUrl?: string
}

export type ReminderStatus = 'pending_confirm' | 'scheduled' | 'running' | 'archived'
export type ReminderResolution = 'reminded' | 'silent_ok' | 'cancelled' | 'rejected' | 'error'

export interface ReminderOrigin {
  botId: string
  botName: string
  larkAppId: string
  chatType: 'group' | 'p2p'
  chatId?: string
  chatName?: string
  replyToMessageId?: string
  deliveryMode: 'thread' | 'chat' | 'p2p'
  userOpenId?: string
  userName?: string
  sourceSessionId?: string
}

export interface ReminderMention {
  openId: string
  name: string
}

export interface ReminderWorktreeMeta {
  worktreePath: string
  branch: string
  prUrl?: string
}

export type ReminderKind = 'general' | 'delegation'

export interface ReminderItem {
  id: string
  kind?: ReminderKind
  title: string
  prompt: string
  reason?: string
  scheduledAt: string
  status: ReminderStatus
  resolution?: ReminderResolution
  origin: ReminderOrigin
  workingDir?: string
  mentions: ReminderMention[]
  ccMentions?: ReminderMention[]
  worktree?: ReminderWorktreeMeta
  confirmMessageId?: string
  lastSessionId?: string
  resultSummary?: string
  urgency?: 'normal' | 'high'
  retryCount?: number
  deferredFromScheduledAt?: string
  chainDepth?: number
  createdAtMs: number
  updatedAtMs: number
  archivedAtMs?: number
}

export interface DirectoryCrumb {
  name: string
  path: string
  hidden: boolean
}

export interface DirectoryBrowseResult {
  path: string
  home: string
  crumbs: DirectoryCrumb[]
  entries: DirectoryCrumb[]
  truncated: boolean
}

export interface BotStatusView {
  botId: string
  avatarUrl?: string
  connected: boolean
  enabled: boolean
  lastEventAtMs?: number
  lastError?: string
  activeBindings: number
}

/** Editable bot fields; the secret is write-only and never returned by the host. */
export interface BotConfig {
  id: string
  name: string
  enabled: boolean
  larkAppId: string
  larkAppSecret?: string
  avatarUrl: string
  description: string
  agentPreset: string
  runtimeProfileId?: string
  model?: string
  reasoningEffort?: string
  defaultWorkingDir: string
  workspaceName: string
  groupReplyMode: GroupReplyMode
  groupSessionMode: GroupSessionMode
  mentionTriggerMode: MentionTriggerMode
  groupAccessMode: 'configured_only' | 'all_joined'
  p2pEnabled: boolean
  p2pSessionMode: 'chat' | 'per_message'
  allowedUsers: string[]
  allowedUserProfiles?: SubstituteTarget[]
  adminUsers: string[]
  adminUserProfiles?: SubstituteTarget[]
  sendIntermediateMessages: boolean
  useInteractiveCard: boolean
  dshSessionLinkInCard: boolean
  sessionLinkGuestReadOnly: boolean
  replyFooterEnabled: boolean
  replyFooterModel: boolean
  replyFooterSignature: boolean
  signature: string
  receivedReactionEmoji: string
  idleCloseMinutes: number
  role: RoleDefinition
  substituteMode: SubstituteMode
  router: BotRouterConfig
  experimental: BotExperimentalConfig
}

export interface BotRecord extends BotConfig {
  hasSecret: boolean
  effectiveWorkspaceName: string
  configuredGroupCount: number
  activeMemoryCount?: number
  status?: BotStatusView
  dreamState?: DreamRunState
}

export interface GroupRoleConfig {
  mode: 'inherit' | 'append' | 'override'
  name: string
  systemPrompt: string
  presetKey?: string
}

export type ListenerMsgType = 'text' | 'post' | 'interactive' | 'image' | 'merge_forward'
export type ListenerSenderType = 'user' | 'bot'

export interface ListenerTemplate {
  key: string
  label: string
  name: string
  scope: 'top_level' | 'all'
  replyMode: GroupReplyMode
  sessionMode: GroupSessionMode
  autoCloseAfterCompletion: boolean
  msgTypes: ListenerMsgType[]
  senderTypes: ListenerSenderType[]
  prompt: string
}

export interface GroupListenerRule {
  enabled: boolean
  templateKey: string
  name: string
  prompt: string
  replyMode: GroupReplyMode
  sessionMode: GroupSessionMode
  allowSilentEmptyReply: boolean
  autoCloseAfterCompletion: boolean
  scope: 'top_level' | 'all'
  msgTypes: ListenerMsgType[]
  senderTypes: ListenerSenderType[]
  senderFilterMode: 'all_except_excluded' | 'include_only'
  senderOpenIds: string[]
  memberOverrides: Record<string, boolean>
  includeKeywords: string[]
  excludeKeywords: string[]
}

export interface GroupConfig {
  key: string
  botId: string
  chatId: string
  chatName: string
  description: string
  enabled: boolean
  workingDir: string
  workspaceName: string
  runtimeMode: 'inherit' | 'override'
  agentPreset: string
  runtimeProfileId?: string
  model: string
  reasoningEffort: string
  replyMode: Inheritable<GroupReplyMode>
  sessionMode: Inheritable<GroupSessionMode>
  mentionTriggerMode: Inheritable<MentionTriggerMode>
  idleCloseMinutes?: number | null
  receivedReactionEmoji: string
  intermediateMessages: Inheritable<'on' | 'off'>
  replyFormat: Inheritable<'card' | 'text'>
  dshSessionLinkInCard: Inheritable<'on' | 'off'>
  sessionLinkGuestReadOnly: Inheritable<'on' | 'off'>
  replyFooterModel: Inheritable<'on' | 'off'>
  signatureMode: 'inherit' | 'custom' | 'off'
  signature: string
  router?: GroupRouterConfig
  role: GroupRoleConfig
  listener: GroupListenerRule
}

export interface GroupView {
  key: string
  botId: string
  botName: string
  chatId: string
  chatName: string
  description: string
  avatar?: string
  configured: boolean
  inChat: boolean
  effectiveWorkspaceName: string
  effectiveWorkingDir: string
  runtimeSource: 'bot' | 'group'
  effectiveAgentPreset: string
  effectiveRuntimeProfileId?: string
  effectiveModel?: string
  effectiveReasoningEffort?: string
  activeSessionCount: number
  inboundTotal: number
  config: GroupConfig
}

export interface ChatMemberItem {
  openId: string
  name: string
  memberType: 'user' | 'bot'
  avatarUrl?: string
  email?: string
}

export interface UserSearchHit {
  openId: string
  name: string
  enName?: string
  email?: string
  avatarUrl?: string
}

export interface OpenPlatformIdentity {
  userId: string
  userName: string
  email?: string
  tenantId: string
  tenantName: string
}

export interface OpenPlatformStatus {
  authenticated: boolean
  source?: 'local_cache' | 'cli_cache'
  identity?: OpenPlatformIdentity
  message?: string
}

export interface OpenPlatformAppItem {
  appId: string
  name: string
  description: string
  avatarUrl?: string
  hasBotAbility: boolean
  abilities: string[]
  appStatus: number
  version?: string
  role?: number
  updateTime?: number
  alreadyConnected: boolean
  connectedBotId?: string
  connectedBotName?: string
}

export interface OpenPlatformAppsPayload {
  authenticated: boolean
  identity?: OpenPlatformIdentity
  apps: OpenPlatformAppItem[]
}

export interface BaselineEventSyncResult {
  synced: boolean
  skipped?: boolean
  addedEvents: string[]
  addedCallbacks: string[]
  version?: string
  message?: string
}

export interface ImportExistingBotInput {
  larkAppId: string
  workspaceName?: string
  defaultWorkingDir: string
  agentPreset: string
  runtimeProfileId?: string
  model?: string
  reasoningEffort?: string
  syncBaselineEvents?: boolean
}

export interface UserAuthStatus {
  botId: string
  authorized: boolean
  expiresAtMs?: number
  scope?: string
}

export interface AuthStatusPayload {
  openPlatform: OpenPlatformStatus
  userAuth: UserAuthStatus[]
}

export interface QrJobView {
  jobId: string
  status: 'waiting_scan' | 'scanned' | 'working' | 'succeeded' | 'expired' | 'failed'
  stepMessage: string
  qrSvgDataUrl?: string
  verificationUrl?: string
  identity?: OpenPlatformIdentity
  createdBotId?: string
  larkAppId?: string
  error?: string
}

export interface AutoCreateBotInput {
  mode: 'open_platform' | 'device_flow'
  id?: string
  name: string
  description?: string
  workspaceName?: string
  defaultWorkingDir: string
  agentPreset: string
  runtimeProfileId?: string
  model?: string
  reasoningEffort?: string
}

export interface SessionBinding {
  routeKey: string
  botId: string
  botName?: string
  chatId: string
  chatName?: string
  workspaceName: string
  sessionId: string
  agentPreset: string
  runtimeProfileId?: string
  workingDir: string
  trigger: string
  listenerName?: string
  lastActivityMs: number
}

export type AuditEventKind = 'inbound' | 'triage' | 'command' | 'reply' | 'silent_skip' | 'ignored' | 'error' | 'lifecycle'

export interface AuditEvent {
  id: string
  timestampMs: number
  botId: string
  botName?: string
  chatId?: string
  chatName?: string
  sessionId?: string
  durationMs?: number
  kind: AuditEventKind
  summary: string
}

export interface DiagnosticAlert {
  id: string
  code:
    | 'split_brain'
    | 'storage_integrity'
    | 'wal_bloated'
    | 'bot_disconnected'
    | 'stale_lock_recovered'
  severity: 'info' | 'warning' | 'error'
  botId?: string
  title: string
  detail: string
  suggestion: string
  timestampMs: number
}

export interface CockpitPayload {
  summary: {
    serviceHealthy: boolean
    onlineBots: number
    totalBots: number
    configuredGroups: number
    activeListeners: number
    activeBindings: number
    inbound24h: number
    replied24h: number
    silentSkipped24h?: number
    errors24h: number
    peakHourlyCount?: number
    successRate24h: number
    avgLatencyMs: number
    p95LatencyMs: number
  }
  alerts?: DiagnosticAlert[]
  hourlySeries: Array<{
    hourKey: string
    label: string
    inbound: number
    replied: number
    silentSkipped?: number
    errors: number
    avgLatencyMs?: number
  }>
  botRows: Array<
    BotStatusView & {
      name: string
      workspaceName: string
      agentPreset: string
      runtimeProfileId?: string
      model?: string
      inboundTotal: number
      repliedTotal: number
      avgLatencyMs: number
    }
  >
  topGroups: Array<{
    key: string
    botId: string
    botName: string
    chatId: string
    chatName: string
    workspaceName: string
    inboundTotal: number
    repliedTotal: number
    activeSessions: number
  }>
  recentEvents: AuditEvent[]
  listenerTemplates?: ListenerTemplate[]
  triageDefaults?: TriageDefaultsPayload
}

export interface RuntimeProfileAuthMethod {
  id: string
  name?: string
  description?: string
}

export interface RuntimeProfileCapabilities {
  supportsCliProfile: boolean
  supportsConfigFile: boolean
  configFileHint?: string
  supportsEnv: boolean
  envHints?: string[]
  supportsArgs: boolean
  supportsAuthMethod: boolean
  authMethods?: RuntimeProfileAuthMethod[]
  supportsExposeAsPreset: boolean
}

export interface RuntimeProfileSummary {
  id: string
  runtimeId: string
  name: string
  description?: string
  source: 'discovered' | 'config' | 'user'
  cliProfile?: string
  configFile?: string
  env?: Record<string, string>
  secretEnvKeys?: string[]
  args?: string[]
  argsMode?: 'append' | 'prepend' | 'replace'
  authMethodId?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  exposeAsPreset?: boolean
  presetId?: string
  providerId?: string
}

export interface RuntimeProfileInput {
  id?: string
  runtimeId: string
  name: string
  description?: string
  cliProfile?: string
  configFile?: string
  env?: Record<string, string>
  removeEnvKeys?: string[]
  args?: string[]
  argsMode?: 'append' | 'prepend' | 'replace'
  authMethodId?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  exposeAsPreset?: boolean
}

export interface ExposedRuntimePreset {
  presetId: string
  runtimeId: string
  profileId: string
  displayName: string
  description: string
  providerId: string
  defaultModel: string
  defaultReasoningEffort?: string
}

export interface RuntimeCatalogPayload {
  runtimes: RuntimeOption[]
  exposedPresets: ExposedRuntimePreset[]
}

/** One agent runtime (DSH preset) the bridge can route a conversation to. */
export interface RuntimeOption {
  id: string
  name: string
  description: string
  kind: 'external' | 'native'
  group?: 'builtin' | 'custom'
  providerId?: string
  defaultModel?: string
  supportsReasoningEffort: boolean
  supportsProfiles?: boolean
  profileCapabilities?: RuntimeProfileCapabilities
  profiles?: RuntimeProfileSummary[]
  isDefault: boolean
  broken?: string
}

export interface CatalogModelItem {
  id: string
  name: string
  reasoningEfforts?: string[]
  defaultEffort?: string
  isDefault?: boolean
}

export interface ModelGroup {
  provider: string
  name?: string
  isExternal?: boolean
  models: CatalogModelItem[]
}

export interface ScheduleTarget {
  botId: string
  chatId: string
}

export type ScheduleDeliveryMode = 'chat' | 'thread'
export type ScheduleNotifyOn = 'non_empty' | 'always' | 'error_only'

export interface ScheduleBinding {
  scheduleId: string
  enabled: boolean
  targets: ScheduleTarget[]
  deliveryMode: ScheduleDeliveryMode
  notifyOn: ScheduleNotifyOn
  sendIntermediateMessages?: boolean
}

export interface ScheduleOriginHint {
  botId: string
  botName: string
  chatId: string
  chatName: string
  replyToMessageId?: string
}

export interface ScheduleView {
  id: string
  title: string
  prompt: string
  kind: string
  ruleSummary: string
  status: 'active' | 'paused' | 'ended'
  scheduledAt: string
  executionActive: boolean
  lastDeliveredAt?: string
  lastTargetSessionId?: string
  inferredOrigin?: ScheduleOriginHint
  configured: boolean
  binding: ScheduleBinding
}

export type ManagedPluginId = 'bridge' | 'external-agents'

export type PluginSourceKind =
  | 'github-release'
  | 'registry'
  | 'local-link'
  | 'local-file'
  | 'git'
  | 'unknown'
  | 'not-installed'

export interface PluginReleaseInfo {
  version: string
  tagName: string
  publishedAt?: string
  releaseUrl: string
  tarballUrl: string
  assetName: string
  expectedSha256?: string
  checksumUrl?: string
  releaseNotes?: string
  source: 'github-api' | 'github-redirect' | 'mirror'
}

export interface ManagedPluginStatus {
  id: ManagedPluginId
  displayName: string
  packageName: string
  installedPackageName?: string
  githubRepo: string
  installed: boolean
  enabled: boolean
  installedVersion?: string
  runningVersion?: string
  sourceKind: PluginSourceKind
  sourceLabel: string
  latest?: PluginReleaseInfo
  updateAvailable: boolean
  hotReloadSupported: boolean
  updateBlockedReason?: string
  checkError?: string
  checkedAtMs?: number
}

export type PluginUpdateOpStatus =
  | 'queued'
  | 'verifying'
  | 'draining'
  | 'removing'
  | 'installing'
  | 'restoring'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface PluginUpdateItemResult {
  id: ManagedPluginId
  displayName: string
  packageName: string
  fromVersion?: string
  toVersion: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back'
  hotReloaded: boolean
  restartRequired: boolean
  restartReason?: string
  error?: string
  rolledBack?: boolean
}

export type PluginUpdateFailureCode =
  | 'drain_timeout'
  | 'verify_failed'
  | 'install_failed'
  | 'unknown'

export interface PluginUpdateOperation {
  operationId: string
  status: PluginUpdateOpStatus
  message: string
  startedAtMs: number
  updatedAtMs: number
  finishedAtMs?: number
  targetSelector?: ManagedPluginId | 'all'
  currentTarget?: ManagedPluginId
  forced?: boolean
  failureCode?: PluginUpdateFailureCode
  items: PluginUpdateItemResult[]
  hotReloaded: boolean
  restartRequired: boolean
  error?: string
}

export interface PluginUpdatesOverview {
  ok: true
  profileName?: string
  hmrAvailable: boolean
  pluginManagerAvailable: boolean
  hotReloadSupported: boolean
  hotReloadUnavailableReason?: string
  checkedAtMs?: number
  inFlightTurns?: number
  activeExternalAgents?: number
  updatableCount: number
  plugins: ManagedPluginStatus[]
  operation?: PluginUpdateOperation
}

export type ObservabilityWindow = '24h' | '7d' | '30d' | '90d'

export interface ObservabilitySeriesPoint {
  bucketStartMs: number
  bucketEndMs: number
  label: string
  fullLabel: string
  inbound: number
  replied: number
  silentSkipped: number
  errors: number
  sessions: number
  llmSteps: number
  toolCalls: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  latencyP50Ms: number
  latencyP95Ms: number
  avgLatencyMs: number
}

export interface ObservabilityLatencyBucket {
  id: string
  label: string
  count: number
  pct: number
}

export interface ObservabilityModelBreakdown {
  model: string
  provider: string
  agentPreset: string
  agents?: string[]
  steps: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate: number
  sharePct: number
}

export interface ObservabilityAgentModelSummary {
  model: string
  totalTokens: number
  sharePct: number
}

export interface ObservabilityAgentBreakdown {
  agentKey: string
  agentPreset: string
  kind: 'runtime' | 'triage' | 'unknown'
  sessions: number
  steps: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate: number
  sharePct: number
  models: ObservabilityAgentModelSummary[]
}

export interface ObservabilityRankModelSummary {
  model: string
  agentPreset: string
  totalTokens: number
}

export interface ObservabilityTriggerBreakdown {
  trigger: string
  count: number
  sessions?: number
  replied: number
  errors: number
  totalTokens: number
  sharePct: number
}

export interface ObservabilityErrorBreakdown {
  code: string
  count: number
  sharePct: number
  latestAtMs: number
}

export interface ObservabilityBotRow {
  botId: string
  name: string
  avatarUrl?: string
  agentPreset: string
  runtimeProfileId?: string
  model?: string
  enabled: boolean
  connected: boolean
  sessions: number
  activeBindings: number
  inbound: number
  replied: number
  silentSkipped: number
  errors: number
  successRate: number
  totalTokens: number
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  topModels?: ObservabilityRankModelSummary[]
  cacheHitRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  ackP50Ms: number
  ackP95Ms: number
  ackSamples: number
  sdkErrorCount: number
  lastEventAtMs?: number
  lastError?: string
}

export interface ObservabilityChatRow {
  key: string
  botId: string
  botName: string
  chatId: string
  chatName: string
  chatType: 'group' | 'p2p' | 'internal'
  sessions: number
  activeBindings: number
  inbound: number
  replied: number
  errors: number
  totalTokens: number
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  topModels?: ObservabilityRankModelSummary[]
  cacheHitRate: number
  avgLatencyMs: number
  lastActiveMs: number
}

export interface ObservabilityChatFilterOption {
  chatId: string
  chatName: string
  chatType: 'group' | 'p2p'
  botIds: string[]
}

export interface ObservabilitySenderBotSummary {
  botId: string
  botName: string
  totalTokens: number
}

export interface ObservabilitySenderRow {
  senderId: string
  senderName: string
  senderType: 'user' | 'bot'
  avatarUrl?: string
  sessions: number
  activeChats: number
  inbound: number
  replied: number
  silentSkipped: number
  errors: number
  llmSteps: number
  totalTokens: number
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  topModels?: ObservabilityRankModelSummary[]
  topBots?: ObservabilitySenderBotSummary[]
  cacheHitRate: number
  avgLatencyMs: number
  lastActiveMs: number
}

export interface ObservabilitySenderFilterOption {
  senderId: string
  senderName: string
  senderType: 'user' | 'bot'
  avatarUrl?: string
  botIds: string[]
}

export interface ObservabilityHeatmapCell {
  dayOfWeek: number
  hour: number
  count: number
  tokens: number
}

export interface ProcessVitalPoint {
  timestampMs: number
  label: string
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
  eventLoopP95Ms: number
  eventLoopMeanMs: number
  activeTurns: number
  onlineBots: number
}

export interface StorageCategoryEntry {
  id: string
  label: string
  pathLabel: string
  scope: 'bridge' | 'dsh'
  bytes: number
  fileCount: number
  sharePct: number
}

export interface ObservabilitySqlQueryPerf {
  fingerprint: string
  count: number
  avgMs: number
  maxMs: number
  lastAtMs: number
}

export interface ObservabilityApiRoutePerf {
  route: string
  count: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  lastAtMs: number
}

export interface ObservabilityDatabasePerf {
  totalQueries: number
  sampleCount: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  slowThresholdMs: number
  slowQueryCount: number
  integrityCheckMs: number
  integrityCheckedAtMs?: number
  lastCheckpointMs?: number
  lastCheckpointAtMs?: number
  slowQueries: ObservabilitySqlQueryPerf[]
  apiRoutes: ObservabilityApiRoutePerf[]
}

export interface StorageTableStat {
  table: string
  rows: number
}

export interface ObservabilityPayload {
  generatedAtMs: number
  window: ObservabilityWindow
  fromMs: number
  toMs: number
  bucketSpanMs: number
  filters: {
    botId: string
    chatId: string
    senderId?: string
    chats: ObservabilityChatFilterOption[]
    senders?: ObservabilitySenderFilterOption[]
  }
  backfill: {
    running: boolean
    completed: boolean
    scannedSessions: number
    totalSessions: number
    lastCompletedAtMs?: number
  }
  product: {
    tokens: {
      total: number
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      reasoning: number
      cacheHitRate: number
      avgPerReply: number
      deltaPct: number | null
    }
    sessions: {
      activeInWindow: number
      createdInWindow: number
      archivedInWindow: number
      liveBindings: number
      deltaPct: number | null
    }
    traffic: {
      inbound: number
      replied: number
      silentSkipped: number
      ignored: number
      errors: number
      llmSteps: number
      toolCalls: number
      toolErrors: number
      toolErrorRate: number
      deltaPct: number | null
    }
    triage: {
      total: number
      silent: number
      quickReply: number
      handoff: number
      fallback: number
      deflectRate: number
      avgLatencyMs: number
      p95LatencyMs: number
      totalTokens: number
    }
    proactive: {
      scheduleRuns: number
      reminderRuns: number
      dreamRuns: number
      activeReminders: number
      pendingConfirmReminders: number
      configuredSchedules: number
      activeMemories: number
      pinnedMemories: number
      totalMemoryRecalls: number
    }
    models: ObservabilityModelBreakdown[]
    agents?: ObservabilityAgentBreakdown[]
    triggers: ObservabilityTriggerBreakdown[]
    heatmap: {
      maxCount: number
      cells: ObservabilityHeatmapCell[]
    }
    botRanking: ObservabilityBotRow[]
    chatRanking: ObservabilityChatRow[]
    senderRanking?: ObservabilitySenderRow[]
  }
  technical: {
    sla: {
      successRate: number
      deltaPct: number | null
      errorRate: number
      triageFallbackRate: number
      toolErrorRate: number
      totalErrors: number
      abortedTurns: number
      interruptedRecoveries: number
    }
    latency: {
      samples: number
      avgMs: number
      p50Ms: number
      p75Ms: number
      p95Ms: number
      p99Ms: number
      maxMs: number
      deltaP95Pct: number | null
      histogram: ObservabilityLatencyBucket[]
    }
    connections: {
      onlineBots: number
      enabledBots: number
      totalBots: number
      avgAckP50Ms: number
      maxAckP95Ms: number
      totalSdkErrors: number
      splitBrainCount: number
      bots: ObservabilityBotRow[]
    }
    runtime: {
      phase: string
      draining: boolean
      pid: number
      nodeVersion: string
      platform: string
      uptimeSec: number
      rssBytes: number
      heapUsedBytes: number
      heapTotalBytes: number
      externalBytes: number
      eventLoopMeanMs: number
      eventLoopP95Ms: number
      eventLoopMaxMs: number
      activeTurns: number
      activeTriageCount: number
      activeRemindersCount: number
      activeDreamingCount: number
      persistedPendingTurns: number
      activeActors: number
      queuedTurns: number
      vitalsSeries: ProcessVitalPoint[]
    }
    storage: {
      scannedAtMs: number
      totalBytes: number
      bridgeBytes: number
      dshBytes: number
      dbBytes: number
      walBytes: number
      shmBytes: number
      walBloated: boolean
      walDetail: string
      journalMode: string
      schemaVersion: number
      pageCount: number
      pageSize: number
      integrityOk: boolean
      foreignKeyErrors: number
      categories: StorageCategoryEntry[]
      tables: StorageTableStat[]
    }
    database?: ObservabilityDatabasePerf
    errors: {
      breakdown: ObservabilityErrorBreakdown[]
      recent: AuditEvent[]
    }
    alerts: DiagnosticAlert[]
  }
  series: ObservabilitySeriesPoint[]
}
