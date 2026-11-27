import {
  COT_MAX_TEXT_CHARS,
  COT_TEXT_CHUNK_CHARS,
  buildCotFinishEvents,
  buildCotPrologueEvents,
  buildCotReasoningMessageEvents,
  buildCotToolCallEvents,
  buildCotToolResultEvents,
  createCotEvent,
  resolveCotPlacement,
  splitCotTextChunks,
  type CotEventPayload,
  type CreateCotMessageOptions,
  type CreateCotMessageResult,
  type GroupReplyMode,
} from '@dsh-lark/lark-core'

export interface CotTransportLike {
  createCotMessage(options: CreateCotMessageOptions): Promise<CreateCotMessageResult>
  appendCotEvents(
    cotId: string,
    messageId: string,
    events: readonly CotEventPayload[],
  ): Promise<{ readonly alreadyTerminal: boolean }>
  completeCotMessage(
    cotId: string,
    messageId: string,
    reason: 'done' | 'error',
  ): Promise<{ readonly alreadyTerminal: boolean }>
}

export type TurnCotInputEvent =
  | {
      readonly type: 'reasoning-delta'
      readonly blockKey: string
      readonly stepKey?: string
      readonly text: string
    }
  | {
      readonly type: 'reasoning-block-end'
      readonly blockKey: string
    }
  | {
      readonly type: 'reasoning-message'
      readonly stepKey?: string
      readonly text: string
    }
  | {
      readonly type: 'commentary-text'
      readonly text: string
    }
  | {
      readonly type: 'tool-call'
      readonly callId: string
      readonly name: string
      readonly arguments: string
    }
  | {
      readonly type: 'tool-result'
      readonly callId: string
      readonly output: string
      readonly isError: boolean
    }

export interface TurnCotControllerOptions {
  readonly transport: CotTransportLike
  readonly chatId: string
  readonly chatType: string
  readonly replyMode: GroupReplyMode
  readonly messageId: string
  readonly rootId?: string
  readonly threadId?: string
  readonly threadKey: string
  readonly runId: string
  readonly toolResultEnabled: boolean
  readonly flushIntervalMs?: number
  readonly finishTimeoutMs?: number
  readonly canPublish?: () => boolean
  readonly onCreated?: (info: CreateCotMessageResult) => void
  readonly onSettled?: () => void
  readonly log?: (level: 'info' | 'warn', message: string) => void
}

const DEFAULT_STREAM_FLUSH_MS = 320
const STREAM_IMMEDIATE_FLUSH_CHARS = 240
const DEFAULT_FINISH_TIMEOUT_MS = 3_500
const PLACEHOLDER_THINKING_TEXT = '正在分析并执行…'

interface OpenStreamingReasoning {
  readonly blockKey: string
  readonly messageId: string
  started: boolean
  pendingText: string
  emittedChars: number
}

/**
 * Purely cosmetic native Feishu CoT (`im/v1/message_cot`) lifecycle controller
 * for a single agent turn.
 *
 * Guarantees:
 * - Lazy bubble creation on the first real reasoning/commentary/tool event so
 *   direct fast replies or silent turns never emit empty bubbles.
 * - Live streaming of `reasoning-delta` chunks (debounced + chunked) while
 *   deduplicating against the subsequent committed `assistant/message`.
 * - Single-flight serialized HTTP pump so event ordering is preserved.
 * - Strict fault isolation: any Feishu error disables CoT for the rest of the
 *   turn without interrupting agent execution or final reply delivery.
 */
export class TurnCotController {
  private readonly flushIntervalMs: number
  private readonly finishTimeoutMs: number
  private readonly queuedEvents: CotEventPayload[] = []
  private readonly seenToolCalls = new Set<string>()
  private readonly seenToolResults = new Set<string>()
  private readonly toolResultLanguages = new Map<string, string>()
  private readonly streamedStepKeys = new Set<string>()
  private readonly firstReasoningId: string

  private cotId?: string
  private cotMessageId?: string
  private lastReasoningId?: string
  private nodeCounter = 0
  private openStream?: OpenStreamingReasoning
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private prologueQueued = false
  private pumping = false
  private disabled = false
  private settled = false
  private finishRequested?: { readonly status: 'done' | 'interrupted'; readonly notice?: string }
  private finishPromise?: Promise<void>
  private pumpDonePromise?: Promise<void>
  private resolvePumpDone?: () => void

  constructor(private readonly opts: TurnCotControllerOptions) {
    this.flushIntervalMs = Math.max(20, opts.flushIntervalMs ?? DEFAULT_STREAM_FLUSH_MS)
    this.finishTimeoutMs = Math.max(200, opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS)
    this.firstReasoningId = `reasoning-${opts.runId}-1`
  }

  get entity(): CreateCotMessageResult | undefined {
    return this.cotId && this.cotMessageId
      ? { cotId: this.cotId, messageId: this.cotMessageId }
      : undefined
  }

  get isDisabled(): boolean {
    return this.disabled
  }

  get isSettled(): boolean {
    return this.settled
  }

  push(event: TurnCotInputEvent): void {
    if (this.settled || this.disabled || this.finishRequested) return
    if (this.opts.canPublish && !this.opts.canPublish()) return

    switch (event.type) {
      case 'reasoning-delta':
        this.handleReasoningDelta(event.blockKey, event.text, event.stepKey)
        return
      case 'reasoning-block-end':
        this.closeOpenStreamIfMatches(event.blockKey)
        return
      case 'reasoning-message':
        this.handleCommittedReasoning(event.text, event.stepKey)
        return
      case 'commentary-text':
        this.handleCommentaryText(event.text)
        return
      case 'tool-call':
        this.handleToolCall(event.callId, event.name, event.arguments)
        return
      case 'tool-result':
        this.handleToolResult(event.callId, event.output, event.isError)
        return
    }
  }

  finish(
    status: 'done' | 'interrupted',
    options: { readonly notice?: string; readonly timeoutMs?: number } = {},
  ): Promise<void> {
    if (this.finishPromise) return this.finishPromise

    this.clearFlushTimer()
    this.closeOpenStream()
    this.finishRequested = {
      status,
      ...(options.notice ? { notice: options.notice } : {}),
    }

    if (!this.cotId && !this.pumping && this.queuedEvents.length === 0) {
      this.settled = true
      this.opts.onSettled?.()
      this.finishPromise = Promise.resolve()
      return this.finishPromise
    }

    const work = this.runFinishWork(status, options.notice)
    const timeoutMs = Math.max(100, options.timeoutMs ?? this.finishTimeoutMs)
    this.finishPromise = this.waitWithTimeout(work, timeoutMs)
    return this.finishPromise
  }

  private nextReasoningId(): string {
    this.nodeCounter += 1
    if (this.nodeCounter === 1) return this.firstReasoningId
    return `reasoning-${this.opts.runId}-${this.nodeCounter}`
  }

  private ensurePrologue(): void {
    if (this.prologueQueued) return
    this.prologueQueued = true
    this.queuedEvents.push(
      ...buildCotPrologueEvents(this.opts.threadKey, this.opts.runId, this.firstReasoningId),
    )
  }

  private enqueue(events: readonly CotEventPayload[]): void {
    if (events.length === 0 || this.disabled || this.settled) return
    this.ensurePrologue()
    this.queuedEvents.push(...events)
    this.schedulePump()
  }

  private handleReasoningDelta(blockKey: string, text: string, stepKey?: string): void {
    if (!text) return
    if (stepKey) this.streamedStepKeys.add(stepKey)

    if (this.openStream && this.openStream.blockKey !== blockKey) {
      this.closeOpenStream()
    }
    if (!this.openStream) {
      const messageId = this.nextReasoningId()
      this.openStream = {
        blockKey,
        messageId,
        started: false,
        pendingText: '',
        emittedChars: 0,
      }
    }

    const remaining = COT_MAX_TEXT_CHARS - this.openStream.emittedChars - this.openStream.pendingText.length
    if (remaining <= 0) return
    this.openStream.pendingText += text.length > remaining ? text.slice(0, remaining) : text

    if (!this.openStream.started && this.openStream.pendingText.trim().length > 0) {
      this.flushOpenStreamBuffer()
      return
    }
    if (this.openStream.pendingText.length >= STREAM_IMMEDIATE_FLUSH_CHARS) {
      this.flushOpenStreamBuffer()
      return
    }
    this.scheduleFlushTimer()
  }

  private flushOpenStreamBuffer(): void {
    this.clearFlushTimer()
    const stream = this.openStream
    if (!stream || !stream.pendingText) return
    if (!stream.started && !stream.pendingText.trim()) return

    const text = stream.pendingText
    stream.pendingText = ''
    const ts = Date.now()
    const batch: CotEventPayload[] = []

    if (!stream.started) {
      stream.started = true
      this.lastReasoningId = stream.messageId
      batch.push(
        createCotEvent('REASONING_MESSAGE_START', { messageId: stream.messageId, role: 'reasoning' }, ts),
      )
    }

    const chunks = splitCotTextChunks(text, COT_TEXT_CHUNK_CHARS, COT_MAX_TEXT_CHARS)
    for (const chunk of chunks) {
      batch.push(
        createCotEvent('REASONING_MESSAGE_CONTENT', { messageId: stream.messageId, delta: chunk }, ts),
      )
    }
    stream.emittedChars += text.length
    this.enqueue(batch)
  }

  private closeOpenStreamIfMatches(blockKey: string): void {
    if (this.openStream?.blockKey === blockKey) {
      this.closeOpenStream()
    }
  }

  private closeOpenStream(): void {
    this.clearFlushTimer()
    const stream = this.openStream
    if (!stream) return
    this.openStream = undefined
    if (stream.pendingText && (stream.started || stream.pendingText.trim())) {
      const ts = Date.now()
      const batch: CotEventPayload[] = []
      if (!stream.started) {
        stream.started = true
        this.lastReasoningId = stream.messageId
        batch.push(
          createCotEvent(
            'REASONING_MESSAGE_START',
            { messageId: stream.messageId, role: 'reasoning' },
            ts,
          ),
        )
      }
      for (const chunk of splitCotTextChunks(stream.pendingText, COT_TEXT_CHUNK_CHARS, COT_MAX_TEXT_CHARS)) {
        batch.push(
          createCotEvent('REASONING_MESSAGE_CONTENT', { messageId: stream.messageId, delta: chunk }, ts),
        )
      }
      batch.push(createCotEvent('REASONING_MESSAGE_END', { messageId: stream.messageId }, ts))
      this.enqueue(batch)
      return
    }
    if (stream.started) {
      this.enqueue([createCotEvent('REASONING_MESSAGE_END', { messageId: stream.messageId })])
    }
  }

  private handleCommittedReasoning(text: string, stepKey?: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (stepKey && this.streamedStepKeys.has(stepKey)) {
      this.closeOpenStream()
      return
    }
    this.closeOpenStream()
    const messageId = this.nextReasoningId()
    this.lastReasoningId = messageId
    this.enqueue(buildCotReasoningMessageEvents(messageId, trimmed))
  }

  private handleCommentaryText(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.closeOpenStream()
    const messageId = this.nextReasoningId()
    this.lastReasoningId = messageId
    this.enqueue(buildCotReasoningMessageEvents(messageId, trimmed))
  }

  private handleToolCall(callId: string, name: string, args: string): void {
    const cleanId = callId.trim()
    if (!cleanId || this.seenToolCalls.has(cleanId)) return
    this.seenToolCalls.add(cleanId)

    this.closeOpenStream()
    const batch: CotEventPayload[] = []
    if (!this.lastReasoningId) {
      const placeholderId = this.nextReasoningId()
      this.lastReasoningId = placeholderId
      batch.push(...buildCotReasoningMessageEvents(placeholderId, PLACEHOLDER_THINKING_TEXT))
    }

    const built = buildCotToolCallEvents({
      toolCallId: cleanId,
      toolName: name || 'tool',
      args,
      parentMessageId: this.lastReasoningId,
    })
    if (built.resultLanguage) {
      this.toolResultLanguages.set(cleanId, built.resultLanguage)
    }
    batch.push(...built.events)
    this.enqueue(batch)
  }

  private handleToolResult(callId: string, output: string, isError: boolean): void {
    const cleanId = callId.trim()
    if (!cleanId || this.seenToolResults.has(cleanId)) return
    if (!this.seenToolCalls.has(cleanId)) return
    this.seenToolResults.add(cleanId)

    const language = this.toolResultLanguages.get(cleanId)
    this.enqueue(
      buildCotToolResultEvents({
        toolCallId: cleanId,
        result: output,
        includeResult: this.opts.toolResultEnabled,
        isError,
        ...(language ? { language } : {}),
      }),
    )
  }

  private scheduleFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushOpenStreamBuffer()
    }, this.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private schedulePump(): void {
    if (this.pumping) return
    this.pumping = true
    this.pumpDonePromise = new Promise<void>((resolve) => {
      this.resolvePumpDone = resolve
    })
    void this.runPump()
  }

  private async runPump(): Promise<void> {
    try {
      while (!this.disabled) {
        if (this.queuedEvents.length === 0) break

        if (!this.cotId) {
          if (this.finishRequested && this.finishRequested.status === 'interrupted') {
            this.queuedEvents.length = 0
            break
          }
          if (this.opts.canPublish && !this.opts.canPublish()) {
            this.queuedEvents.length = 0
            break
          }
          const placement = resolveCotPlacement({
            chatType: this.opts.chatType,
            replyMode: this.opts.replyMode,
            messageId: this.opts.messageId,
            ...(this.opts.rootId ? { rootId: this.opts.rootId } : {}),
            ...(this.opts.threadId ? { threadId: this.opts.threadId } : {}),
          })
          const created = await this.opts.transport.createCotMessage({
            chatId: this.opts.chatId,
            ...(placement.originMessageId ? { originMessageId: placement.originMessageId } : {}),
            ...(placement.replyInThread ? { replyInThread: true } : {}),
          })
          this.cotId = created.cotId
          this.cotMessageId = created.messageId
          this.opts.log?.(
            'info',
            `CoT bubble created for run ${this.opts.runId}: cotId=${created.cotId} messageId=${created.messageId}`,
          )
          this.opts.onCreated?.(created)
        }

        const batch = this.queuedEvents.splice(0, this.queuedEvents.length)
        if (batch.length === 0) break
        const res = await this.opts.transport.appendCotEvents(this.cotId, this.cotMessageId!, batch)
        if (res.alreadyTerminal) {
          this.disabled = true
          break
        }
      }
    } catch (err) {
      this.disabled = true
      this.queuedEvents.length = 0
      this.opts.log?.(
        'warn',
        `CoT stream disabled for run ${this.opts.runId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      this.pumping = false
      const done = this.resolvePumpDone
      this.resolvePumpDone = undefined
      done?.()
    }
  }

  private async runFinishWork(status: 'done' | 'interrupted', notice?: string): Promise<void> {
    try {
      if (this.pumpDonePromise) {
        await this.pumpDonePromise
      }
      if (!this.cotId || !this.cotMessageId) {
        this.settled = true
        this.opts.onSettled?.()
        return
      }

      if (!this.disabled) {
        try {
          if (this.queuedEvents.length > 0) {
            const pending = this.queuedEvents.splice(0, this.queuedEvents.length)
            await this.opts.transport.appendCotEvents(this.cotId, this.cotMessageId, pending)
          }
          const finishEvents = buildCotFinishEvents({
            threadId: this.opts.threadKey,
            runId: this.opts.runId,
            lastReasoningId: this.lastReasoningId ?? this.firstReasoningId,
            status,
            ...(notice ? { interruptedNotice: notice } : {}),
          })
          const appendRes = await this.opts.transport.appendCotEvents(
            this.cotId,
            this.cotMessageId,
            finishEvents,
          )
          if (status === 'interrupted' && !appendRes.alreadyTerminal) {
            await this.opts.transport.completeCotMessage(this.cotId, this.cotMessageId, 'error')
          }
          this.opts.log?.(
            'info',
            `CoT bubble finished (${status}) for run ${this.opts.runId}: cotId=${this.cotId}`,
          )
          this.settled = true
          this.opts.onSettled?.()
          return
        } catch (err) {
          this.disabled = true
          this.opts.log?.(
            'warn',
            `CoT finish append failed for ${this.cotId}, falling back to explicit complete: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      // Best-effort explicit close so an already-created bubble never spins forever.
      try {
        await this.opts.transport.completeCotMessage(
          this.cotId,
          this.cotMessageId,
          status === 'done' ? 'done' : 'error',
        )
        this.opts.log?.(
          'info',
          `CoT bubble explicitly completed (${status}) for run ${this.opts.runId}: cotId=${this.cotId}`,
        )
      } catch (err) {
        this.opts.log?.(
          'warn',
          `CoT explicit complete(${status}) failed for ${this.cotId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      this.settled = true
      this.opts.onSettled?.()
    } catch {
      this.settled = true
      this.opts.onSettled?.()
    }
  }

  private async waitWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/**
 * Best-effort orphan closure for a persisted CoT bubble left open across a
 * restart or crash. Annotates before completing when closing with `error`.
 */
export async function closeOrphanCotBubble(
  transport: CotTransportLike,
  input: {
    readonly cotId: string
    readonly messageId: string
    readonly reason: 'done' | 'error'
    readonly notice?: string
  },
): Promise<void> {
  if (!input.cotId || !input.messageId) return
  if (input.reason === 'error' && input.notice) {
    try {
      const noticeEvents = buildCotReasoningMessageEvents(
        `reasoning-orphan-${Date.now()}`,
        input.notice,
      )
      const res = await transport.appendCotEvents(input.cotId, input.messageId, noticeEvents)
      if (res.alreadyTerminal) return
    } catch {
      // Proceed to explicit complete even if annotating fails.
    }
  }
  try {
    await transport.completeCotMessage(input.cotId, input.messageId, input.reason)
  } catch {
    // Strictly cosmetic cleanup.
  }
}
