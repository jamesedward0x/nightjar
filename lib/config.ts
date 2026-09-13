/**
 * Runtime configuration and cache policy for Nightjar.
 *
 * Every TTL here comes from DECISION.md 7.4. The cache is in-memory only:
 * nothing in this app is authoritative state, so a cold start is safe.
 */

export type RuntimeMode = "live" | "fixture";

/** Base URL of the Bitget public REST v3 market API. Keyless. Never derived from user input (SSRF). */
export const BITGET_REST_BASE = "https://api.bitget.com";
export const BITGET_MARKET_PREFIX = "/api/v3/market";

/**
 * Base URL of the Bitget Qwen gateway. We call POST /responses: it is the only
 * surface verified end-to-end for tool calling, streaming and reasoning traces.
 * POST /chat/completions also answers (HTTP 200, reasoning_content inline) but we
 * deliberately do not depend on it - see DECISION.md 11.7.
 */
export const QWEN_GATEWAY_BASE = "https://hackathon.bitgetops.com/v1";

/**
 * SDK v1.2.0 has NO "market" module. Its module list is
 * spot|futures|account|margin|copytrading|convert|earn|p2p|broker.
 * Public market data lives in "spot" and "futures", so that is what we load.
 */
export const BITGET_SDK_MODULES = "spot,futures";

/** Hard invariant: the app never holds Bitget credentials and never builds write tools. */
export const BITGET_READ_ONLY = true;

export const CACHE_TTL_MS = {
  /** Raw instrument lists. Changes rarely; the derived universe keys off these. */
  instruments: 6 * 60 * 60 * 1000,
  /** instruments -> the dual-listed universe. Changes rarely. */
  universe: 6 * 60 * 60 * 1000,
  /** discount-rate ignores ?symbol and returns ~427KB for every coin. Never call per request. */
  discountRate: 24 * 60 * 60 * 1000,
  candles1D: 5 * 60 * 1000,
  candles1H: 60 * 1000,
  tickers: 8 * 1000,
  orderbook: 5 * 1000,
  fills: 8 * 1000,
  funding: 60 * 1000,
  openInterest: 60 * 1000,
  indexComponents: 5 * 60 * 1000,
  health: 15 * 1000,
} as const;

export type CacheTtlKey = keyof typeof CACHE_TTL_MS;

/** Multi-name comparisons are capped to stay inside the serverless timeout. */
export const MAX_SYMBOLS_PER_QUERY = 4;

/**
 * Hard cap on Qwen tool calls in ONE research turn. Enforced by lib/llm/loop.ts.
 * Six is enough for the documented single-name plan (snapshot, distribution, two
 * context tools, emit_memo) plus one retry, and low enough that a looping model
 * cannot spend the whole serverless budget on one question.
 */
export const MAX_TOOL_CALLS = 6;

/**
 * Wall-clock budget for one research turn, in ms. Observed Qwen latency is 3-25s per
 * call and a turn is 2-3 calls, so 90s is a real ceiling rather than a guess. The
 * route exports a matching maxDuration; Vercel Hobby caps functions at 60s, so the
 * loop also honours whatever the platform gives it (see app/api/research/route.ts).
 */
export const RESEARCH_TIMEOUT_MS = 90_000;

/** Milliseconds of the budget held back so we can still emit the fallback memo. */
export const BUDGET_RESERVE_MS = 12_000;
/**
 * Vercel Hobby caps one serverless function at 60s (Pro: 300s). The loop budget must
 * fit inside whatever the platform actually grants, so the route exports
 * `maxDuration = FUNCTION_MAX_DURATION_S` and the budget is clamped here - in one
 * place, where it can be unit-tested - rather than at each call site.
 */
export const FUNCTION_MAX_DURATION_S = 60;
/** Seconds held back at the end of the function for SSE teardown and the final flush. */
export const FUNCTION_TEARDOWN_S = 5;

/**
 * The wall-clock budget one research turn may spend, clamped to the platform limit.
 * RESEARCH_TIMEOUT_MS=90000 therefore yields 55s on Hobby, which is the honest number:
 * a 90s promise we cannot keep would just produce a truncated stream.
 */
export function resolveResearchBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const requested = Number(env.RESEARCH_TIMEOUT_MS) || RESEARCH_TIMEOUT_MS;
  const maxDurationS = Number(env.FUNCTION_MAX_DURATION_S) || FUNCTION_MAX_DURATION_S;
  const platform = (maxDurationS - FUNCTION_TEARDOWN_S) * 1000;
  return Math.max(15_000, Math.min(requested, platform));
}
export function resolveMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return env.NIGHTJAR_MODE === "fixture" ? "fixture" : "live";
}
