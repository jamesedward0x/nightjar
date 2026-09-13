/**
 * Token bucket + exponential backoff.
 *
 * Bitget does not publish a rate limit for the v3 market endpoints (a gap we
 * raise in the submission). We therefore assume a tight one and stay well under
 * it: a 20-request burst, refilling 10/s, shared process-wide. Both classes take
 * an injectable clock so they are unit-testable offline with zero real waiting.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface TokenBucketOptions {
  capacity?: number;
  refillPerSecond?: number;
  clock?: Clock;
  /** Ceiling on a single take(), so a misconfigured bucket cannot hang a request. */
  maxWaitMs?: number;
}

export interface TakeResult {
  waitedMs: number;
  available: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly clock: Clock;
  private readonly maxWaitMs: number;
  private tokens: number;
  private updatedAt: number;
  private waits = 0;
  private waitedMsTotal = 0;

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? 20;
    this.refillPerSecond = options.refillPerSecond ?? 10;
    this.clock = options.clock ?? systemClock;
    this.maxWaitMs = options.maxWaitMs ?? 10_000;
    if (this.capacity <= 0) throw new Error("TokenBucket capacity must be > 0");
    if (this.refillPerSecond <= 0) throw new Error("TokenBucket refillPerSecond must be > 0");
    this.tokens = this.capacity;
    this.updatedAt = this.clock.now();
  }

  private refill(at: number): void {
    const elapsedMs = at - this.updatedAt;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
    this.updatedAt = at;
  }

  get available(): number {
    this.refill(this.clock.now());
    return this.tokens;
  }

  /** Non-blocking. Returns false when the bucket cannot pay for cost right now. */
  tryTake(cost = 1): boolean {
    if (cost <= 0) throw new Error("TokenBucket cost must be > 0");
    const at = this.clock.now();
    this.refill(at);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** How long until cost tokens exist, without consuming anything. */
  waitMsFor(cost = 1): number {
    this.refill(this.clock.now());
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil((deficit / this.refillPerSecond) * 1000);
  }

  /** Blocking. Sleeps only as long as the deficit requires. */
  async take(cost = 1): Promise<TakeResult> {
    if (cost > this.capacity) {
      throw new Error("TokenBucket cost " + cost + " exceeds capacity " + this.capacity);
    }
    const startedAt = this.clock.now();
    for (;;) {
      if (this.tryTake(cost)) break;
      const waitMs = Math.min(this.waitMsFor(cost), this.maxWaitMs);
      if (waitMs <= 0) continue;
      this.waits += 1;
      this.waitedMsTotal += waitMs;
      await this.clock.sleep(waitMs);
      if (this.clock.now() - startedAt > this.maxWaitMs) {
        // Last chance; if still short, take what we can and move on rather than hang.
        if (this.tryTake(cost)) break;
        this.refill(this.clock.now());
        this.tokens = Math.max(0, this.tokens - cost);
        break;
      }
    }
    return { waitedMs: this.clock.now() - startedAt, available: this.tokens };
  }

  stats(): { waits: number; waitedMsTotal: number; available: number } {
    return { waits: this.waits, waitedMsTotal: this.waitedMsTotal, available: this.available };
  }
}

/** Process-wide bucket for all keyless Bitget v3 market calls. */
export const bitgetBucket = new TokenBucket({ capacity: 20, refillPerSecond: 10 });

export interface BackoffOptions {
  /** Total attempts including the first. */
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** Fraction of the delay randomised, 0..1. Prevents a thundering herd after an outage. */
  jitter?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  clock?: Clock;
}

export interface ResolvedBackoff {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  random: () => number;
  clock: Clock;
}

export function resolveBackoff(options: BackoffOptions = {}): ResolvedBackoff {
  return {
    maxAttempts: options.maxAttempts ?? 3,
    baseMs: options.baseMs ?? 400,
    maxMs: options.maxMs ?? 5_000,
    factor: options.factor ?? 2,
    jitter: options.jitter ?? 0.2,
    random: options.random ?? Math.random,
    clock: options.clock ?? systemClock,
  };
}

/** attempt is 1-based: the delay BEFORE retrying after attempt N failed. */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const cfg = resolveBackoff(options);
  if (attempt < 1) return 0;
  const raw = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(cfg.factor, attempt - 1));
  const spread = raw * cfg.jitter * (cfg.random() * 2 - 1);
  return Math.max(0, Math.round(raw + spread));
}

export interface BackoffOutcome<T> {
  value: T;
  attempts: number;
  waitedMs: number;
}

/**
 * Retry a task with exponential backoff. Only errors that isRetryable() accepts
 * are retried; anything else propagates immediately so real bugs stay visible.
 */
export async function withBackoff<T>(
  task: (attempt: number) => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  options: BackoffOptions = {},
): Promise<BackoffOutcome<T>> {
  const cfg = resolveBackoff(options);
  let waitedMs = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    try {
      const value = await task(attempt);
      return { value, attempts: attempt, waitedMs };
    } catch (err) {
      lastError = err;
      if (attempt >= cfg.maxAttempts || !isRetryable(err)) throw err;
      const delay = backoffDelayMs(attempt, { ...options, random: cfg.random, clock: cfg.clock });
      waitedMs += delay;
      if (delay > 0) await cfg.clock.sleep(delay);
    }
  }
  throw lastError;
}
