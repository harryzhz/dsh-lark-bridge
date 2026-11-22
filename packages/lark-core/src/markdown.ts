const LEADING_PUNCT_RE = /^[“‘「『（【《〈〔〖(\[{"']/
const TRAILING_PUNCT_RE = /[”’」』）】》〉〕〗)\]}"'。，、！？；：.,!?;:]$/
const NON_SPACE_NON_PUNCT_BEFORE_RE = /[\p{L}\p{N}]$/u
const NON_SPACE_NON_PUNCT_AFTER_RE = /^[\p{L}\p{N}]/u

export interface LarkPostPayloadOptions {
  readonly title?: string
}

function normalizeLineEndings(raw: string): string {
  return raw.replace(/\r\n?/g, '\n')
}

function normalizeAtMentions(text: string, target: 'post' | 'card'): string {
  const attrName = target === 'post' ? 'user_id' : 'id'
  return text.replace(
    /<at\s+(?:user_id|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>([\s\S]*?)<\/at>/gi,
    (_m, dq?: string, sq?: string, bare?: string, inner?: string) => {
      const id = (dq ?? sq ?? bare ?? '').trim()
      if (!id) return _m
      const label = inner ?? ''
      return `<at ${attrName}="${id}">${label}</at>`
    },
  )
}

function repairPairedDelimiterOnLine(line: string, delimiter: '**' | '~~'): string {
  const parts = line.split(delimiter)
  if (parts.length < 3) return line

  const pairCount = Math.floor((parts.length - 1) / 2)
  let out = parts[0] ?? ''

  for (let i = 0; i < pairCount; i += 1) {
    const rawInner = parts[i * 2 + 1] ?? ''
    const after = parts[i * 2 + 2] ?? ''
    const leadingMatch = /^[ \t]+/.exec(rawInner)
    const trailingMatch = /[ \t]+$/.exec(rawInner)
    const core = rawInner.trim()

    if (!core) {
      out += `${delimiter}${rawInner}${delimiter}${after}`
      continue
    }

    if (leadingMatch && out.length > 0 && !/\s$/.test(out)) {
      out += ' '
    }
    if (delimiter === '**' && LEADING_PUNCT_RE.test(core) && NON_SPACE_NON_PUNCT_BEFORE_RE.test(out)) {
      out += ' '
    }

    out += `${delimiter}${core}${delimiter}`

    let nextAfter = after
    if (trailingMatch && nextAfter.length > 0 && !/^\s/.test(nextAfter)) {
      nextAfter = ` ${nextAfter}`
    } else if (
      delimiter === '**' &&
      TRAILING_PUNCT_RE.test(core) &&
      NON_SPACE_NON_PUNCT_AFTER_RE.test(nextAfter)
    ) {
      nextAfter = ` ${nextAfter}`
    }
    out += nextAfter
  }

  if ((parts.length - 1) % 2 === 1) {
    out += `${delimiter}${parts[parts.length - 1] ?? ''}`
  }
  return out
}

function formatPlainInlineChunk(chunk: string, target: 'post' | 'card'): string {
  if (!chunk) return ''
  let text = chunk.replace(/<(https?:\/\/[^\s<>]+)>/g, '[$1]($1)')
  text = normalizeAtMentions(text, target)
  text = text.replace(/(^|[^\p{L}\p{N}_])__([^\s_](?:[^\n]*?[^\s_])?)__(?=$|[^\p{L}\p{N}_])/gu, '$1**$2**')
  text = repairPairedDelimiterOnLine(text, '**')
  text = repairPairedDelimiterOnLine(text, '~~')
  return text
}

function formatNonCodeLineInline(line: string, target: 'post' | 'card'): string {
  const tokenRe =
    /(`+[^`]*`+|!?\[[^\]]*\]\([^)\n]+\)|<(?:at|link|font|person|text_tag|number_tag|local_datetime)\b[^>]*>[\s\S]*?<\/(?:at|link|font|person|text_tag|number_tag|local_datetime)>|<(?:at|person|hr|br)\b[^>]*\/?>|https?:\/\/[^\s<>()]+)/gi

  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > cursor) {
      result += formatPlainInlineChunk(line.slice(cursor, match.index), target)
    }
    const token = match[0]
    if (token.startsWith('`')) {
      result += token
    } else if (/^!?\[/.test(token)) {
      const linkMatch = /^(!?\[)([^\]]*)(\]\([^)\n]+\))$/.exec(token)
      result += linkMatch
        ? `${linkMatch[1]}${formatPlainInlineChunk(linkMatch[2]!, target)}${linkMatch[3]}`
        : token
    } else if (/^<at\b/i.test(token)) {
      result += normalizeAtMentions(token, target)
    } else {
      result += token
    }
    cursor = match.index + token.length
  }

  if (cursor < line.length) {
    result += formatPlainInlineChunk(line.slice(cursor), target)
  }
  return result
}

function normalizeListAndRuleLine(line: string): string {
  if (/^\s*(?:\*\s*\*\s*\*+|_\s*_\s*_+)\s*$/.test(line)) {
    return '---'
  }
  const listMatch = /^([ \t]*)([-*+]|\d+\.)([ \t]+)(.*)$/.exec(line)
  if (!listMatch) return line

  const rawIndent = (listMatch[1] ?? '').replace(/\t/g, '    ')
  const level = rawIndent.length === 0 ? 0 : Math.max(1, Math.ceil(rawIndent.length / 2))
  const normalizedIndent = rawIndent.length % 4 === 0 ? rawIndent : '    '.repeat(level)
  const rawMarker = listMatch[2]!
  const marker = /^\d+\.$/.test(rawMarker) ? rawMarker : '-'
  let rest = listMatch[4] ?? ''

  const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(rest)
  if (taskMatch) {
    const box = taskMatch[1]!.toLowerCase() === 'x' ? '☑' : '☐'
    rest = `${box} ${taskMatch[2]}`
  }

  return `${normalizedIndent}${marker} ${rest}`
}

function formatNonCodeBlock(block: string, target: 'post' | 'card'): string {
  const rawLines = block.split('\n')
  const hasTopLevelHeading = rawLines.some((l) => /^\s*#{1,3}(?:\s+\S|\S)/.test(l))
  const outLines: string[] = []
  let prevWasHeading = false

  for (const rawLine of rawLines) {
    const headingMatch = /^\s*(#{1,6})\s*([^\s#].*)$/.exec(rawLine)
    if (headingMatch) {
      const hashes = headingMatch[1]!
      const body = formatNonCodeLineInline(headingMatch[2]!.trim(), target)
      const normalizedHashes = hasTopLevelHeading
        ? hashes.length === 1
          ? '####'
          : '##### '
            .trim()
        : hashes
      if (prevWasHeading && outLines[outLines.length - 1] !== '') {
        outLines.push('')
      }
      outLines.push(`${normalizedHashes} ${body}`)
      prevWasHeading = true
      continue
    }

    prevWasHeading = false
    const listNormalized = normalizeListAndRuleLine(rawLine)
    outLines.push(formatNonCodeLineInline(listNormalized, target))
  }

  return outLines.join('\n')
}

function formatMarkdownForLark(markdown: string, target: 'post' | 'card'): string {
  const normalized = normalizeLineEndings(markdown).trim()
  if (!normalized) return ''

  const lines = normalized.split('\n')
  const segments: Array<{ readonly isCode: boolean; readonly text: string }> = []
  let buffer: string[] = []
  let fenceMarker: string | null = null

  for (const line of lines) {
    if (!fenceMarker) {
      const openFence = /^\s*(`{3,}|~{3,})/.exec(line)
      if (openFence) {
        if (buffer.length > 0) {
          segments.push({ isCode: false, text: buffer.join('\n') })
          buffer = []
        }
        fenceMarker = openFence[1]!
        buffer.push(line)
        continue
      }
      buffer.push(line)
    } else {
      buffer.push(line)
      const closeRe = new RegExp(`^\\s*${fenceMarker[0]}{${fenceMarker.length},}\\s*$`)
      if (closeRe.test(line)) {
        segments.push({ isCode: true, text: buffer.join('\n') })
        buffer = []
        fenceMarker = null
      }
    }
  }

  if (buffer.length > 0) {
    segments.push({ isCode: fenceMarker !== null, text: buffer.join('\n') })
  }

  const formatted = segments
    .map((seg) => (seg.isCode ? seg.text : formatNonCodeBlock(seg.text, target)))
    .join('\n')

  return formatted.replace(/\n{3,}/g, '\n\n').trim()
}

export function formatMarkdownForLarkPost(markdown: string): string {
  return formatMarkdownForLark(markdown, 'post')
}

export function formatMarkdownForLarkCard(markdown: string): string {
  return formatMarkdownForLark(markdown, 'card')
}

export function buildLarkPostPayload(
  markdown: string,
  options: LarkPostPayloadOptions = {},
): Record<string, unknown> {
  const formatted = formatMarkdownForLarkPost(markdown)
  const title = options.title?.trim()
  return {
    zh_cn: {
      ...(title ? { title } : {}),
      content: [[{ tag: 'md', text: formatted || markdown.trim() || ' ' }]],
    },
  }
}
