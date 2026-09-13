/**
 * Unit tests for the throttle and the retry policy.
 *
 * Bitget publishes no rate limit for the v3 market endpoints (a gap we raise in the
 * submission), so lib/bitget/ratelimit.ts assumes a tight one: a 20-request burst
 * refilling at 10/s, plus bounded exponential backoff with jitter. Phase 1's
 * acceptance criterion is that this "demonstrably works", which means it has to be
 * observable in a test - so both classes take an injectable clock and these tests
 * assert exact millisecond behaviour with zero real waiting.
 *
 * The last two tests go through restGet() itself, because the guarantee that matters
 * is not "TokenBucket sleeps" but "a rate-limited Bitget call is retried and still
 * returns data, while a business error is NOT retried".
 */

import { describe, expect, it } from "vitest";
import { NetworkError, RateLimitError } from "@bitget-ai/bitget-agent-sdk";

import { NightjarError } from "@/lib/bitget/errors";
import { TokenBucket, backoffDelayMs, withBackoff, type Clock } from "@/lib/bitget/ratelimit";
import { isRetryableUpstreamError, restGet, type RawEnvelope } from "@/lib/bitget/client";

/** A clock we drive by hand: sleep() advances time instead of burning it. */
function fakeClock(start = 0): { clock: Clock; sleeps: number[]; advance: (ms: number) => void; time: () => number } {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
  };
}

describe("TokenBucket", () => {
  it("passes a full burst without waiting, then makes the next call pay for refill", async () => {
    const fake = fakeClock();
    const bucket = new TokenBucket({ capacity: 20, refillPerSecond: 10, clock: fake.clock });
    for (let i = 0; i < 20; i += 1) expect(bucket.tryTake(), "burst request " + i).toBe(true);
    expect(bucket.tryTake(), "the 21st request must not be free").toBe(false);
    // One token at 10/s costs exactly 100ms.
    expect(bucket.waitMsFor(1)).toBe(100);
    expect(fake.sleeps).toEqual([]);
  });

  it("sleeps only the deficit, not a fixed poll interval", async () => {
    const fake = fakeClock();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10, clock: fake.clock });
    expect((await bucket.take(2)).waitedMs).toBe(0);

    const third = await bucket.take(1);
    expect(fake.sleeps).toEqual([100]);
    expect(third.waitedMs).toBe(100);
    expect(bucket.stats()).toEqual({ waits: 1, waitedMsTotal: 100, available: 0 });
  });

  it("refills proportionally to idle time but never above capacity", () => {
    const fake = fakeClock();
    const bucket = new TokenBucket({ capacity: 4, refillPerSecond: 10, clock: fake.clock });
    expect(bucket.tryTake(4)).toBe(true);
    expect(bucket.available).toBe(0);
    // 500ms idle is worth 5 tokens at 10/s; the bucket must clamp at 4.
    fake.advance(500);
    expect(bucket.available).toBe(4);
  });

  it("caps a single wait at maxWaitMs so a starved bucket cannot hang a request", async () => {
    const fake = fakeClock();
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.001, clock: fake.clock, maxWaitMs: 500 });
    expect(bucket.tryTake()).toBe(true);

    const outcome = await bucket.take(1);
    expect(fake.sleeps.length).toBeGreaterThan(0);
    expect(fake.sleeps.every((ms) => ms <= 500), "no single sleep may exceed maxWaitMs").toBe(true);
    expect(outcome.waitedMs).toBeLessThanOrEqual(1000);
    expect(bucket.stats().waits).toBeGreaterThan(0);
  });

  it("rejects a nonsensical configuration instead of deadlocking on it", () => {
    expect(() => new TokenBucket({ capacity: 0 })).toThrow(/capacity/);
    expect(() => new TokenBucket({ refillPerSecond: 0 })).toThrow(/refillPerSecond/);
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, clock: fakeClock().clock });
    expect(() => bucket.tryTake(0)).toThrow(/cost/);
    expect(bucket.waitMsFor(1)).toBe(0);
  });
});

describe("backoffDelayMs", () => {
  const flat = { jitter: 0, baseMs: 400, factor: 2, maxMs: 5000 };

  it("doubles each attempt and stops at maxMs", () => {
    expect(backoffDelayMs(0, flat)).toBe(0);
    expect(backoffDelayMs(1, flat)).toBe(400);
    expect(backoffDelayMs(2, flat)).toBe(800);
    expect(backoffDelayMs(3, flat)).toBe(1600);
    expect(backoffDelayMs(4, flat)).toBe(3200);
    expect(backoffDelayMs(5, flat)).toBe(5000);
    expect(backoffDelayMs(50, flat)).toBe(5000);
  });

  it("keeps jitter inside +/- the configured fraction, whatever the RNG returns", () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffDelayMs(2, { jitter: 0.2, baseMs: 400, factor: 2, maxMs: 5000, random: () => value });
      expect(delay, "random() = " + value).toBeGreaterThanOrEqual(640);
      expect(delay, "random() = " + value).toBeLessThanOrEqual(960);
    }
  });
});

describe("withBackoff", () => {
  it("retries a retryable failure and reports what it cost", async () => {
    const fake = fakeClock();
    let calls = 0;
    const outcome = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new RateLimitError("Too many requests");
        return "ok";
      },
      (err) => err instanceof RateLimitError,
      { clock: fake.clock, jitter: 0, baseMs: 100, maxAttempts: 3 },
    );
    expect(outcome).toEqual({ value: "ok", attempts: 3, waitedMs: 300 });
    expect(fake.sleeps).toEqual([100, 200]);
  });

  it("propagates a non-retryable failure immediately, without spending attempts", async () => {
    const fake = fakeClock();
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new NightjarError("upstream_error_code", "bad parameter");
        },
        () => false,
        { clock: fake.clock, maxAttempts: 5 },
      ),
    ).rejects.toThrow(/bad parameter/);
    expect(calls).toBe(1);
    expect(fake.sleeps).toEqual([]);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const fake = fakeClock();
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new NetworkError("socket hang up", "/api/v3/market/tickers");
        },
        isRetryableUpstreamError,
        { clock: fake.clock, jitter: 0, baseMs: 10, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(3);
  });
});

describe("isRetryableUpstreamError", () => {
  it("retries transport failures and nothing else", () => {
    expect(isRetryableUpstreamError(new RateLimitError("429"))).toBe(true);
    expect(isRetryableUpstreamError(new NetworkError("down", "/api/v3/market/tickers"))).toBe(true);
    expect(isRetryableUpstreamError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableUpstreamError(new NightjarError("network", "dns"))).toBe(true);
    // A well-formed response carrying a business error is a fact, not a hiccup.
    expect(isRetryableUpstreamError(new NightjarError("upstream_error_code", "unknown symbol"))).toBe(false);
    expect(isRetryableUpstreamError(new Error("our own bug"))).toBe(false);
  });
});

describe("restGet under a rate-limited upstream", () => {
  function ok(data: unknown): RawEnvelope {
    return { code: "00000", msg: "success", requestTime: 1789300207961, data, endpoint: "/api/v3/market/tickers", latencyMs: 1 };
  }

  it("retries a RateLimitError and still returns a provenance-stamped payload", async () => {
    let calls = 0;
    const envelope = await restGet("/tickers", { category: "SPOT", symbol: "RAAPLUSDT" }, {
      skipRateLimit: true,
      maxAttempts: 3,
      transport: async () => {
        calls += 1;
        if (calls < 3) throw new RateLimitError("Too many requests");
        return ok([]);
      },
    });
    expect(calls).toBe(3);
    expect(envelope.data).toEqual([]);
    // The label must carry the query, or two different calls look identical.
    expect(envelope.endpoint).toBe("GET /api/v3/market/tickers?category=SPOT&symbol=RAAPLUSDT");
    expect(envelope.upstreamTime).toBe(1789300207961);
    expect(envelope.recordedAt).toBeNull();
  }, 20000);

  it("does NOT retry a business error code, so a bad request cannot burn rate limit", async () => {
    let calls = 0;
    await expect(
      restGet("/tickers", { category: "SPOT" }, {
        skipRateLimit: true,
        maxAttempts: 3,
        transport: async () => {
          calls += 1;
          return { code: "40034", msg: "Parameter error", requestTime: 1789300207961, data: null };
        },
      }),
    ).rejects.toThrow(/40034/);
    expect(calls).toBe(1);
  }, 20000);
});
