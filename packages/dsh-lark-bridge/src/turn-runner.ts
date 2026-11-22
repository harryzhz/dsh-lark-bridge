import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export interface TurnReplyTrackerOptions {
  /**
   * Invoked immediately whenever an intermediate progress/commentary message is
   * committed (e.g. alongside a tool call or superseded by a later step). Calls
   * are serialized in arrival order and `flush()` settles before the final reply.
   */
  readonly onIntermediate?: (text: string) => void | Promise<void>
}

/**
 * Separates intermediate progress commentary from a turn's terminal response:
 * - When `onIntermediate` is omitted, intermediate messages are discarded and
 *   `result()` returns only the final response.
 * - When `onIntermediate` is provided, each intermediate message is dispatched
 *   immediately as soon as its step commits it, and `result()` still returns
 *   only the standalone final response (never concatenated).
 */
export class TurnFinalReplyTracker {
  private pendingFinalText = ''
  private sentCount = 0
  private queue: Promise<void> = Promise.resolve()
  private readonly onIntermediate?: (text: string) => void | Promise<void>

  constructor(options: TurnReplyTrackerOptions = {}) {
    this.onIntermediate = options.onIntermediate
  }

  get intermediateCount(): number {
    return this.sentCount
  }

  private enqueueIntermediate(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || !this.onIntermediate) return
    this.sentCount += 1
    const cb = this.onIntermediate
    this.queue = this.queue
      .then(async () => {
        await cb(trimmed)
      })
      .catch(() => {
        // Isolate intermediate delivery errors so the turn itself continues cleanly.
      })
  }

  onEvent(event: SessionEvent): void {
    if (event.type === 'tool/call') {
      if (this.pendingFinalText) {
        this.enqueueIntermediate(this.pendingFinalText)
        this.pendingFinalText = ''
      }
      return
    }
    if (event.type !== 'assistant/message') return
    if ((event.data as { interrupted?: boolean }).interrupted) return

    // If an earlier non-tool assistant message existed in this turn, it is now superseded.
    if (this.pendingFinalText) {
      this.enqueueIntermediate(this.pendingFinalText)
      this.pendingFinalText = ''
    }

    const content = event.data.message.content
    const nonEmptyTexts = content
      .filter(
        (b): b is Extract<ContentBlock, { type: 'text' }> =>
          b.type === 'text' && b.text.trim().length > 0,
      )
      .map((b) => b.text.trim())

    if (content.some((b) => b.type === 'tool-call')) {
      for (const part of nonEmptyTexts) {
        this.enqueueIntermediate(part)
      }
      return
    }

    if (nonEmptyTexts.length === 0) {
      this.pendingFinalText = ''
      return
    }

    for (let i = 0; i < nonEmptyTexts.length - 1; i += 1) {
      this.enqueueIntermediate(nonEmptyTexts[i]!)
    }
    this.pendingFinalText = nonEmptyTexts[nonEmptyTexts.length - 1]!
  }

  flush(): Promise<void> {
    return this.queue
  }

  result(): string {
    return this.pendingFinalText
  }
}

export interface RunTurnOptions {
  readonly onIntermediate?: (text: string) => void | Promise<void>
}

/**
 * Submit one user turn to an agent and resolve with ONLY the assistant's final
 * response text for that turn; when `options.onIntermediate` is supplied, intermediate
 * progress messages are dispatched immediately as they arrive.
 */
export function runTurnAndCollectReply(
  ctx: Context,
  agent: Agent,
  content: ContentBlock[],
  options: RunTurnOptions = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const tracker = new TurnFinalReplyTracker({
      ...(options.onIntermediate ? { onIntermediate: options.onIntermediate } : {}),
    })
    let targetTurn: number | undefined

    const off = ctx.on(
      'session/event',
      (session: Session, event: SessionEvent) => {
        if (session.id !== agent.session.id) return
        if (event.type === 'turn/start' && targetTurn === undefined) {
          targetTurn = event.data.turn
          return
        }
        if (targetTurn === undefined) return
        if (
          (event.type === 'assistant/message' || event.type === 'tool/call') &&
          event.data.turn === targetTurn
        ) {
          tracker.onEvent(event)
          return
        }
        if (event.type === 'turn/end' && event.data.turn === targetTurn) {
          off()
          if (event.data.reason.kind === 'error') {
            reject(new Error(event.data.reason.error.message || 'Agent turn failed'))
          } else {
            void tracker.flush().then(() => resolve(tracker.result()))
          }
        }
      },
      { global: true },
    )

    try {
      agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    } catch (err) {
      off()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
