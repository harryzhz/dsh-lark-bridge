import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { hasVisibleText, trimInvisibleText } from '@dsh-lark/lark-core'

export type TurnAbortKind =
  | 'disposed'
  | 'recalled'
  | 'disabled'
  | 'user'
  | 'parent'
  | 'hook'
  | 'interrupted'
  | 'blocked'
  | 'other'

export class TurnAbortedError extends Error {
  readonly kind: TurnAbortKind

  constructor(kind: TurnAbortKind, message: string) {
    super(message)
    this.name = 'TurnAbortedError'
    this.kind = kind
  }
}

function createTurnAbortedError(reason: TurnEndReason): TurnAbortedError | undefined {
  if (reason.kind === 'aborted') {
    const cause = reason.reason
    switch (cause?.kind) {
      case 'disposed':
        return new TurnAbortedError('disposed', '本轮执行因服务重载或会话关闭已中断')
      case 'user':
        return new TurnAbortedError('user', '本轮执行已被手动停止')
      case 'parent':
        return new TurnAbortedError('parent', '本轮执行因上级任务中止已停止')
      case 'hook':
        return new TurnAbortedError('hook', cause.reason?.trim() || '本轮执行被拦截中止')
      default:
        return new TurnAbortedError('other', '本轮执行已中断')
    }
  }
  if (reason.kind === 'interrupted') {
    return new TurnAbortedError('interrupted', '本轮执行因服务中断已停止')
  }
  if (reason.kind === 'blocked') {
    return new TurnAbortedError('blocked', '本轮执行已阻塞终止')
  }
  if (reason.kind === 'forked') {
    return new TurnAbortedError('other', '本轮执行因会话分叉已结束')
  }
  return undefined
}

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
    const trimmed = trimInvisibleText(text)
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

    const content = event.data.message.content
    const hasToolCall = content.some((b) => b.type === 'tool-call')
    const nonEmptyTexts = content
      .filter(
        (b): b is Extract<ContentBlock, { type: 'text' }> =>
          b.type === 'text' && hasVisibleText(b.text),
      )
      .map((b) => trimInvisibleText(b.text))

    // Ignore purely invisible/reasoning trailing assistant messages so they neither erase
    // a previously committed visible response nor leak zero-width filler text.
    if (!hasToolCall && nonEmptyTexts.length === 0) {
      return
    }

    // If an earlier non-tool assistant message existed in this turn, it is now superseded.
    if (this.pendingFinalText) {
      this.enqueueIntermediate(this.pendingFinalText)
      this.pendingFinalText = ''
    }

    if (hasToolCall) {
      for (const part of nonEmptyTexts) {
        this.enqueueIntermediate(part)
      }
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

const claimedTurnsBySession = new Map<string, Set<number>>()
const POST_STEP_STALL_WARN_MS = 3_000
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 5_000

function toCancelAbortError(reason: unknown): TurnAbortedError {
  if (reason instanceof TurnAbortedError) return reason
  return new TurnAbortedError('recalled', '原消息已撤回，已取消当前轮次并停止执行')
}

function claimSessionTurn(sessionId: string, turn: number): boolean {
  let set = claimedTurnsBySession.get(sessionId)
  if (set?.has(turn)) return false
  if (!set) {
    set = new Set<number>()
    claimedTurnsBySession.set(sessionId, set)
  }
  set.add(turn)
  return true
}

function releaseSessionTurn(sessionId: string, turn: number | undefined): void {
  if (turn === undefined) return
  const set = claimedTurnsBySession.get(sessionId)
  if (!set) return
  set.delete(turn)
  if (set.size === 0) {
    claimedTurnsBySession.delete(sessionId)
  }
}

export interface RunTurnOptions {
  readonly onIntermediate?: (text: string) => void | Promise<void>
  readonly onActivity?: (timestampMs: number) => void
  readonly signal?: AbortSignal
  /**
   * Optional per-turn cancellation signal (e.g. inbound message recalled).
   * Fires `agent.cancel({ kind: 'user' }, { keepInbox: true })` to stop active
   * execution and awaits `turn/end` settlement up to `cancelFallbackTimeoutMs`.
   */
  readonly cancelSignal?: AbortSignal
  readonly cancelFallbackTimeoutMs?: number
}

/**
 * Submit one user turn to an agent and resolve with ONLY the assistant's final
 * response text for that turn; when `options.onIntermediate` is supplied, intermediate
 * progress messages are dispatched immediately as they arrive.
 */
const RUNTIME_EXECUTOR_ERROR_BANNER_RE = /^⚠\s*agent executor error:\s*([^\r\n]+)$/u

/**
 * Secondary guard against external ACP runtimes that surface internal fatal
 * executor errors (e.g. `⚠ agent executor error: ...`) as a standalone plain
 * assistant message followed by `turn/end (completed)`.
 */
export function detectRuntimeExecutorErrorBanner(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const match = RUNTIME_EXECUTOR_ERROR_BANNER_RE.exec(trimmed)
  if (!match?.[1]) return undefined
  return `agent executor error: ${match[1].trim()}`
}

export function runTurnAndCollectReply(
  ctx: Context,
  agent: Agent,
  content: ContentBlock[],
  options: RunTurnOptions = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new TurnAbortedError('disposed', '本轮执行因服务重载或停机已中断'))
      return
    }
    if (options.cancelSignal?.aborted) {
      reject(toCancelAbortError(options.cancelSignal.reason))
      return
    }

    const sessionId = String(agent.session.id)
    const userMessage = createUserMessage({ content, source: { kind: 'user' } })
    const expectedUserMessageId = (userMessage as { id?: string }).id
    let cancelError: TurnAbortedError | undefined
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    const guardedOnIntermediate = options.onIntermediate
      ? (text: string) => {
          if (cancelError || options.cancelSignal?.aborted) return
          return options.onIntermediate!(text)
        }
      : undefined
    let tracker = new TurnFinalReplyTracker({
      ...(guardedOnIntermediate ? { onIntermediate: guardedOnIntermediate } : {}),
    })
    let targetTurn: number | undefined
    let targetTurnConfirmed = false
    let lastStepEndAtMs: number | undefined
    let lastAssistantMessageAtMs: number | undefined
    let phase: 'running' | 'flushing' | 'settled' = 'running'
    let offEvent: (() => void) | undefined
    let offDispose: (() => void) | undefined

    const onAbortSignal = () => {
      fail(new TurnAbortedError('disposed', '本轮执行因服务重载或停机已中断'))
    }

    const onCancelSignal = () => {
      if (cancelError) return
      cancelError = toCancelAbortError(options.cancelSignal?.reason)
      if (phase === 'settled') return
      if (phase === 'flushing') {
        phase = 'settled'
        cleanup()
        reject(cancelError)
        return
      }
      const cancelFn = (agent as { cancel?: Agent['cancel'] }).cancel
      if (typeof cancelFn === 'function') {
        try {
          cancelFn.call(agent, { kind: 'user' }, { keepInbox: true })
        } catch {
          // Fall through to timeout/immediate rejection if agent.cancel throws.
        }
        const fallbackMs = Math.max(
          50,
          options.cancelFallbackTimeoutMs ?? DEFAULT_CANCEL_SETTLE_TIMEOUT_MS,
        )
        cancelTimer = setTimeout(() => {
          if (phase === 'running' && cancelError) {
            fail(cancelError)
          }
        }, fallbackMs)
        cancelTimer.unref?.()
      } else {
        fail(cancelError)
      }
    }

    const cleanup = (skipDisposeEffect = false) => {
      releaseSessionTurn(sessionId, targetTurn)
      options.signal?.removeEventListener('abort', onAbortSignal)
      options.cancelSignal?.removeEventListener('abort', onCancelSignal)
      if (cancelTimer) {
        clearTimeout(cancelTimer)
        cancelTimer = undefined
      }
      if (offEvent) {
        const fn = offEvent
        offEvent = undefined
        try {
          fn()
        } catch {
          // Listener may already be detached by Cordis fiber disposal.
        }
      }
      if (!skipDisposeEffect && offDispose) {
        const fn = offDispose
        offDispose = undefined
        try {
          fn()
        } catch {
          // Effect may already be disposing.
        }
      }
    }

    const succeed = (text: string) => {
      if (phase === 'settled') return
      if (cancelError || options.cancelSignal?.aborted) {
        phase = 'settled'
        cleanup()
        reject(cancelError ?? toCancelAbortError(options.cancelSignal?.reason))
        return
      }
      phase = 'settled'
      cleanup()
      resolve(text)
    }

    const fail = (err: Error, skipDisposeEffect = false) => {
      if (phase !== 'running') return
      phase = 'settled'
      cleanup(skipDisposeEffect)
      reject(err)
    }

    options.signal?.addEventListener('abort', onAbortSignal, { once: true })
    options.cancelSignal?.addEventListener('abort', onCancelSignal, { once: true })

    try {
      offEvent = ctx.on(
        'session/event',
        (session: Session, event: SessionEvent) => {
          if (phase !== 'running' || session.id !== agent.session.id) return
          if (event.type === 'turn/start' && targetTurn === undefined) {
            if (!claimSessionTurn(sessionId, event.data.turn)) return
            targetTurn = event.data.turn
            targetTurnConfirmed = false
            lastStepEndAtMs = undefined
            lastAssistantMessageAtMs = undefined
            options.onActivity?.(Date.now())
            return
          }
          if (targetTurn === undefined) return
          if (event.type === 'user/message' && !targetTurnConfirmed) {
            const eventMsgId = (event.data as { id?: string }).id
            if (eventMsgId && expectedUserMessageId) {
              if (eventMsgId === expectedUserMessageId) {
                targetTurnConfirmed = true
                return
              }
              // Turn belongs to another caller (e.g. Web UI or scheduled run); release and wait for ours.
              releaseSessionTurn(sessionId, targetTurn)
              targetTurn = undefined
              lastStepEndAtMs = undefined
              lastAssistantMessageAtMs = undefined
              tracker = new TurnFinalReplyTracker({
                ...(guardedOnIntermediate ? { onIntermediate: guardedOnIntermediate } : {}),
              })
              return
            }
          }
          if (
            (event.type === 'assistant/message' || event.type === 'tool/call') &&
            event.data.turn === targetTurn
          ) {
            targetTurnConfirmed = true
            if (cancelError || options.cancelSignal?.aborted) return
            const nowMs = Date.now()
            if (event.type === 'assistant/message') {
              lastAssistantMessageAtMs = nowMs
            }
            options.onActivity?.(nowMs)
            tracker.onEvent(event)
            return
          }
          if (
            (event.type === 'step/start' || event.type === 'tool/result') &&
            (event.data as { turn?: number }).turn === targetTurn
          ) {
            options.onActivity?.(Date.now())
            return
          }
          if (event.type === 'step/end' && event.data.turn === targetTurn) {
            const nowMs = Date.now()
            lastStepEndAtMs = nowMs
            options.onActivity?.(nowMs)
            return
          }
          if (event.type === 'turn/end' && event.data.turn === targetTurn) {
            if (cancelError || options.cancelSignal?.aborted) {
              fail(cancelError ?? toCancelAbortError(options.cancelSignal?.reason))
              return
            }
            const stallAnchorMs = lastStepEndAtMs ?? lastAssistantMessageAtMs
            if (stallAnchorMs !== undefined) {
              const postStepGapMs = Date.now() - stallAnchorMs
              if (postStepGapMs >= POST_STEP_STALL_WARN_MS) {
                ctx.logger?.warn?.(
                  `[lark-bridge][session=${sessionId}][turn=${targetTurn}] post-step turn-stopping stall detected: ${postStepGapMs}ms between step completion and turn/end (check DSH workspace-changes git snapshot or turn-stopping hooks)`,
                )
              }
            }
            const reason = event.data.reason
            if (reason.kind === 'error') {
              fail(new Error(reason.error.message || 'Agent turn failed'))
              return
            }
            const abortedErr = createTurnAbortedError(reason)
            if (abortedErr) {
              fail(abortedErr)
              return
            }
            // Leave `running` before detaching listeners/effects so tearing down our own
            // `ctx.effect` handle (or a racing plugin dispose during intermediate flush)
            // cannot invoke `fail()` and falsely reject an already completed turn.
            phase = 'flushing'
            cleanup()
            void tracker.flush().then(() => {
              const finalReply = tracker.result()
              const executorError = detectRuntimeExecutorErrorBanner(finalReply)
              if (executorError) {
                if (phase === 'settled') return
                phase = 'settled'
                reject(new Error(executorError))
                return
              }
              succeed(finalReply)
            })
          }
        },
        { global: true },
      )

      // Guard against Cordis LIFO fiber disposal detaching `ctx.on` before `turn/end`
      // arrives (e.g. during HMR or plugin unload), which would otherwise strand the promise.
      if (typeof ctx.effect === 'function') {
        offDispose = ctx.effect(
          () => () => {
            if (phase !== 'running') return
            fail(new TurnAbortedError('disposed', '本轮执行因服务重载或停机已中断'), true)
          },
          'dsh-lark-bridge.turn-runner',
        )
      }

      agent.followup(userMessage)
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
