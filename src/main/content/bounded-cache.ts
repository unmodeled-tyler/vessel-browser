interface CacheEntry<V> {
  capturedAt: number;
  content: V;
}

/**
 * Simple bounded TTL cache backed by a Map. Evicts the oldest entry when
 * maxEntries is exceeded, and ignores entries older than ttlMs.
 * Unlike a true LRU, we only evict oldest-by-insertion — good enough for
 * short-lived extraction caches where entries have similar lifetimes.
 */
export class BoundedCache<V> {
  private map = new Map<string, CacheEntry<V>>();

  constructor(
    private ttlMs: number,
    private maxEntries: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.capturedAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.content;
  }

  set(key: string, value: V): void {
    this.map.set(key, { capturedAt: Date.now(), content: value });
    if (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey) this.map.delete(oldestKey);
    }
  }

  invalidateByPrefix(prefix: string): void {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
