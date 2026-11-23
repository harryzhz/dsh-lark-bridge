export interface LarkSdkErrorRecord {
  readonly code: string
  readonly count: number
  readonly lastAtMs: number
  readonly hint?: string
}

const KNOWN_ERROR_HINTS: Readonly<Record<string, string>> = {
  '41050':
    '通讯录权限范围不足（41050）：请在飞书开发者后台检查「通讯录权限范围」是否包含对应成员，或忽略非授权外部成员查询。',
  '99992402':
    '缺少应用自管理/字段权限（99992402）：如需自动同步应用简介，请开通 `application:application:self_manage` 权限。',
  '230002':
    '机器人不在目标群聊中（230002）：请确认机器人已被邀请进该群且未被移出。',
  '230006':
    '目标消息不存在或已撤回（230006）：无法对该消息执行引用回复或表情回应。',
  '99991663':
    '租户凭证无效或已过期（99991663）：请检查 App ID / App Secret 是否正确及应用是否已发布。',
  '99991664':
    '应用凭证校验失败（99991664）：请核对飞书应用的 App ID 与 App Secret 配置。',
  '99991668':
    '用户授权令牌无效或已过期（99991668）：请在控制台重新完成飞书扫码授权。',
  '11232':
    '飞书接口触发限流（11232）：请降低短时间内的并发推送频率。',
  '99991400':
    '飞书接口调用频次超限（99991400）：稍后自动重试或降低轮询频率。',
}

export function explainLarkErrorCode(code: string | number | undefined): string | undefined {
  if (code === undefined || code === null) return undefined
  const key = String(code).trim()
  return KNOWN_ERROR_HINTS[key]
}

const REDACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]'],
  [/"?(?:app_secret|larkAppSecret|client_secret|tenant_access_token|user_access_token|refresh_token|access_token)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '[REDACTED_SECRET]'],
  [/\b(?:t|u)-[A-Za-z0-9._-]{20,}\b/g, '[REDACTED_TOKEN]'],
]

function sanitizeText(input: string): string {
  let out = input
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out.length > 400 ? `${out.slice(0, 400)}…` : out
}

function extractErrorMeta(arg: unknown): { readonly code?: string; readonly summary?: string } {
  if (!arg || typeof arg !== 'object') return {}
  const rec = arg as Record<string, unknown>
  const response = rec.response && typeof rec.response === 'object' ? (rec.response as Record<string, unknown>) : undefined
  const respData = response?.data && typeof response.data === 'object' ? (response.data as Record<string, unknown>) : undefined
  const data = rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : undefined

  const rawCode = respData?.code ?? data?.code ?? rec.code
  const rawMsg = respData?.msg ?? data?.msg ?? rec.msg ?? rec.message
  const code =
    typeof rawCode === 'number' || (typeof rawCode === 'string' && /^\d{4,10}$/.test(rawCode.trim()))
      ? String(rawCode).trim()
      : undefined
  const summary = typeof rawMsg === 'string' && rawMsg.trim() ? rawMsg.trim() : undefined
  return {
    ...(code ? { code } : {}),
    ...(summary ? { summary } : {}),
  }
}

export function formatSdkLogArgs(args: readonly unknown[]): {
  readonly text: string
  readonly code?: string
} {
  const parts: string[] = []
  let detectedCode: string | undefined

  for (const item of args) {
    if (item === undefined || item === null) continue
    if (typeof item === 'string') {
      const codeMatch = /\bcode["':=\s]+(\d{4,10})\b/i.exec(item)
      if (!detectedCode && codeMatch?.[1]) detectedCode = codeMatch[1]
      parts.push(sanitizeText(item))
      continue
    }
    if (item instanceof Error) {
      const meta = extractErrorMeta(item)
      if (!detectedCode && meta.code) detectedCode = meta.code
      parts.push(sanitizeText(meta.summary ? `${item.message} (${meta.summary})` : item.message))
      continue
    }
    if (typeof item === 'object') {
      const meta = extractErrorMeta(item)
      if (!detectedCode && meta.code) detectedCode = meta.code
      if (meta.code || meta.summary) {
        parts.push(
          sanitizeText(
            `${meta.code ? `code=${meta.code} ` : ''}${meta.summary ?? ''}`.trim(),
          ),
        )
      } else {
        try {
          parts.push(sanitizeText(JSON.stringify(item)))
        } catch {
          parts.push('[Object]')
        }
      }
      continue
    }
    parts.push(String(item))
  }

  return {
    text: parts.filter(Boolean).join(' '),
    ...(detectedCode ? { code: detectedCode } : {}),
  }
}

export interface LarkSdkLoggerAdapter {
  error: (...msg: unknown[]) => void
  warn: (...msg: unknown[]) => void
  info: (...msg: unknown[]) => void
  debug: (...msg: unknown[]) => void
  trace: (...msg: unknown[]) => void
}

export function createLarkSdkLogger(options: {
  readonly botId: string
  readonly botName: string
  readonly emit: (level: 'info' | 'warn' | 'error', message: string) => void
  readonly onErrorCode?: (code: string, hint?: string) => void
}): LarkSdkLoggerAdapter {
  const handle = (level: 'info' | 'warn' | 'error', args: unknown[]) => {
    const formatted = formatSdkLogArgs(args)
    if (!formatted.text) return
    const hint = explainLarkErrorCode(formatted.code)
    if (formatted.code) {
      options.onErrorCode?.(formatted.code, hint)
    }
    // Suppress noisy optional-scope probe errors (e.g. 41050 / 99992402) from flooding error logs;
    // downgrade to warn with actionable Chinese hint instead.
    const effectiveLevel =
      level === 'error' && (formatted.code === '41050' || formatted.code === '99992402')
        ? 'warn'
        : level
    const prefix = `[sdk][bot=${options.botId}]`
    const suffix = hint ? ` | 排障建议: ${hint}` : ''
    options.emit(effectiveLevel, `${prefix} ${formatted.text}${suffix}`)
  }

  return {
    error: (...args) => handle('error', args),
    warn: (...args) => handle('warn', args),
    info: (...args) => {
      // Only surface meaningful connection lifecycle info from SDK, skip noisy debug noise.
      const formatted = formatSdkLogArgs(args)
      if (!formatted.text) return
      if (/connected|reconnect|ready|ws/i.test(formatted.text)) {
        options.emit('info', `[sdk][bot=${options.botId}] ${formatted.text}`)
      }
    },
    debug: () => {},
    trace: () => {},
  }
}
