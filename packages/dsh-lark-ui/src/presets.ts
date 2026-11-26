import { LARK_EMOJI_ASSETS } from './assets/lark-emoji.js'
import type {
  GroupReplyMode,
  GroupSessionMode,
  Inheritable,
  ListenerMsgType,
  ListenerSenderType,
  ListenerTemplate,
  ReminderCreationMode,
  RouterBypassConfig,
  RouterBypassMsgType,
  RouterScopeMode,
  ScheduleDeliveryMode,
  ScheduleNotifyOn,
  TriageDefaultsPayload,
} from './types.js'

export interface Choice<T extends string> {
  readonly value: T
  readonly label: string
  readonly desc?: string
}

export const REPLY_MODES: readonly Choice<GroupReplyMode>[] = [
  { value: 'new-topic', label: '话题内回复' },
  { value: 'reply', label: '引用回复' },
  { value: 'chat', label: '直接发送' },
]

export const SESSION_MODES: readonly Choice<GroupSessionMode>[] = [
  { value: 'thread', label: '按话题复用' },
  { value: 'per_message', label: '每次新建' },
  { value: 'chat', label: '全群共享' },
]

export const REPLY_FORMATS: readonly Choice<'card' | 'text'>[] = [
  { value: 'card', label: '消息卡片' },
  { value: 'text', label: '纯文本' },
]

export const BINARY_SWITCH_MODES: readonly Choice<'on' | 'off'>[] = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
]

export const INTERMEDIATE_MESSAGE_MODES: readonly Choice<'on' | 'off'>[] = [
  { value: 'off', label: '仅最终回复' },
  { value: 'on', label: '实时发送过程消息' },
]

export const TRIGGER_MODES: readonly Choice<'mention_and_active_thread' | 'mention_only'>[] = [
  { value: 'mention_and_active_thread', label: '@ 或活跃话题' },
  { value: 'mention_only', label: '仅 @ 时' },
]

export const ACCESS_MODES: readonly Choice<'all_joined' | 'configured_only'>[] = [
  { value: 'all_joined', label: '所有已加入的群' },
  { value: 'configured_only', label: '仅已启用的群' },
]

export const P2P_SESSION_MODES: readonly Choice<'chat' | 'per_message'>[] = [
  { value: 'chat', label: '每人一个会话' },
  { value: 'per_message', label: '每条消息新建' },
]

export const DISCLOSURE_MODES: readonly Choice<'none' | 'subtle' | 'explicit'>[] = [
  {
    value: 'none',
    label: '不说明身份',
    desc: '以协作者口吻直接作答，不提及代答身份',
  },
  {
    value: 'subtle',
    label: '自然协助说明',
    desc: '正常协助作答，涉及拍板事项时提示由本人最终确认',
  },
  {
    value: 'explicit',
    label: '明确声明代答',
    desc: '回复开头说明正代为先行检索回复，关键决策待本人确认',
  },
]

export const DEFAULT_DREAMING_SCOPES: readonly string[] = [
  '个人偏好',
  '协作约定',
  '项目领域知识',
  '踩坑与排障经验',
  '潜在问题与技术债',
  '未完成待办',
]

export const REMINDER_CREATION_MODES: readonly Choice<ReminderCreationMode>[] = [
  { value: 'silent', label: '静默创建' },
  { value: 'notify', label: '创建时发送提示' },
  { value: 'confirm', label: '创建前请求确认' },
]

export const ROUTER_SCOPE_MODES: readonly Choice<RouterScopeMode>[] = [
  {
    value: 'passive_only',
    label: '仅监听与活跃话题',
    desc: '显式 @ 智能体直达主运行时，仅对主动监听与活跃话题续聊做分流',
  },
  {
    value: 'active_thread_only',
    label: '仅活跃话题续聊',
    desc: '主动监听首消息与显式 @ 直达主运行时，仅对活跃话题续聊做分流',
  },
  {
    value: 'all_group',
    label: '全部群消息',
    desc: '包含显式 @ 在内的全部群聊消息均先经轻量模型分流（私聊除外；显式 @ 仅区分快回与转交，不静默）',
  },
]

export const ROUTER_BYPASS_MSG_TYPES: readonly Choice<RouterBypassMsgType>[] = [
  { value: 'interactive', label: '卡片' },
  { value: 'text', label: '文本' },
  { value: 'post', label: '富文本' },
  { value: 'image', label: '图片' },
]

export const DEFAULT_ROUTER_BYPASS: RouterBypassConfig = {
  senderTypes: ['bot'],
  msgTypes: [],
  keywords: [],
}

export function cloneRouterBypass(bypass?: Partial<RouterBypassConfig>): RouterBypassConfig {
  return {
    senderTypes: bypass?.senderTypes ? [...bypass.senderTypes] : [...DEFAULT_ROUTER_BYPASS.senderTypes],
    msgTypes: bypass?.msgTypes ? [...bypass.msgTypes] : [...DEFAULT_ROUTER_BYPASS.msgTypes],
    keywords: bypass?.keywords ? [...bypass.keywords] : [...DEFAULT_ROUTER_BYPASS.keywords],
  }
}

export const FALLBACK_TRIAGE_DEFAULTS: TriageDefaultsPayload = {
  toolName: 'route_message',
  toolSchema: {
    name: 'route_message',
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
  },
  variables: [
    { key: 'bot_name', token: '{{bot_name}}', label: '智能体名称', desc: '当前响应的智能体显示名称' },
    { key: 'bot_role', token: '{{bot_role}}', label: '角色设定', desc: '当前生效的角色名称与说明全文（未配置时为空）' },
    { key: 'chat_name', token: '{{chat_name}}', label: '群聊名称', desc: '当前消息所在群聊名称' },
    { key: 'trigger', token: '{{trigger}}', label: '触发来源', desc: '群主动监听 / 显式 @ 智能体 / 活跃话题续聊 / 代答模式' },
    { key: 'trigger_guide', token: '{{trigger_guide}}', label: '触发场景规则', desc: '按触发来源自动生成的对应判断说明' },
    { key: 'active_session_rule', token: '{{active_session_rule}}', label: '活跃会话约束', desc: '根据是否存在活跃主会话决定是否允许 quick_reply' },
    { key: 'listener_name', token: '{{listener_name}}', label: '监听规则名', desc: '命中主动监听时的规则名称（非监听为空）' },
    { key: 'listener_prompt', token: '{{listener_prompt}}', label: '监听指令全文', desc: '群主动监听配置的完整判断指令（非监听为空）' },
  ],
  defaultSystemPrompt: [
    '你是飞书群聊智能体「{{bot_name}}」的前置智能分流助手。你的唯一职责是在极短时间内判断当前入站消息的处理去向，并调用 `route_message` 工具（或直接输出严格 JSON）。',
    '',
    '## 可选动作与铁律',
    '1. `handoff`（直接移交给主运行时智能体接管，高召回优先）：',
    '   - 任何涉及代码库、文档、配置、日志、监控、工具执行、排查排障、写代码、方案设计、数据分析或需要历史记忆的任务；',
    '   - 任何你无法 100% 确定不需要工具或上下文核实的问题（**拿不准一律选 `handoff`，宁可多移交、绝不漏任务或编造事实**）；',
    '   - 当已有活跃主会话且消息是追问、补充信息、或对上一轮提问的答复/批准（如上一轮问“是否执行/选 A 还是 B”，用户回“好的”“执行吧”“B”）时，必须选 `handoff`。',
    '2. `silent`（静默跳过，不发消息也不唤醒主运行时；显式 `@` 本智能体时严禁使用）：',
    '   - 群友之间的闲聊、寒暄、无关插话、明确指派或 @ 他人/其他智能体的事项；',
    '   - 无需回应的纯陈述确认语（如“收到”“好的”“了解”“+1”“辛苦了”“谢谢”），前提是它**不是**对上一轮提问的确认答复。',
    '{{active_session_rule}}',
    '',
    '{{trigger_guide}}',
    '',
    '{{listener_prompt}}',
    '',
    '{{bot_role}}',
    '',
    '请优先调用工具 `route_message` 返回裁决；若当前通道不支持工具调用，仅输出一行合法 JSON：{"action":"silent|quick_reply|handoff","reason":"...","reply_text":"..."}。',
  ].join('\n'),
}

export const REASONING_EFFORTS: readonly Choice<string>[] = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
]

export const MSG_TYPES: readonly Choice<ListenerMsgType>[] = [
  { value: 'text', label: '文本' },
  { value: 'post', label: '富文本' },
  { value: 'interactive', label: '卡片' },
  { value: 'image', label: '图片' },
  { value: 'merge_forward', label: '合并转发' },
]

export const SENDER_TYPES: readonly Choice<ListenerSenderType>[] = [
  { value: 'user', label: '成员' },
  { value: 'bot', label: '应用 / 智能体' },
]

export const LISTENER_SCOPES: readonly Choice<'top_level' | 'all'>[] = [
  { value: 'top_level', label: '仅群内新消息' },
  { value: 'all', label: '包含话题回复' },
]

export const SCHEDULE_DELIVERY_MODES: readonly Choice<ScheduleDeliveryMode>[] = [
  { value: 'chat', label: '群内直发' },
  { value: 'thread', label: '发回原话题' },
]

export const SCHEDULE_NOTIFY_ON: readonly Choice<ScheduleNotifyOn>[] = [
  { value: 'non_empty', label: '有内容或异常时' },
  { value: 'always', label: '每次执行都推送' },
  { value: 'error_only', label: '仅执行异常时' },
]

export const REACTION_NONE = 'NONE'
export const REACTION_EMOJIS = LARK_EMOJI_ASSETS

export interface RolePreset {
  readonly key: string
  readonly label: string
  readonly roleName: string
  readonly systemPrompt: string
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    key: 'dev-partner',
    label: '研发搭档',
    roleName: '研发协作搭档',
    systemPrompt: [
      '你是团队驻群的高级研发协作搭档。',
      '1. 结论与可执行建议先行，再附关键代码路径、日志证据或推导依据。',
      '2. 涉及代码时先检索真实代码与提交记录，禁止猜测编造接口或配置。',
      '3. 排版紧凑清晰，善用短列表与代码块。',
    ].join('\n'),
  },
  {
    key: 'reviewer',
    label: '架构评审',
    roleName: '架构与代码评审专家',
    systemPrompt: [
      '你是严谨的系统架构师与代码评审专家。',
      '1. 从第一性原理审视方案，识别隐含假设、路径依赖与边界风险。',
      '2. 按「阻塞问题 / 结构建议 / 边界验证」分级输出，定位到具体文件与行号。',
      '3. 优先推荐简单、职责单一的实现，拒绝过度设计。',
    ].join('\n'),
  },
  {
    key: 'oncall',
    label: '值班排障',
    roleName: '线上值班助手',
    systemPrompt: [
      '你是线上稳定性值班专家。',
      '1. 收到告警或报错时，按「影响面 → 止损手段 → 高概率根因 → 核查命令」输出。',
      '2. 明确区分已验证事实与待验证假设，高风险操作必须提示人工确认。',
    ].join('\n'),
  },
  {
    key: 'advisor',
    label: '技术顾问',
    roleName: '技术顾问',
    systemPrompt: [
      '你是面向跨角色协作群的技术顾问。',
      '1. 用清晰直白的语言解释技术原因，给出明确的下一步建议。',
      '2. 保持客观、准确、简洁。',
    ].join('\n'),
  },
]

export const FALLBACK_LISTENER_TEMPLATES: readonly ListenerTemplate[] = [
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
      '参与团队日常群聊协作，按以下规则判断是否回复；无需回复时仅输出空文本：',
      '1. 回复场景：',
      '   - 开放话题讨论、征求建议，或承接已参与的对话；',
      '   - 涉及工作区代码、文档、工具或研发流程的提问，先检索核实后作答；',
      '   - 自然团队交流，简短拟人回应。',
      '2. 静默场景（输出空文本）：',
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
      '旁听项目技术与方案讨论，仅在能提供确切工程依据时回复，其余情况仅输出空文本：',
      '1. 回复条件：',
      '   - 代码实现、接口契约、配置项、构建报错或线上现象疑问；',
      '   - 方案讨论中可通过检索工作区代码、提交记录或文档提供事实依据与边界提醒的问题。',
      '2. 输出要求：',
      '   - 先核实代码与文档，结论先行，附具体文件路径或验证命令，禁止猜测接口；',
      '   - 指派他人的事务、日常寒暄、单纯进度同步或缺乏证据的话题一律输出空文本。',
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
      '判断消息是否为监控告警、指标异常、CI/部署失败或线上故障；非告警及恢复通知仅输出空文本。',
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
      '1. 常规推进通知、无风险状态同步或点名审批消息，仅输出空文本。',
      '2. 仅在结合工作区代码与配置发现实质风险时简短回复：',
      '   - 上下游协议或字段不兼容、默认值变更影响存量调用、发布顺序倒置；',
      '   - 遗漏配置开关、数据回填、多集群覆盖或回滚方案；',
      '   - 与已知线上异常或并行变更冲突。',
      '3. 直指风险点、代码/配置依据与核对动作，不写套话。',
    ].join('\n'),
  },
]

export function choiceLabel<T extends string>(choices: readonly Choice<T>[], value: T): string {
  return choices.find((c) => c.value === value)?.label ?? value
}

export function withInherit<T extends string>(
  choices: readonly Choice<T>[],
  inherited: T,
): Choice<Inheritable<T>>[] {
  const inheritedChoice = choices.find((c) => c.value === inherited)
  return [
    {
      value: 'inherit',
      label: `跟随智能体（${inheritedChoice?.label ?? inherited}）`,
    },
    ...choices,
  ]
}
