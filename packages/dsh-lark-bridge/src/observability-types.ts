import type { LarkAuditEvent, LarkDiagnosticAlert } from './types.js'

export type ObservabilityWindow = '24h' | '7d' | '30d' | '90d'

export type TelemetryRecordKind = 'llm_step' | 'turn' | 'triage' | 'inbound' | 'proactive'

export interface TelemetryUsageEventInput {
  readonly id: string
  readonly timestampMs: number
  readonly recordKind: TelemetryRecordKind
  readonly botId: string
  readonly chatId?: string
  readonly chatType?: 'group' | 'p2p' | 'internal' | ''
  readonly sessionId?: string
  readonly senderId?: string
  readonly senderName?: string
  readonly senderType?: 'user' | 'bot' | ''
  readonly trigger?: string
  readonly agentPreset?: string
  readonly provider?: string
  readonly model?: string
  readonly outcome?: string
  readonly errorCode?: string
  readonly latencyMs?: number
  readonly queueWaitMs?: number
  readonly execMs?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly totalTokens?: number
  readonly toolCalls?: number
  readonly toolErrors?: number
}

export interface ObservabilitySeriesPoint {
  readonly bucketStartMs: number
  readonly bucketEndMs: number
  readonly label: string
  readonly fullLabel: string
  readonly inbound: number
  readonly replied: number
  readonly silentSkipped: number
  readonly errors: number
  readonly sessions: number
  readonly llmSteps: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly latencyP50Ms: number
  readonly latencyP95Ms: number
  readonly avgLatencyMs: number
}

export interface ObservabilityLatencyBucket {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly pct: number
}

export interface ObservabilityModelBreakdown {
  readonly model: string
  readonly provider: string
  readonly agentPreset: string
  readonly agents: readonly string[]
  readonly steps: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly cacheHitRate: number
  readonly sharePct: number
}

export interface ObservabilityAgentModelSummary {
  readonly model: string
  readonly totalTokens: number
  readonly sharePct: number
}

export interface ObservabilityAgentBreakdown {
  readonly agentKey: string
  readonly agentPreset: string
  readonly kind: 'runtime' | 'triage' | 'unknown'
  readonly sessions: number
  readonly steps: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly cacheHitRate: number
  readonly sharePct: number
  readonly models: readonly ObservabilityAgentModelSummary[]
}

export interface ObservabilityRankModelSummary {
  readonly model: string
  readonly agentPreset: string
  readonly totalTokens: number
}

export interface ObservabilityTriggerBreakdown {
  readonly trigger: string
  readonly count: number
  readonly sessions: number
  readonly replied: number
  readonly errors: number
  readonly totalTokens: number
  readonly sharePct: number
}

export interface ObservabilityErrorBreakdown {
  readonly code: string
  readonly count: number
  readonly sharePct: number
  readonly latestAtMs: number
}

export interface ObservabilityBotRow {
  readonly botId: string
  readonly name: string
  readonly avatarUrl?: string
  readonly agentPreset: string
  readonly runtimeProfileId?: string
  readonly model?: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly sessions: number
  readonly activeBindings: number
  readonly inbound: number
  readonly replied: number
  readonly silentSkipped: number
  readonly errors: number
  readonly successRate: number
  readonly totalTokens: number
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly topModels?: readonly ObservabilityRankModelSummary[]
  readonly cacheHitRate: number
  readonly avgLatencyMs: number
  readonly p95LatencyMs: number
  readonly ackP50Ms: number
  readonly ackP95Ms: number
  readonly ackSamples: number
  readonly sdkErrorCount: number
  readonly lastEventAtMs?: number
  readonly lastError?: string
}

export interface ObservabilityChatRow {
  readonly key: string
  readonly botId: string
  readonly botName: string
  readonly chatId: string
  readonly chatName: string
  readonly chatType: 'group' | 'p2p' | 'internal'
  readonly sessions: number
  readonly activeBindings: number
  readonly inbound: number
  readonly replied: number
  readonly errors: number
  readonly totalTokens: number
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly topModels?: readonly ObservabilityRankModelSummary[]
  readonly cacheHitRate: number
  readonly avgLatencyMs: number
  readonly lastActiveMs: number
}

export interface TelemetrySenderProfileRecord {
  readonly botId: string
  readonly openId: string
  readonly unionId?: string
  readonly name?: string
  readonly avatarUrl?: string
  readonly senderType?: 'user' | 'bot'
  readonly updatedAtMs?: number
}

export interface ObservabilityChatFilterOption {
  readonly chatId: string
  readonly chatName: string
  readonly chatType: 'group' | 'p2p'
  readonly botIds: readonly string[]
}

export interface ObservabilitySenderBotSummary {
  readonly botId: string
  readonly botName: string
  readonly totalTokens: number
}

export interface ObservabilitySenderRow {
  readonly senderId: string
  readonly senderName: string
  readonly senderType: 'user' | 'bot'
  readonly avatarUrl?: string
  readonly sessions: number
  readonly activeChats: number
  readonly inbound: number
  readonly replied: number
  readonly silentSkipped: number
  readonly errors: number
  readonly llmSteps: number
  readonly totalTokens: number
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
  readonly topModels?: readonly ObservabilityRankModelSummary[]
  readonly topBots?: readonly ObservabilitySenderBotSummary[]
  readonly cacheHitRate: number
  readonly avgLatencyMs: number
  readonly lastActiveMs: number
}

export interface ObservabilitySenderFilterOption {
  readonly senderId: string
  readonly senderName: string
  readonly senderType: 'user' | 'bot'
  readonly avatarUrl?: string
  readonly botIds: readonly string[]
}

export interface ObservabilityHeatmapCell {
  readonly dayOfWeek: number
  readonly hour: number
  readonly count: number
  readonly tokens: number
}

export interface ProcessVitalPoint {
  readonly timestampMs: number
  readonly label: string
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly heapTotalBytes: number
  readonly externalBytes: number
  readonly eventLoopP95Ms: number
  readonly eventLoopMeanMs: number
  readonly activeTurns: number
  readonly onlineBots: number
}

export interface StorageCategoryEntry {
  readonly id: string
  readonly label: string
  readonly pathLabel: string
  readonly scope: 'bridge' | 'dsh'
  readonly bytes: number
  readonly fileCount: number
  readonly sharePct: number
}

export interface StorageTableStat {
  readonly table: string
  readonly rows: number
}

export interface ObservabilitySqlQueryPerf {
  readonly fingerprint: string
  readonly count: number
  readonly avgMs: number
  readonly maxMs: number
  readonly lastAtMs: number
}

export interface ObservabilityApiRoutePerf {
  readonly route: string
  readonly count: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly lastAtMs: number
}

export interface ObservabilityDatabasePerf {
  readonly totalQueries: number
  readonly sampleCount: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly slowThresholdMs: number
  readonly slowQueryCount: number
  readonly integrityCheckMs: number
  readonly integrityCheckedAtMs?: number
  readonly lastCheckpointMs?: number
  readonly lastCheckpointAtMs?: number
  readonly slowQueries: readonly ObservabilitySqlQueryPerf[]
  readonly apiRoutes: readonly ObservabilityApiRoutePerf[]
}

export interface ObservabilityPayload {
  readonly generatedAtMs: number
  readonly window: ObservabilityWindow
  readonly fromMs: number
  readonly toMs: number
  readonly bucketSpanMs: number
  readonly filters: {
    readonly botId: string
    readonly chatId: string
    readonly senderId: string
    readonly chats: readonly ObservabilityChatFilterOption[]
    readonly senders: readonly ObservabilitySenderFilterOption[]
  }
  readonly backfill: {
    readonly running: boolean
    readonly completed: boolean
    readonly scannedSessions: number
    readonly totalSessions: number
    readonly lastCompletedAtMs?: number
  }
  readonly product: {
    readonly tokens: {
      readonly total: number
      readonly input: number
      readonly output: number
      readonly cacheRead: number
      readonly cacheWrite: number
      readonly reasoning: number
      readonly cacheHitRate: number
      readonly avgPerReply: number
      readonly deltaPct: number | null
    }
    readonly sessions: {
      readonly activeInWindow: number
      readonly createdInWindow: number
      readonly archivedInWindow: number
      readonly liveBindings: number
      readonly deltaPct: number | null
    }
    readonly traffic: {
      readonly inbound: number
      readonly replied: number
      readonly silentSkipped: number
      readonly ignored: number
      readonly errors: number
      readonly llmSteps: number
      readonly toolCalls: number
      readonly toolErrors: number
      readonly toolErrorRate: number
      readonly deltaPct: number | null
    }
    readonly triage: {
      readonly total: number
      readonly silent: number
      readonly quickReply: number
      readonly handoff: number
      readonly fallback: number
      readonly deflectRate: number
      readonly avgLatencyMs: number
      readonly p95LatencyMs: number
      readonly totalTokens: number
    }
    readonly proactive: {
      readonly scheduleRuns: number
      readonly reminderRuns: number
      readonly dreamRuns: number
      readonly activeReminders: number
      readonly pendingConfirmReminders: number
      readonly configuredSchedules: number
      readonly activeMemories: number
      readonly pinnedMemories: number
      readonly totalMemoryRecalls: number
    }
    readonly models: readonly ObservabilityModelBreakdown[]
    readonly agents: readonly ObservabilityAgentBreakdown[]
    readonly triggers: readonly ObservabilityTriggerBreakdown[]
    readonly heatmap: {
      readonly maxCount: number
      readonly cells: readonly ObservabilityHeatmapCell[]
    }
    readonly botRanking: readonly ObservabilityBotRow[]
    readonly chatRanking: readonly ObservabilityChatRow[]
    readonly senderRanking: readonly ObservabilitySenderRow[]
  }
  readonly technical: {
    readonly sla: {
      readonly successRate: number
      readonly deltaPct: number | null
      readonly errorRate: number
      readonly triageFallbackRate: number
      readonly toolErrorRate: number
      readonly totalErrors: number
      readonly abortedTurns: number
      readonly interruptedRecoveries: number
    }
    readonly latency: {
      readonly samples: number
      readonly avgMs: number
      readonly p50Ms: number
      readonly p75Ms: number
      readonly p95Ms: number
      readonly p99Ms: number
      readonly maxMs: number
      readonly deltaP95Pct: number | null
      readonly histogram: readonly ObservabilityLatencyBucket[]
      readonly breakdown?: {
        readonly queueWait: {
          readonly samples: number
          readonly queuedCount: number
          readonly avgMs: number
          readonly p95Ms: number
          readonly maxMs: number
        }
        readonly exec: {
          readonly samples: number
          readonly avgMs: number
          readonly p95Ms: number
          readonly maxMs: number
        }
        readonly proactive: {
          readonly samples: number
          readonly avgMs: number
          readonly p95Ms: number
          readonly maxMs: number
        }
      }
    }
    readonly connections: {
      readonly onlineBots: number
      readonly enabledBots: number
      readonly totalBots: number
      readonly avgAckP50Ms: number
      readonly maxAckP95Ms: number
      readonly totalSdkErrors: number
      readonly splitBrainCount: number
      readonly bots: readonly ObservabilityBotRow[]
    }
    readonly runtime: {
      readonly phase: string
      readonly draining: boolean
      readonly pid: number
      readonly nodeVersion: string
      readonly platform: string
      readonly uptimeSec: number
      readonly rssBytes: number
      readonly heapUsedBytes: number
      readonly heapTotalBytes: number
      readonly externalBytes: number
      readonly eventLoopMeanMs: number
      readonly eventLoopP95Ms: number
      readonly eventLoopMaxMs: number
      readonly activeTurns: number
      readonly activeTriageCount: number
      readonly activeRemindersCount: number
      readonly activeDreamingCount: number
      readonly persistedPendingTurns: number
      readonly activeActors: number
      readonly queuedTurns: number
      readonly vitalsSeries: readonly ProcessVitalPoint[]
    }
    readonly storage: {
      readonly scannedAtMs: number
      readonly totalBytes: number
      readonly bridgeBytes: number
      readonly dshBytes: number
      readonly dbBytes: number
      readonly walBytes: number
      readonly shmBytes: number
      readonly walBloated: boolean
      readonly walDetail: string
      readonly journalMode: string
      readonly schemaVersion: number
      readonly pageCount: number
      readonly pageSize: number
      readonly integrityOk: boolean
      readonly foreignKeyErrors: number
      readonly categories: readonly StorageCategoryEntry[]
      readonly tables: readonly StorageTableStat[]
    }
    readonly database: ObservabilityDatabasePerf
    readonly errors: {
      readonly breakdown: readonly ObservabilityErrorBreakdown[]
      readonly recent: readonly LarkAuditEvent[]
    }
    readonly alerts: readonly LarkDiagnosticAlert[]
  }
  readonly series: readonly ObservabilitySeriesPoint[]
}
