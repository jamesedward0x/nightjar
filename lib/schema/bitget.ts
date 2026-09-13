/**
 * Zod schemas for every Bitget v3 market response Nightjar depends on.
 *
 * These were written from RECORDED payloads in lib/fixtures/, not from the docs.
 * Two wire facts drive the whole file:
 *   1. Every scalar arrives as a STRING, including numbers and timestamps.
 *   2. "" and the literal "null" are Bitget's sentinels for "absent".
 * Neither is interpreted here. This layer only proves the shape; lib/bitget/decode.ts
 * is the single place that turns strings into numbers.
 *
 * Objects use .passthrough() because SPOT and USDT-FUTURES instruments share a core
 * and each adds its own fields. Rejecting unknown keys would break us the day Bitget
 * adds a column, and we gain nothing from it: we never forward raw payloads to a user.
 */

import { z } from "zod";

/** v3 signals success with "00000". v2 used "0". Both are accepted (DECISION.md 11.4). */
export const SUCCESS_CODES: readonly string[] = ["0", "00000"];

export function isSuccessCode(code: unknown): boolean {
  return typeof code === "string" && SUCCESS_CODES.includes(code);
}

/** A wire scalar. Always a string on the wire; "" and "null" are legitimate values. */
const wire = z.string();
/** A wire scalar that may also be missing or JSON-null. */
const wireOpt = z.string().nullish();

export const envelopeSchema = z
  .object({
    code: z.string(),
    msg: z.string().nullish(),
    requestTime: z.union([z.string(), z.number()]).nullish(),
    data: z.unknown(),
  })
  .passthrough();

// ---------------------------------------------------------------- instruments

/** Shared core of SPOT and USDT-FUTURES instruments. */
export const instrumentSchema = z
  .object({
    symbol: wire,
    category: wireOpt,
    baseCoin: wire,
    quoteCoin: wire,
    symbolType: wireOpt,
    status: wireOpt,
    launchTime: wireOpt,
    minOrderQty: wireOpt,
    maxOrderQty: wireOpt,
    minOrderAmount: wireOpt,
    pricePrecision: wireOpt,
    quantityPrecision: wireOpt,
    quotePrecision: wireOpt,
    // USDT-FUTURES only. Absent (not "") on SPOT rows.
    isRwa: wireOpt,
    type: wireOpt,
    makerFeeRate: wireOpt,
    takerFeeRate: wireOpt,
    fundInterval: wireOpt,
  })
  .passthrough();

export const instrumentsSchema = z.array(instrumentSchema);

// ------------------------------------------------------------------- tickers

/** SPOT and USDT-FUTURES tickers share a core; futures add index/mark/funding/OI. */
export const tickerSchema = z
  .object({
    symbol: wire,
    category: wireOpt,
    ts: wireOpt,
    lastPrice: wireOpt,
    openPrice24h: wireOpt,
    highPrice24h: wireOpt,
    lowPrice24h: wireOpt,
    ask1Price: wireOpt,
    bid1Price: wireOpt,
    ask1Size: wireOpt,
    bid1Size: wireOpt,
    price24hPcnt: wireOpt,
    volume24h: wireOpt,
    turnover24h: wireOpt,
    // USDT-FUTURES only
    indexPrice: wireOpt,
    markPrice: wireOpt,
    fundingRate: wireOpt,
    openInterest: wireOpt,
  })
  .passthrough();

export const tickersSchema = z.array(tickerSchema);

// ------------------------------------------------------------------- candles

/**
 * [ts, open, high, low, close, baseVolume, quoteVolume] - ascending, all strings.
 * type=index and type=premium rows carry "0","0" volumes; premium OHLC are
 * FRACTIONS (0.001582839 = +0.158%), not prices.
 */
export const candleRowSchema = z.tuple([wire, wire, wire, wire, wire, wire, wire]);
export const candlesSchema = z.array(candleRowSchema);

// ----------------------------------------------------------------- orderbook

/** The one endpoint where levels are JSON NUMBERS, not strings. Asks ascend, bids descend. */
export const bookLevelSchema = z.tuple([z.number(), z.number()]);
export const orderbookSchema = z
  .object({
    a: z.array(bookLevelSchema),
    b: z.array(bookLevelSchema),
    ts: wireOpt,
  })
  .passthrough();

// --------------------------------------------------------------------- fills

/**
 * The tape. This is our liquidity source of truth for rTokens: the candle
 * volume columns for spot rTokens are internally inconsistent (DECISION.md F4),
 * so turnover is derived from fills and depth from orderbook instead.
 */
export const fillSchema = z
  .object({
    execId: wire,
    price: wire,
    size: wire,
    side: z.enum(["buy", "sell"]),
    ts: wire,
    execLinkId: wireOpt,
    isRPI: wireOpt,
  })
  .passthrough();

export const fillsSchema = z.array(fillSchema);

// ----------------------------------------------------------- index components

/** The reference-price recipe: Binance + Hyperliquid + Pyth, equal 0.3333 weight. */
export const indexComponentSchema = z
  .object({
    exchange: wire,
    spotPair: wireOpt,
    equivalentPrice: wireOpt,
    weight: wireOpt,
  })
  .passthrough();

export const indexComponentsSchema = z
  .object({
    symbol: wire,
    componentList: z.array(indexComponentSchema),
  })
  .passthrough();

// --------------------------------------------------------------- funding / OI

/** Returns an ARRAY of one object, not an object. cashDividendNextUpdate can be "null". */
export const currentFundRateRowSchema = z
  .object({
    symbol: wire,
    fundingRate: wireOpt,
    fundingRateInterval: wireOpt,
    nextUpdate: wireOpt,
    minFundingRate: wireOpt,
    maxFundingRate: wireOpt,
    cashDividend: wireOpt,
    cashDividendNextUpdate: wireOpt,
  })
  .passthrough();

export const currentFundRateSchema = z.array(currentFundRateRowSchema);

export const historyFundRateRowSchema = z
  .object({
    symbol: wire,
    fundingRate: wireOpt,
    fundingRateTimestamp: wireOpt,
  })
  .passthrough();

/** Requires ?category. Wraps rows in resultList, not a bare array. */
export const historyFundRateSchema = z
  .object({
    resultList: z.array(historyFundRateRowSchema),
  })
  .passthrough();

/** Requires ?category. Wraps rows in {list, ts}, not a bare array. */
export const openInterestRowSchema = z
  .object({
    symbol: wire,
    openInterest: wireOpt,
  })
  .passthrough();

export const openInterestSchema = z
  .object({
    list: z.array(openInterestRowSchema),
    ts: wireOpt,
  })
  .passthrough();

/** Ignores ?symbol and returns ~500 coins / ~427KB. Cached 24h; never per-request. */
export const discountRateTierSchema = z
  .object({
    tierStartValue: wireOpt,
    discountRate: wireOpt,
  })
  .passthrough();

export const discountRateRowSchema = z
  .object({
    coin: wire,
    list: z.array(discountRateTierSchema),
  })
  .passthrough();

export const discountRateSchema = z.array(discountRateRowSchema);

// ------------------------------------------------------------------ inference

export type Envelope = z.infer<typeof envelopeSchema>;
export type Instrument = z.infer<typeof instrumentSchema>;
export type Ticker = z.infer<typeof tickerSchema>;
export type CandleRow = z.infer<typeof candleRowSchema>;
export type BookLevel = z.infer<typeof bookLevelSchema>;
export type Orderbook = z.infer<typeof orderbookSchema>;
export type Fill = z.infer<typeof fillSchema>;
export type IndexComponent = z.infer<typeof indexComponentSchema>;
export type IndexComponents = z.infer<typeof indexComponentsSchema>;
export type CurrentFundRateRow = z.infer<typeof currentFundRateRowSchema>;
export type HistoryFundRate = z.infer<typeof historyFundRateSchema>;
export type OpenInterest = z.infer<typeof openInterestSchema>;
export type DiscountRateRow = z.infer<typeof discountRateRowSchema>;
