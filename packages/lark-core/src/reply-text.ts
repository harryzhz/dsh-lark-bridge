export const SILENT_REPLY_SENTINEL = '<no_reply/>'

/**
 * Invisible / zero-width / format characters that JS `String.prototype.trim()` does not strip,
 * yet render as completely blank messages in Feishu (e.g. `\u200b` emitted by some LLMs).
 */
const INVISIBLE_CHAR_CLASS =
  '\\s\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u2800\\u3164\\uFEFF\\uFFA0'

const LEADING_INVISIBLE_RE = new RegExp(`^[${INVISIBLE_CHAR_CLASS}]+`)
const TRAILING_INVISIBLE_RE = new RegExp(`[${INVISIBLE_CHAR_CLASS}]+$`)
const ALL_INVISIBLE_RE = new RegExp(`[${INVISIBLE_CHAR_CLASS}]+`, 'g')

/**
 * Matches explicit silent-skip sentinels (optionally wrapped in inline code backticks).
 */
const SILENT_SENTINEL_RE = /`?<(?:no_reply|no_reminder_needed)\s*\/>`?/gi

/**
 * Strips leading and trailing whitespace as well as invisible zero-width / filler characters.
 * Preserves interior invisible joiners (such as ZWJ inside compound emoji) when visible text exists.
 */
export function trimInvisibleText(raw: string): string {
  if (!raw) return ''
  const trimmed = raw.replace(LEADING_INVISIBLE_RE, '').replace(TRAILING_INVISIBLE_RE, '')
  if (!trimmed) return ''
  return hasVisibleText(trimmed) ? trimmed : ''
}

/**
 * Returns true if the text contains at least one visible character beyond whitespace and
 * zero-width / invisible formatting code points.
 */
export function hasVisibleText(raw: string): boolean {
  if (!raw) return false
  return raw.replace(ALL_INVISIBLE_RE, '').length > 0
}

/**
 * Returns true when the text consists solely of internal silent-skip sentinels
 * (`<no_reply/>` / `<no_reminder_needed/>`, optionally wrapped in inline code backticks)
 * plus optional whitespace or invisible characters.
 */
export function isSilentReplySentinel(raw: string): boolean {
  const trimmed = trimInvisibleText(raw)
  if (!trimmed) return false
  const withoutSentinels = trimmed.replace(SILENT_SENTINEL_RE, '')
  return !hasVisibleText(withoutSentinels)
}

export interface NormalizeReplyTextOptions {
  /**
   * When true, replies consisting solely of silent sentinels (`<no_reply/>` /
   * `<no_reminder_needed/>`) and invisible/whitespace characters normalize to `""`.
   */
  readonly allowSilentSentinel?: boolean
}

/**
 * Normalizes an agent reply for delivery or silent-skip evaluation.
 * Returns `""` when the reply has no visible content (or only silent sentinels when allowed).
 */
export function normalizeReplyText(
  raw: string,
  options: NormalizeReplyTextOptions = {},
): string {
  const trimmed = trimInvisibleText(raw)
  if (!trimmed) return ''
  if (options.allowSilentSentinel && isSilentReplySentinel(trimmed)) {
    return ''
  }
  return trimmed
}
