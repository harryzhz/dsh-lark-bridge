import type {
  GroupReplyMode,
  InboundLarkMessage,
  LarkBotStatus,
  LarkGroupConfig,
  LarkMemoryMutationStats,
  ListenerTemplate,
  RouterHandoffTurn,
  TriageAction,
  TriagePromptVariable,
  TriageToolSchema,
} from '@dsh-lark/lark-core'

export const LARK_ORIGIN_RECORD_TYPE = 'plugin:lark-bridge/origin'
export const LARK_SENT_MESSAGE_RECORD_TYPE = 'plugin:lark-bridge/sent-message'

export interface LarkSentMessageRecord {
  readonly messageId: string
}

export interface LarkOriginRecord {
  readonly botId: string
  readonly botName: string
  readonly larkAppId: string
  readonly chatType?: 'group' | 'p2p'
  readonly chatId: string
  readonly chatName?: string
  readonly replyToMessageId?: string
  readonly userOpenId?: string
  readonly userName?: string
  readonly workspaceName: string
  readonly routeKey: string
  readonly trigger: string
  readonly listenerName?: string
  readonly scheduleId?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:lark-bridge/origin': {
      botId: string
      botName: string
      larkAppId: string
      chatType?: 'group' | 'p2p'
      chatId: string
      chatName?: string
      replyToMessageId?: string
      userOpenId?: string
      userName?: string
      workspaceName: string
      routeKey: string
      trigger: string
      listenerName?: string
      scheduleId?: string
    }
    'plugin:lark-bridge/sent-message': {
      messageId: string
    }
  }
}

export interface LarkBridgeConfig {
  readonly dataDir: string
  readonly publicBaseUrl: string
  readonly idleSweepIntervalMs: number
  readonly maxAuditEvents: number
  readonly autoInstallCliAndSkill?: boolean
  readonly syncGlobalCliAndSkill?: boolean
  readonly enableInstanceLock?: boolean
  readonly instanceLockWaitMs?: number
  /** Max concurrent heavy Agent turns per runtime preset (`0` = unlimited, default `3`). */
  readonly maxConcurrentTurnsPerRuntime?: number
  /** Delay between simultaneously due proactive reminders to avoid upstream 429 bursts. */
  readonly reminderDispatchStaggerMs?: number
  /** Optional override for top-level passive listener debounce window (ms). */
  readonly listenerDebounceOverrideMs?: number
  /** Wait threshold (ms) before emitting a queue-wait progress notice for interactive turns (`0` = disabled). */
  readonly queueWaitAnchorMs?: number
  /** Execution threshold (ms) before emitting a long-turn progress notice when no output was sent (`0` = disabled). */
  readonly longTurnAnchorMs?: number
}

export interface LarkSessionBinding {
  readonly routeKey: string
  readonly aliasRouteKeys?: readonly string[]
  readonly botId: string
  readonly botName?: string
  readonly larkAppId: string
  readonly chatType?: 'group' | 'p2p'
  readonly chatId: string
  readonly chatName?: string
  readonly userOpenId?: string
  readonly userName?: string
  readonly workspaceName: string
  readonly sessionId: string
  readonly agentPreset: string
  readonly runtimeProfileId?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly workingDir: string
  readonly trigger: string
  readonly listenerName?: string
  readonly hasReplied?: boolean
  readonly createdAtMs: number
  readonly lastActivityMs: number
  readonly idleCloseMs?: number
}

export interface LarkManagedSession {
  readonly sessionId: string
  readonly botId: string
  readonly chatId: string
  readonly routeKey?: string
  readonly trigger?: string
  readonly createdAtMs: number
  readonly lastActivityMs: number
  readonly idleCloseMs?: number
  readonly archivedAtMs?: number
}

export type PendingTurnStatus = 'running' | 'interrupted' | 'recovering'

export type PendingTurnInterruptKind = 'graceful_shutdown' | 'crash'

export interface LarkPendingTurn {
  readonly id: string
  readonly botId: string
  readonly chatId: string
  readonly chatName?: string
  readonly messageId: string
  readonly routeKey: string
  readonly replyMode: GroupReplyMode
  readonly trigger: string
  readonly allowSilentEmptyReply: boolean
  readonly reactionId?: string
  readonly sessionId?: string
  readonly traceId?: string
  readonly startedAtMs: number
  readonly status?: PendingTurnStatus
  readonly inboundMsg?: InboundLarkMessage
  readonly senderName?: string
  readonly intermediateSentCount?: number
  readonly recoveryAttempts?: number
  readonly gracefulRecoveryAttempts?: number
  readonly handoffTurns?: readonly RouterHandoffTurn[]
  readonly updatedAtMs?: number
  readonly interruptedAtMs?: number
  readonly lastActivityAtMs?: number
  readonly interruptKind?: PendingTurnInterruptKind
}

export type BridgeLifecyclePhase = 'starting' | 'running' | 'draining' | 'stopping' | 'stopped'

export interface ActiveTurnSummary {
  readonly id: string
  readonly botId: string
  readonly chatId: string
  readonly chatName?: string
  readonly messageId: string
  readonly routeKey: string
  readonly sessionId?: string
  readonly trigger: string
  readonly startedAtMs: number
  readonly lastActivityAtMs: number
  readonly idleSec: number
  readonly willAutoResume: boolean
}

export interface BridgeLifecycleStatus {
  readonly phase: BridgeLifecyclePhase
  readonly draining: boolean
  readonly drainRequestedAtMs?: number
  readonly drainReason?: string
  readonly drained: boolean
  readonly activeTurns: readonly ActiveTurnSummary[]
  readonly activeTriageCount: number
  readonly activeRemindersCount: number
  readonly activeDreamingCount: number
  readonly totalInFlight: number
  readonly persistedPendingTurns: number
  readonly pid: number
  readonly startedAtMs: number
}

export interface LarkDreamRunState {
  readonly botId: string
  readonly status: 'idle' | 'running' | 'succeeded' | 'skipped' | 'failed'
  readonly lastDreamAtMs?: number
  readonly lastCheckedDateKey?: string
  readonly lastSessionId?: string
  readonly lastProcessedCount?: number
  readonly lastSummary?: string
  readonly processedSessionIds: readonly string[]
}

export interface LarkDreamSession {
  readonly sessionId: string
  readonly botId: string
  readonly botName?: string
  readonly workspaceName: string
  readonly workingDir: string
  readonly agentPreset: string
  readonly runtimeProfileId?: string
  readonly model?: string
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly outcome?: 'memory_updated' | 'no_change' | 'failed'
  readonly memoryStats?: LarkMemoryMutationStats
  readonly dateKey: string
  readonly processedCount: number
  readonly summary?: string
  readonly createdAtMs: number
  readonly lastActivityMs: number
  readonly durationMs?: number
}

export interface LarkTriageSession {
  readonly sessionId: string
  readonly botId: string
  readonly botName?: string
  readonly chatId: string
  readonly chatName?: string
  readonly workspaceName: string
  readonly workingDir: string
  readonly routeKey: string
  readonly trigger: string
  readonly listenerName?: string
  readonly senderName?: string
  readonly action: TriageAction
  readonly fallback?: boolean
  readonly reason: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly replyText?: string
  readonly provider?: string
  readonly model?: string
  readonly durationMs: number
  readonly handoffSessionId?: string
  readonly createdAtMs: number
  readonly lastActivityMs: number
}

export interface LarkAuditEvent {
  readonly id: string
  readonly timestampMs: number
  readonly botId: string
  readonly botName?: string
  readonly chatId?: string
  readonly chatName?: string
  readonly routeKey?: string
  readonly sessionId?: string
  readonly traceId?: string
  readonly durationMs?: number
  readonly kind:
    | 'inbound'
    | 'triage'
    | 'command'
    | 'reply'
    | 'silent_skip'
    | 'ignored'
    | 'error'
    | 'lifecycle'
  readonly summary: string
}

export interface LarkHourlyBucket {
  readonly hourKey: string
  inbound: number
  replied: number
  listenerTriggered: number
  silentSkipped: number
  ignored: number
  errors: number
  totalLatencyMs: number
  latencySamples: number
}

export interface LarkBotMetrics {
  readonly botId: string
  inboundTotal: number
  repliedTotal: number
  listenerTriggeredTotal: number
  silentSkippedTotal: number
  ignoredTotal: number
  errorTotal: number
  latenciesMs: number[]
}

export interface LarkGroupTraffic {
  readonly key: string
  readonly botId: string
  readonly chatId: string
  chatName: string
  inboundTotal: number
  repliedTotal: number
  lastActiveMs: number
}

export interface LarkGroupView {
  readonly key: string
  readonly botId: string
  readonly botName: string
  readonly larkAppId: string
  readonly chatId: string
  readonly chatName: string
  readonly description: string
  readonly avatar?: string
  readonly configured: boolean
  readonly inChat: boolean
  readonly effectiveWorkspaceName: string
  readonly effectiveWorkingDir: string
  readonly runtimeSource: 'bot' | 'group'
  readonly effectiveAgentPreset: string
  readonly effectiveRuntimeProfileId?: string
  readonly effectiveModel?: string
  readonly effectiveReasoningEffort?: string
  readonly activeSessionCount: number
  readonly inboundTotal: number
  readonly config: LarkGroupConfig
}

export interface LarkScheduleTarget {
  readonly botId: string
  readonly chatId: string
}

export type LarkScheduleDeliveryMode = 'chat' | 'thread'
export type LarkScheduleNotifyOn = 'non_empty' | 'always' | 'error_only'

export interface LarkScheduleBinding {
  readonly scheduleId: string
  readonly enabled: boolean
  readonly targets: readonly LarkScheduleTarget[]
  readonly deliveryMode: LarkScheduleDeliveryMode
  readonly notifyOn: LarkScheduleNotifyOn
  readonly sendIntermediateMessages?: boolean
}

export interface LarkScheduleOriginHint {
  readonly botId: string
  readonly botName: string
  readonly chatId: string
  readonly chatName: string
  readonly replyToMessageId?: string
}

export interface LarkScheduleView {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly kind: string
  readonly ruleSummary: string
  readonly status: 'active' | 'paused' | 'ended'
  readonly scheduledAt: string
  readonly executionActive: boolean
  readonly lastDeliveredAt?: string
  readonly lastTargetSessionId?: string
  readonly inferredOrigin?: LarkScheduleOriginHint
  readonly configured: boolean
  readonly binding: LarkScheduleBinding
}

export interface LarkCockpitSummary {
  readonly serviceHealthy: boolean
  readonly onlineBots: number
  readonly totalBots: number
  readonly configuredGroups: number
  readonly activeListeners: number
  readonly activeBindings: number
  readonly inbound24h: number
  readonly replied24h: number
  readonly silentSkipped24h: number
  readonly errors24h: number
  readonly peakHourlyCount: number
  readonly successRate24h: number
  readonly avgLatencyMs: number
  readonly p95LatencyMs: number
  readonly interactiveLatencySamples24h?: number
  readonly avgQueueWaitMs24h?: number
  readonly avgExecMs24h?: number
  readonly queuedReplies24h?: number
  readonly proactiveAvgLatencyMs24h?: number
  readonly proactiveSamples24h?: number
}

export interface LarkDiagnosticAlert {
  readonly id: string
  readonly code:
    | 'split_brain'
    | 'storage_integrity'
    | 'wal_bloated'
    | 'bot_disconnected'
    | 'stale_lock_recovered'
  readonly severity: 'info' | 'warning' | 'error'
  readonly botId?: string
  readonly title: string
  readonly detail: string
  readonly suggestion: string
  readonly timestampMs: number
}

export interface LarkCockpitPayload {
  readonly summary: LarkCockpitSummary
  readonly alerts?: readonly LarkDiagnosticAlert[]
  readonly hourlySeries: readonly {
    readonly hourKey: string
    readonly label: string
    readonly inbound: number
    readonly replied: number
    readonly silentSkipped: number
    readonly errors: number
    readonly avgLatencyMs: number
  }[]
  readonly botRows: readonly (LarkBotStatus & {
    readonly workspaceName: string
    readonly agentPreset: string
    readonly runtimeProfileId?: string
    readonly model?: string
    readonly inboundTotal: number
    readonly repliedTotal: number
    readonly errorTotal: number
    readonly avgLatencyMs: number
  })[]
  readonly engineDistribution: readonly { readonly engine: string; readonly count: number }[]
  readonly topGroups: readonly {
    readonly key: string
    readonly botId: string
    readonly botName: string
    readonly chatId: string
    readonly chatName: string
    readonly workspaceName: string
    readonly inboundTotal: number
    readonly repliedTotal: number
    readonly activeSessions: number
    readonly lastActiveMs: number
  }[]
  readonly bindings: readonly (LarkSessionBinding & { readonly sessionUrl: string })[]
  readonly recentEvents: readonly LarkAuditEvent[]
  readonly listenerTemplates?: readonly ListenerTemplate[]
  readonly triageDefaults?: {
    readonly defaultSystemPrompt: string
    readonly variables: readonly TriagePromptVariable[]
    readonly toolName: string
    readonly toolSchema: TriageToolSchema
  }
}
