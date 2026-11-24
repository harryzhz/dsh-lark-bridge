import type { LarkMention, ParsedSlashCommand } from './types.js'

const SLASH_COMMANDS = new Set([
  'new',
  'close',
  'cancel',
  'status',
  'model',
  'agent',
  'help',
])

export interface ParsedLarkContent {
  readonly text: string
  readonly imageKeys: readonly string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function collectPostText(node: unknown, texts: string[], imageKeys: string[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) collectPostText(item, texts, imageKeys)
    return
  }
  const rec = asRecord(node)
  if (!rec) return
  if (typeof rec.title === 'string' && rec.title.trim()) {
    texts.push(rec.title.trim())
  }
  if (
    (rec.tag === 'text' || rec.tag === 'md' || rec.tag === 'code_block') &&
    typeof rec.text === 'string'
  ) {
    texts.push(rec.text)
    return
  }
  if (rec.tag === 'a' && typeof rec.text === 'string') {
    const href = typeof rec.href === 'string' ? ` (${rec.href})` : ''
    texts.push(`${rec.text}${href}`)
    return
  }
  if (rec.tag === 'at') {
    const userName = typeof rec.user_name === 'string' ? rec.user_name.trim() : ''
    const userId = typeof rec.user_id === 'string' ? rec.user_id.trim() : ''
    if (userName) {
      texts.push(`@${userName}`)
    } else if (userId.startsWith('@_user_')) {
      texts.push(userId)
    }
    return
  }
  if (rec.tag === 'img' && typeof rec.image_key === 'string') {
    imageKeys.push(rec.image_key)
    return
  }
  if (Array.isArray(rec.content)) {
    for (const row of rec.content) {
      const lineParts: string[] = []
      collectPostText(row, lineParts, imageKeys)
      if (lineParts.length > 0) texts.push(lineParts.join(''))
    }
    return
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      collectPostText(val, texts, imageKeys)
    }
  }
}

function collectInteractiveText(node: unknown, texts: string[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) collectInteractiveText(item, texts)
    return
  }
  const rec = asRecord(node)
  if (!rec) return
  if (typeof rec.title === 'string' && rec.title.trim()) texts.push(rec.title.trim())
  if (typeof rec.text === 'string' && rec.text.trim()) texts.push(rec.text.trim())
  if (typeof rec.content === 'string' && rec.content.trim()) texts.push(rec.content.trim())
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'title' || k === 'text' || k === 'content') continue
    if (v && typeof v === 'object') collectInteractiveText(v, texts)
  }
}

export function parseLarkMessageContent(msgType: string, rawContent: string): ParsedLarkContent {
  if (msgType === 'sticker') {
    return { text: '[表情包]', imageKeys: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return { text: rawContent.trim(), imageKeys: [] }
  }

  const rec = asRecord(parsed)
  if (!rec) return { text: rawContent.trim(), imageKeys: [] }

  if (msgType === 'text') {
    return { text: typeof rec.text === 'string' ? rec.text : '', imageKeys: [] }
  }
  if (msgType === 'image') {
    const key = typeof rec.image_key === 'string' ? rec.image_key : ''
    return { text: '', imageKeys: key ? [key] : [] }
  }
  if (msgType === 'post') {
    const texts: string[] = []
    const imageKeys: string[] = []
    collectPostText(rec, texts, imageKeys)
    return { text: texts.join('\n').trim(), imageKeys }
  }
  if (msgType === 'interactive') {
    const texts: string[] = []
    collectInteractiveText(rec, texts)
    return { text: texts.join('\n').trim(), imageKeys: [] }
  }
  return { text: typeof rec.text === 'string' ? rec.text : rawContent.trim(), imageKeys: [] }
}

export function stripBotMentions(
  text: string,
  mentions: readonly LarkMention[],
  botOpenId?: string,
): string {
  let result = text
  if (botOpenId) {
    const escapedId = botOpenId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(
      new RegExp(`<at\\s+(?:user_id|id)\\s*=\\s*["']?${escapedId}["']?[^>]*>[\\s\\S]*?<\\/at>`, 'gi'),
      ' ',
    )
  }
  for (const mention of mentions) {
    if (!botOpenId || mention.openId === botOpenId) {
      if (mention.key) {
        result = result.split(mention.key).join(' ')
      }
      if (mention.name) {
        result = result.split(`@${mention.name}`).join(' ')
      }
      if (!botOpenId && mention.openId) {
        const escapedId = mention.openId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        result = result.replace(
          new RegExp(`<at\\s+(?:user_id|id)\\s*=\\s*["']?${escapedId}["']?[^>]*>[\\s\\S]*?<\\/at>`, 'gi'),
          ' ',
        )
      }
    }
  }
  return result.replace(/\s+/g, ' ').trim()
}

export function replaceMentionKeysWithNames(
  text: string,
  mentions: readonly LarkMention[],
): string {
  let result = text
  for (const mention of mentions) {
    if (mention.key && mention.name) {
      result = result.split(mention.key).join(`@${mention.name}`)
    }
  }
  return result.trim()
}

export function parseSlashCommand(cleanText: string): ParsedSlashCommand | undefined {
  const trimmed = cleanText.trim()
  if (!trimmed.startsWith('/')) return undefined
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return undefined
  const rawName = match[1]?.toLowerCase() ?? ''
  if (!SLASH_COMMANDS.has(rawName)) return undefined
  return {
    name: rawName as ParsedSlashCommand['name'],
    args: (match[2] ?? '').trim(),
  }
}

/**
 * Extracts pure human message intent from a prompt that may contain
 * `<system_reminder>...</system_reminder>` and `<user_message>...</user_message>`
 * blocks (plus legacy XML wrappers from historical sessions), preventing
 * auto-generated session titles from being polluted by injected instructions.
 */
export function extractPureUserIntent(rawPrompt: string): string {
  if (!rawPrompt) return ''

  const userMatch = /<user_message>([\s\S]*?)<\/user_message>/i.exec(rawPrompt)
  const candidate = userMatch?.[1]
    ? userMatch[1]
    : rawPrompt
        .replace(/<system_reminder\b[^>]*>[\s\S]*?<\/system_reminder>/gi, ' ')
        .replace(/<role_definition\b[^>]*>[\s\S]*?<\/role_definition>/gi, ' ')
        .replace(/<summary_memory\b[^>]*>[\s\S]*?<\/summary_memory>/gi, ' ')
        .replace(/<[a-z0-9_]+_(?:listener|substitute)\b[^>]*>[\s\S]*?<\/[a-z0-9_]+_(?:listener|substitute)>/gi, ' ')
        .replace(/<\/?[a-z0-9_]+_message\b[^>]*>/gi, ' ')

  return candidate
    .replace(/@_user_\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hasInjectedPromptMarkup(title: string): boolean {
  const t = title.trim()
  return /^<(?:system_reminder|user_message|role|proactive|lark_context|substitute|listener|schedule|reminder_trigger|dream_job|role_definition|summary_memory|[a-z0-9_]+_(?:listener|substitute|message))\b/i.test(t)
}
