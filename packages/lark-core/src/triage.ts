import type {
  EffectiveRouterConfig,
  InboundLarkMessage,
  RoutingDecision,
} from './types.js'

export type TriageAction = 'silent' | 'quick_reply' | 'handoff'

export interface TriageVerdict {
  readonly action: TriageAction
  readonly reason: string
  readonly replyText?: string
  readonly fallback?: boolean
}

export interface TriageToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface TriageHistoryEntry {
  readonly role: 'user' | 'router' | 'worker'
  readonly senderName?: string
  readonly text: string
  readonly timestampMs: number
}

export interface TriagePromptInput {
  readonly botName: string
  readonly botRoleName?: string
  readonly botRoleSummary?: string
  readonly chatName?: string
  readonly trigger: 'p2p' | 'mention' | 'active-thread' | 'substitute' | 'listener'
  readonly listenerName?: string
  readonly listenerPrompt?: string
  readonly customPrompt?: string
  readonly senderName?: string
  readonly senderType: 'user' | 'bot'
  readonly userText: string
  readonly hasActiveWorker: boolean
  readonly workerBusy?: boolean
  readonly lastWorkerReplyExcerpt?: string
  readonly recentMessages: readonly TriageHistoryEntry[]
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
    'Decide how to route the incoming group chat message: silent (ignore chatter/acks), quick_reply (brief reply without invoking the heavy Worker, ONLY allowed when has_active_worker=false), or handoff (transfer directly to the heavy Worker agent).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['silent', 'quick_reply', 'handoff'],
        description:
          'Routing decision. Use "handoff" whenever tools, codebase/doc inspection, memory lookup, multi-step reasoning, or follow-up to an active Worker is needed, or whenever uncertain.',
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

const MAX_EXCERPT_CHARS = 1500
const FAST_BYPASS_TEXT_CHARS = 800

export type AgentRoutingDecision = Extract<RoutingDecision, { action: 'agent' }>

/**
 * Whether an agent-bound routing decision falls under the configured Router/Worker triage scope.
 */
export function shouldRunTriage(
  decision: AgentRoutingDecision,
  routerConfig: EffectiveRouterConfig,
): boolean {
  if (!routerConfig.enabled) return false
  if (decision.trigger === 'p2p') return false
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
 * Deterministic zero-cost fast-bypass to Worker for payloads that clearly require full Worker capabilities
 * (images, file/forward attachments, or long/code-bearing non-listener requests).
 * Listener cards/alerts are NOT bypassed by length so recovery/routine notifications can still be filtered.
 */
export function shouldFastBypassTriage(
  msg: Pick<InboundLarkMessage, 'msgType' | 'imageKeys'>,
  decision: Pick<AgentRoutingDecision, 'trigger' | 'userText'>,
): { readonly bypass: boolean; readonly reason?: string } {
  if (msg.imageKeys.length > 0 || msg.msgType === 'image') {
    return { bypass: true, reason: '包含图片附件，直通 Worker' }
  }
  if (msg.msgType === 'file' || msg.msgType === 'media' || msg.msgType === 'merge_forward') {
    return { bypass: true, reason: `消息类型 ${msg.msgType} 直通 Worker` }
  }
  if (decision.trigger !== 'listener') {
    if (decision.userText.length > FAST_BYPASS_TEXT_CHARS) {
      return { bypass: true, reason: '长文本任务，直通 Worker' }
    }
    if (decision.userText.includes('```')) {
      return { bypass: true, reason: '包含代码块，直通 Worker' }
    }
  }
  return { bypass: false }
}

function clipText(raw: string, maxChars: number): string {
  const trimmed = raw.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}…`
}

export function buildTriageSystemPrompt(input: {
  readonly botName: string
  readonly botRoleName?: string
  readonly botRoleSummary?: string
  readonly hasActiveWorker: boolean
  readonly trigger: TriagePromptInput['trigger']
  readonly listenerPrompt?: string
  readonly customPrompt?: string
}): string {
  const lines: string[] = [
    `你是飞书群聊智能体「${input.botName}」的前置快速分流路由（Router）。你的唯一职责是在极短时间内判断当前入站消息的处理去向，并调用 \`${TRIAGE_TOOL_NAME}\` 工具（或直接输出严格 JSON）。`,
    '',
    '## 可选动作与铁律',
    '1. `handoff`（直接移交给专业 Worker 智能体接管，高召回优先）：',
    '   - 任何涉及代码库、文档、配置、日志、监控、工具执行、排查排障、写代码、方案设计、数据分析或需要历史记忆的任务；',
    '   - 任何你无法 100% 确定不需要工具或上下文核实的问题（**拿不准一律选 `handoff`，宁可多移交、绝不漏任务或编造事实**）；',
    '   - 当已有活跃 Worker 且消息是追问、补充信息、或对 Worker 上一轮提问的答复/批准（如 Worker 问“是否执行/选 A 还是 B”，用户回“好的”“执行吧”“B”）时，必须选 `handoff`。',
    '2. `silent`（静默跳过，不发消息也不唤醒 Worker）：',
    '   - 群友之间的闲聊、寒暄、无关插话、明确指派给他人的事项；',
    '   - 无需回应的纯陈述确认语（如“收到”“好的”“了解”“+1”“辛苦了”“谢谢”），前提是它**不是**对 Worker 提问的确认答复。',
  ]

  if (input.hasActiveWorker) {
    lines.push(
      '3. **当前话题已由 Worker 接管（`has_active_worker=true`）**：禁止使用 `quick_reply`，只能在 `silent` 与 `handoff` 之间二选一，避免双人格分裂或越权回答。',
    )
  } else {
    lines.push(
      '3. `quick_reply`（仅在 `has_active_worker=false` 时允许）：',
      '   - 仅用于明确面向本智能体的简单打招呼、轻松寒暄或礼貌致谢回应（1-2 句自然简体中文）；',
      '   - 严禁在 `quick_reply` 中猜测或回答任何需要查代码、文档、系统状态或专业深思的问题。',
    )
  }

  if (input.trigger === 'mention') {
    lines.push(
      '',
      '## 触发信号：显式 @本智能体',
      '- 用户主动 @ 了本智能体，表达了明确对话意图：极度克制 `silent`（仅明显纯礼貌致谢且无需回应时可 `silent` 或简短 `quick_reply`）；凡有实质诉求一律 `handoff`。',
    )
  } else if (input.trigger === 'listener') {
    lines.push(
      '',
      '## 触发信号：群主动监听（旁听）',
      '- 用户并未 @ 本智能体，请严格参照下方监听规则过滤噪音；无关讨论与常规状态同步直接 `silent`，符合规则需要核实或执行的 `handoff`。',
    )
    if (input.listenerPrompt?.trim()) {
      lines.push(`<listener_rule>\n${clipText(input.listenerPrompt, 800)}\n</listener_rule>`)
    }
  } else if (input.trigger === 'active-thread') {
    lines.push(
      '',
      '## 触发信号：活跃话题内免 @ 续聊',
      '- 消息位于已有对话话题中：请结合最近对话与 Worker 上一轮结尾判断是否面向本智能体继续推进；若只是同事间旁白或纯确认收尾则 `silent`，否则 `handoff`。',
    )
  } else if (input.trigger === 'substitute') {
    lines.push(
      '',
      '## 触发信号：代答模式',
      '- 用户 @ 了代答目标成员：若为具体业务/技术问题请 `handoff`，仅纯寒暄或无需回复的确认可 `silent`。',
    )
  }

  if (input.botRoleName || input.botRoleSummary) {
    lines.push(
      '',
      `## 智能体角色摘要：${[input.botRoleName, input.botRoleSummary ? clipText(input.botRoleSummary, 240) : ''].filter(Boolean).join(' — ')}`,
    )
  }

  if (input.customPrompt?.trim()) {
    lines.push('', '## 额外分流约定', clipText(input.customPrompt, 600))
  }

  lines.push(
    '',
    `请优先调用工具 \`${TRIAGE_TOOL_NAME}\` 返回裁决；若当前通道不支持工具调用，仅输出一行合法 JSON：{"action":"silent|quick_reply|handoff","reason":"...","reply_text":"..."}。`,
  )
  return lines.join('\n')
}

export function buildTriageUserMessage(input: TriagePromptInput): string {
  const sections: string[] = []
  const metaParts = [
    `trigger=${input.trigger}`,
    `has_active_worker=${input.hasActiveWorker ? 'true' : 'false'}`,
    ...(input.hasActiveWorker ? [`worker_busy=${input.workerBusy ? 'true' : 'false'}`] : []),
    ...(input.chatName ? [`chat="${input.chatName}"`] : []),
    ...(input.listenerName ? [`listener="${input.listenerName}"`] : []),
    `sender_type=${input.senderType}`,
    ...(input.senderName ? [`sender="${input.senderName}"`] : []),
  ]
  sections.push(`<triage_meta ${metaParts.join(' ')} />`)

  if (input.hasActiveWorker && input.lastWorkerReplyExcerpt?.trim()) {
    sections.push(
      `<last_worker_reply>\n${clipText(input.lastWorkerReplyExcerpt, 350)}\n</last_worker_reply>`,
    )
  }

  if (input.recentMessages.length > 0) {
    const historyLines = input.recentMessages.slice(-6).map((item) => {
      const who =
        item.role === 'worker'
          ? '[Worker]'
          : item.role === 'router'
            ? '[Router]'
            : `[${item.senderName || '成员'}]`
      return `- ${who} ${clipText(item.text, 220)}`
    })
    sections.push(`<recent_context>\n${historyLines.join('\n')}\n</recent_context>`)
  }

  sections.push(`<incoming_message>\n${clipText(input.userText || '[空消息]', MAX_EXCERPT_CHARS)}\n</incoming_message>`)
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

function normalizeVerdictObject(
  obj: Record<string, unknown> | undefined,
  hasActiveWorker: boolean,
): TriageVerdict | undefined {
  if (!obj) return undefined
  const rawAction = typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : ''
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim()
      ? clipText(obj.reason.trim(), 80)
      : 'Router 判定'
  const rawReply =
    typeof obj.reply_text === 'string'
      ? obj.reply_text.trim()
      : typeof obj.replyText === 'string'
        ? obj.replyText.trim()
        : ''

  if (rawAction === 'silent') {
    return { action: 'silent', reason }
  }
  if (rawAction === 'handoff') {
    return { action: 'handoff', reason }
  }
  if (rawAction === 'quick_reply') {
    // Invariant: once a Worker owns the route, never allow Router quick_reply to split persona/context.
    if (hasActiveWorker) {
      return { action: 'handoff', reason: `${reason}（已有活跃 Worker，转交接管）` }
    }
    if (!rawReply) {
      return { action: 'handoff', reason: '轻回复内容为空，回退移交 Worker', fallback: true }
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
}): TriageVerdict {
  const matchingTool = input.toolCalls?.find((c) => c.name === TRIAGE_TOOL_NAME)
  if (matchingTool) {
    const parsed = normalizeVerdictObject(
      tryParseJsonObject(matchingTool.arguments),
      input.hasActiveWorker,
    )
    if (parsed) return parsed
  }

  if (input.text?.trim()) {
    const parsed = normalizeVerdictObject(tryParseJsonObject(input.text), input.hasActiveWorker)
    if (parsed) return parsed
  }

  return {
    action: 'handoff',
    reason: '分流解析失败，自动直通 Worker',
    fallback: true,
  }
}

export function composeRouterHandoffReminder(turns: readonly RouterHandoffTurn[]): string | undefined {
  if (turns.length === 0) return undefined
  const lines = [
    '<router_handoff_context>',
    '此前置 Router 已在当前对话中进行了简短初步回应，现正式移交给你全权接管并直接回复用户（无需提及 Router）：',
  ]
  for (const turn of turns.slice(-4)) {
    lines.push(`- ${turn.senderName || '用户'}：${clipText(turn.userText, 300)}`)
    lines.push(`- 此前简短回复：${clipText(turn.routerReply, 300)}`)
  }
  lines.push('</router_handoff_context>')
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
