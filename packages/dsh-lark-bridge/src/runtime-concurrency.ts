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

export interface RuntimeConcurrencyConfigSnapshot {
  readonly defaultLimit: number
  readonly maxLimit: number
  readonly limits: Readonly<Record<string, number>>
  readonly stats: RuntimeConcurrencyStats
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
export const MIN_CONCURRENT_TURNS_PER_RUNTIME = 0
export const MAX_CONCURRENT_TURNS_PER_RUNTIME = 32
export const RUNTIME_CONCURRENCY_KEY_SEP = '::'

export function normalizeRuntimeConcurrencyKey(raw?: string): string {
  const clean = raw?.trim().toLowerCase()
  return clean || 'default'
}

/**
 * Build a canonical concurrency pool key for a `(runtimeId, profileId)` pair.
 * Base runtimes use `<runtimeId>` (e.g. `codex`, `standard`); named profiles use
 * `<runtimeId>::<profileId>` so distinct accounts/proxies hold independent pools
 * while inheriting the parent runtime's limit unless explicitly overridden.
 */
export function buildRuntimeConcurrencyKey(
  agentPreset?: string,
  runtimeProfileId?: string,
): string {
  const preset = normalizeRuntimeConcurrencyKey(agentPreset)
  const profile = runtimeProfileId?.trim().toLowerCase()
  return profile ? `${preset}${RUNTIME_CONCURRENCY_KEY_SEP}${profile}` : preset
}

function parentRuntimeConcurrencyKey(runtimeKey: string): string | undefined {
  const idx = runtimeKey.indexOf(RUNTIME_CONCURRENCY_KEY_SEP)
  if (idx <= 0) return undefined
  return runtimeKey.slice(0, idx)
}

/**
 * Parse and validate an explicit concurrency limit value:
 * - `null` / `undefined` => remove custom override (inherit parent/default)
 * - integer in `[0, 32]` => valid (`0` = unlimited)
 * Throws a descriptive Error on invalid inputs.
 */
export function parseRuntimeConcurrencyLimit(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error('并发上限必须为整数（0 表示不限制）或留空恢复默认')
  }
  if (raw < MIN_CONCURRENT_TURNS_PER_RUNTIME || raw > MAX_CONCURRENT_TURNS_PER_RUNTIME) {
    throw new Error(
      `并发上限需在 ${MIN_CONCURRENT_TURNS_PER_RUNTIME}～${MAX_CONCURRENT_TURNS_PER_RUNTIME} 之间（0 表示不限制）`,
    )
  }
  return raw
}

/** Sanitize persisted override maps defensively when loading from storage. */
export function sanitizeRuntimeConcurrencyLimits(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = normalizeRuntimeConcurrencyKey(k)
    if (!key) continue
    if (
      typeof v === 'number' &&
      Number.isFinite(v) &&
      Number.isInteger(v) &&
      v >= MIN_CONCURRENT_TURNS_PER_RUNTIME &&
      v <= MAX_CONCURRENT_TURNS_PER_RUNTIME
    ) {
      out[key] = v
    }
  }
  return out
}

function normalizeDefaultLimit(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(MAX_CONCURRENT_TURNS_PER_RUNTIME, Math.floor(raw))
}

/**
 * Per-runtime priority semaphore bounding concurrent heavy Agent executions
 * without hardcoding specific runtime/provider names:
 * - Separate independent pools per normalized `runtimeKey` (`<runtimeId>` or `<runtimeId>::<profileId>`).
 * - Hierarchical limit resolution: exact profile override -> base runtime override -> global default.
 * - Hot-reconfigurable limits via `setOverride` / `setOverrides`, immediately waking queued waiters
 *   when a limit increases or switches to unlimited (`0`).
 * - Two-tier priority (`interactive` > `background`) with strict FIFO inside each tier,
 *   preventing alert storms or proactive reminders from starving live user replies.
 * - Fully abort-safe: cancelled/recalled/disabled/shutdown waiters exit immediately
 *   without leaking permits.
 */
export class RuntimeConcurrencyLimiter {
  private readonly defaultLimit: number
  private readonly overrides = new Map<string, number>()
  private readonly buckets = new Map<string, RuntimeBucket>()
  private seq = 0
  private disposed = false

  constructor(
    defaultLimit = DEFAULT_MAX_CONCURRENT_TURNS_PER_RUNTIME,
    initialOverrides?: Readonly<Record<string, number>>,
  ) {
    this.defaultLimit = normalizeDefaultLimit(defaultLimit)
    if (initialOverrides) {
      for (const [key, val] of Object.entries(sanitizeRuntimeConcurrencyLimits(initialOverrides))) {
        this.overrides.set(key, val)
      }
    }
  }

  get limit(): number {
    return this.defaultLimit
  }

  getDefaultLimit(): number {
    return this.defaultLimit
  }

  getOverrides(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [key, val] of this.overrides) {
      out[key] = val
    }
    return out
  }

  /** Effective limit for a normalized key (`0` = unlimited). */
  getLimit(rawRuntimeKey: string): number {
    const runtimeKey = normalizeRuntimeConcurrencyKey(rawRuntimeKey)
    const direct = this.overrides.get(runtimeKey)
    if (direct !== undefined) return direct
    const parent = parentRuntimeConcurrencyKey(runtimeKey)
    if (parent) {
      const parentVal = this.overrides.get(parent)
      if (parentVal !== undefined) return parentVal
    }
    return this.defaultLimit
  }

  /**
   * Hot-update a single runtime or profile limit without restarting the service.
   * Passing `null` removes the custom override so the bucket inherits parent/default.
   */
  setOverride(rawRuntimeKey: string, rawLimit: number | null): void {
    const runtimeKey = normalizeRuntimeConcurrencyKey(rawRuntimeKey)
    const parsed = parseRuntimeConcurrencyLimit(rawLimit)
    if (parsed === null) {
      this.overrides.delete(runtimeKey)
    } else {
      this.overrides.set(runtimeKey, parsed)
    }
    const isBaseRuntime = !runtimeKey.includes(RUNTIME_CONCURRENCY_KEY_SEP)
    const prefix = `${runtimeKey}${RUNTIME_CONCURRENCY_KEY_SEP}`
    for (const [bucketKey, bucket] of [...this.buckets.entries()]) {
      if (bucketKey === runtimeKey || (isBaseRuntime && bucketKey.startsWith(prefix))) {
        this.pumpBucket(bucketKey, bucket)
      }
    }
  }

  /** Replace the full override map and immediately pump all active buckets. */
  setOverrides(overrides: Readonly<Record<string, number>>): void {
    this.overrides.clear()
    for (const [key, val] of Object.entries(sanitizeRuntimeConcurrencyLimits(overrides))) {
      this.overrides.set(key, val)
    }
    for (const [bucketKey, bucket] of [...this.buckets.entries()]) {
      this.pumpBucket(bucketKey, bucket)
    }
  }

  async acquire(options: ConcurrencyAcquireOptions): Promise<ConcurrencyLease | undefined> {
    const runtimeKey = normalizeRuntimeConcurrencyKey(options.runtimeKey)
    if (this.disposed || options.signal?.aborted || options.isAborted?.()) {
      return undefined
    }

    const effectiveLimit = this.getLimit(runtimeKey)
    const bucket = this.ensureBucket(runtimeKey)
    if (effectiveLimit === 0 || bucket.active < effectiveLimit) {
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
      maxPerRuntime: this.defaultLimit,
      active,
      queued,
      byRuntime,
    }
  }

  getConfigSnapshot(): RuntimeConcurrencyConfigSnapshot {
    return {
      defaultLimit: this.defaultLimit,
      maxLimit: MAX_CONCURRENT_TURNS_PER_RUNTIME,
      limits: this.getOverrides(),
      stats: this.getStats(),
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
    while (!this.disposed && bucket.waiters.length > 0) {
      const effectiveLimit = this.getLimit(runtimeKey)
      if (effectiveLimit > 0 && bucket.active >= effectiveLimit) break
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
