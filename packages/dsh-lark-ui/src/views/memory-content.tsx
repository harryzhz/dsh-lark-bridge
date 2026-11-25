import { Fragment, type ReactNode } from 'react'

type ContentBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }

function renderInlineSpans(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={`c-${key++}`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>)
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

function parseContentBlocks(content: string): ContentBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ContentBlock[] = []
  let paraLines: string[] = []
  let listItems: string[] = []
  let listOrdered = false

  const flushParagraph = () => {
    if (paraLines.length === 0) return
    blocks.push({ kind: 'paragraph', text: paraLines.join('\n') })
    paraLines = []
  }
  const flushList = () => {
    if (listItems.length === 0) return
    blocks.push({ kind: 'list', ordered: listOrdered, items: listItems })
    listItems = []
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      flushParagraph()
      flushList()
      continue
    }
    const unorderedMatch = /^[-*•]\s+(.+)$/.exec(trimmed)
    const orderedMatch = /^\d+\.\s+(.+)$/.exec(trimmed)
    if (unorderedMatch || orderedMatch) {
      flushParagraph()
      const ordered = Boolean(orderedMatch)
      if (listItems.length > 0 && listOrdered !== ordered) {
        flushList()
      }
      listOrdered = ordered
      listItems.push((unorderedMatch?.[1] ?? orderedMatch?.[1] ?? '').trim())
      continue
    }
    flushList()
    paraLines.push(trimmed)
  }

  flushParagraph()
  flushList()
  return blocks
}

/**
 * Pure React block renderer for memory prose (paragraphs, bullet/numbered lists, inline `code` and **bold**).
 * Uses React elements exclusively with zero raw HTML injection.
 */
export function MemoryContentBlocks({ content }: { readonly content: string }) {
  const blocks = parseContentBlocks(content)
  if (blocks.length === 0) return null

  return (
    <div className="fb-mem-paper-body">
      {blocks.map((block, idx) => {
        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={`list-${idx}`}>
              {block.items.map((item, itemIdx) => (
                <li key={`li-${itemIdx}`}>{renderInlineSpans(item)}</li>
              ))}
            </ListTag>
          )
        }
        const segments = block.text.split('\n')
        return (
          <p key={`p-${idx}`}>
            {segments.map((line, lineIdx) => (
              <Fragment key={`l-${lineIdx}`}>
                {lineIdx > 0 && <br />}
                {renderInlineSpans(line)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
