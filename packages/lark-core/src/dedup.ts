export interface SeenMessageEntry {
  readonly key: string
  readonly seenAtMs: number
}

export class MessageDeduplicator {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = 24 * 60 * 60_000,
    private readonly maxEntries = 4096,
  ) {}

  /**
   * Restores persisted seen keys (typically across process restarts) so delayed
   * Feishu webhook/WebSocket retries are never re-processed.
   */
  hydrate(entries: readonly SeenMessageEntry[], now = Date.now()): void {
    const valid = entries
      .filter((e) => typeof e.key === 'string' && e.key.length > 0 && Number.isFinite(e.seenAtMs))
      .filter((e) => now - e.seenAtMs < this.ttlMs)
      .sort((a, b) => a.seenAtMs - b.seenAtMs)

    const slice = valid.length > this.maxEntries ? valid.slice(-this.maxEntries) : valid
    for (const entry of slice) {
      this.seen.set(entry.key, entry.seenAtMs)
    }
    this.prune(now)
  }

  /**
   * Returns active non-expired seen entries in chronological order for persistence.
   */
  exportEntries(now = Date.now()): SeenMessageEntry[] {
    this.prune(now)
    const out: SeenMessageEntry[] = []
    for (const [key, seenAtMs] of this.seen) {
      out.push({ key, seenAtMs })
    }
    return out
  }

  /**
   * Returns true if this key is new and has now been recorded; false if already seen.
   */
  claim(key: string, now = Date.now()): boolean {
    this.prune(now)
    const existing = this.seen.get(key)
    if (existing !== undefined && now - existing < this.ttlMs) {
      return false
    }
    this.seen.delete(key)
    this.seen.set(key, now)
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return true
  }

  private prune(now: number): void {
    for (const [k, ts] of this.seen) {
      if (now - ts >= this.ttlMs) {
        this.seen.delete(k)
      } else {
        break
      }
    }
  }
}
