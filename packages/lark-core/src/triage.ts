import type {
  EffectiveRouterConfig,
  InboundLarkMessage,
  RouterBypassConfig,
  RoutingDecision,
  TaskDifficultyTier,
  TierRoutingConfig,
  TierRoutingTarget,
} from './types.js'

export type TriageAction = 'silent' | 'quick_reply' | 'handoff'

export interface TriageVerdict {
  readonly action: TriageAction
  readonly reason: string
  readonly replyText?: string
  readonly tier?: TaskDifficultyTier
  readonly fallback?: boolean
}

export const TASK_DIFFICULTY_TIERS: readonly TaskDifficultyTier[] = ['lite', 'standard', 'heavy']

export const DEFAULT_TIER_ROUTING_DESCRIPTIONS: Readonly<Record<TaskDifficultyTier, string>> = {
  lite: '轻量任务：查资料、查飞书消息/文档、读单个文件、简单配置查询、内容总结整理或单步工具操作',
  standard: '常规研发与协作：常规代码修改、定位常见 Bug、补写单测、常规 PR Review、多工具信息检索与方案整理',
  heavy: '深度攻坚任务：跨模块架构设计、疑难并发/性能/线上复杂故障根因排查、大规模重构、高风险安全/代码深度审查或复杂长上下文深推',
}

export const RECOMMENDED_TIER_ROUTING_TARGETS: Readonly<
  Record<TaskDifficultyTier, readonly TierRoutingTarget[]>
> = {
  lite: [
    {
      id: 'lite-agy',
      agentPreset: 'agy',
      runtimeProfileId: '',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
      weight: 70,
      enabled: true,
    },
    {
      id: 'lite-codex',
      agentPreset: 'codex',
      runtimeProfileId: '',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
      weight: 30,
      enabled: true,
    },
  ],
  standard: [
    {
      id: 'std-agy',
      agentPreset: 'agy',
      runtimeProfileId: '',
      model: 'gemini-4-neon',
      reasoningEffort: 'xhigh',
      weight: 70,
      enabled: true,
    },
    {
      id: 'std-codex',
      agentPreset: 'codex',
      runtimeProfileId: '',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
      weight: 30,
      enabled: true,
    },
  ],
  heavy: [
    {
      id: 'heavy-agy',
      agentPreset: 'agy',
      runtimeProfileId: '',
      model: 'gemini-4-carbon',
      reasoningEffort: 'high',
      weight: 70,
      enabled: true,
    },
    {
      id: 'heavy-codex',
      agentPreset: 'codex',
      runtimeProfileId: '',
      model: 'gpt-6-astra',
      reasoningEffort: 'xhigh',
      weight: 30,
      enabled: true,
    },
  ],
}

export interface WeightedTierSelectionInput {
  readonly tier: TaskDifficultyTier
  readonly tierRouting: TierRoutingConfig
  /** Optional runtime availability check (false = skip broken/uninstalled runtime). */
  readonly isAvailable?: (target: TierRoutingTarget) => boolean
  /** Optional concurrency capacity check (true = has free concurrency slot right now). */
  readonly hasConcurrencyCapacity?: (target: TierRoutingTarget) => boolean
  /** Optional temporary cooldown/backoff check (true = recently failed / 429). */
  readonly isInCooldown?: (target: TierRoutingTarget) => boolean
  /** Injectable RNG in [0, 1) for deterministic testing. */
  readonly random?: () => number
}

export interface WeightedTierSelectionResult {
  readonly tier: TaskDifficultyTier
  readonly target: TierRoutingTarget
  readonly totalWeight: number
  readonly candidateCount: number
  readonly avoidedBusy: boolean
  readonly avoidedCooldown: boolean
}

export function hasConfiguredTierRouting(
  routerConfig: Pick<EffectiveRouterConfig, 'enabled' | 'tierRouting'> | undefined,
): boolean {
  if (!routerConfig?.enabled || !routerConfig.tierRouting?.enabled) return false
  const tiers = routerConfig.tierRouting.tiers
  return TASK_DIFFICULTY_TIERS.some((tier) =>
    (tiers[tier]?.targets ?? []).some(
      (t) => t.enabled !== false && t.weight > 0 && Boolean(t.agentPreset.trim()),
    ),
  )
}

export function selectWeightedTierTarget(
  input: WeightedTierSelectionInput,
): WeightedTierSelectionResult | undefined {
  const rawTargets = input.tierRouting.tiers[input.tier]?.targets ?? []
  const eligible = rawTargets.filter(
    (t) =>
      t.enabled !== false &&
      t.weight > 0 &&
      Boolean(t.agentPreset.trim()) &&
      (input.isAvailable ? input.isAvailable(t) : true),
  )
  if (eligible.length === 0) return undefined

  const healthy = eligible.filter((t) => !(input.isInCooldown?.(t) ?? false))
  const healthyIdle = healthy.filter((t) => input.hasConcurrencyCapacity?.(t) ?? true)
  const anyIdle = eligible.filter((t) => input.hasConcurrencyCapacity?.(t) ?? true)

  let pool: readonly TierRoutingTarget[]
  let avoidedCooldown = false
  let avoidedBusy = false

  if (healthyIdle.length > 0) {
    pool = healthyIdle
    avoidedCooldown = healthy.length < eligible.length
    avoidedBusy = healthyIdle.length < healthy.length
  } else if (healthy.length > 0) {
    pool = healthy
    avoidedCooldown = healthy.length < eligible.length
  } else if (anyIdle.length > 0) {
    pool = anyIdle
    avoidedBusy = anyIdle.length < eligible.length
  } else {
    pool = eligible
  }

  const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return undefined

  const rngVal = input.random ? input.random() : Math.random()
  const clamped = Number.isFinite(rngVal) ? Math.min(0.999999999, Math.max(0, rngVal)) : 0
  let cursor = clamped * totalWeight
  let chosen = pool[pool.length - 1]!
  for (const item of pool) {
    cursor -= item.weight
    if (cursor < 0) {
      chosen = item
      break
    }
  }

  return {
    tier: input.tier,
    target: chosen,
    totalWeight,
    candidateCount: pool.length,
    avoidedBusy,
    avoidedCooldown,
  }
}

export interface TriageToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface TriagePromptVariable {
  readonly key: string
  readonly token: string
  readonly label: string
  readonly desc: string
}

export interface TriageHistoryEntry {
  readonly role: 'user' | 'router' | 'worker'
  readonly senderName?: string
  readonly text: string
  readonly timestampMs: number
  readonly messageId?: string
}

export interface TriageQuotedMessage {
  readonly messageId: string
  readonly senderName?: string
  readonly msgType: string
  readonly text?: string
  readonly imageCount: number
}

export interface TriageActiveListenerSummary {
  readonly senderName?: string
  readonly preview: string
  readonly elapsedSec: number
}

export interface TriagePromptInput {
  readonly botName: string
  readonly botRoleName?: string
  readonly botRoleSummary?: string
  readonly chatName?: string
  readonly trigger: 'p2p' | 'mention' | 'active-thread' | 'substitute' | 'listener'
  readonly listenerName?: string
  readonly listenerPrompt?: string
  readonly systemPromptTemplate?: string
  readonly senderName?: string
  readonly senderType: 'user' | 'bot'
  readonly msgType?: string
  readonly peerMentions?: readonly string[]
  readonly userText: string
  readonly quotedMessage?: TriageQuotedMessage
  readonly attachedImageCount?: number
  readonly hasActiveWorker: boolean
  readonly workerBusy?: boolean
  readonly activeChatListeners?: readonly TriageActiveListenerSummary[]
  readonly silentOnly?: boolean
  readonly delegationFollowupEnabled?: boolean
  readonly lastWorkerReply?: string
  readonly recentMessages: readonly TriageHistoryEntry[]
  readonly recentMessageCount?: number
  readonly includeLastReply?: boolean
}

export interface RouterHandoffTurn {
  readonly senderName?: string
  readonly userText: string
  readonly routerReply: string
  readonly timestampMs: number
}

export interface CoalescedMessageItem {
  readonly messageId: string
  readonly senderName?: string
  readonly senderOpenId?: string
  readonly text: string
  readonly timestampMs: number
}

export const TRIAGE_TOOL_NAME = 'route_message' as const

export const ROUTE_MESSAGE_TOOL_SCHEMA: TriageToolSchema = {
  name: TRIAGE_TOOL_NAME,
  description:
    'Decide how to route the incoming group chat message: silent (ignore chatter/acks), quick_reply (brief reply without invoking the main runtime, ONLY allowed when has_active_session=false), or handoff (transfer directly to the main runtime agent).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['silent', 'quick_reply', 'handoff'],
        description:
          'Routing decision. Use "handoff" whenever tools, codebase/doc inspection, memory lookup, multi-step reasoning, or follow-up to an active session is needed, or whenever uncertain.',
      },
      reason: {
        type: 'string',
        description: 'Brief Simplified Chinese reason for audit logs (<= 40 chars).',
      },
      reply_text: {
        type: 'string',
        description:
          'Required only when action is "quick_reply". Concise, natural Simplified Chinese reply text (1-2 sentences, no fabrication of codebase/internal facts).',
      },
    },
    required: ['action', 'reason'],
    additionalProperties: false,
  },
}

export function buildRouteMessageToolSchema(
  options: { readonly includeTier?: boolean } = {},
): TriageToolSchema {
  if (!options.includeTier) return ROUTE_MESSAGE_TOOL_SCHEMA
  const baseProps = ROUTE_MESSAGE_TOOL_SCHEMA.parameters.properties as Record<string, unknown>
  return {
    name: ROUTE_MESSAGE_TOOL_SCHEMA.name,
    description: `${ROUTE_MESSAGE_TOOL_SCHEMA.description} When action is "handoff" on a new session, also set "tier" (lite | standard | heavy) based on task complexity.`,
    parameters: {
      ...ROUTE_MESSAGE_TOOL_SCHEMA.parameters,
      properties: {
        ...baseProps,
        tier: {
          type: 'string',
          enum: ['lite', 'standard', 'heavy'],
          description:
            'Task difficulty tier when action is "handoff" for a new session: "lite" (quick lookup/summary/single-step), "standard" (routine coding/debugging/review), or "heavy" (complex architecture/deep debugging/large refactor/hard reasoning).',
        },
      },
    },
  }
}

export function buildTierRoutingGuide(tierRouting: TierRoutingConfig | undefined): string {
  if (!tierRouting?.enabled) return ''
  const liteDesc = tierRouting.tiers.lite.prompt.trim() || DEFAULT_TIER_ROUTING_DESCRIPTIONS.lite
  const stdDesc =
    tierRouting.tiers.standard.prompt.trim() || DEFAULT_TIER_ROUTING_DESCRIPTIONS.standard
  const heavyDesc = tierRouting.tiers.heavy.prompt.trim() || DEFAULT_TIER_ROUTING_DESCRIPTIONS.heavy
  return [
    '## 新会话难度分档（`tier`，仅在 `action="handoff"` 时填写）',
    `- \`lite\`（轻量）：${liteDesc}`,
    `- \`standard\`（标准）：${stdDesc}`,
    `- \`heavy\`（深度）：${heavyDesc}`,
    '- 判断拿不准时优先选 `standard`；涉及复杂根因定位、大范围代码改动或架构设计时选 `heavy`。',
  ].join('\n')
}

export const TRIAGE_PROMPT_VARIABLES: readonly TriagePromptVariable[] = [
  { key: 'bot_name', token: '{{bot_name}}', label: '智能体名称', desc: '当前响应的智能体显示名称' },
  { key: 'bot_role', token: '{{bot_role}}', label: '角色设定', desc: '当前生效的角色名称与说明全文（未配置时为空）' },
  { key: 'chat_name', token: '{{chat_name}}', label: '群聊名称', desc: '当前消息所在群聊名称' },
  { key: 'trigger', token: '{{trigger}}', label: '触发来源', desc: '群主动监听 / 显式 @ 智能体 / 活跃话题续聊 / 代答模式' },
  { key: 'trigger_guide', token: '{{trigger_guide}}', label: '触发场景规则', desc: '按触发来源自动生成的对应判断说明' },
  { key: 'active_session_rule', token: '{{active_session_rule}}', label: '活跃会话约束', desc: '根据是否存在活跃主会话决定是否允许 quick_reply' },
  { key: 'listener_name', token: '{{listener_name}}', label: '监听规则名', desc: '命中主动监听时的规则名称（非监听为空）' },
  { key: 'listener_prompt', token: '{{listener_prompt}}', label: '监听指令全文', desc: '群主动监听配置的完整判断指令（非监听为空）' },
  { key: 'tier_routing_guide', token: '{{tier_routing_guide}}', label: '难度分档规则', desc: '开启按难度路由且新建会话时自动生成的三档判定说明' },
]

export const DEFAULT_TRIAGE_SYSTEM_PROMPT = [
  `你是飞书群聊智能体「{{bot_name}}」的前置智能分流助手。你的唯一职责是在极短时间内判断当前入站消息的处理去向，并调用 \`${TRIAGE_TOOL_NAME}\` 工具（或直接输出严格 JSON）。`,
  '',
  '## 可选动作与铁律',
  '1. `handoff`（直接移交给主运行时智能体接管，高召回优先）：',
  '   - 任何涉及代码库、文档、配置、日志、监控、工具执行、排查排障、写代码、方案设计、数据分析或需要历史记忆的任务；',
  '   - 若消息或引用消息附带图片：报错截图、监控图表、界面 Bug、架构/设计图或含实质业务信息的内容，一律选 `handoff`；',
  '   - 任何你无法 100% 确定不需要工具或上下文核实的问题（**拿不准一律选 `handoff`，宁可多移交、绝不漏任务或编造事实**）；',
  '   - 当已有活跃主会话且消息是追问、补充信息、或对上一轮提问的答复/批准（如上一轮问“是否执行/选 A 还是 B”，用户回“好的”“执行吧”“B”）时，必须选 `handoff`。',
  '2. `silent`（静默跳过，不发消息也不唤醒主运行时；显式 `@` 本智能体时严禁使用）：',
  '   - 群友之间的闲聊、寒暄、表情包/梗图/生活晒图、无关插话、明确指派或 @ 他人/其他智能体的事项；',
  '   - 无需回应的纯陈述确认语（如“收到”“好的”“了解”“+1”“辛苦了”“谢谢”），前提是它**不是**对上一轮提问的确认答复。',
  '{{active_session_rule}}',
  '',
  '{{tier_routing_guide}}',
  '',
  '{{trigger_guide}}',
  '',
  '{{listener_prompt}}',
  '',
  '{{bot_role}}',
  '',
  `请优先调用工具 \`${TRIAGE_TOOL_NAME}\` 返回裁决；若当前通道不支持工具调用，仅输出一行合法 JSON：{"action":"silent|quick_reply|handoff","reason":"...","reply_text":"...","tier":"lite|standard|heavy"}。`,
].join('\n')

export interface TriageSystemPromptVars {
  readonly bot_name: string
  readonly bot_role: string
  readonly chat_name: string
  readonly trigger: string
  readonly trigger_guide: string
  readonly active_session_rule: string
  readonly listener_name: string
  readonly listener_prompt: string
  readonly tier_routing_guide: string
}

export type AgentRoutingDecision = Extract<RoutingDecision, { action: 'agent' }>

/**
 * Whether an agent-bound routing decision falls under the configured smart-triage scope.
 * When tier routing is enabled with configured targets, brand-new `@Bot` sessions also
 * enter triage once to pick the difficulty tier (explicit `@Bot` stays forbidden from silent).
 */
export function shouldRunTriage(
  decision: AgentRoutingDecision,
  routerConfig: EffectiveRouterConfig,
  options?: { readonly hasActiveWorker?: boolean },
): boolean {
  if (!routerConfig.enabled) return false
  if (decision.trigger === 'p2p') return false
  if (
    decision.trigger === 'mention' &&
    !options?.hasActiveWorker &&
    hasConfiguredTierRouting(routerConfig)
  ) {
    return true
  }
  if (routerConfig.scope === 'active_thread_only') {
    return decision.trigger === 'active-thread'
  }
  if (routerConfig.scope === 'passive_only') {
    return decision.trigger === 'listener' || decision.trigger === 'active-thread'
  }
  return (
    decision.trigger === 'mention' ||
    decision.trigger === 'active-thread' ||
    decision.trigger === 'substitute' ||
    decision.trigger === 'listener'
  )
}

/**
 * Deterministic zero-cost fast-bypass to the main runtime:
 * 1. Always bypasses non-image binary attachments (`file` / `media` / `merge_forward`) that triage cannot inspect.
 * 2. Evaluates optional declarative bypass rules (senderTypes / msgTypes / keywords, OR logic),
 *    including explicit `image` message-type bypass and optional `maxTriageImages` cap.
 */
export function shouldFastBypassTriage(
  msg: Pick<InboundLarkMessage, 'msgType' | 'imageKeys'> &
    Partial<Pick<InboundLarkMessage, 'senderType' | 'text'>>,
  decision?: Pick<AgentRoutingDecision, 'trigger' | 'userText'>,
  bypass?: RouterBypassConfig,
  options?: { readonly maxTriageImages?: number; readonly extraImageCount?: number },
): { readonly bypass: boolean; readonly reason?: string } {
  if (msg.msgType === 'file' || msg.msgType === 'media' || msg.msgType === 'merge_forward') {
    return { bypass: true, reason: `消息类型 ${msg.msgType} 直通主运行时` }
  }
  const hasImage =
    msg.imageKeys.length > 0 || msg.msgType === 'image' || (options?.extraImageCount ?? 0) > 0
  const totalImages =
    Math.max(msg.imageKeys.length, msg.msgType === 'image' ? 1 : 0) +
    (options?.extraImageCount ?? 0)
  if (bypass) {
    if (
      msg.senderType &&
      bypass.senderTypes.includes(msg.senderType) &&
      !(msg.senderType === 'bot' && decision?.trigger === 'active-thread')
    ) {
      return {
        bypass: true,
        reason:
          msg.senderType === 'bot' ? '应用/机器人消息直通主运行时' : '成员消息直通主运行时',
      }
    }
    if (hasImage && bypass.msgTypes.includes('image')) {
      return {
        bypass: true,
        reason: '包含图片附件，按直通规则直通主运行时',
      }
    }
    if (
      (msg.msgType === 'interactive' || msg.msgType === 'text' || msg.msgType === 'post') &&
      bypass.msgTypes.includes(msg.msgType)
    ) {
      return {
        bypass: true,
        reason: `消息类型 ${msg.msgType} 直通主运行时`,
      }
    }
    if (bypass.keywords.length > 0) {
      const hay = (decision?.userText ?? msg.text ?? '').toLowerCase()
      if (hay) {
        const matched = bypass.keywords.find((kw) => {
          const needle = kw.trim().toLowerCase()
          return needle.length > 0 && hay.includes(needle)
        })
        if (matched) {
          return {
            bypass: true,
            reason: `命中直通关键词「${matched.trim()}」，直通主运行时`,
          }
        }
      }
    }
  }
  if (hasImage && options?.maxTriageImages !== undefined) {
    const cap = Math.max(0, Math.floor(options.maxTriageImages))
    if (cap === 0) {
      return { bypass: true, reason: '分流图片上限为 0，直通主运行时' }
    }
    if (totalImages > cap) {
      return { bypass: true, reason: `图片数量（${totalImages} 张）超过分流上限（${cap} 张），直通主运行时` }
    }
  }
  return { bypass: false }
}

function clipReason(raw: string, maxChars: number): string {
  const trimmed = raw.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}

function triggerLabelOf(trigger: TriagePromptInput['trigger']): string {
  if (trigger === 'mention') return '显式 @ 智能体'
  if (trigger === 'listener') return '群主动监听'
  if (trigger === 'active-thread') return '活跃话题续聊'
  if (trigger === 'substitute') return '代答模式'
  return '私聊'
}

function isUnmentionedPeerDirected(
  trigger: TriagePromptInput['trigger'] | undefined,
  peerMentions: readonly string[] | undefined,
): boolean {
  return Boolean(
    (trigger === 'listener' || trigger === 'active-thread') &&
      peerMentions &&
      peerMentions.length > 0,
  )
}

function formatPeerMentionsLabel(peerMentions: readonly string[]): string {
  const cleaned = peerMentions.map((item) => item.trim()).filter(Boolean)
  if (cleaned.length <= 2) return cleaned.join('、')
  return `${cleaned.slice(0, 2).join('、')}等`
}

function triggerGuideOf(
  trigger: TriagePromptInput['trigger'],
  options?: {
    readonly botName?: string
    readonly peerMentions?: readonly string[]
    readonly delegationFollowupEnabled?: boolean
    readonly silentOnly?: boolean
  },
): string {
  const botLabel = options?.botName?.trim() ? `「${options.botName.trim()}」` : ''
  const peerLabel =
    options?.peerMentions && options.peerMentions.length > 0
      ? `（当前消息仅 @ 了 ${formatPeerMentionsLabel(options.peerMentions)}，并非本智能体${botLabel}）`
      : ''
  const delegationNote =
    '- **已开启「委派事项跟进」**：仅当成员 A **首次**明确 @ 成员 B 指派新的具体可跟进事项（如故障排查、修复 Bug、发布、审批、CR、待办交付等）时，不要按“指派他人”静默，应选 `handoff` 交由主运行时后台登记提醒；若 `<recent_context>` 显示双方已在持续来回沟通同一事项（补充细节、互相答疑、进度确认或回复结果），或仅是寒暄、玩笑、纯信息同步与无明确行动项的 @ 他人，一律选 `silent`。'

  if (options?.silentOnly && options?.delegationFollowupEnabled) {
    return [
      '## 触发信号：委派事项静默观察（仅后台登记提醒，禁止回复群聊）',
      '- 本轮只用于识别群内 A @ B **首次**提出的明确行动委派（新排查/修复/发版/审批/CR/交付等）：若构成需要后续核查的新行动指派，选 `handoff` 交由主运行时静默创建跟进提醒；同一事项的后续来回沟通、细节补充、进度确认、寒暄、玩笑或无具体行动项的提及一律选 `silent`。',
      '- **严禁选择 `quick_reply`**，只能在 `silent` 与 `handoff` 之间二选一。',
    ].join('\n')
  }
  if (trigger === 'mention') {
    return [
      '## 触发信号：显式 @ 本智能体',
      `- 用户主动 @ 了本智能体${botLabel}，表达了明确对话意图：**本轮严禁选择 \`silent\`**（系统强制响应显式 @）；`,
      '- 仅在 `has_active_session=false` 且属于简单打招呼、礼貌致谢、轻松闲聊吐槽或纯表情包/生活趣图互动时可选 `quick_reply` 简短回应；凡有实质诉求、业务图表/报错截图、需核实上下文或 `has_active_session=true` 一律 `handoff`。',
    ].join('\n')
  }
  if (trigger === 'listener') {
    return [
      '## 触发信号：群主动监听（旁听）',
      `- 用户并未 @ 本智能体${botLabel}，请严格参照下方监听规则过滤噪音；无关讨论与常规状态同步直接 \`silent\`，符合规则需要核实或执行的 \`handoff\`。`,
      `- **收紧旁听误触发**：成员间正在自行讨论、互相答疑、确认进展，或发送未向本智能体求助的日常/状态同步截图时，优先选 \`silent\`；仅当消息明确命中下方监听规则且确实需要本智能体核实代码/日志/监控或提供专业结论时再选 \`handoff\`。`,
      `- **严防错认 @ 对象**：若消息或 \`peer_mentions\` 提及了其他成员或其他智能体${peerLabel}，严禁误认为在呼叫本智能体，也**禁止使用 \`quick_reply\` 抢答**；除命中业务监听规则或委派跟进需 \`handoff\` 外，一律 \`silent\`。`,
      '- **避免同话题并发重复拉起**：若 `<active_chat_listeners>` 显示本群已有正在处理同一讨论/故障的主会话，且当前消息只是成员间的连续补充、确认、回复或配套报错截图（未显式 `@` 本智能体），直接选 `silent` 避免重复拉起并发主会话；仅当出现明确独立的新故障或新诉求时再选 `handoff`。',
      ...(options?.delegationFollowupEnabled ? [delegationNote] : []),
    ].join('\n')
  }
  if (trigger === 'active-thread') {
    return [
      '## 触发信号：活跃话题内免 @ 续聊',
      `- 消息位于已有对话话题中：请结合最近对话与上一轮主回复判断是否面向本智能体${botLabel}继续推进；若只是同事间旁白、仅 @ 其他成员/智能体的对话${peerLabel}或纯确认收尾则 \`silent\`，否则 \`handoff\`。`,
      ...(options?.delegationFollowupEnabled ? [delegationNote] : []),
    ].join('\n')
  }
  if (trigger === 'substitute') {
    return [
      '## 触发信号：代答模式',
      '- 用户 @ 了代答目标成员：若为具体业务/技术问题请 `handoff`，仅纯寒暄或无需回复的确认可 `silent`。',
    ].join('\n')
  }
  return ''
}

function activeSessionRuleOf(
  hasActiveSession: boolean,
  silentOnly = false,
  options?: {
    readonly trigger?: TriagePromptInput['trigger']
    readonly peerMentions?: readonly string[]
  },
): string {
  if (silentOnly) {
    return '3. **当前为后台静默观察模式（`silent_only=true`）**：禁止使用 `quick_reply`，只能在 `silent` 与 `handoff` 之间二选一。'
  }
  if (hasActiveSession) {
    if (options?.trigger === 'mention') {
      return '3. **当前话题已由主运行时接管且用户显式 @ 本智能体（`has_active_session=true`）**：禁止使用 `silent` 与 `quick_reply`，必须选择 `handoff`。'
    }
    return '3. **当前话题已由主运行时接管（`has_active_session=true`）**：禁止使用 `quick_reply`，只能在 `silent` 与 `handoff` 之间二选一，避免双人格分裂或越权回答。'
  }
  if (isUnmentionedPeerDirected(options?.trigger, options?.peerMentions)) {
    return `3. **当前消息仅 @ 了其他成员/智能体（${formatPeerMentionsLabel(options!.peerMentions!)}），未 @ 本智能体**：禁止使用 \`quick_reply\` 抢答，只能在 \`silent\` 与 \`handoff\` 之间二选一。`
  }
  return [
    '3. `quick_reply`（仅在 `has_active_session=false` 时允许）：',
    '   - 仅用于明确面向本智能体的简单打招呼、轻松寒暄、礼貌致谢，或对纯表情包/梗图/生活趣图的简短互动（1-2 句自然简体中文）；',
    '   - 严禁在 `quick_reply` 中猜测或回答任何需要查代码、文档、系统状态、业务图表/报错截图或专业深思的问题。',
  ].join('\n')
}

export function buildTriageSystemPromptVars(input: {
  readonly botName: string
  readonly botRoleName?: string
  readonly botRoleSummary?: string
  readonly chatName?: string
  readonly hasActiveWorker: boolean
  readonly trigger: TriagePromptInput['trigger']
  readonly peerMentions?: readonly string[]
  readonly listenerName?: string
  readonly listenerPrompt?: string
  readonly delegationFollowupEnabled?: boolean
  readonly silentOnly?: boolean
  readonly tierRouting?: TierRoutingConfig
}): TriageSystemPromptVars {
  const roleParts = [input.botRoleName?.trim(), input.botRoleSummary?.trim()].filter(Boolean)
  const botRole = roleParts.length > 0 ? `## 智能体角色设定\n${roleParts.join('\n')}` : ''
  const rawListener = input.trigger === 'listener' ? input.listenerPrompt?.trim() ?? '' : ''
  const listenerPrompt = rawListener ? `<listener_rule>\n${rawListener}\n</listener_rule>` : ''
  const tierRoutingGuide =
    !input.hasActiveWorker && !input.silentOnly && input.tierRouting?.enabled
      ? buildTierRoutingGuide(input.tierRouting)
      : ''

  return {
    bot_name: input.botName.trim(),
    bot_role: botRole,
    chat_name: input.chatName?.trim() ?? '',
    trigger: input.silentOnly && input.delegationFollowupEnabled ? '委派事项静默观察' : triggerLabelOf(input.trigger),
    trigger_guide: triggerGuideOf(input.trigger, {
      botName: input.botName,
      ...(input.peerMentions && input.peerMentions.length > 0
        ? { peerMentions: input.peerMentions }
        : {}),
      ...(input.delegationFollowupEnabled !== undefined
        ? { delegationFollowupEnabled: input.delegationFollowupEnabled }
        : {}),
      ...(input.silentOnly !== undefined ? { silentOnly: input.silentOnly } : {}),
    }),
    active_session_rule: activeSessionRuleOf(input.hasActiveWorker, Boolean(input.silentOnly), {
      trigger: input.trigger,
      ...(input.peerMentions && input.peerMentions.length > 0
        ? { peerMentions: input.peerMentions }
        : {}),
    }),
    listener_name: input.trigger === 'listener' ? (input.listenerName?.trim() ?? '') : '',
    listener_prompt: listenerPrompt,
    tier_routing_guide: tierRoutingGuide,
  }
}

export function renderTriageSystemPrompt(
  template: string | undefined,
  vars: TriageSystemPromptVars,
): string {
  const source = template?.trim() ? template : DEFAULT_TRIAGE_SYSTEM_PROMPT
  const table: Record<string, string> = {
    bot_name: vars.bot_name,
    bot_role: vars.bot_role,
    chat_name: vars.chat_name,
    trigger: vars.trigger,
    trigger_guide: vars.trigger_guide,
    active_session_rule: vars.active_session_rule,
    listener_name: vars.listener_name,
    listener_prompt: vars.listener_prompt,
    tier_routing_guide: vars.tier_routing_guide,
  }
  const hasTierToken = /\{\{\s*tier_routing_guide\s*\}\}/i.test(source)
  let rendered = source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, rawKey: string) => {
    const key = rawKey.toLowerCase()
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : full
  })
  if (vars.tier_routing_guide && !hasTierToken) {
    rendered = `${rendered.trim()}\n\n${vars.tier_routing_guide}`
  }
  return rendered.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function buildTriageSystemPrompt(input: {
  readonly botName: string
  readonly botRoleName?: string
  readonly botRoleSummary?: string
  readonly chatName?: string
  readonly hasActiveWorker: boolean
  readonly trigger: TriagePromptInput['trigger']
  readonly peerMentions?: readonly string[]
  readonly listenerName?: string
  readonly listenerPrompt?: string
  readonly systemPromptTemplate?: string
  readonly delegationFollowupEnabled?: boolean
  readonly silentOnly?: boolean
  readonly tierRouting?: TierRoutingConfig
}): string {
  const vars = buildTriageSystemPromptVars(input)
  return renderTriageSystemPrompt(input.systemPromptTemplate, vars)
}

export function buildTriageUserMessage(input: TriagePromptInput): string {
  const sections: string[] = []
  const cleanBotName = input.botName.trim()
  const metaParts = [
    `trigger=${input.trigger}`,
    ...(cleanBotName ? [`bot_name="${cleanBotName}"`] : []),
    `has_active_session=${input.hasActiveWorker ? 'true' : 'false'}`,
    ...(input.silentOnly ? ['silent_only=true'] : []),
    ...(input.hasActiveWorker ? [`session_busy=${input.workerBusy ? 'true' : 'false'}`] : []),
    ...(input.chatName ? [`chat="${input.chatName}"`] : []),
    ...(input.listenerName ? [`listener="${input.listenerName}"`] : []),
    `sender_type=${input.senderType}`,
    ...(input.senderName ? [`sender="${input.senderName}"`] : []),
    ...(input.peerMentions && input.peerMentions.length > 0
      ? [`peer_mentions="${input.peerMentions.join('、')}"`]
      : []),
    ...(input.msgType ? [`msg_type=${input.msgType}`] : []),
    ...(input.attachedImageCount && input.attachedImageCount > 0
      ? [`images=${input.attachedImageCount}`]
      : []),
    ...(input.trigger === 'listener' && input.activeChatListeners && input.activeChatListeners.length > 0
      ? [`active_chat_listeners=${input.activeChatListeners.length}`]
      : []),
  ]
  sections.push(`<triage_meta ${metaParts.join(' ')} />`)

  if (
    input.trigger === 'listener' &&
    input.activeChatListeners &&
    input.activeChatListeners.length > 0
  ) {
    const activeLines = input.activeChatListeners.slice(0, 3).map((item) => {
      const who = item.senderName?.trim() || '成员'
      const elapsed = Math.max(0, Math.round(item.elapsedSec))
      const preview = item.preview.replace(/\s+/g, ' ').trim()
      const clipped = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview || '[空消息]'
      return `- [${who} · 已运行 ${elapsed}s] ${clipped}`
    })
    sections.push(
      [
        '<active_chat_listeners>',
        `当前群聊已有 ${input.activeChatListeners.length} 个主动监听主会话正在后台处理（避免为同一讨论串的后续碎片重复拉起并发会话）：`,
        ...activeLines,
        '</active_chat_listeners>',
      ].join('\n'),
    )
  }

  const includeLastReply = input.includeLastReply !== false
  if (includeLastReply && input.hasActiveWorker && input.lastWorkerReply?.trim()) {
    sections.push(`<last_reply>\n${input.lastWorkerReply.trim()}\n</last_reply>`)
  }

  if (input.quotedMessage) {
    const q = input.quotedMessage
    const qAttrs = [
      `message_id="${q.messageId}"`,
      `msg_type="${q.msgType}"`,
      ...(q.senderName ? [`sender="${q.senderName}"`] : []),
      ...(q.imageCount > 0 ? [`images=${q.imageCount}`] : []),
    ]
    const rawText = q.text?.trim() ?? ''
    const clippedText =
      rawText.length > 1500 ? `${rawText.slice(0, 1500)}…` : rawText
    const qBody =
      clippedText || (q.imageCount > 0 ? `[引用图片消息，共 ${q.imageCount} 张]` : `[${q.msgType}]`)
    sections.push(`<quoted_message ${qAttrs.join(' ')}>\n${qBody}\n</quoted_message>`)
  }

  const maxRecent =
    input.recentMessageCount !== undefined
      ? Math.max(0, Math.floor(input.recentMessageCount))
      : 6
  if (maxRecent > 0 && input.recentMessages.length > 0) {
    const historyLines = input.recentMessages.slice(-maxRecent).map((item) => {
      const who =
        item.role === 'worker'
          ? '[智能体]'
          : item.role === 'router'
            ? '[智能分流]'
            : `[${item.senderName || '成员'}]`
      return `- ${who} ${item.text.trim()}`
    })
    sections.push(`<recent_context>\n${historyLines.join('\n')}\n</recent_context>`)
  }

  const body = input.userText.trim() || '[空消息]'
  sections.push(`<incoming_message>\n${body}\n</incoming_message>`)
  return sections.join('\n\n')
}

function tryParseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const candidates: string[] = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) candidates.unshift(fenced[1].trim())
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined
}

function parseTaskDifficultyTier(raw: unknown): TaskDifficultyTier | undefined {
  if (typeof raw !== 'string') return undefined
  const norm = raw.trim().toLowerCase()
  if (norm === 'lite' || norm === 'light' || norm === 'fast') return 'lite'
  if (norm === 'standard' || norm === 'medium' || norm === 'normal') return 'standard'
  if (norm === 'heavy' || norm === 'hard' || norm === 'deep') return 'heavy'
  return undefined
}

function normalizeVerdictObject(
  obj: Record<string, unknown> | undefined,
  hasActiveWorker: boolean,
  silentOnly = false,
  options?: {
    readonly trigger?: TriagePromptInput['trigger']
    readonly peerMentions?: readonly string[]
  },
): TriageVerdict | undefined {
  if (!obj) return undefined
  const rawAction = typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : ''
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim()
      ? clipReason(obj.reason.trim(), 80)
      : '智能分流判定'
  const rawReply =
    typeof obj.reply_text === 'string'
      ? obj.reply_text.trim()
      : typeof obj.replyText === 'string'
        ? obj.replyText.trim()
        : ''
  const parsedTier = !hasActiveWorker ? parseTaskDifficultyTier(obj.tier) : undefined

  if (rawAction === 'silent') {
    // Invariant: explicit @Bot mentions must never be silently swallowed by triage.
    if (options?.trigger === 'mention' && !silentOnly) {
      return {
        action: 'handoff',
        reason: `${reason}（显式 @ 智能体禁止静默，转交主运行时）`,
        ...(parsedTier ? { tier: parsedTier } : {}),
      }
    }
    return { action: 'silent', reason }
  }
  if (rawAction === 'handoff') {
    return {
      action: 'handoff',
      reason,
      ...(parsedTier ? { tier: parsedTier } : {}),
    }
  }
  if (rawAction === 'quick_reply') {
    if (silentOnly) {
      return { action: 'silent', reason: `${reason}（后台观察模式禁止直接回复）` }
    }
    // Invariant: once the main runtime owns the route, never allow quick_reply to split persona/context.
    if (hasActiveWorker) {
      return { action: 'handoff', reason: `${reason}（已有活跃会话，转交主运行时）` }
    }
    // Invariant: passive listener / active-thread messages mentioning other peers (without @Bot)
    // must never trigger a quick_reply hijack pretending to answer for the mentioned peer.
    if (isUnmentionedPeerDirected(options?.trigger, options?.peerMentions)) {
      const peerLabel = formatPeerMentionsLabel(options!.peerMentions!)
      return {
        action: 'silent',
        reason: `${reason}（仅 @ ${peerLabel}，未 @ 本智能体，已拦截抢答快回）`,
      }
    }
    if (!rawReply) {
      return {
        action: 'handoff',
        reason: '轻回复内容为空，回退直通主运行时',
        ...(parsedTier ? { tier: parsedTier } : {}),
        fallback: true,
      }
    }
    return { action: 'quick_reply', reason, replyText: rawReply }
  }
  return undefined
}

/**
 * Dual-channel parser: prefers structured `route_message` tool call arguments,
 * falls back to JSON text parsing, and strictly Fails-Open to `handoff` on any ambiguity.
 */
export function parseTriageVerdict(input: {
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly arguments: string }>
  readonly text?: string
  readonly hasActiveWorker: boolean
  readonly silentOnly?: boolean
  readonly trigger?: TriagePromptInput['trigger']
  readonly peerMentions?: readonly string[]
}): TriageVerdict {
  const silentOnly = Boolean(input.silentOnly)
  const guardOpts = {
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.peerMentions && input.peerMentions.length > 0
      ? { peerMentions: input.peerMentions }
      : {}),
  }
  const matchingTool = input.toolCalls?.find((c) => c.name === TRIAGE_TOOL_NAME)
  if (matchingTool) {
    const parsed = normalizeVerdictObject(
      tryParseJsonObject(matchingTool.arguments),
      input.hasActiveWorker,
      silentOnly,
      guardOpts,
    )
    if (parsed) return parsed
  }

  if (input.text?.trim()) {
    const parsed = normalizeVerdictObject(
      tryParseJsonObject(input.text),
      input.hasActiveWorker,
      silentOnly,
      guardOpts,
    )
    if (parsed) return parsed
  }

  return {
    action: 'handoff',
    reason: '分流解析失败，自动直通主运行时',
    fallback: true,
  }
}

export function composeRouterHandoffReminder(turns: readonly RouterHandoffTurn[]): string | undefined {
  if (turns.length === 0) return undefined
  const lines = [
    '<triage_handoff_context>',
    '此前智能分流已在当前对话中进行了简短初步回应，现正式移交给你全权接管并直接回复用户（无需提及前置分流）：',
  ]
  for (const turn of turns.slice(-4)) {
    lines.push(`- ${turn.senderName || '用户'}：${turn.userText.trim()}`)
    lines.push(`- 此前简短回复：${turn.routerReply.trim()}`)
  }
  lines.push('</triage_handoff_context>')
  return lines.join('\n')
}

export function composeCoalescedUserText(items: readonly CoalescedMessageItem[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!.text
  const lines = [`以下 ${items.length} 条消息在你上一轮处理期间连续到达，请结合上下文统一处理并回复：`]
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    const who = item.senderName || item.senderOpenId || '成员'
    lines.push(`[${i + 1}] ${who} (message_id="${item.messageId}"): ${item.text || '[空消息]'}`)
  }
  return lines.join('\n')
}
