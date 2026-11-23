import { homedir } from 'node:os'
import { basename, join, parse, resolve } from 'node:path'
import { z } from 'zod'

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
      .default('02:00')
      .transform((v) => normalizeHHMM(v, '02:00')),
    minNewSessions: z.number().int().min(1).max(50).default(2),
    scopes: z
      .array(z.string().trim().min(1))
      .default([...DEFAULT_DREAMING_SCOPES]),
    cleanupAndCorrect: z.boolean().default(true),
  }),
)

export const DEFAULT_BOT_DREAMING_CONFIG: z.output<typeof BotDreamingConfigSchema> = {
  enabled: false,
  scheduleTime: '02:00',
  minNewSessions: 2,
  scopes: [...DEFAULT_DREAMING_SCOPES],
  cleanupAndCorrect: true,
}

export const ReminderCreationModeSchema = z.enum(['silent', 'notify', 'confirm'])

export const BotProactiveConfigSchema = z.object({
  remindersEnabled: z.boolean().default(false),
  reminderCreationMode: ReminderCreationModeSchema.default('silent'),
  autoCodeEnabled: z.boolean().default(false),
  branchPrefix: z
    .string()
    .default('agent/')
    .transform((v) => v.trim() || 'agent/'),
})

export const DEFAULT_BOT_PROACTIVE_CONFIG: z.output<typeof BotProactiveConfigSchema> = {
  remindersEnabled: false,
  reminderCreationMode: 'silent',
  autoCodeEnabled: false,
  branchPrefix: 'agent/',
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
export const ListenerSenderTypeSchema = z.enum(['user', 'bot'])

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
  delete rec.workspaceGroupName
  delete rec.brandLabel
  delete rec.replyFooterBrand
  return rec
}

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
    groupReplyMode: GroupReplyModeSchema.default('new-topic'),
    groupSessionMode: GroupSessionModeSchema.default('thread'),
    mentionTriggerMode: MentionTriggerModeSchema.default('mention_and_active_thread'),
    groupAccessMode: z.enum(['configured_only', 'all_joined']).default('all_joined'),

    // Direct message (P2P) & admin policies
    p2pEnabled: z.boolean().default(true),
    p2pSessionMode: z.enum(['chat', 'per_message']).default('chat'),
    allowedUsers: z.array(z.string()).default([]),
    allowedUserProfiles: z.array(SubstituteTargetSchema).default([]),
    adminUsers: z.array(z.string()).default([]),
    adminUserProfiles: z.array(SubstituteTargetSchema).default([]),

    // Card, signature & feedback
    sendIntermediateMessages: z.boolean().default(false),
    useInteractiveCard: z.boolean().default(true),
    dshSessionLinkInCard: z.boolean().default(true),
    sessionLinkGuestReadOnly: z.boolean().default(true),
    replyFooterEnabled: z.boolean().default(true),
    replyFooterModel: z.boolean().default(true),
    replyFooterSignature: z.boolean().default(true),
    signature: z.string().default(''),
    receivedReactionEmoji: z.string().default('OnIt'),
    idleCloseMinutes: z.number().min(0).default(720),

    // Persona, substitute collaboration & experimental capabilities
    role: RoleDefinitionSchema.default({ enabled: false, name: '', systemPrompt: '' }),
    substituteMode: SubstituteModeSchema.default({
      enabled: false,
      targets: [],
      disclosure: 'none',
      activeThreadFollowup: true,
    }),
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
  msgTypes: z.array(ListenerMsgTypeSchema).default(['text', 'post', 'interactive']),
  senderTypes: z.array(ListenerSenderTypeSchema).default(['user']),
  senderFilterMode: z.enum(['all_except_excluded', 'include_only']).default('all_except_excluded'),
  senderOpenIds: z.array(z.string()).default([]),
  memberOverrides: z.record(z.string(), z.boolean()).default({}),
  includeKeywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
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
    intermediateMessages: z.enum(['inherit', 'on', 'off']).default('inherit'),
    replyFormat: z.enum(['inherit', 'card', 'text']).default('inherit'),
    dshSessionLinkInCard: z.enum(['inherit', 'on', 'off']).default('inherit'),
    sessionLinkGuestReadOnly: z.enum(['inherit', 'on', 'off']).default('inherit'),
    replyFooterModel: z.enum(['inherit', 'on', 'off']).default('inherit'),
    signatureMode: z.enum(['inherit', 'custom', 'off']).default('inherit'),
    signature: z.string().default(''),

    // Group-level role & passive listener
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
      msgTypes: ['text', 'post', 'interactive'],
      senderTypes: ['user'],
      senderFilterMode: 'all_except_excluded',
      senderOpenIds: [],
      memberOverrides: {},
      includeKeywords: [],
      excludeKeywords: [],
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
export type BotExperimentalConfig = z.output<typeof BotExperimentalConfigSchema>
export type GroupReplyMode = z.infer<typeof GroupReplyModeSchema>
export type GroupSessionMode = z.infer<typeof GroupSessionModeSchema>
export type MentionTriggerMode = z.infer<typeof MentionTriggerModeSchema>
export type ListenerMsgType = z.infer<typeof ListenerMsgTypeSchema>
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
  readonly senderType: 'user' | 'bot'
  readonly text: string
  readonly rawContent: string
  readonly mentions: readonly LarkMention[]
  readonly imageKeys: readonly string[]
  readonly createTimeMs: number
}

export interface ParsedSlashCommand {
  readonly name: 'new' | 'close' | 'cancel' | 'status' | 'model' | 'agent' | 'help'
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
      readonly workingDir: string
      readonly workspaceName: string
      readonly chatName?: string
      readonly agentPreset: string
      readonly runtimeProfileId?: string
      readonly model?: string
      readonly reasoningEffort?: string
      readonly sessionMode: 'thread' | 'per_message' | 'chat'
      readonly replyMode: GroupReplyMode
      readonly useCard: boolean
      readonly sendIntermediateMessages: boolean
      readonly receivedReactionEmoji?: string
      readonly allowSilentEmptyReply: boolean
      readonly autoCloseAfterCompletion: boolean
      readonly idleCloseMs?: number
      readonly roleReminder?: string
      readonly turnReminders: readonly string[]
      readonly userText: string
      readonly promptText: string
      readonly listenerName?: string
    }

export interface RoutingRuntimeContext {
  readonly groupConfig?: LarkGroupConfig
  readonly chatName?: string
  readonly hasActiveSessionForRoute: (routeKey: string) => boolean
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

export function toPublicBotView(bot: LarkBotConfig): LarkBotPublicView {
  const { larkAppSecret, ...rest } = bot
  return {
    ...rest,
    hasSecret: Boolean(larkAppSecret),
  }
}
