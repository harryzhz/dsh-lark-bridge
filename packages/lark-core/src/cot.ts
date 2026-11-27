export const COT_REQUEST_TIMEOUT_MS = 15_000
export const COT_MAX_EVENTS_PER_BATCH = 50
export const COT_TEXT_CHUNK_CHARS = 3_500
export const COT_MAX_TEXT_CHARS = 16_000
export const COT_TOOL_ARGS_MAX_CHARS = 600
export const COT_TOOL_RESULT_MAX_CHARS = 800
export const COT_TOOL_TITLE_SUBJECT_MAX_CHARS = 80
export const COT_SUBJECT_MAX_CHARS = 1_000

export interface CotEventPayload {
  readonly event_type: string
  readonly content: string
  readonly timestamp: number
}

export interface CreateCotMessageOptions {
  readonly chatId: string
  readonly originMessageId?: string
  readonly replyInThread?: boolean
}

export interface CreateCotMessageResult {
  readonly cotId: string
  readonly messageId: string
}

export interface CotPlacement {
  readonly originMessageId?: string
  readonly replyInThread?: boolean
}

export interface CotToolMeta {
  readonly icon: 'bash' | 'write' | 'read' | 'search' | 'task' | 'default'
  readonly label: string
}

export interface CotToolSubject {
  readonly display: string
  readonly full: string
}

const COT_SUBJECT_FIELDS = [
  'command',
  'cmd',
  'CommandLine',
  'file_path',
  'path',
  'Path',
  'TargetFile',
  'AbsolutePath',
  'pattern',
  'query',
  'Query',
  'url',
  'Url',
  'skill',
  'subject',
  'toolAction',
  'toolSummary',
  'description',
  'prompt',
  'Prompt',
] as const

const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/m

const COT_EXT_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  md: 'markdown',
}

export function truncateCotText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 1)}…`
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractSubjectFromObject(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const record = input as Record<string, unknown>
  for (const key of COT_SUBJECT_FIELDS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return collapseWhitespace(value)
    }
    if (Array.isArray(value) && value.length > 0) {
      const parts = value.map((item) => String(item ?? '').trim()).filter(Boolean)
      if (parts.length === 0) continue
      const isShellWrapper =
        parts.length >= 3 &&
        /(?:^|\/)(?:ba|z|da|k|fi)?sh$/i.test(parts[0]!) &&
        /^-[a-z]*c$/i.test(parts[1]!)
      return collapseWhitespace(isShellWrapper ? parts[parts.length - 1]! : parts.join(' '))
    }
  }
  return ''
}

function recoverSubjectFromTruncatedJson(raw: string): string {
  for (const key of COT_SUBJECT_FIELDS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw)
    if (!match?.[1]) continue
    try {
      const decoded = JSON.parse(`"${match[1]}"`) as unknown
      if (typeof decoded === 'string') {
        const clean = collapseWhitespace(decoded)
        if (clean) return clean
      }
    } catch {
      // Skip malformed escape sequences in truncated strings.
    }
  }
  return ''
}

/**
 * Extracts a compact one-line subject (command, file path, search query, etc.)
 * from tool arguments. The Feishu native CoT renderer ignores `TOOL_CALL_ARGS`,
 * so the subject must travel inside `TOOL_CALL_START.title`.
 */
export function extractCotToolSubject(rawArgs: unknown): CotToolSubject {
  let full = ''
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    if (trimmed.startsWith('{')) {
      try {
        full = extractSubjectFromObject(JSON.parse(trimmed))
      } catch {
        full = recoverSubjectFromTruncatedJson(trimmed)
      }
    } else if (trimmed.startsWith('*** Begin Patch')) {
      const m = APPLY_PATCH_FILE_RE.exec(trimmed)
      if (m?.[1]) full = collapseWhitespace(m[1])
    } else if (trimmed.length > 0 && trimmed !== '{}') {
      full = collapseWhitespace(trimmed)
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    full = extractSubjectFromObject(rawArgs)
  }

  if (!full) return { display: '', full: '' }
  const boundedFull = truncateCotText(full, COT_SUBJECT_MAX_CHARS)
  const display = truncateCotText(full, COT_TOOL_TITLE_SUBJECT_MAX_CHARS)
  return { display, full: boundedFull }
}

export function resolveCotToolMeta(toolName: string): CotToolMeta {
  const n = toolName.trim().toLowerCase()
  if (
    n.includes('bash') ||
    n.includes('shell') ||
    n.includes('command') ||
    /(^|[^a-z])exec([^a-z]|$)/.test(n)
  ) {
    return { icon: 'bash', label: '执行命令' }
  }
  if (
    n.includes('write') ||
    n.includes('edit') ||
    n.includes('patch') ||
    n.includes('replace')
  ) {
    return { icon: 'write', label: '编辑文件' }
  }
  if (
    n.includes('read') ||
    n.includes('view_file') ||
    n.includes('notebook') ||
    n.includes('list_dir') ||
    n.includes('find_by_name')
  ) {
    return { icon: 'read', label: '读取文件' }
  }
  if (
    n.includes('grep') ||
    n.includes('glob') ||
    n.includes('search') ||
    n.includes('fetch') ||
    n.includes('web')
  ) {
    return { icon: 'search', label: '检索信息' }
  }
  if (
    n.includes('task') ||
    n.includes('todo') ||
    n.includes('plan') ||
    n.includes('subagent')
  ) {
    return { icon: 'task', label: '执行任务' }
  }
  return { icon: 'default', label: toolName.trim() || '调用工具' }
}

export function formatCotToolTitle(toolName: string, subjectDisplay: string): string {
  const meta = resolveCotToolMeta(toolName)
  return subjectDisplay ? `${meta.label} · ${subjectDisplay}` : meta.label
}

export function resolveCotResultLanguage(
  toolName: string | undefined,
  fullSubject: string | undefined,
): string | undefined {
  if (!toolName) return undefined
  const n = toolName.toLowerCase()
  if (
    n.includes('bash') ||
    n.includes('shell') ||
    n.includes('command') ||
    /(^|[^a-z])exec([^a-z]|$)/.test(n)
  ) {
    return 'bash'
  }
  if (n.includes('fetch') || n.includes('search') || n.includes('grep') || n.includes('glob')) {
    return undefined
  }
  const cleanSubject = fullSubject?.replace(/…$/, '').trim()
  const ext = cleanSubject?.match(/\.([A-Za-z0-9]+)\s*$/)?.[1]?.toLowerCase()
  return ext ? COT_EXT_LANGUAGES[ext] : undefined
}

export function createCotEvent(
  eventType: string,
  content: Record<string, unknown>,
  timestamp = Date.now(),
): CotEventPayload {
  return {
    event_type: eventType,
    content: JSON.stringify(content),
    timestamp,
  }
}

export function splitCotTextChunks(
  text: string,
  chunkChars = COT_TEXT_CHUNK_CHARS,
  maxTotalChars = COT_MAX_TEXT_CHARS,
): string[] {
  const bounded = truncateCotText(text, maxTotalChars)
  if (!bounded) return []
  const chunks: string[] = []
  for (let i = 0; i < bounded.length; i += chunkChars) {
    chunks.push(bounded.slice(i, i + chunkChars))
  }
  return chunks
}

export function buildCotPrologueEvents(
  threadId: string,
  runId: string,
  firstReasoningId: string,
  timestamp = Date.now(),
): CotEventPayload[] {
  return [
    createCotEvent('RUN_STARTED', { threadId, runId }, timestamp),
    createCotEvent('REASONING_START', { messageId: firstReasoningId }, timestamp),
  ]
}

export function buildCotReasoningMessageEvents(
  messageId: string,
  text: string,
  timestamp = Date.now(),
): CotEventPayload[] {
  const chunks = splitCotTextChunks(text)
  if (chunks.length === 0) return []
  return [
    createCotEvent('REASONING_MESSAGE_START', { messageId, role: 'reasoning' }, timestamp),
    ...chunks.map((delta) =>
      createCotEvent('REASONING_MESSAGE_CONTENT', { messageId, delta }, timestamp),
    ),
    createCotEvent('REASONING_MESSAGE_END', { messageId }, timestamp),
  ]
}

export function buildCotToolCallEvents(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: string
  readonly parentMessageId?: string
  readonly timestamp?: number
}): { readonly events: CotEventPayload[]; readonly resultLanguage?: string } {
  const ts = input.timestamp ?? Date.now()
  const meta = resolveCotToolMeta(input.toolName)
  const subject = extractCotToolSubject(input.args)
  const boundedArgs = truncateCotText(input.args, COT_TOOL_ARGS_MAX_CHARS)
  const resultLanguage = resolveCotResultLanguage(input.toolName, subject.full)

  const events: CotEventPayload[] = [
    createCotEvent(
      'TOOL_CALL_START',
      {
        toolCallId: input.toolCallId,
        icon: meta.icon,
        title: formatCotToolTitle(input.toolName, subject.display),
        toolCallName: input.toolName,
        ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      },
      ts,
    ),
  ]
  if (boundedArgs.length > 0 && boundedArgs !== '{}') {
    events.push(
      createCotEvent(
        'TOOL_CALL_ARGS',
        { toolCallId: input.toolCallId, delta: boundedArgs },
        ts,
      ),
    )
  }
  events.push(createCotEvent('TOOL_CALL_END', { toolCallId: input.toolCallId }, ts))

  return {
    events,
    ...(resultLanguage ? { resultLanguage } : {}),
  }
}

export function buildCotToolResultEvents(input: {
  readonly toolCallId: string
  readonly result: string
  readonly includeResult: boolean
  readonly isError?: boolean
  readonly language?: string
  readonly timestamp?: number
}): CotEventPayload[] {
  const ts = input.timestamp ?? Date.now()
  const trimmed = input.result.trim()
  const omitResult = !input.includeResult || trimmed.length === 0
  const payload = omitResult
    ? { type: 'text', text: input.isError ? '执行失败' : '已完成' }
    : {
        type: 'code',
        ...(input.language ? { language: input.language } : {}),
        code: truncateCotText(trimmed, COT_TOOL_RESULT_MAX_CHARS),
      }
  return [
    createCotEvent(
      'TOOL_CALL_RESULT',
      {
        messageId: `tr-${input.toolCallId}`,
        toolCallId: input.toolCallId,
        role: 'tool',
        content: JSON.stringify(payload),
      },
      ts,
    ),
  ]
}

export function buildCotFinishEvents(input: {
  readonly threadId: string
  readonly runId: string
  readonly lastReasoningId: string
  readonly status: 'done' | 'interrupted'
  readonly interruptedNotice?: string
  readonly timestamp?: number
}): CotEventPayload[] {
  const ts = input.timestamp ?? Date.now()
  const events: CotEventPayload[] = []
  if (input.status === 'interrupted' && input.interruptedNotice) {
    events.push(
      ...buildCotReasoningMessageEvents(
        `reasoning-interrupted-${input.lastReasoningId}`,
        input.interruptedNotice,
        ts,
      ),
    )
  }
  events.push(createCotEvent('REASONING_END', { messageId: input.lastReasoningId }, ts))
  if (input.status === 'done') {
    events.push(
      createCotEvent(
        'RUN_FINISHED',
        { threadId: input.threadId, runId: input.runId, status: 'done' },
        ts,
      ),
    )
  }
  return events
}

/**
 * Determines where to anchor a Feishu native CoT bubble so it lands in the exact
 * same thread or quote context as the turn's reply without spawning unexpected topics.
 */
export function resolveCotPlacement(input: {
  readonly chatType: string
  readonly replyMode: 'new-topic' | 'reply' | 'chat'
  readonly messageId: string
  readonly rootId?: string
  readonly threadId?: string
}): CotPlacement {
  if (input.chatType !== 'group') {
    return {}
  }
  if (input.threadId) {
    const anchor = input.rootId || input.messageId
    return anchor.startsWith('om_')
      ? { originMessageId: anchor, replyInThread: true }
      : {}
  }
  if (input.replyMode === 'new-topic') {
    return input.messageId.startsWith('om_')
      ? { originMessageId: input.messageId, replyInThread: true }
      : {}
  }
  if (input.replyMode === 'reply') {
    return input.messageId.startsWith('om_')
      ? { originMessageId: input.messageId }
      : {}
  }
  return {}
}

export function isCotAlreadyTerminalResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const rec = response as { code?: unknown; msg?: unknown }
  return (
    typeof rec.code === 'number' &&
    rec.code !== 0 &&
    typeof rec.msg === 'string' &&
    /^COT already in terminal state\.?$/i.test(rec.msg.trim())
  )
}
