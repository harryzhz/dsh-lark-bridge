export type ConcurrencyPriority = 'interactive' | 'background'

export interface ConcurrencyAcquireOptions {
  readonly runtimeKey: string
  readonly priority: ConcurrencyPriority
  readonly signal?: AbortSignal
  readonly isAborted?: () => boolean
}

export interface ConcurrencyLease {
  readonly runtimeKey: string
  readonly waitMs: number
  readonly release: () => void
}

export interface RuntimeConcurrencyBucketStats {
  readonly active: number
  readonly queued: number
}

export interface RuntimeConcurrencyStats {
  readonly maxPerRuntime: number
  readonly active: number
  readonly queued: number
  readonly byRuntime: Readonly<Record<string, RuntimeConcurrencyBucketStats>>
}

interface QueuedWaiter {
  readonly runtimeKey: string
  readonly rank: number
  readonly seq: number
  readonly enqueuedAtMs: number
  readonly signal?: AbortSignal
  readonly isAborted?: () => boolean
  readonly resolve: (lease: ConcurrencyLease | undefined) => void
  readonly cleanup: () => void
  settled: boolean
}

interface RuntimeBucket {
  active: number
  readonly waiters: QueuedWaiter[]
}

export const DEFAULT_MAX_CONCURRENT_TURNS_PER_RUNTIME = 3

export function normalizeRuntimeConcurrencyKey(raw?: string): string {
  const clean = raw?.trim().toLowerCase()
  return clean || 'default'
}

/**
 * Per-runtime priority semaphore bounding concurrent heavy Agent executions
 * without hardcoding specific runtime/provider names:
 * - Separate independent pools per normalized `runtimeKey` (e.g. `agentPreset`).
 * - Two-tier priority (`interactive` > `background`) with strict FIFO inside each tier,
 *   preventing alert storms or proactive reminders from starving live user replies.
 * - Fully abort-safe: cancelled/recalled/disabled/shutdown waiters exit immediately
 *   without leaking permits.
 */
export class RuntimeConcurrencyLimiter {
  private readonly maxPerRuntime: number
  private readonly buckets = new Map<string, RuntimeBucket>()
  private seq = 0
  private disposed = false

  constructor(maxPerRuntime = DEFAULT_MAX_CONCURRENT_TURNS_PER_RUNTIME) {
    this.maxPerRuntime =
      Number.isFinite(maxPerRuntime) && maxPerRuntime > 0 ? Math.floor(maxPerRuntime) : 0
  }

  get limit(): number {
    return this.maxPerRuntime
  }

  async acquire(options: ConcurrencyAcquireOptions): Promise<ConcurrencyLease | undefined> {
    const runtimeKey = normalizeRuntimeConcurrencyKey(options.runtimeKey)
    if (this.disposed || options.signal?.aborted || options.isAborted?.()) {
      return undefined
    }
    if (this.maxPerRuntime <= 0) {
      return {
        runtimeKey,
        waitMs: 0,
        release: () => {},
      }
    }

    const bucket = this.ensureBucket(runtimeKey)
    if (bucket.active < this.maxPerRuntime) {
      bucket.active += 1
      return this.createLease(runtimeKey, bucket, 0)
    }

    const enqueuedAtMs = Date.now()
    const rank = options.priority === 'interactive' ? 0 : 1
    const seq = ++this.seq

    return new Promise<ConcurrencyLease | undefined>((resolve) => {
      let onAbort: (() => void) | undefined
      const cleanup = () => {
        if (onAbort && options.signal) {
          options.signal.removeEventListener('abort', onAbort)
        }
        onAbort = undefined
      }

      const waiter: QueuedWaiter = {
        runtimeKey,
        rank,
        seq,
        enqueuedAtMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.isAborted ? { isAborted: options.isAborted } : {}),
        resolve,
        cleanup,
        settled: false,
      }

      onAbort = () => {
        if (waiter.settled) return
        waiter.settled = true
        cleanup()
        const idx = bucket.waiters.indexOf(waiter)
        if (idx >= 0) bucket.waiters.splice(idx, 1)
        this.pruneBucketIfEmpty(runtimeKey, bucket)
        resolve(undefined)
      }

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort()
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      this.insertWaiter(bucket.waiters, waiter)
    })
  }

  getStats(): RuntimeConcurrencyStats {
    let active = 0
    let queued = 0
    const byRuntime: Record<string, RuntimeConcurrencyBucketStats> = {}
    for (const [key, bucket] of this.buckets) {
      const liveQueued = bucket.waiters.filter((w) => !w.settled).length
      if (bucket.active === 0 && liveQueued === 0) continue
      active += bucket.active
      queued += liveQueued
      byRuntime[key] = { active: bucket.active, queued: liveQueued }
    }
    return {
      maxPerRuntime: this.maxPerRuntime,
      active,
      queued,
      byRuntime,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const bucket of this.buckets.values()) {
      while (bucket.waiters.length > 0) {
        const waiter = bucket.waiters.shift()!
        if (waiter.settled) continue
        waiter.settled = true
        waiter.cleanup()
        waiter.resolve(undefined)
      }
    }
    this.buckets.clear()
  }

  private ensureBucket(runtimeKey: string): RuntimeBucket {
    let bucket = this.buckets.get(runtimeKey)
    if (!bucket) {
      bucket = { active: 0, waiters: [] }
      this.buckets.set(runtimeKey, bucket)
    }
    return bucket
  }

  private insertWaiter(list: QueuedWaiter[], waiter: QueuedWaiter): void {
    let idx = list.length
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i]!
      if (waiter.rank < current.rank || (waiter.rank === current.rank && waiter.seq < current.seq)) {
        idx = i
        break
      }
    }
    list.splice(idx, 0, waiter)
  }

  private createLease(
    runtimeKey: string,
    bucket: RuntimeBucket,
    waitMs: number,
  ): ConcurrencyLease {
    let released = false
    return {
      runtimeKey,
      waitMs,
      release: () => {
        if (released) return
        released = true
        bucket.active = Math.max(0, bucket.active - 1)
        this.pumpBucket(runtimeKey, bucket)
      },
    }
  }

  private pumpBucket(runtimeKey: string, bucket: RuntimeBucket): void {
    while (!this.disposed && bucket.active < this.maxPerRuntime && bucket.waiters.length > 0) {
      const next = bucket.waiters.shift()!
      if (next.settled) continue
      next.settled = true
      next.cleanup()
      if (next.signal?.aborted || next.isAborted?.()) {
        next.resolve(undefined)
        continue
      }
      bucket.active += 1
      const waitMs = Math.max(0, Date.now() - next.enqueuedAtMs)
      next.resolve(this.createLease(runtimeKey, bucket, waitMs))
    }
    this.pruneBucketIfEmpty(runtimeKey, bucket)
  }

  private pruneBucketIfEmpty(runtimeKey: string, bucket: RuntimeBucket): void {
    if (bucket.active === 0 && bucket.waiters.length === 0) {
      if (this.buckets.get(runtimeKey) === bucket) {
        this.buckets.delete(runtimeKey)
      }
    }
  }
}
