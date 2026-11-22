export class MessageDeduplicator {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 4096,
  ) {}

  /**
   * Returns true if this key is new and has now been recorded; false if already seen.
   */
  claim(key: string, now = Date.now()): boolean {
    this.prune(now)
    const existing = this.seen.get(key)
    if (existing !== undefined && now - existing < this.ttlMs) {
      return false
    }
    this.seen.set(key, now)
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
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
