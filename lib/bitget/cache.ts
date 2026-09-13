/**
 * In-memory TTL cache with in-flight coalescing.
 *
 * Deliberately NOT a durable store. Nightjar holds no authoritative state, so a
 * cold start is always safe: the worst case is one extra upstream call. This is
 * what makes the cache legal on Vercel's ephemeral serverless instances.
 *
 * Coalescing matters more than TTL here. One page render fans out to tickers +
 * candles + orderbook for the same symbol; without coalescing, N concurrent
 * visitors would each fire their own copy of an endpoint that is already in
 * flight. Bitget does not publish a rate limit for market endpoints, so we
 * assume the tightest one and never duplicate a call we have not finished.
 */

import { CACHE_TTL_MS, type CacheTtlKey } from "@/lib/config";

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  sets: number;
  coalesced: number;
  evictions: number;
}

export type CacheLookup<T> =
  | { hit: true; value: T; storedAt: number; expiresAt: number; ageMs: number }
  | { hit: false };

export interface WrapResult<T> {
  value: T;
  fromCache: boolean;
  /** True when this call joined an already-running load instead of starting one. */
  coalesced: boolean;
  storedAt: number;
  expiresAt: number;
}

export interface TtlCacheOptions {
  maxEntries?: number;
  /** Injectable so tests never have to sleep. */
  now?: () => number;
}

interface Entry {
  value: unknown;
  storedAt: number;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 512;

export class TtlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private coalesced = 0;
  private evictions = 0;

  constructor(options: TtlCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get<T>(key: string): CacheLookup<T> {
    const at = this.now();
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return { hit: false };
    }
    if (entry.expiresAt <= at) {
      this.entries.delete(key);
      this.misses += 1;
      return { hit: false };
    }
    // Re-insert so Map iteration order is recency order (cheap LRU).
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { hit: true, value: entry.value as T, storedAt: entry.storedAt, expiresAt: entry.expiresAt, ageMs: at - entry.storedAt };
  }

  set<T>(key: string, value: T, ttlMs: number): { storedAt: number; expiresAt: number } {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("TtlCache.set requires a positive ttlMs, got " + String(ttlMs));
    }
    const storedAt = this.now();
    const expiresAt = storedAt + ttlMs;
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt, expiresAt });
    this.sets += 1;
    this.evict();
    return { storedAt, expiresAt };
  }

  has(key: string): boolean {
    return this.get(key).hit;
  }

  delete(key: string): boolean {
    this.inflight.delete(key);
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  stats(): CacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      coalesced: this.coalesced,
      evictions: this.evictions,
    };
  }

  /**
   * Read-through with coalescing. Concurrent callers for the same key share one
   * load; a failed load is never cached, and never leaves a stuck in-flight entry.
   */
  async wrap<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<WrapResult<T>> {
    const cached = this.get<T>(key);
    if (cached.hit) {
      return { value: cached.value, fromCache: true, coalesced: false, storedAt: cached.storedAt, expiresAt: cached.expiresAt };
    }

    const running = this.inflight.get(key);
    if (running) {
      this.coalesced += 1;
      const value = (await running) as T;
      const fresh = this.get<T>(key);
      return {
        value,
        fromCache: fresh.hit,
        coalesced: true,
        storedAt: fresh.hit ? fresh.storedAt : this.now(),
        expiresAt: fresh.hit ? fresh.expiresAt : this.now(),
      };
    }

    const promise = loader();
    this.inflight.set(key, promise);
    try {
      const value = await promise;
      const { storedAt, expiresAt } = this.set(key, value, ttlMs);
      return { value, fromCache: false, coalesced: false, storedAt, expiresAt };
    } finally {
      // Delete only if it is still OUR promise; a newer load may have replaced it.
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    // Expired first, then oldest-inserted. Map iteration order is insertion order,
    // and get() re-inserts on hit, so the first key is the least recently used.
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (entry.expiresAt <= at) {
        this.entries.delete(key);
        this.evictions += 1;
      }
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) return;
      this.entries.delete(key);
      this.evictions += 1;
    }
  }
}

/** The one process-wide cache. Keyed by endpoint + query, built in endpoints.ts. */
export const bitgetCache = new TtlCache({ maxEntries: 512 });

export function ttlFor(key: CacheTtlKey): number {
  return CACHE_TTL_MS[key];
}

/** Canonical cache key. Query values are sorted so {a,b} and {b,a} collide. */
export function cacheKey(endpoint: string, query: Record<string, string | number | undefined> = {}): string {
  const parts: string[] = [];
  for (const name of Object.keys(query).sort()) {
    const value = query[name];
    if (value === undefined || value === null || value === "") continue;
    parts.push(name + "=" + String(value));
  }
  return endpoint + (parts.length ? "?" + parts.join("&") : "");
}
