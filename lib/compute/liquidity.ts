/**
 * Liquidity, priced the way a desk would price an exit.
 *
 * DECISION.md 2.6 F6 is the reason this file exists in this shape: rToken SPOT candle
 * volume is internally inconsistent (a 1D row claiming 72.78m base volume / $23.88bn
 * quote for an instrument whose 24h turnover is $11k, and a 1D row claiming 34.171
 * while a single 1H row inside it claims 10.77m). So NO function here reads candle
 * volume. Realised activity comes from the tape (/fills), resting size from the book
 * (/orderbook), and headline turnover from tickers.turnover24h.
 *
 * "Cost to exit" is the framing the memo uses, and walkBook is what produces it:
 * consuming the book level by level until a target notional is filled, then reporting
 * the average fill and the slippage against top-of-book.
 */

import { toNum } from "@/lib/bitget/decode";
import type { BookLevel, Fill, Orderbook, Ticker } from "@/lib/schema/bitget";
import { mean, median, percentile, round, sum } from "@/lib/compute/stats";

export interface DepthLevel {
  price: number;
  size: number;
  notional: number;
  cumulativeNotional: number;
}

export interface BookSide {
  levels: DepthLevel[];
  bestPrice: number | null;
  totalNotional: number;
  /** Notional resting in the top 5 levels - the figure quoted in the findings. */
  top5Notional: number;
}

export interface OrderbookSummary {
  ts: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spreadAbs: number | null;
  /** Spread as a percentage of mid. Observed 0.28-0.5% for RAAPLUSDT. */
  spreadPct: number | null;
  bids: BookSide;
  asks: BookSide;
  levelCount: number;
}

function side(levels: BookLevel[]): BookSide {
  const out: DepthLevel[] = [];
  let cumulative = 0;
  for (const level of levels) {
    const price = level[0];
    const size = level[1];
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0) continue;
    const notional = price * size;
    cumulative += notional;
    out.push({ price, size, notional, cumulativeNotional: cumulative });
  }
  const best = out[0];
  return {
    levels: out,
    bestPrice: best ? best.price : null,
    totalNotional: cumulative,
    top5Notional: sum(out.slice(0, 5).map((l) => l.notional)),
  };
}

/** Asks ascend and bids descend on the wire, so element 0 of each is the touch. */
export function summariseOrderbook(book: Orderbook): OrderbookSummary {
  const bids = side(book.b);
  const asks = side(book.a);
  const bestBid = bids.bestPrice;
  const bestAsk = asks.bestPrice;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadAbs = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  return {
    ts: toNum(book.ts),
    bestBid,
    bestAsk,
    midPrice: mid,
    spreadAbs,
    spreadPct: mid !== null && mid > 0 && spreadAbs !== null ? (spreadAbs / mid) * 100 : null,
    bids,
    asks,
    levelCount: Math.max(bids.levels.length, asks.levels.length),
  };
}

export interface BookWalk {
  targetNotional: number;
  filledNotional: number;
  /** Volume-weighted average fill price across the levels consumed. */
  averagePrice: number | null;
  /** Reference price the slippage is measured against (the touch). */
  referencePrice: number | null;
  /** Percentage adverse movement from the touch to the VWAP. Always >= 0. */
  slippagePct: number | null;
  levelsConsumed: number;
  /** False when the visible book cannot absorb the order at all. */
  fullyFilled: boolean;
}

/**
 * Consume a side of the book until targetNotional is filled.
 * To price a SELL, walk the BIDS (you hit resting buy orders).
 */
export function walkBook(levels: DepthLevel[], targetNotional: number, referencePrice: number | null): BookWalk {
  let remaining = Math.max(0, targetNotional);
  let filledNotional = 0;
  let filledSize = 0;
  let consumed = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    consumed++;
    const take = Math.min(remaining, level.notional);
    const takeSize = level.price > 0 ? take / level.price : 0;
    filledNotional += take;
    filledSize += takeSize;
    remaining -= take;
  }
  const averagePrice = filledSize > 0 ? filledNotional / filledSize : null;
  const slippagePct =
    averagePrice !== null && referencePrice !== null && referencePrice > 0
      ? Math.abs((averagePrice - referencePrice) / referencePrice) * 100
      : null;
  return {
    targetNotional,
    filledNotional: round(filledNotional, 2),
    averagePrice: averagePrice === null ? null : round(averagePrice, 6),
    referencePrice,
    slippagePct: slippagePct === null ? null : round(slippagePct, 4),
    levelsConsumed: consumed,
    fullyFilled: remaining <= 1e-9,
  };
}

export interface SlippagePoint {
  notional: number;
  walk: BookWalk;
}

/** The exit-cost curve: how slippage grows with size. This is the "cost to exit" chart. */
export function slippageCurve(summary: OrderbookSummary, notionals: number[]): SlippagePoint[] {
  return notionals.map((notional) => ({
    notional,
    walk: walkBook(summary.bids.levels, notional, summary.bestBid),
  }));
}

export const DEFAULT_EXIT_SIZES_USD = [100, 500, 1000, 5000, 25000, 100000] as const;

export interface TapeStats {
  tradeCount: number;
  spanMs: number;
  spanHours: number | null;
  firstTs: number | null;
  lastTs: number | null;
  /** Age of the most recent print relative to `now`. Hours-apart prints are the story. */
  ageOfLastTradeMs: number | null;
  totalNotional: number;
  medianTradeNotional: number | null;
  largestTradeNotional: number | null;
  buyNotional: number;
  sellNotional: number;
  /** Share of notional initiated by buyers, 0-1. */
  buyShare: number | null;
  tradesPerHour: number | null;
}

/**
 * Tape statistics from /fills. `now` is injected so this stays pure and testable;
 * callers pass Date.now() (or the fixture's recordedAt in fixture mode).
 */
export function tapeStats(fills: Fill[], now: number): TapeStats {
  const notionals: number[] = [];
  let buyNotional = 0;
  let sellNotional = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const fill of fills) {
    const price = toNum(fill.price);
    const size = toNum(fill.size);
    const ts = toNum(fill.ts);
    if (price === null || size === null || price <= 0 || size <= 0) continue;
    const notional = price * size;
    notionals.push(notional);
    if (fill.side === "buy") buyNotional += notional;
    else sellNotional += notional;
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
  }
  const spanMs = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;
  const spanHours = spanMs > 0 ? spanMs / 3_600_000 : null;
  const total = buyNotional + sellNotional;
  return {
    tradeCount: notionals.length,
    spanMs,
    spanHours: spanHours === null ? null : round(spanHours, 3),
    firstTs,
    lastTs,
    ageOfLastTradeMs: lastTs === null ? null : Math.max(0, now - lastTs),
    totalNotional: round(total, 2),
    medianTradeNotional: median(notionals),
    largestTradeNotional: percentile(notionals, 100),
    buyNotional: round(buyNotional, 2),
    sellNotional: round(sellNotional, 2),
    buyShare: total > 0 ? round(buyNotional / total, 4) : null,
    tradesPerHour: spanHours !== null && spanHours > 0 ? round(notionals.length / spanHours, 3) : null,
  };
}

export interface TurnoverAsymmetry {
  spotTurnover24h: number | null;
  perpTurnover24h: number | null;
  /** perp / spot. Observed 11x-1560x across AAPL, TSLA, NVDA, SPY, QQQ. */
  ratio: number | null;
  spotVolume24h: number | null;
  perpVolume24h: number | null;
  interpretation: string;
}

/** How much more of this name trades on the derivative than on the token itself. */
export function turnoverAsymmetry(spotTicker: Ticker | null, perpTicker: Ticker | null): TurnoverAsymmetry {
  const spotTurnover = spotTicker ? toNum(spotTicker.turnover24h) : null;
  const perpTurnover = perpTicker ? toNum(perpTicker.turnover24h) : null;
  const ratio =
    spotTurnover !== null && perpTurnover !== null && spotTurnover > 0 ? perpTurnover / spotTurnover : null;
  return {
    spotTurnover24h: spotTurnover === null ? null : round(spotTurnover, 2),
    perpTurnover24h: perpTurnover === null ? null : round(perpTurnover, 2),
    ratio: ratio === null ? null : round(ratio, 1),
    spotVolume24h: spotTicker ? toNum(spotTicker.volume24h) : null,
    perpVolume24h: perpTicker ? toNum(perpTicker.volume24h) : null,
    interpretation:
      ratio === null
        ? "Turnover comparison unavailable - one side did not report turnover24h."
        : ratio >= 10
          ? `The perpetual turns over ~${round(ratio, 0)}x more value than the tokenized spot. Price discovery for this name happens on the derivative; the rToken is a thin follower.`
          : ratio >= 2
            ? `The perpetual turns over ~${round(ratio, 1)}x more value than the tokenized spot.`
            : "Turnover is comparable across the two venues.",
  };
}

/** Convenience aggregate for the memo's "liquidity reality" section. */
export interface LiquidityProfile {
  orderbook: OrderbookSummary | null;
  slippage: SlippagePoint[];
  tape: TapeStats | null;
  turnover: TurnoverAsymmetry | null;
  /** Dollars of resting bid support within 1% of the touch - the honest exit capacity. */
  bidSupportWithin1Pct: number | null;
}

export function buildLiquidityProfile(
  book: Orderbook | null,
  fills: Fill[] | null,
  spotTicker: Ticker | null,
  perpTicker: Ticker | null,
  now: number,
  exitSizes: readonly number[] = DEFAULT_EXIT_SIZES_USD,
): LiquidityProfile {
  const orderbook = book ? summariseOrderbook(book) : null;
  const nearTouch =
    orderbook && orderbook.bestBid !== null
      ? sum(
          orderbook.bids.levels
            .filter((l) => l.price >= orderbook.bestBid! * 0.99)
            .map((l) => l.notional),
        )
      : null;
  return {
    orderbook,
    slippage: orderbook ? slippageCurve(orderbook, [...exitSizes]) : [],
    tape: fills ? tapeStats(fills, now) : null,
    turnover: spotTicker || perpTicker ? turnoverAsymmetry(spotTicker, perpTicker) : null,
    bidSupportWithin1Pct: nearTouch === null ? null : round(nearTouch, 2),
  };
}

/** Mean notional per level, for the "~$100-$310 per level" style claim. */
export function meanNotionalPerLevel(levels: DepthLevel[]): number | null {
  const m = mean(levels.map((l) => l.notional));
  return m === null ? null : round(m, 2);
}