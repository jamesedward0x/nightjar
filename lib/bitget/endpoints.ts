/**
 * Typed wrappers - one per verified Bitget v3 market endpoint.
 *
 * Every function returns SafeResult<T>: it never throws, it is cached, and the
 * value it hands back has already passed its Zod schema. Query strings here are
 * EXACTLY the ones that were recorded into lib/fixtures/, so fixture mode matches
 * by construction rather than by luck.
 *
 * Parameter limits in this file are the ones we probed, not the ones we assumed:
 *   - /candles          accepts limit=1000
 *   - /history-candles  caps at limit=100 (200+ returns code 40020)
 *   - /open-interest    REQUIRES ?category, and wraps rows in {list, ts}
 *   - /history-fund-rate REQUIRES ?category, and wraps rows in {resultList}
 *   - /current-fund-rate returns an ARRAY of one object, not an object
 *   - /index-components and /current-fund-rate take ?symbol but no ?category
 *   - /discount-rate    IGNORES ?symbol entirely and returns every coin (~427KB)
 */

import type { EndpointSpec } from "@/lib/bitget/client";
import { safeFetch, type SafeResult } from "@/lib/bitget/safe-invoke";
import {
  candlesSchema,
  currentFundRateSchema,
  discountRateSchema,
  fillsSchema,
  historyFundRateSchema,
  indexComponentsSchema,
  instrumentsSchema,
  openInterestSchema,
  orderbookSchema,
  tickersSchema,
  type CandleRow,
  type CurrentFundRateRow,
  type DiscountRateRow,
  type Fill,
  type HistoryFundRate,
  type IndexComponents,
  type Instrument,
  type OpenInterest,
  type Orderbook,
  type Ticker,
} from "@/lib/schema/bitget";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger("bitget.endpoints");

export type Category = "SPOT" | "USDT-FUTURES";
export const SPOT: Category = "SPOT";
export const FUTURES: Category = "USDT-FUTURES";

/** Only these two were recorded and verified. Adding one means recording a fixture for it. */
export const VERIFIED_INTERVALS = ["1H", "1D"] as const;
export type Interval = (typeof VERIFIED_INTERVALS)[number];

export const CANDLE_TYPES = ["market", "index", "premium"] as const;
export type CandleType = (typeof CANDLE_TYPES)[number];

export const CANDLES_MAX_LIMIT = 1000;
/** /history-candles rejects 200+ with code 40020. Verified, not guessed. */
export const HISTORY_CANDLES_MAX_LIMIT = 100;
export const ORDERBOOK_MAX_LIMIT = 20;
export const FILLS_MAX_LIMIT = 100;

function clamp(name: string, value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return max;
  if (value > max) {
    log.warn("param.clamped", { param: name, requested: value, max });
    return max;
  }
  return Math.floor(value);
}

function ttlForInterval(interval: Interval): "candles1H" | "candles1D" {
  return interval === "1D" ? "candles1D" : "candles1H";
}

// ---------------------------------------------------------------- instruments

export function instrumentsSpec(category: Category): EndpointSpec<Instrument[]> {
  return {
    id: "instruments-" + category.toLowerCase(),
    path: "/instruments",
    query: { category },
    schema: instrumentsSchema,
    ttl: "instruments",
  };
}

export function getInstruments(category: Category): Promise<SafeResult<Instrument[]>> {
  return safeFetch(instrumentsSpec(category));
}

// -------------------------------------------------------------------- tickers

export function tickersSpec(category: Category, symbol?: string): EndpointSpec<Ticker[]> {
  return {
    id: "tickers-" + category.toLowerCase() + (symbol ? "-" + symbol : "-all"),
    path: "/tickers",
    query: symbol ? { category, symbol } : { category },
    schema: tickersSchema,
    ttl: "tickers",
  };
}

/** One symbol. FUTURES rows additionally carry indexPrice / markPrice / fundingRate / openInterest. */
export function getTicker(category: Category, symbol: string): Promise<SafeResult<Ticker[]>> {
  return safeFetch(tickersSpec(category, symbol));
}

/** Whole category. Large; only used for screening, never per-symbol lookups. */
export function getAllTickers(category: Category): Promise<SafeResult<Ticker[]>> {
  return safeFetch(tickersSpec(category));
}

// -------------------------------------------------------------------- candles

export interface CandlesRequest {
  category: Category;
  symbol: string;
  interval: Interval;
  /** FUTURES only. SPOT candles take no type parameter - omitting it is what we recorded. */
  type?: CandleType;
  limit?: number;
}

export function candlesSpec(request: CandlesRequest): EndpointSpec<CandleRow[]> {
  const limit = clamp("limit", request.limit ?? CANDLES_MAX_LIMIT, CANDLES_MAX_LIMIT);
  const isFutures = request.category === FUTURES;
  const type = request.type ?? "market";
  return {
    id: "candles-" + request.category.toLowerCase() + "-" + request.symbol + "-" + request.interval + "-" + type,
    path: "/candles",
    // SPOT: no type param. FUTURES: type is required to distinguish market|index|premium.
    query: isFutures
      ? { category: request.category, symbol: request.symbol, interval: request.interval, type, limit }
      : { category: request.category, symbol: request.symbol, interval: request.interval, limit },
    schema: candlesSchema,
    ttl: ttlForInterval(request.interval),
  };
}

export function getCandles(request: CandlesRequest): Promise<SafeResult<CandleRow[]>> {
  return safeFetch(candlesSpec(request));
}

/** The reference price series. Equal-weight Binance + Hyperliquid + Pyth composite. */
export function getIndexCandles(symbol: string, interval: Interval, limit?: number): Promise<SafeResult<CandleRow[]>> {
  return getCandles({ category: FUTURES, symbol, interval, type: "index", limit });
}

/** Premium rows are FRACTIONS of the index price, not prices. 0.001582839 = +0.158%. */
export function getPremiumCandles(symbol: string, interval: Interval, limit?: number): Promise<SafeResult<CandleRow[]>> {
  return getCandles({ category: FUTURES, symbol, interval, type: "premium", limit });
}

export type HistoryCandlesRequest = CandlesRequest;

export function historyCandlesSpec(request: HistoryCandlesRequest): EndpointSpec<CandleRow[]> {
  const limit = clamp("limit", request.limit ?? HISTORY_CANDLES_MAX_LIMIT, HISTORY_CANDLES_MAX_LIMIT);
  const isFutures = request.category === FUTURES;
  const type = request.type ?? "market";
  return {
    id: "history-candles-" + request.category.toLowerCase() + "-" + request.symbol + "-" + request.interval + "-" + type,
    path: "/history-candles",
    query: isFutures
      ? { category: request.category, symbol: request.symbol, interval: request.interval, type, limit }
      : { category: request.category, symbol: request.symbol, interval: request.interval, limit },
    schema: candlesSchema,
    ttl: ttlForInterval(request.interval),
  };
}

/** Older history. Same row shape as /candles but a hard 100-row ceiling. */
export function getHistoryCandles(request: HistoryCandlesRequest): Promise<SafeResult<CandleRow[]>> {
  return safeFetch(historyCandlesSpec(request));
}

// ------------------------------------------------------------ index components

export function indexComponentsSpec(symbol: string): EndpointSpec<IndexComponents> {
  return {
    id: "index-components-" + symbol,
    path: "/index-components",
    query: { symbol },
    schema: indexComponentsSchema,
    ttl: "indexComponents",
  };
}

/** The reference-price recipe. No category parameter. */
export function getIndexComponents(symbol: string): Promise<SafeResult<IndexComponents>> {
  return safeFetch(indexComponentsSpec(symbol));
}

// ------------------------------------------------------------------ orderbook

export function orderbookSpec(category: Category, symbol: string, limit = ORDERBOOK_MAX_LIMIT): EndpointSpec<Orderbook> {
  return {
    id: "orderbook-" + category.toLowerCase() + "-" + symbol,
    path: "/orderbook",
    query: { category, symbol, limit: clamp("limit", limit, ORDERBOOK_MAX_LIMIT) },
    schema: orderbookSchema,
    ttl: "orderbook",
  };
}

/**
 * Depth. The only endpoint whose levels are JSON numbers, not strings.
 * Asks ascend, bids descend. This - not candle volume - is how we price an exit.
 */
export function getOrderbook(category: Category, symbol: string, limit?: number): Promise<SafeResult<Orderbook>> {
  return safeFetch(orderbookSpec(category, symbol, limit));
}

// ---------------------------------------------------------------------- fills

export function fillsSpec(category: Category, symbol: string, limit = FILLS_MAX_LIMIT): EndpointSpec<Fill[]> {
  return {
    id: "fills-" + category.toLowerCase() + "-" + symbol,
    path: "/fills",
    query: { category, symbol, limit: clamp("limit", limit, FILLS_MAX_LIMIT) },
    schema: fillsSchema,
    ttl: "fills",
  };
}

/**
 * The tape. Spot rToken candle volumes are internally inconsistent (DECISION.md F4),
 * so realised turnover and trade size come from here instead.
 */
export function getFills(category: Category, symbol: string, limit?: number): Promise<SafeResult<Fill[]>> {
  return safeFetch(fillsSpec(category, symbol, limit));
}

// -------------------------------------------------------------------- funding

export function currentFundRateSpec(symbol: string): EndpointSpec<CurrentFundRateRow[]> {
  return {
    id: "current-fund-rate-" + symbol,
    path: "/current-fund-rate",
    query: { symbol },
    schema: currentFundRateSchema,
    ttl: "funding",
  };
}

/** Returns an ARRAY of one row. cashDividendNextUpdate may be the literal "null". */
export function getCurrentFundRate(symbol: string): Promise<SafeResult<CurrentFundRateRow[]>> {
  return safeFetch(currentFundRateSpec(symbol));
}

export function historyFundRateSpec(symbol: string, pageSize = 50): EndpointSpec<HistoryFundRate> {
  return {
    id: "history-fund-rate-" + symbol + "-" + pageSize,
    path: "/history-fund-rate",
    query: { symbol, category: FUTURES, pageSize },
    schema: historyFundRateSchema,
    ttl: "funding",
  };
}

/** Requires ?category. Rows live under resultList. */
export function getHistoryFundRate(symbol: string, pageSize?: number): Promise<SafeResult<HistoryFundRate>> {
  return safeFetch(historyFundRateSpec(symbol, pageSize));
}

export function openInterestSpec(symbol: string, limit = 50): EndpointSpec<OpenInterest> {
  return {
    id: "open-interest-" + symbol + "-" + limit,
    path: "/open-interest",
    query: { symbol, category: FUTURES, limit },
    schema: openInterestSchema,
    ttl: "openInterest",
  };
}

/** Requires ?category. Rows live under {list, ts}, NOT a flat array. */
export function getOpenInterest(symbol: string, limit?: number): Promise<SafeResult<OpenInterest>> {
  return safeFetch(openInterestSpec(symbol, limit));
}

// -------------------------------------------------------------- discount rate

export function discountRateSpec(): EndpointSpec<DiscountRateRow[]> {
  return {
    id: "discount-rate",
    path: "/discount-rate",
    // Deliberately no symbol: the endpoint ignores it and returns every coin anyway.
    query: {},
    schema: discountRateSchema,
    ttl: "discountRate",
  };
}

/**
 * ~500 coins, ~427KB, ignores ?symbol. Cached 24h and never called per request.
 * Fetching this on the hot path is the single easiest way to blow a serverless budget.
 */
export function getDiscountRate(): Promise<SafeResult<DiscountRateRow[]>> {
  return safeFetch(discountRateSpec());
}
