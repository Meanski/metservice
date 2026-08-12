/**
 * A tiny in-memory TTL cache keyed by request URL.
 *
 * Purpose: keep beta exploration from burning the rate limit (≤100 req/min, abuse revokes
 * access) and lean on the fact that tide data is deterministic. Lives for the process
 * lifetime — an MCP stdio server is a long-running process, so repeated tool calls within a
 * session are served from memory.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class TtlCache {
  private store = new Map<string, Entry>();

  /** Returns the cached value if present and unexpired, else undefined. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** Store a value under key for `ttlMs`. A ttlMs <= 0 means "do not cache". */
  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Fetch-through helper: return cached value or compute, store, and return it. */
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  clear(): void {
    this.store.clear();
  }
}

/** Per-resource TTLs. Discovery data is effectively static; predictions are deterministic. */
export const TTL = {
  /** /stations, /models, /stations/{id}, /models/{id} — change ~never. */
  discovery: 6 * 60 * 60 * 1000, // 6h
  /** tidetimes / timeseries — deterministic, but keep moderate so windows roll forward. */
  prediction: 30 * 60 * 1000, // 30min
  /** /health — never cache. */
  health: 0,
} as const;
