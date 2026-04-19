export class SeenNonceCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  /**
   * Records a nonce for `nowMs` and rejects duplicates still within TTL.
   */
  checkAndRemember(
    nonce: string,
    nowMs: number
  ): { ok: true } | { ok: false; reason: "replay" } {
    this.prune(nowMs);
    if (this.seen.has(nonce)) {
      return { ok: false, reason: "replay" };
    }
    this.seen.set(nonce, nowMs);
    this.evictIfNeeded();
    return { ok: true };
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.ttlMs;
    for (const [nonce, seenAt] of this.seen) {
      if (seenAt < cutoff) {
        this.seen.delete(nonce);
      }
    }
  }

  private evictIfNeeded(): void {
    if (this.seen.size <= this.maxEntries) {
      return;
    }
    const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
    const overflow = this.seen.size - this.maxEntries;
    for (let i = 0; i < overflow; i++) {
      const first = entries[i];
      if (first) {
        this.seen.delete(first[0]);
      }
    }
  }
}
