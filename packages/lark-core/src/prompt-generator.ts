import {
  GroupReplyModeSchema,
  GroupSessionModeSchema,
  ListenerMentionFilterSchema,
  ListenerMsgTypeSchema,
  ListenerSenderTypeSchema,
  type GroupReplyMode,
  type GroupSessionMode,
  type ListenerMentionFilter,
  type ListenerMsgType,
  type ListenerSenderType,
} from './types.js'

export type PromptGenerationKind = 'role' | 'listener'
export type RoleGenerationMode = 'bot' | 'append' | 'override'

export interface PromptGenerationContext {
  readonly botName?: string
  readonly botDescription?: string
  readonly chatName?: string
  readonly roleMode?: RoleGenerationMode
  readonly baseRoleName?: string
  readonly baseRolePrompt?: string
  readonly currentName?: string
  readonly currentPrompt?: string
}

export interface GeneratedRoleDraft {
  readonly name: string
  readonly systemPrompt: string
}

export interface GeneratedListenerDraft {
  readonly name: string
  readonly prompt: string
  readonly scope?: 'top_level' | 'all'
  readonly mentionFilter?: ListenerMentionFilter
  readonly replyMode?: GroupReplyMode
  readonly sessionMode?: GroupSessionMode
  readonly autoCloseAfterCompletion?: boolean
  readonly msgTypes?: readonly ListenerMsgType[]
  readonly senderTypes?: readonly ListenerSenderType[]
  readonly includeKeywords?: readonly string[]
  readonly excludeKeywords?: readonly string[]
}

export interface PromptGenerationMessages {
  readonly system: string
  readonly user: string
}

const MAX_CONTEXT_TEXT_CHARS = 1200

function trimContextText(raw: string | undefined, maxChars = MAX_CONTEXT_TEXT_CHARS): string {
  const clean = raw?.trim() ?? ''
  if (!clean) return ''
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trim()}…` : clean
}

export function buildPromptGenerationMessages(input: {
  readonly kind: PromptGenerationKind
  readonly description: string
  readonly context?: PromptGenerationContext
}): PromptGenerationMessages {
  const description = input.description.trim()
  const ctx = input.context ?? {}

  if (input.kind === 'role') {
    const mode: RoleGenerationMode = ctx.roleMode ?? 'bot'
    const modeGuide =
      mode === 'append'
        ? '当前为「群聊追加角色设定」：将在智能体基础角色之后追加生效，请聚焦本群专属职责、业务范围、回复风格与协作边界，避免重复基础角色已有内容。`name` 可留空以沿用基础角色名，或给出更贴合本群的简短角色名（2–12 字）。'
        : mode === 'override'
          ? '当前为「群聊独立覆盖角色设定」：将完全覆盖智能体默认角色，请生成一份完整、自洽的群聊角色设定。'
          : '当前为「智能体全局角色设定」：将在新会话开始时注入，请生成一份结构清晰、直接可执行的通用角色设定。'

    const system = [
      '你是飞书智能体配置专家，负责把用户的简短自然语言描述转化为高质量、结构化、可直接落地的智能体「角色设定」。',
      '',
      '## 编写准则',
      '1. 全部使用自然、直接、克制的简体中文，拒绝空洞套话与官腔；',
      '2. 提示词采用第二人称（“你是…”），严格以用户需求描述为核心，包含：清晰定位、核心职责/工作方式、事实与工具核实原则、输出格式与协作边界；',
      '3. 控制在 150–400 字之间，分条清晰（用 1. 2. 3. 编号），易于模型稳定遵循；',
      '4. `name` 必须是概括职责的简短角色头衔（2–12 字，如「代码评审专家」「线上值班助手」），不要直接填智能体的应用名称；智能体简介仅作背景参考，与需求无关时不要硬塞进提示词；',
      `5. ${modeGuide}`,
      '6. 若你正处于带工具的 Agent 运行时环境，**禁止调用任何工具、禁止读写文件或执行命令**，直接输出最终 JSON。',
      '',
      '## 输出格式（严格要求）',
      '只输出一个合法 JSON 对象，不要包含任何额外的解释性文字：',
      '{"name":"简短角色名称（2-12字）","systemPrompt":"完整的角色提示词正文"}',
    ].join('\n')

    const userLines: string[] = [`用户需求描述：\n${description}`]
    if (ctx.botName?.trim()) userLines.push(`智能体名称：${ctx.botName.trim()}`)
    if (ctx.botDescription?.trim()) {
      userLines.push(`智能体简介：${trimContextText(ctx.botDescription, 400)}`)
    }
    if (ctx.chatName?.trim()) userLines.push(`所在群聊：${ctx.chatName.trim()}`)
    if (mode === 'append' && (ctx.baseRoleName?.trim() || ctx.baseRolePrompt?.trim())) {
      userLines.push(
        `智能体已有基础角色（请补充而非重复）：\n名称：${ctx.baseRoleName?.trim() || '（未命名）'}\n${trimContextText(ctx.baseRolePrompt, 800)}`,
      )
    }
    if (ctx.currentName?.trim() || ctx.currentPrompt?.trim()) {
      userLines.push(
        `当前已有草稿（如用户希望在其基础上优化可参考，否则以用户最新描述为准）：\n名称：${ctx.currentName?.trim() || '（空）'}\n${trimContextText(ctx.currentPrompt, 800)}`,
      )
    }
    userLines.push('请严格按 JSON 格式返回 `name` 与 `systemPrompt`。')

    return { system, user: userLines.join('\n\n') }
  }

  const system = [
    '你是飞书群聊主动监听规则配置专家，负责把用户的简短描述转化为高质量、低误报、可直接落地的「监听判断指令」与配套过滤/回复策略。',
    '',
    '## 编写准则',
    '1. 全部使用自然、直接、克制的简体中文，避免空泛开场白；',
    '2. `prompt`（判断指令）直接从判断规则写起，结构紧凑（150–400 字）：',
    '   - 首句说明适用场景，并明确「无需回复时仅输出 `<no_reply/>`（或空文本）」；',
    '   - 明确列出「需要回复的触发条件」与「应静默忽略的排除场景」；',
    '   - 明确命中后的处理步骤或回复结构（例如先查代码/日志、给出论据与下一步建议）；',
    '   - 注意：上下文中的「执行本规则的智能体」是监听方自己，切勿将其误写成被监听的外部机器人或告警源；',
    '3. 根据用户场景一并推荐合理的配置参数：',
    '   - `scope`: `"top_level"`（仅群内新消息，默认推荐）或 `"all"`（包含话题回复）',
    '   - `mentionFilter`: `"all"`（监听全部） / `"exclude_peer"`（跳过 @ 他人，保留 @ 所有人） / `"exclude_all"`（跳过所有 @）',
    '   - `replyMode`: `"new-topic"`（话题内回复，适合深度讨论/告警排查） / `"reply"`（引用回复） / `"chat"`（直接发送，适合轻互动）',
    '   - `sessionMode`: `"per_message"`（每次新建，适合单次提醒/轻判断） / `"thread"`（按话题复用，适合多轮跟进） / `"chat"`（全群共享）',
    '   - `autoCloseAfterCompletion`: 布尔值（一次性回复后关闭为 `true`，需话题内持续追问为 `false`）',
    '   - `msgTypes`: 从 `["text","post","interactive","image","merge_forward"]` 中选择（告警卡片/工单通知务必包含 `"interactive"`）',
    '   - `senderTypes`: 从 `["user","bot"]` 中选择（监控告警机器人/CI 通知务必包含 `"bot"`）',
    '   - `includeKeywords` / `excludeKeywords`: 仅在用户明确提到特定关键词时填写，否则返回空数组 `[]`',
    '4. 若你正处于带工具的 Agent 运行时环境，**禁止调用任何工具、禁止读写文件或执行命令**，直接输出最终 JSON。',
    '',
    '## 输出格式（严格要求）',
    '只输出一个合法 JSON 对象，不要包含任何额外的解释性文字：',
    JSON.stringify({
      name: '简短场景名（2-10字）',
      prompt: '完整的监听判断指令',
      scope: 'top_level',
      mentionFilter: 'exclude_peer',
      replyMode: 'new-topic',
      sessionMode: 'thread',
      autoCloseAfterCompletion: false,
      msgTypes: ['text', 'post', 'interactive'],
      senderTypes: ['user'],
      includeKeywords: [],
      excludeKeywords: [],
    }),
  ].join('\n')

  const userLines: string[] = [`用户监听场景描述：\n${description}`]
  if (ctx.botName?.trim()) userLines.push(`执行本规则的智能体（监听方自身）：${ctx.botName.trim()}`)
  if (ctx.chatName?.trim()) userLines.push(`目标群聊：${ctx.chatName.trim()}`)
  if (ctx.currentPrompt?.trim()) {
    userLines.push(
      `当前已有判断指令草稿（如用户希望在其基础上优化可参考，否则以最新描述为准）：\n${trimContextText(ctx.currentPrompt, 800)}`,
    )
  }
  userLines.push('请严格按 JSON 格式返回完整结果。')

  return { system, user: userLines.join('\n\n') }
}

function extractFirstJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const candidates: string[] = [trimmed]
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fencedRegex.exec(trimmed)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try next candidate.
    }
  }
  return undefined
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return (match?.[1] ?? trimmed).trim()
}

function normalizeStringArray(raw: unknown, maxItems = 20): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = item.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
    if (out.length >= maxItems) break
  }
  return out
}

export function parseGeneratedRoleOutput(rawText: string): GeneratedRoleDraft {
  const obj = extractFirstJsonObject(rawText)
  if (obj) {
    const rawPrompt =
      typeof obj.systemPrompt === 'string'
        ? obj.systemPrompt.trim()
        : typeof obj.prompt === 'string'
          ? obj.prompt.trim()
          : ''
    const rawName =
      typeof obj.name === 'string'
        ? obj.name.trim()
        : typeof obj.roleName === 'string'
          ? obj.roleName.trim()
          : ''
    if (rawPrompt) {
      return {
        name: rawName.slice(0, 40),
        systemPrompt: rawPrompt,
      }
    }
  }

  const fallbackText = stripCodeFences(rawText)
  if (!fallbackText) {
    throw new Error('模型未返回有效的角色设定内容，请重试或补充更具体的描述')
  }
  return {
    name: '',
    systemPrompt: fallbackText,
  }
}

export function parseGeneratedListenerOutput(rawText: string): GeneratedListenerDraft {
  const obj = extractFirstJsonObject(rawText)
  if (obj) {
    const prompt =
      typeof obj.prompt === 'string'
        ? obj.prompt.trim()
        : typeof obj.instruction === 'string'
          ? obj.instruction.trim()
          : ''
    if (prompt) {
      const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 32) : ''
      const scope = obj.scope === 'top_level' || obj.scope === 'all' ? obj.scope : undefined
      const mentionParsed = ListenerMentionFilterSchema.safeParse(obj.mentionFilter)
      const replyParsed = GroupReplyModeSchema.safeParse(obj.replyMode)
      const sessionParsed = GroupSessionModeSchema.safeParse(obj.sessionMode)
      const autoClose =
        typeof obj.autoCloseAfterCompletion === 'boolean'
          ? obj.autoCloseAfterCompletion
          : undefined

      const msgTypes = Array.isArray(obj.msgTypes)
        ? Array.from(
            new Set(
              obj.msgTypes
                .map((v) => ListenerMsgTypeSchema.safeParse(v))
                .filter((r): r is { success: true; data: ListenerMsgType } => r.success)
                .map((r) => r.data),
            ),
          )
        : undefined
      const senderTypes = Array.isArray(obj.senderTypes)
        ? Array.from(
            new Set(
              obj.senderTypes
                .map((v) => ListenerSenderTypeSchema.safeParse(v))
                .filter((r): r is { success: true; data: ListenerSenderType } => r.success)
                .map((r) => r.data),
            ),
          )
        : undefined
      const includeKeywords = normalizeStringArray(obj.includeKeywords)
      const excludeKeywords = normalizeStringArray(obj.excludeKeywords)

      return {
        name,
        prompt,
        ...(scope ? { scope } : {}),
        ...(mentionParsed.success ? { mentionFilter: mentionParsed.data } : {}),
        ...(replyParsed.success ? { replyMode: replyParsed.data } : {}),
        ...(sessionParsed.success ? { sessionMode: sessionParsed.data } : {}),
        ...(autoClose !== undefined ? { autoCloseAfterCompletion: autoClose } : {}),
        ...(msgTypes && msgTypes.length > 0 ? { msgTypes } : {}),
        ...(senderTypes && senderTypes.length > 0 ? { senderTypes } : {}),
        ...(includeKeywords ? { includeKeywords } : {}),
        ...(excludeKeywords ? { excludeKeywords } : {}),
      }
    }
  }

  const fallbackText = stripCodeFences(rawText)
  if (!fallbackText) {
    throw new Error('模型未返回有效的监听判断指令，请重试或补充更具体的描述')
  }
  return {
    name: '',
    prompt: fallbackText,
  }
}
