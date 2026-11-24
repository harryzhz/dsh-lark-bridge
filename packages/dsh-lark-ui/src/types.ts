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
export type RouterBypassMsgType = 'interactive' | 'text' | 'post'

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

export interface ReminderItem {
  id: string
  title: string
  prompt: string
  reason?: string
  scheduledAt: string
  status: ReminderStatus
  resolution?: ReminderResolution
  origin: ReminderOrigin
  workingDir?: string
  mentions: ReminderMention[]
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
  code: 'split_brain' | 'storage_integrity' | 'bot_disconnected' | 'stale_lock_recovered'
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
