import { homedir } from 'node:os'
import { basename, join, parse, resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_TRIAGE_SYSTEM_PROMPT, RECOMMENDED_TIER_ROUTING_TARGETS } from './triage.js'

export function expandWorkingDir(rawDir: string): string {
  const trimmed = rawDir.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

export function leafDirectoryName(rawDir: string): string {
  const expanded = expandWorkingDir(rawDir)
  if (!expanded) return ''
  return basename(expanded) || parse(expanded).root
}

export function normalizeHHMM(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (trimmed === 'immediate') return 'immediate'
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(trimmed)
  if (!match) return fallback
  const hour = Number(match[1])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fallback
  return `${String(hour).padStart(2, '0')}:${match[2]}`
}

export const RoleDefinitionSchema = z.object({
  enabled: z.boolean().default(false),
  name: z.string().default(''),
  systemPrompt: z.string().default(''),
  presetKey: z.string().optional(),
})

export const SubstituteTargetSchema = z.object({
  openId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
  note: z.string().optional(),
})

export const SubstituteModeSchema = z.object({
  enabled: z.boolean().default(false),
  targets: z.array(SubstituteTargetSchema).default([]),
  disclosure: z.enum(['none', 'subtle', 'explicit']).default('none'),
  activeThreadFollowup: z.boolean().default(true),
})

export const DEFAULT_DREAMING_SCOPES: readonly string[] = [
  '个人偏好',
  '协作约定',
  '项目领域知识',
  '踩坑与排障经验',
  '潜在问题与技术债',
  '未完成待办',
]

export const DEFAULT_DREAMING_SCHEDULE_TIME = '03:00'
export const DEFAULT_DREAMING_MAX_SESSIONS_PER_RUN = 0
export const DEFAULT_DREAMING_MAX_CHARS_PER_SESSION = 5000
export const DEFAULT_DREAMING_MAX_REMINDERS_PER_RUN = 5
export const DEFAULT_DREAMING_MAX_DURATION_MINUTES = 45

function migrateLegacyDreamingInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const rec = { ...(input as Record<string, unknown>) }
  if (!Array.isArray(rec.scopes)) {
    const hasLegacyFlags =
      'extractPreferences' in rec ||
      'extractDomainKnowledge' in rec ||
      'extractOpenLoops' in rec
    if (hasLegacyFlags) {
      const migrated: string[] = []
      if (rec.extractPreferences !== false) migrated.push('个人偏好', '协作约定')
      if (rec.extractDomainKnowledge !== false) migrated.push('项目领域知识', '踩坑与排障经验')
      if (rec.extractOpenLoops !== false) migrated.push('潜在问题与技术债', '未完成待办')
      rec.scopes = migrated
    }
  }
  return rec
}

export const BotDreamingConfigSchema = z.preprocess(
  migrateLegacyDreamingInput,
  z.object({
    enabled: z.boolean().default(false),
    scheduleTime: z
      .string()
      .default(DEFAULT_DREAMING_SCHEDULE_TIME)
      .transform((v) => normalizeHHMM(v, DEFAULT_DREAMING_SCHEDULE_TIME)),
    minNewSessions: z.number().int().min(1).max(50).default(2),
    /** Max sessions to consolidate per Dreaming run (`0` = all unprocessed sessions since last run). */
    maxSessionsPerRun: z
      .number()
      .int()
      .min(0)
      .max(500)
      .default(DEFAULT_DREAMING_MAX_SESSIONS_PER_RUN),
    /** Per-session character budget for head+tail transcript sampling. */
    maxCharsPerSession: z
      .number()
      .int()
      .min(1000)
      .max(20_000)
      .default(DEFAULT_DREAMING_MAX_CHARS_PER_SESSION),
    /** Hard cap on proactive reminders created during a single Dreaming run (`0` = disabled). */
    maxRemindersPerRun: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(DEFAULT_DREAMING_MAX_REMINDERS_PER_RUN),
    /** Soft wall-clock budget (minutes) for multi-batch overnight Dreaming execution. */
    maxDurationMinutes: z
      .number()
      .int()
      .min(5)
      .max(180)
      .default(DEFAULT_DREAMING_MAX_DURATION_MINUTES),
    /** Enable Stage 2 deep memory audit (codebase verification, cold-memory pruning & SOP synthesis). */
    deepConsolidation: z.boolean().default(true),
    /** Optional dedicated model for overnight Dreaming (empty string = inherit bot model). */
    model: z
      .string()
      .default('')
      .transform((v) => v.trim()),
    /** Optional dedicated reasoning effort for overnight Dreaming (empty string = inherit bot effort). */
    reasoningEffort: z
      .string()
      .default('')
      .transform((v) => v.trim()),
    scopes: z
      .array(z.string().trim().min(1))
      .default([...DEFAULT_DREAMING_SCOPES]),
    cleanupAndCorrect: z.boolean().default(true),
  }),
)

export const DEFAULT_BOT_DREAMING_CONFIG: z.output<typeof BotDreamingConfigSchema> = {
  enabled: false,
  scheduleTime: DEFAULT_DREAMING_SCHEDULE_TIME,
  minNewSessions: 2,
  maxSessionsPerRun: DEFAULT_DREAMING_MAX_SESSIONS_PER_RUN,
  maxCharsPerSession: DEFAULT_DREAMING_MAX_CHARS_PER_SESSION,
  maxRemindersPerRun: DEFAULT_DREAMING_MAX_REMINDERS_PER_RUN,
  maxDurationMinutes: DEFAULT_DREAMING_MAX_DURATION_MINUTES,
  deepConsolidation: true,
  model: '',
  reasoningEffort: '',
  scopes: [...DEFAULT_DREAMING_SCOPES],
  cleanupAndCorrect: true,
}

export const ReminderCreationModeSchema = z.enum(['silent', 'notify', 'confirm'])

export const BotProactiveConfigSchema = z.object({
  remindersEnabled: z.boolean().default(false),
  reminderCreationMode: ReminderCreationModeSchema.default('silent'),
  delegationFollowupEnabled: z.boolean().default(false),
  quietHoursEnabled: z.boolean().default(true),
  quietHoursStart: z
    .string()
    .default('00:00')
    .transform((v) => normalizeHHMM(v, '00:00')),
  quietHoursEnd: z
    .string()
    .default('08:00')
    .transform((v) => normalizeHHMM(v, '08:00')),
  autoCodeEnabled: z.boolean().default(false),
  branchPrefix: z
    .string()
    .default('agent/')
    .transform((v) => v.trim() || 'agent/'),
})

export const DEFAULT_BOT_PROACTIVE_CONFIG: z.output<typeof BotProactiveConfigSchema> = {
  remindersEnabled: false,
  reminderCreationMode: 'silent',
  delegationFollowupEnabled: false,
  quietHoursEnabled: true,
  quietHoursStart: '00:00',
  quietHoursEnd: '08:00',
  autoCodeEnabled: false,
  branchPrefix: 'agent/',
}

export const ListenerSenderTypeSchema = z.enum(['user', 'bot'])
export const RouterScopeModeSchema = z.enum(['passive_only', 'active_thread_only', 'all_group'])
export const GroupRouterModeSchema = z.enum(['inherit', 'override', 'off'])
export const RouterBypassMsgTypeSchema = z.enum(['interactive', 'text', 'post', 'image'])
export const TaskDifficultyTierSchema = z.enum(['lite', 'standard', 'heavy'])
export const TierRoutingBypassTierSchema = z.enum(['default', 'lite', 'standard', 'heavy'])

export const TierRoutingTargetSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1),
  agentPreset: z
    .string()
    .trim()
    .min(1),
  runtimeProfileId: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  model: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  reasoningEffort: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  weight: z.number().int().min(0).max(1000).default(50),
  enabled: z.boolean().default(true),
})

export const TierRoutingTierConfigSchema = z.object({
  prompt: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  targets: z.array(TierRoutingTargetSchema).default([]),
})

export const DEFAULT_TIER_ROUTING_TIERS: {
  readonly lite: z.output<typeof TierRoutingTierConfigSchema>
  readonly standard: z.output<typeof TierRoutingTierConfigSchema>
  readonly heavy: z.output<typeof TierRoutingTierConfigSchema>
} = {
  lite: { prompt: '', targets: [] },
  standard: { prompt: '', targets: [] },
  heavy: { prompt: '', targets: [] },
}

export const TierRoutingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  presetKey: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  bypassTier: TierRoutingBypassTierSchema.default('default'),
  tiers: z
    .object({
      lite: TierRoutingTierConfigSchema.default({ prompt: '', targets: [] }),
      standard: TierRoutingTierConfigSchema.default({ prompt: '', targets: [] }),
      heavy: TierRoutingTierConfigSchema.default({ prompt: '', targets: [] }),
    })
    .default(DEFAULT_TIER_ROUTING_TIERS),
})

export const DEFAULT_TIER_ROUTING_CONFIG: z.output<typeof TierRoutingConfigSchema> = {
  enabled: false,
  presetKey: '',
  bypassTier: 'default',
  tiers: {
    lite: { prompt: '', targets: [] },
    standard: { prompt: '', targets: [] },
    heavy: { prompt: '', targets: [] },
  },
}

export const RouterBypassConfigSchema = z.object({
  senderTypes: z.array(ListenerSenderTypeSchema).default(['bot']),
  msgTypes: z.array(RouterBypassMsgTypeSchema).default([]),
  keywords: z
    .array(z.string())
    .default([])
    .transform((items) => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const raw of items) {
        const trimmed = raw.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
      }
      return out
    }),
})

export const DEFAULT_ROUTER_BYPASS_CONFIG: z.output<typeof RouterBypassConfigSchema> = {
  senderTypes: ['bot'],
  msgTypes: [],
  keywords: [],
}

function migrateLegacyRouterConfig(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const rec = { ...(input as Record<string, unknown>) }
  const legacyCustom = typeof rec.customPrompt === 'string' ? rec.customPrompt.trim() : ''
  const currentSystem = typeof rec.systemPrompt === 'string' ? rec.systemPrompt.trim() : ''
  if (!currentSystem && legacyCustom) {
    rec.systemPrompt = `${DEFAULT_TRIAGE_SYSTEM_PROMPT}\n\n## 额外分流约定\n${legacyCustom}`
  }
  delete rec.customPrompt
  return rec
}

export const BotRouterConfigSchema = z.preprocess(
  migrateLegacyRouterConfig,
  z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default(''),
    model: z.string().default(''),
    scope: RouterScopeModeSchema.default('passive_only'),
    bypass: RouterBypassConfigSchema.default(DEFAULT_ROUTER_BYPASS_CONFIG),
    timeoutMs: z.number().int().min(1000).max(15000).default(4000),
    maxTriageImages: z.number().int().min(0).max(20).default(5),
    systemPrompt: z.string().default(''),
    recentMessageCount: z.number().int().min(0).max(50).default(6),
    contextTtlMinutes: z.number().int().min(1).max(1440).default(30),
    includeLastReply: z.boolean().default(true),
    coalesceQueuedMessages: z.boolean().default(true),
    tierRouting: TierRoutingConfigSchema.default(DEFAULT_TIER_ROUTING_CONFIG),
  }),
)

export const DEFAULT_BOT_ROUTER_CONFIG: z.output<typeof BotRouterConfigSchema> = {
  enabled: false,
  provider: '',
  model: '',
  scope: 'passive_only',
  bypass: {
    senderTypes: [...DEFAULT_ROUTER_BYPASS_CONFIG.senderTypes],
    msgTypes: [],
    keywords: [],
  },
  timeoutMs: 4000,
  maxTriageImages: 5,
  systemPrompt: '',
  recentMessageCount: 6,
  contextTtlMinutes: 30,
  includeLastReply: true,
  coalesceQueuedMessages: true,
  tierRouting: {
    enabled: false,
    presetKey: '',
    bypassTier: 'default',
    tiers: {
      lite: { prompt: '', targets: [] },
      standard: { prompt: '', targets: [] },
      heavy: { prompt: '', targets: [] },
    },
  },
}

export const GroupRouterConfigSchema = z.preprocess(
  migrateLegacyRouterConfig,
  z.object({
    mode: GroupRouterModeSchema.default('inherit'),
    provider: z.string().default(''),
    model: z.string().default(''),
    scope: RouterScopeModeSchema.default('passive_only'),
    bypass: RouterBypassConfigSchema.default(DEFAULT_ROUTER_BYPASS_CONFIG),
    timeoutMs: z.number().int().min(1000).max(15000).default(4000),
    maxTriageImages: z.number().int().min(0).max(20).default(5),
    systemPrompt: z.string().default(''),
    recentMessageCount: z.number().int().min(0).max(50).default(6),
    contextTtlMinutes: z.number().int().min(1).max(1440).default(30),
    includeLastReply: z.boolean().default(true),
    coalesceQueuedMessages: z.boolean().default(true),
    tierRouting: TierRoutingConfigSchema.default(DEFAULT_TIER_ROUTING_CONFIG),
  }),
)

export const DEFAULT_GROUP_ROUTER_CONFIG: z.output<typeof GroupRouterConfigSchema> = {
  mode: 'inherit',
  provider: '',
  model: '',
  scope: 'passive_only',
  bypass: {
    senderTypes: [...DEFAULT_ROUTER_BYPASS_CONFIG.senderTypes],
    msgTypes: [],
    keywords: [],
  },
  timeoutMs: 4000,
  maxTriageImages: 5,
  systemPrompt: '',
  recentMessageCount: 6,
  contextTtlMinutes: 30,
  includeLastReply: true,
  coalesceQueuedMessages: true,
  tierRouting: {
    enabled: false,
    presetKey: '',
    bypassTier: 'default',
    tiers: {
      lite: { prompt: '', targets: [] },
      standard: { prompt: '', targets: [] },
      heavy: { prompt: '', targets: [] },
    },
  },
}

function migrateLegacyExperimentalInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const rec = { ...(input as Record<string, unknown>) }
  if (!rec.proactive && rec.dreaming && typeof rec.dreaming === 'object') {
    const dreamRec = rec.dreaming as Record<string, unknown>
    if (dreamRec.proactiveMode === 'auto_draft' && dreamRec.enabled === true) {
      rec.proactive = {
        remindersEnabled: true,
        reminderCreationMode: 'silent',
        autoCodeEnabled: true,
        branchPrefix: 'agent/',
      }
    } else if (dreamRec.proactiveMode === 'remind_only' && dreamRec.enabled === true) {
      rec.proactive = {
        remindersEnabled: true,
        reminderCreationMode: 'silent',
        autoCodeEnabled: false,
        branchPrefix: 'agent/',
      }
    }
  }
  return rec
}

export const BotExperimentalConfigSchema = z.preprocess(
  migrateLegacyExperimentalInput,
  z.object({
    dreaming: BotDreamingConfigSchema.default(DEFAULT_BOT_DREAMING_CONFIG),
    proactive: BotProactiveConfigSchema.default(DEFAULT_BOT_PROACTIVE_CONFIG),
  }),
)

export const GroupReplyModeSchema = z.enum(['new-topic', 'reply', 'chat'])
export const GroupSessionModeSchema = z.enum(['thread', 'per_message', 'chat'])
export const MentionTriggerModeSchema = z.enum(['mention_and_active_thread', 'mention_only'])
export const ListenerMsgTypeSchema = z.enum(['text', 'post', 'interactive', 'image', 'merge_forward'])
export const ListenerMentionFilterSchema = z.enum(['all', 'exclude_peer', 'exclude_all'])

function migrateLegacyWorkspaceField(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const rec = { ...(input as Record<string, unknown>) }
  if (rec.workspaceName === undefined && typeof rec.workspaceGroupName === 'string') {
    rec.workspaceName = rec.workspaceGroupName
  }
  if (rec.signature === undefined && typeof rec.brandLabel === 'string') {
    rec.signature = rec.brandLabel
  }
  if (Array.isArray(rec.allowedUserProfiles) && !Array.isArray(rec.allowedUsers)) {
    rec.allowedUsers = rec.allowedUserProfiles
      .map((u) => (u && typeof u === 'object' ? (u as { openId?: unknown }).openId : undefined))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  }
  if (Array.isArray(rec.adminUserProfiles) && !Array.isArray(rec.adminUsers)) {
    rec.adminUsers = rec.adminUserProfiles
      .map((u) => (u && typeof u === 'object' ? (u as { openId?: unknown }).openId : undefined))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  }
  if (
    rec.router === undefined &&
    rec.experimental &&
    typeof rec.experimental === 'object' &&
    !Array.isArray(rec.experimental) &&
    'router' in (rec.experimental as Record<string, unknown>)
  ) {
    const exp = { ...(rec.experimental as Record<string, unknown>) }
    rec.router = exp.router
    delete exp.router
    rec.experimental = exp
  }
  delete rec.workspaceGroupName
  delete rec.brandLabel
  delete rec.replyFooterBrand
  return rec
}

export const DEFAULT_BOT_GROUP_ACCESS_MODE = 'configured_only' as const
export const DEFAULT_BOT_GROUP_REPLY_MODE = 'reply' as const
export const DEFAULT_BOT_SIGNATURE = 'AI 可能出错，请谨慎判断结果~'

/** Preferred default runtime selection when creating a new bot (falls back if unavailable). */
export const DEFAULT_NEW_BOT_PREFERRED_RUNTIME = {
  agentPreset: 'agy',
  model: 'gemini-4-neon',
  reasoningEffort: 'xhigh',
} as const

export interface DefaultNewBotTierRoutingOptions {
  /** Available non-broken runtime IDs in the current host (when non-empty, filters targets to installed runtimes). */
  readonly availableRuntimeIds?: readonly string[]
  /** Main runtime preset chosen for the new bot. */
  readonly defaultAgentPreset?: string
  /** Optional launch profile chosen on the main runtime; synced onto matching tier targets. */
  readonly defaultProfileId?: string
}

/**
 * Build the recommended 3-tier difficulty routing preset (Agy 70% + Codex 30%
 * across lite / standard / heavy) for newly created bots.
 */
export function buildDefaultNewBotTierRouting(
  options: DefaultNewBotTierRoutingOptions = {},
): z.output<typeof TierRoutingConfigSchema> {
  const available =
    options.availableRuntimeIds && options.availableRuntimeIds.length > 0
      ? new Set(options.availableRuntimeIds.map((id) => id.trim()).filter(Boolean))
      : undefined
  const hasAgy = !available || available.has('agy')
  const hasCodex = !available || available.has('codex')
  if (available && !hasAgy && !hasCodex) {
    return {
      enabled: false,
      presetKey: '',
      bypassTier: 'default',
      tiers: {
        lite: { prompt: '', targets: [] },
        standard: { prompt: '', targets: [] },
        heavy: { prompt: '', targets: [] },
      },
    }
  }

  const agyProfile =
    options.defaultAgentPreset === 'agy' && options.defaultProfileId?.trim()
      ? options.defaultProfileId.trim()
      : ''
  const codexProfile =
    options.defaultAgentPreset === 'codex' && options.defaultProfileId?.trim()
      ? options.defaultProfileId.trim()
      : ''

  const buildTierTargets = (
    tier: 'lite' | 'standard' | 'heavy',
  ): z.output<typeof TierRoutingTargetSchema>[] =>
    RECOMMENDED_TIER_ROUTING_TARGETS[tier]
      .filter((t) => !available || available.has(t.agentPreset))
      .map((t) => ({
        ...t,
        runtimeProfileId:
          t.agentPreset === 'agy'
            ? agyProfile
            : t.agentPreset === 'codex'
              ? codexProfile
              : t.runtimeProfileId,
      }))

  return {
    enabled: true,
    presetKey: 'recommended',
    bypassTier: 'default',
    tiers: {
      lite: { prompt: '', targets: buildTierTargets('lite') },
      standard: { prompt: '', targets: buildTierTargets('standard') },
      heavy: { prompt: '', targets: buildTierTargets('heavy') },
    },
  }
}

/**
 * Default behavioral configuration applied to newly created bots across all creation
 * flows (auto-create, open-platform import, manual UI form, and POST /bots).
 * Existing bots keep their stored values and conservative schema defaults on load.
 */
export function buildDefaultNewBotSettings(
  options: DefaultNewBotTierRoutingOptions = {},
): {
  readonly groupAccessMode: typeof DEFAULT_BOT_GROUP_ACCESS_MODE
  readonly mentionTriggerMode: 'mention_and_active_thread'
  readonly groupSessionMode: 'thread'
  readonly idleCloseMinutes: number
  readonly groupReplyMode: typeof DEFAULT_BOT_GROUP_REPLY_MODE
  readonly p2pEnabled: boolean
  readonly p2pSessionMode: 'chat'
  readonly receivedReactionEmoji: string
  readonly cotEnabled: boolean
  readonly cotToolResultEnabled: boolean
  readonly sendIntermediateMessages: boolean
  readonly useInteractiveCard: boolean
  readonly dshSessionLinkInCard: boolean
  readonly sessionLinkGuestReadOnly: boolean
  readonly replyFooterEnabled: boolean
  readonly replyFooterModel: boolean
  readonly replyFooterSignature: boolean
  readonly signature: string
  readonly router: z.output<typeof BotRouterConfigSchema>
  readonly experimental: z.output<typeof BotExperimentalConfigSchema>
} {
  return {
    groupAccessMode: DEFAULT_BOT_GROUP_ACCESS_MODE,
    mentionTriggerMode: 'mention_and_active_thread',
    groupSessionMode: 'thread',
    idleCloseMinutes: 720,
    groupReplyMode: DEFAULT_BOT_GROUP_REPLY_MODE,
    p2pEnabled: true,
    p2pSessionMode: 'chat',
    receivedReactionEmoji: 'OnIt',
    cotEnabled: true,
    cotToolResultEnabled: true,
    sendIntermediateMessages: false,
    useInteractiveCard: true,
    dshSessionLinkInCard: true,
    sessionLinkGuestReadOnly: true,
    replyFooterEnabled: true,
    replyFooterModel: true,
    replyFooterSignature: true,
    signature: DEFAULT_BOT_SIGNATURE,
    router: {
      ...DEFAULT_BOT_ROUTER_CONFIG,
      enabled: true,
      provider: '',
      model: '',
      scope: 'all_group',
      bypass: {
        senderTypes: [...DEFAULT_ROUTER_BYPASS_CONFIG.senderTypes],
        msgTypes: [],
        keywords: [],
      },
      timeoutMs: 15_000,
      tierRouting: buildDefaultNewBotTierRouting(options),
    },
    experimental: {
      dreaming: {
        ...DEFAULT_BOT_DREAMING_CONFIG,
        enabled: true,
        reasoningEffort: 'high',
        scopes: [...DEFAULT_DREAMING_SCOPES],
      },
      proactive: {
        ...DEFAULT_BOT_PROACTIVE_CONFIG,
        remindersEnabled: true,
        delegationFollowupEnabled: true,
        autoCodeEnabled: true,
      },
    },
  }
}

/** Default conversation & message overrides applied when configuring a new group. */
export const DEFAULT_NEW_GROUP_CONVERSATION_CONFIG = {
  replyMode: 'new-topic',
  idleCloseMinutes: 360,
  replyFormat: 'text',
} as const

export const LarkBotConfigSchema = z.preprocess(
  migrateLegacyWorkspaceField,
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    larkAppId: z.string().min(1),
    larkAppSecret: z.string().min(1),
    avatarUrl: z.string().default(''),
    description: z.string().default(''),

    // Engine & workspace defaults
    agentPreset: z.string().min(1).default('codex'),
    runtimeProfileId: z.string().default(''),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
    defaultWorkingDir: z.string().min(1),
    workspaceName: z.string().default(''),

    // Reply & session lifecycle policies
    groupReplyMode: GroupReplyModeSchema.default(DEFAULT_BOT_GROUP_REPLY_MODE),
    groupSessionMode: GroupSessionModeSchema.default('thread'),
    mentionTriggerMode: MentionTriggerModeSchema.default('mention_and_active_thread'),
    groupAccessMode: z.enum(['configured_only', 'all_joined']).default(DEFAULT_BOT_GROUP_ACCESS_MODE),

    // Direct message (P2P) & admin policies
    p2pEnabled: z.boolean().default(true),
    p2pSessionMode: z.enum(['chat', 'per_message']).default('chat'),
    allowedUsers: z.array(z.string()).default([]),
    allowedUserProfiles: z.array(SubstituteTargetSchema).default([]),
    adminUsers: z.array(z.string()).default([]),
    adminUserProfiles: z.array(SubstituteTargetSchema).default([]),

    // Card, signature & feedback
    cotEnabled: z.boolean().default(false),
    cotToolResultEnabled: z.boolean().default(true),
    sendIntermediateMessages: z.boolean().default(false),
    useInteractiveCard: z.boolean().default(true),
    dshSessionLinkInCard: z.boolean().default(true),
    sessionLinkGuestReadOnly: z.boolean().default(true),
    replyFooterEnabled: z.boolean().default(true),
    replyFooterModel: z.boolean().default(true),
    replyFooterSignature: z.boolean().default(true),
    signature: z.string().default(DEFAULT_BOT_SIGNATURE),
    receivedReactionEmoji: z.string().default('OnIt'),
    idleCloseMinutes: z.number().min(0).default(720),

    // Persona, substitute collaboration, Router triage & experimental capabilities
    role: RoleDefinitionSchema.default({ enabled: false, name: '', systemPrompt: '' }),
    substituteMode: SubstituteModeSchema.default({
      enabled: false,
      targets: [],
      disclosure: 'none',
      activeThreadFollowup: true,
    }),
    router: BotRouterConfigSchema.default(DEFAULT_BOT_ROUTER_CONFIG),
    experimental: BotExperimentalConfigSchema.default({
      dreaming: DEFAULT_BOT_DREAMING_CONFIG,
      proactive: DEFAULT_BOT_PROACTIVE_CONFIG,
    }),
  }),
)

export const GroupRoleConfigSchema = z.object({
  mode: z.enum(['inherit', 'append', 'override']).default('inherit'),
  name: z.string().default(''),
  systemPrompt: z.string().default(''),
  presetKey: z.string().optional(),
})

export const GroupListenerRuleSchema = z.object({
  enabled: z.boolean().default(false),
  templateKey: z.string().default(''),
  name: z.string().default(''),
  prompt: z.string().default(''),
  replyMode: GroupReplyModeSchema.default('new-topic'),
  sessionMode: z.enum(['per_message', 'thread', 'chat']).default('per_message'),
  allowSilentEmptyReply: z.boolean().default(true),
  autoCloseAfterCompletion: z.boolean().default(false),
  scope: z.enum(['top_level', 'all']).default('top_level'),
  mentionFilter: ListenerMentionFilterSchema.default('all'),
  msgTypes: z.array(ListenerMsgTypeSchema).default(['text', 'post', 'interactive']),
  senderTypes: z.array(ListenerSenderTypeSchema).default(['user']),
  senderFilterMode: z.enum(['all_except_excluded', 'include_only']).default('all_except_excluded'),
  senderOpenIds: z.array(z.string()).default([]),
  memberOverrides: z.record(z.string(), z.boolean()).default({}),
  includeKeywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  debounceSeconds: z.number().int().min(0).max(30).default(5),
})

function migrateLegacyGroupFields(input: unknown): unknown {
  const base = migrateLegacyWorkspaceField(input)
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base
  const rec = { ...(base as Record<string, unknown>) }
  if (rec.runtimeMode === undefined) {
    const hasOverride =
      (typeof rec.agentPreset === 'string' && rec.agentPreset.trim().length > 0) ||
      (typeof rec.runtimeProfileId === 'string' && rec.runtimeProfileId.trim().length > 0) ||
      (typeof rec.model === 'string' && rec.model.trim().length > 0) ||
      (typeof rec.reasoningEffort === 'string' && rec.reasoningEffort.trim().length > 0)
    rec.runtimeMode = hasOverride ? 'override' : 'inherit'
  }
  if (rec.idleCloseMinutes === null) {
    delete rec.idleCloseMinutes
  }
  if (typeof rec.receivedReactionEmoji === 'string' && rec.receivedReactionEmoji.trim() === '') {
    rec.receivedReactionEmoji = 'inherit'
  }
  if (rec.router === undefined && typeof rec.routerMode === 'string') {
    const legacyMode = rec.routerMode.trim()
    if (legacyMode === 'off') {
      rec.router = { mode: 'off' }
    } else if (legacyMode === 'passive_only' || legacyMode === 'all_group') {
      rec.router = { mode: 'override', scope: legacyMode }
    }
  }
  delete rec.routerMode
  return rec
}

export const LarkGroupConfigSchema = z.preprocess(
  migrateLegacyGroupFields,
  z.object({
    key: z.string().min(1),
    botId: z.string().min(1),
    chatId: z.string().min(1),
    chatName: z.string().default(''),
    description: z.string().default(''),
    enabled: z.boolean().default(true),

    // Workspace & engine overrides
    workingDir: z.string().default(''),
    workspaceName: z.string().default(''),
    runtimeMode: z.enum(['inherit', 'override']).default('inherit'),
    agentPreset: z.string().default(''),
    runtimeProfileId: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),

    // Reply & session overrides
    replyMode: z.enum(['inherit', 'new-topic', 'reply', 'chat']).default('inherit'),
    sessionMode: z.enum(['inherit', 'thread', 'per_message', 'chat']).default('inherit'),
    mentionTriggerMode: z
      .enum(['inherit', 'mention_and_active_thread', 'mention_only'])
      .default('inherit'),
    idleCloseMinutes: z.number().min(0).optional(),

    // Message & card overrides
    receivedReactionEmoji: z.string().default('inherit'),
    cotEnabled: z.enum(['inherit', 'on', 'off']).default('inherit'),
    cotToolResultEnabled: z.enum(['inherit', 'on', 'off']).default('inherit'),
    intermediateMessages: z.enum(['inherit', 'on', 'off']).default('inherit'),
    replyFormat: z.enum(['inherit', 'card', 'text']).default('inherit'),
    dshSessionLinkInCard: z.enum(['inherit', 'on', 'off']).default('inherit'),
    sessionLinkGuestReadOnly: z.enum(['inherit', 'on', 'off']).default('inherit'),
    replyFooterModel: z.enum(['inherit', 'on', 'off']).default('inherit'),
    signatureMode: z.enum(['inherit', 'custom', 'off']).default('inherit'),
    signature: z.string().default(''),

    // Group-level router triage, role & passive listener
    router: GroupRouterConfigSchema.default(DEFAULT_GROUP_ROUTER_CONFIG),
    role: GroupRoleConfigSchema.default({ mode: 'inherit', name: '', systemPrompt: '' }),
    listener: GroupListenerRuleSchema.default({
      enabled: false,
      templateKey: '',
      name: '',
      prompt: '',
      replyMode: 'new-topic',
      sessionMode: 'per_message',
      allowSilentEmptyReply: true,
      autoCloseAfterCompletion: false,
      scope: 'top_level',
      mentionFilter: 'all',
      msgTypes: ['text', 'post', 'interactive'],
      senderTypes: ['user'],
      senderFilterMode: 'all_except_excluded',
      senderOpenIds: [],
      memberOverrides: {},
      includeKeywords: [],
      excludeKeywords: [],
      debounceSeconds: 5,
    }),
  }),
)

export const ListenerTemplateSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  name: z.string().min(1),
  scope: z.enum(['top_level', 'all']),
  replyMode: GroupReplyModeSchema,
  sessionMode: GroupSessionModeSchema,
  autoCloseAfterCompletion: z.boolean(),
  msgTypes: z.array(ListenerMsgTypeSchema),
  senderTypes: z.array(ListenerSenderTypeSchema),
  prompt: z.string().min(1),
})

export type ListenerTemplate = z.infer<typeof ListenerTemplateSchema>

export const DEFAULT_LISTENER_TEMPLATES: readonly ListenerTemplate[] = [
  {
    key: 'daily',
    label: '工作日常',
    name: '工作日常',
    scope: 'top_level',
    replyMode: 'chat',
    sessionMode: 'per_message',
    autoCloseAfterCompletion: true,
    msgTypes: ['text', 'post', 'image', 'interactive', 'merge_forward'],
    senderTypes: ['user'],
    prompt: [
      '参与团队日常群聊协作，按以下规则判断是否回复；无需回复时仅输出 `<no_reply/>`（或空文本）：',
      '1. 回复场景：',
      '   - 开放话题讨论、征求建议，或承接已参与的对话；',
      '   - 涉及工作区代码、文档、工具或研发流程的提问，先检索核实后作答；',
      '   - 自然团队交流，简短拟人回应。',
      '2. 静默场景（仅输出 `<no_reply/>` 或空文本）：',
      '   - 明确 @他人 并指派给特定成员的事项；',
      '   - 「收到」「好的」「+1」等确认语、排期打卡或无诉求碎片消息；',
      '   - 缺少上下文且意图不明的内部事务。',
    ].join('\n'),
  },
  {
    key: 'project',
    label: '项目讨论',
    name: '项目讨论',
    scope: 'top_level',
    replyMode: 'new-topic',
    sessionMode: 'thread',
    autoCloseAfterCompletion: false,
    msgTypes: ['text', 'post', 'interactive'],
    senderTypes: ['user'],
    prompt: [
      '旁听项目技术与方案讨论，仅在能提供确切工程依据时回复，其余情况仅输出 `<no_reply/>`（或空文本）：',
      '1. 回复条件：',
      '   - 代码实现、接口契约、配置项、构建报错或线上现象疑问；',
      '   - 方案讨论中可通过检索工作区代码、提交记录或文档提供事实依据与边界提醒的问题。',
      '2. 输出要求：',
      '   - 先核实代码与文档，结论先行，附具体文件路径或验证命令，禁止猜测接口；',
      '   - 指派他人的事务、日常寒暄、单纯进度同步或缺乏证据的话题一律输出 `<no_reply/>`（或空文本）。',
    ].join('\n'),
  },
  {
    key: 'alert',
    label: '告警排查',
    name: '告警排查',
    scope: 'top_level',
    replyMode: 'new-topic',
    sessionMode: 'thread',
    autoCloseAfterCompletion: false,
    msgTypes: ['interactive', 'text', 'post', 'image', 'merge_forward'],
    senderTypes: ['bot', 'user'],
    prompt: [
      '判断消息是否为监控告警、指标异常、CI/部署失败或线上故障；非告警及恢复通知仅输出 `<no_reply/>`（或空文本）。',
      '',
      '命中告警后按顺序执行：',
      '1. 告警确认：若环境具备监控平台工具（CLI / MCP / API）且有权限，先执行「确认并屏蔽 1 小时」；无工具或失败时如实说明，禁止伪造结果。',
      '2. 根因排查：提取服务、集群、接口、错误码与时间窗口，结合工作区代码、近期变更与日志监控定位问题，区分已验证事实与待确认假设。',
      '3. 回复结构：',
      '   - **止损方式**：可立即执行的回滚、限流、降级或流量隔离手段；',
      '   - **根本原因**：高概率触发链路、代码/配置位置与证据；',
      '   - **后续行动**：防复发改造、监控补齐或待人工确认事项。',
    ].join('\n'),
  },
  {
    key: 'change',
    label: '变更观察',
    name: '变更观察',
    scope: 'top_level',
    replyMode: 'reply',
    sessionMode: 'per_message',
    autoCloseAfterCompletion: true,
    msgTypes: ['text', 'post', 'interactive'],
    senderTypes: ['user', 'bot'],
    prompt: [
      '观察代码合入、服务发布、配置调整、数据迁移与接口变更通知：',
      '1. 常规推进通知、无风险状态同步或点名审批消息，仅输出 `<no_reply/>`（或空文本）。',
      '2. 仅在结合工作区代码与配置发现实质风险时简短回复：',
      '   - 上下游协议或字段不兼容、默认值变更影响存量调用、发布顺序倒置；',
      '   - 遗漏配置开关、数据回填、多集群覆盖或回滚方案；',
      '   - 与已知线上异常或并行变更冲突。',
      '3. 直指风险点、代码/配置依据与核对动作，不写套话。',
    ].join('\n'),
  },
]

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>
export type SubstituteTarget = z.infer<typeof SubstituteTargetSchema>
export type SubstituteMode = z.infer<typeof SubstituteModeSchema>
export type ReminderCreationMode = z.infer<typeof ReminderCreationModeSchema>
export type BotDreamingConfig = z.output<typeof BotDreamingConfigSchema>
export type BotProactiveConfig = z.output<typeof BotProactiveConfigSchema>
export type RouterScopeMode = z.infer<typeof RouterScopeModeSchema>
export type GroupRouterMode = z.infer<typeof GroupRouterModeSchema>
export type RouterBypassMsgType = z.infer<typeof RouterBypassMsgTypeSchema>
export type RouterBypassConfig = z.output<typeof RouterBypassConfigSchema>
export type TaskDifficultyTier = z.infer<typeof TaskDifficultyTierSchema>
export type TierRoutingBypassTier = z.infer<typeof TierRoutingBypassTierSchema>
export type TierRoutingTarget = z.output<typeof TierRoutingTargetSchema>
export type TierRoutingTierConfig = z.output<typeof TierRoutingTierConfigSchema>
export type TierRoutingConfig = z.output<typeof TierRoutingConfigSchema>
export type BotRouterConfig = z.output<typeof BotRouterConfigSchema>
export type GroupRouterConfig = z.output<typeof GroupRouterConfigSchema>
export type BotExperimentalConfig = z.output<typeof BotExperimentalConfigSchema>
export type GroupReplyMode = z.infer<typeof GroupReplyModeSchema>
export type GroupSessionMode = z.infer<typeof GroupSessionModeSchema>
export type MentionTriggerMode = z.infer<typeof MentionTriggerModeSchema>
export type ListenerMsgType = z.infer<typeof ListenerMsgTypeSchema>
export type ListenerMentionFilter = z.infer<typeof ListenerMentionFilterSchema>
export type ListenerSenderType = z.infer<typeof ListenerSenderTypeSchema>
export type LarkBotConfig = z.infer<typeof LarkBotConfigSchema>
export type GroupRoleConfig = z.infer<typeof GroupRoleConfigSchema>
export type GroupListenerRule = z.infer<typeof GroupListenerRuleSchema>
export type LarkGroupConfig = z.infer<typeof LarkGroupConfigSchema>

export interface LarkBotPublicView extends Omit<LarkBotConfig, 'larkAppSecret'> {
  readonly hasSecret: boolean
}

export interface DiscoveredLarkChat {
  readonly botId: string
  readonly botName: string
  readonly larkAppId: string
  readonly chatId: string
  readonly name: string
  readonly description?: string
  readonly avatar?: string
  readonly ownerId?: string
}

export interface LarkChatMember {
  readonly openId: string
  readonly name: string
  readonly memberType: 'user' | 'bot'
  readonly avatarUrl?: string
  readonly email?: string
  readonly larkAppId?: string
  readonly userId?: string
}

export interface LarkDirectoryUserHit {
  readonly openId: string
  readonly userId?: string
  readonly name: string
  readonly enName?: string
  readonly email?: string
  readonly avatarUrl?: string
}

export interface LarkUserSearchHit {
  readonly openId: string
  readonly name: string
  readonly enName?: string
  readonly email?: string
  readonly department?: string
  readonly avatarUrl?: string
}

export interface LarkResourceRef {
  readonly type: 'image' | 'file'
  readonly key: string
  readonly name?: string
}

export interface LarkHistoryMessage {
  readonly messageId: string
  readonly chatId?: string
  readonly rootId?: string
  readonly parentId?: string
  readonly threadId?: string
  readonly senderOpenId?: string
  readonly senderName?: string
  readonly senderType: 'user' | 'bot'
  readonly msgType: string
  readonly text: string
  readonly createTimeMs: number
  readonly resources: readonly LarkResourceRef[]
}

export interface LarkDownloadedResource {
  readonly type: 'image' | 'file'
  readonly key: string
  readonly fileName: string
  readonly dataBase64: string
}

export interface LarkMessageDetail extends LarkHistoryMessage {
  readonly rawContent?: string
  readonly downloaded?: readonly LarkDownloadedResource[]
}

export interface LarkMention {
  readonly key: string
  readonly openId?: string
  readonly name?: string
}

export interface InboundLarkMessage {
  readonly botId: string
  readonly larkAppId: string
  readonly botOpenId?: string
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group' | string
  readonly rootId?: string
  readonly parentId?: string
  readonly threadId?: string
  readonly msgType: string
  readonly senderOpenId?: string
  readonly senderUnionId?: string
  readonly senderType: 'user' | 'bot'
  readonly text: string
  readonly rawContent: string
  readonly mentions: readonly LarkMention[]
  readonly imageKeys: readonly string[]
  readonly createTimeMs: number
}

export interface RecalledLarkMessageEvent {
  readonly botId: string
  readonly larkAppId: string
  readonly eventId?: string
  readonly messageId: string
  readonly chatId: string
  readonly recallTimeMs?: number
  readonly recallType?: string
}

export interface ParsedSlashCommand {
  readonly name: 'new' | 'close' | 'cancel' | 'status' | 'model' | 'agent' | 'console' | 'cot' | 'help'
  readonly args: string
}

export type RoutingDecision =
  | { readonly action: 'ignore'; readonly reason: string }
  | {
      readonly action: 'command'
      readonly command: ParsedSlashCommand
      readonly routeKey: string
      readonly workingDir: string
      readonly workspaceName: string
      readonly replyMode: GroupReplyMode
    }
  | {
      readonly action: 'agent'
      readonly trigger: 'p2p' | 'mention' | 'active-thread' | 'substitute' | 'listener'
      readonly routeKey: string
      readonly ephemeralHandoffRouteKey?: string
      readonly workingDir: string
      readonly workspaceName: string
      readonly chatName?: string
      readonly agentPreset: string
      readonly runtimeProfileId?: string
      readonly model?: string
      readonly reasoningEffort?: string
      /** True when the session's runtime/model was selected by tier routing or session override and must stay pinned. */
      readonly runtimePinned?: boolean
      /** Difficulty tier chosen when spawning a new session via tier routing. */
      readonly routedTier?: TaskDifficultyTier
      readonly sessionMode: 'thread' | 'per_message' | 'chat'
      readonly replyMode: GroupReplyMode
      readonly useCard: boolean
      readonly cotEnabled?: boolean
      readonly cotToolResultEnabled?: boolean
      readonly sendIntermediateMessages: boolean
      readonly receivedReactionEmoji?: string
      readonly allowSilentEmptyReply: boolean
      readonly autoCloseAfterCompletion: boolean
      readonly silentOnly?: boolean
      readonly delegationFollowup?: boolean
      readonly idleCloseMs?: number
      readonly roleReminder?: string
      readonly turnReminders: readonly string[]
      readonly userText: string
      readonly promptText: string
      readonly listenerName?: string
      readonly listenerDebounceMs?: number
    }

export interface RoutingRuntimeContext {
  readonly groupConfig?: LarkGroupConfig
  readonly chatName?: string
  readonly hasActiveSessionForRoute: (routeKey: string) => boolean
  readonly isRouteBoundToNativeThread?: (routeKey: string) => boolean
  readonly hasEphemeralRouterThread?: (routeKey: string) => boolean
  readonly getRouteTrigger?: (routeKey: string) => string | undefined
  readonly hasRouteReplied?: (routeKey: string) => boolean
}

export interface LarkBotStatus {
  readonly botId: string
  readonly larkAppId: string
  readonly name: string
  readonly avatarUrl?: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly botOpenId?: string
  readonly startedAtMs?: number
  readonly lastEventAtMs?: number
  readonly lastError?: string
  readonly activeBindings: number
}

export function buildGroupKey(botId: string, chatId: string): string {
  return `${botId}:${chatId}`
}

export interface EffectiveAgentRuntime {
  readonly source: 'bot' | 'group'
  readonly agentPreset: string
  readonly runtimeProfileId?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

export function resolveEffectiveAgentRuntime(
  bot: Pick<LarkBotConfig, 'agentPreset' | 'runtimeProfileId' | 'provider' | 'model' | 'reasoningEffort'>,
  group?: Pick<LarkGroupConfig, 'runtimeMode' | 'agentPreset' | 'runtimeProfileId' | 'model' | 'reasoningEffort'>,
): EffectiveAgentRuntime {
  const botProfileId = bot.runtimeProfileId?.trim() || undefined
  if (!group || group.runtimeMode === 'inherit') {
    return {
      source: 'bot',
      agentPreset: bot.agentPreset,
      ...(botProfileId ? { runtimeProfileId: botProfileId } : {}),
      ...(bot.provider ? { provider: bot.provider } : {}),
      ...(bot.model ? { model: bot.model } : {}),
      ...(bot.reasoningEffort ? { reasoningEffort: bot.reasoningEffort } : {}),
    }
  }

  const groupPreset = group.agentPreset.trim()
  const groupProfileId = group.runtimeProfileId?.trim() || undefined
  const groupModel = group.model.trim()
  const groupEffort = group.reasoningEffort.trim()

  if (groupPreset) {
    const provider = groupPreset === bot.agentPreset ? bot.provider : undefined
    return {
      source: 'group',
      agentPreset: groupPreset,
      ...(groupProfileId ? { runtimeProfileId: groupProfileId } : {}),
      ...(provider ? { provider } : {}),
      ...(groupModel ? { model: groupModel } : {}),
      ...(groupEffort ? { reasoningEffort: groupEffort } : {}),
    }
  }

  // Partial override (e.g. API caller supplied profile/model/reasoningEffort without agentPreset)
  const effectiveProfileId = groupProfileId ?? botProfileId
  const profileChanged = Boolean(groupProfileId && groupProfileId !== botProfileId)
  const effectiveModel = groupModel || (profileChanged ? undefined : bot.model)
  const effectiveEffort = groupEffort || (profileChanged ? undefined : bot.reasoningEffort)
  return {
    source: groupProfileId || groupModel || groupEffort ? 'group' : 'bot',
    agentPreset: bot.agentPreset,
    ...(effectiveProfileId ? { runtimeProfileId: effectiveProfileId } : {}),
    ...(bot.provider ? { provider: bot.provider } : {}),
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
  }
}

export function resolveEffectiveWorkspaceName(
  bot: {
    readonly name: string
    readonly workspaceName: string
    readonly defaultWorkingDir?: string
  },
  group?: {
    readonly workspaceName?: string
    readonly workingDir?: string
  },
): string {
  const fromGroup = group?.workspaceName?.trim()
  if (fromGroup) return fromGroup

  const rawGroupDir = group?.workingDir?.trim() ?? ''
  const rawBotDir = bot.defaultWorkingDir?.trim() ?? ''
  const groupDir = rawGroupDir ? expandWorkingDir(rawGroupDir) : ''
  const botDir = rawBotDir ? expandWorkingDir(rawBotDir) : ''

  if (groupDir && groupDir !== botDir) {
    return leafDirectoryName(groupDir) || bot.workspaceName.trim() || bot.name.trim()
  }

  const fromBot = bot.workspaceName.trim()
  if (fromBot) return fromBot

  return leafDirectoryName(botDir) || bot.name.trim()
}

export function resolveEffectiveWorkingDir(
  bot: Pick<LarkBotConfig, 'defaultWorkingDir'>,
  group?: Pick<LarkGroupConfig, 'workingDir'>,
): string {
  const raw = group?.workingDir?.trim() || bot.defaultWorkingDir.trim()
  return expandWorkingDir(raw) || raw
}

export function resolveEffectiveReactionEmoji(
  bot: Pick<LarkBotConfig, 'receivedReactionEmoji'>,
  group?: Pick<LarkGroupConfig, 'receivedReactionEmoji'>,
): string | undefined {
  const raw =
    group && group.receivedReactionEmoji && group.receivedReactionEmoji !== 'inherit'
      ? group.receivedReactionEmoji.trim()
      : bot.receivedReactionEmoji.trim()
  return raw && raw !== 'NONE' ? raw : undefined
}

export function resolveEffectiveCardBot(
  bot: LarkBotConfig,
  group?: Pick<
    LarkGroupConfig,
    'dshSessionLinkInCard' | 'replyFooterModel' | 'signatureMode' | 'signature'
  >,
): LarkBotConfig {
  const dshSessionLinkInCard =
    group?.dshSessionLinkInCard === 'on'
      ? true
      : group?.dshSessionLinkInCard === 'off'
        ? false
        : bot.dshSessionLinkInCard
  const showModel =
    group?.replyFooterModel === 'on'
      ? true
      : group?.replyFooterModel === 'off'
        ? false
        : Boolean(bot.replyFooterEnabled && bot.replyFooterModel)
  const effectiveSignature =
    !group || group.signatureMode === 'inherit'
      ? bot.replyFooterEnabled && bot.replyFooterSignature
        ? bot.signature.trim()
        : ''
      : group.signatureMode === 'off'
        ? ''
        : group.signature.trim()
  const hasSignature = Boolean(effectiveSignature)
  return {
    ...bot,
    dshSessionLinkInCard,
    replyFooterEnabled: showModel || hasSignature,
    replyFooterModel: showModel,
    replyFooterSignature: hasSignature,
    signature: effectiveSignature,
  }
}

export function resolveEffectiveGuestReadOnly(
  bot: Pick<LarkBotConfig, 'dshSessionLinkInCard' | 'sessionLinkGuestReadOnly'>,
  group?: Pick<LarkGroupConfig, 'dshSessionLinkInCard' | 'sessionLinkGuestReadOnly'>,
): boolean {
  const linkEnabled =
    group?.dshSessionLinkInCard === 'on'
      ? true
      : group?.dshSessionLinkInCard === 'off'
        ? false
        : bot.dshSessionLinkInCard
  if (!linkEnabled) return false
  if (group?.sessionLinkGuestReadOnly === 'on') return true
  if (group?.sessionLinkGuestReadOnly === 'off') return false
  return bot.sessionLinkGuestReadOnly
}

export interface EffectiveRouterConfig {
  readonly source: 'bot' | 'group'
  readonly enabled: boolean
  readonly provider: string
  readonly model: string
  readonly scope: RouterScopeMode
  readonly bypass: RouterBypassConfig
  readonly timeoutMs: number
  readonly maxTriageImages: number
  readonly systemPrompt: string
  readonly recentMessageCount: number
  readonly contextTtlMinutes: number
  readonly includeLastReply: boolean
  readonly coalesceQueuedMessages: boolean
  readonly tierRouting: TierRoutingConfig
}

export function resolveEffectiveRouterConfig(
  bot: Pick<LarkBotConfig, 'router'>,
  group?: Pick<LarkGroupConfig, 'router'>,
): EffectiveRouterConfig {
  const base = bot.router ?? DEFAULT_BOT_ROUTER_CONFIG
  const baseTierRouting = base.tierRouting ?? DEFAULT_TIER_ROUTING_CONFIG
  const groupRouter = group?.router
  if (!groupRouter || groupRouter.mode === 'inherit') {
    return {
      source: 'bot',
      enabled: base.enabled,
      provider: base.provider.trim(),
      model: base.model.trim(),
      scope: base.scope,
      bypass: base.bypass,
      timeoutMs: base.timeoutMs,
      maxTriageImages: base.maxTriageImages,
      systemPrompt: base.systemPrompt.trim(),
      recentMessageCount: base.recentMessageCount,
      contextTtlMinutes: base.contextTtlMinutes,
      includeLastReply: base.includeLastReply,
      coalesceQueuedMessages: base.enabled && base.coalesceQueuedMessages,
      tierRouting: baseTierRouting,
    }
  }
  if (groupRouter.mode === 'off') {
    return {
      source: 'group',
      enabled: false,
      provider: base.provider.trim(),
      model: base.model.trim(),
      scope: base.scope,
      bypass: base.bypass,
      timeoutMs: base.timeoutMs,
      maxTriageImages: base.maxTriageImages,
      systemPrompt: '',
      recentMessageCount: base.recentMessageCount,
      contextTtlMinutes: base.contextTtlMinutes,
      includeLastReply: base.includeLastReply,
      coalesceQueuedMessages: false,
      tierRouting: DEFAULT_TIER_ROUTING_CONFIG,
    }
  }
  const groupProvider = groupRouter.provider.trim()
  const groupModel = groupRouter.model.trim()
  const provider = groupProvider || base.provider.trim()
  const model = groupModel || (groupProvider ? '' : base.model.trim())
  return {
    source: 'group',
    enabled: true,
    provider,
    model,
    scope: groupRouter.scope,
    bypass: groupRouter.bypass,
    timeoutMs: groupRouter.timeoutMs,
    maxTriageImages: groupRouter.maxTriageImages,
    systemPrompt: groupRouter.systemPrompt.trim(),
    recentMessageCount: groupRouter.recentMessageCount,
    contextTtlMinutes: groupRouter.contextTtlMinutes,
    includeLastReply: groupRouter.includeLastReply,
    coalesceQueuedMessages: groupRouter.coalesceQueuedMessages,
    tierRouting: groupRouter.tierRouting ?? DEFAULT_TIER_ROUTING_CONFIG,
  }
}

export interface EffectiveCotConfig {
  readonly enabled: boolean
  readonly toolResultEnabled: boolean
  readonly source: 'bot' | 'group'
}

export function resolveEffectiveCotConfig(
  bot: Pick<LarkBotConfig, 'cotEnabled' | 'cotToolResultEnabled'>,
  group?: Pick<LarkGroupConfig, 'cotEnabled' | 'cotToolResultEnabled'>,
): EffectiveCotConfig {
  const groupOverride = group?.cotEnabled === 'on' || group?.cotEnabled === 'off'
  const enabled =
    group?.cotEnabled === 'on'
      ? true
      : group?.cotEnabled === 'off'
        ? false
        : Boolean(bot.cotEnabled)
  const toolResultEnabled =
    group?.cotToolResultEnabled === 'on'
      ? true
      : group?.cotToolResultEnabled === 'off'
        ? false
        : bot.cotToolResultEnabled !== false
  return {
    enabled,
    toolResultEnabled,
    source: groupOverride ? 'group' : 'bot',
  }
}

export function toPublicBotView(bot: LarkBotConfig): LarkBotPublicView {
  const { larkAppSecret, ...rest } = bot
  return {
    ...rest,
    hasSecret: Boolean(larkAppSecret),
  }
}
