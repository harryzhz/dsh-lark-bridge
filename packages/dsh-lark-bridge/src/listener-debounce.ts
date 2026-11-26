export interface DebouncedListenerEntry<T> {
  readonly botId: string
  readonly chatId: string
  readonly messageId: string
  readonly payload: T
}

interface PendingDebounceBucket<T> {
  readonly key: string
  readonly botId: string
  readonly chatId: string
  readonly debounceMs: number
  readonly maxWaitMs: number
  readonly firstEnqueuedAtMs: number
  readonly entries: DebouncedListenerEntry<T>[]
  readonly waiters: Array<() => void>
  timer: ReturnType<typeof setTimeout> | null
}

export const DEFAULT_MAX_DEBOUNCE_BATCH = 12
export const MAX_DEBOUNCE_WINDOW_CAP_MS = 15_000

/**
 * Short-window debounce coalescer for top-level passive group listener messages.
 * Absorbs rapid consecutive chat chatter or alert card bursts in the same group
 * (separate buckets per `bucketKey`) into a single downstream triage/worker batch
 * before spinning up isolated sessions.
 */
export class ListenerDebounceBuffer<T> {
  private readonly buckets = new Map<string, PendingDebounceBucket<T>>()
  private readonly maxBatchSize: number
  private disposed = false

  constructor(
    private readonly onFlush: (entries: readonly DebouncedListenerEntry<T>[]) => Promise<void>,
    options: { readonly maxBatchSize?: number } = {},
  ) {
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? DEFAULT_MAX_DEBOUNCE_BATCH)
  }

  get pendingCount(): number {
    let total = 0
    for (const bucket of this.buckets.values()) {
      total += bucket.entries.length
    }
    return total
  }

  /**
   * Adds an entry to the debounce bucket and resolves once that bucket has flushed
   * and completed processing (or been cancelled by recall/disable/dispose).
   */
  enqueue(input: {
    readonly bucketKey: string
    readonly botId: string
    readonly chatId: string
    readonly messageId: string
    readonly debounceMs: number
    readonly payload: T
  }): Promise<void> {
    if (this.disposed || input.debounceMs <= 0) {
      return this.onFlush([
        {
          botId: input.botId,
          chatId: input.chatId,
          messageId: input.messageId,
          payload: input.payload,
        },
      ])
    }

    const nowMs = Date.now()
    let bucket = this.buckets.get(input.bucketKey)
    if (!bucket) {
      const maxWaitMs = Math.min(
        Math.max(input.debounceMs * 3, input.debounceMs),
        MAX_DEBOUNCE_WINDOW_CAP_MS,
      )
      bucket = {
        key: input.bucketKey,
        botId: input.botId,
        chatId: input.chatId,
        debounceMs: input.debounceMs,
        maxWaitMs,
        firstEnqueuedAtMs: nowMs,
        entries: [],
        waiters: [],
        timer: null,
      }
      this.buckets.set(input.bucketKey, bucket)
    }

    bucket.entries.push({
      botId: input.botId,
      chatId: input.chatId,
      messageId: input.messageId,
      payload: input.payload,
    })

    const completion = new Promise<void>((resolve) => {
      bucket!.waiters.push(resolve)
    })

    if (bucket.entries.length >= this.maxBatchSize) {
      this.flushBucket(bucket.key)
      return completion
    }

    const elapsedMs = Math.max(0, nowMs - bucket.firstEnqueuedAtMs)
    const remainingCapMs = Math.max(0, bucket.maxWaitMs - elapsedMs)
    const delayMs = Math.min(bucket.debounceMs, remainingCapMs)

    if (bucket.timer) {
      clearTimeout(bucket.timer)
      bucket.timer = null
    }
    if (delayMs <= 0) {
      this.flushBucket(bucket.key)
    } else {
      const targetKey = bucket.key
      bucket.timer = setTimeout(() => {
        this.flushBucket(targetKey)
      }, delayMs)
      bucket.timer.unref?.()
    }

    return completion
  }

  /** Removes a recalled message from any pending debounce bucket. Returns true if removed. */
  cancelMessage(botId: string, messageId: string): boolean {
    let removed = false
    for (const [key, bucket] of [...this.buckets.entries()]) {
      if (bucket.botId !== botId) continue
      const idx = bucket.entries.findIndex((e) => e.messageId === messageId)
      if (idx < 0) continue
      bucket.entries.splice(idx, 1)
      removed = true
      if (bucket.entries.length === 0) {
        this.dropBucket(key, bucket)
      }
    }
    return removed
  }

  /** Cancels all buffered listener messages for a disabled bot or group. Returns dropped count. */
  cancelScope(botId: string, chatId?: string): number {
    let dropped = 0
    for (const [key, bucket] of [...this.buckets.entries()]) {
      if (bucket.botId !== botId) continue
      if (chatId && bucket.chatId !== chatId) continue
      dropped += bucket.entries.length
      this.dropBucket(key, bucket)
    }
    return dropped
  }

  /** Immediately flushes all pending buckets (e.g. when entering graceful maintenance drain). */
  flushAll(): void {
    for (const key of [...this.buckets.keys()]) {
      this.flushBucket(key)
    }
  }

  /** Cancels all pending timers and resolves waiters without flushing during teardown. */
  dispose(): void {
    this.disposed = true
    for (const [key, bucket] of [...this.buckets.entries()]) {
      this.dropBucket(key, bucket)
    }
  }

  private flushBucket(key: string): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    this.buckets.delete(key)
    if (bucket.timer) {
      clearTimeout(bucket.timer)
      bucket.timer = null
    }
    const entries = [...bucket.entries]
    const waiters = [...bucket.waiters]
    bucket.entries.length = 0
    bucket.waiters.length = 0

    if (entries.length === 0 || this.disposed) {
      for (const resolve of waiters) resolve()
      return
    }

    void this.onFlush(entries)
      .catch(() => {})
      .finally(() => {
        for (const resolve of waiters) resolve()
      })
  }

  private dropBucket(key: string, bucket: PendingDebounceBucket<T>): void {
    if (this.buckets.get(key) === bucket) {
      this.buckets.delete(key)
    }
    if (bucket.timer) {
      clearTimeout(bucket.timer)
      bucket.timer = null
    }
    const waiters = [...bucket.waiters]
    bucket.entries.length = 0
    bucket.waiters.length = 0
    for (const resolve of waiters) resolve()
  }
}
