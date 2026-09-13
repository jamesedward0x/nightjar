/**
 * Wire -> Candle decoding.
 *
 * Bitget v3 candle rows are 7-element STRING tuples:
 *   [ts, open, high, low, close, baseVolume, quoteVolume]
 * Two shapes need special handling:
 *   - type=index and type=premium rows carry "0","0" volumes (a reference price has
 *     no volume), so a zero volume is NOT evidence of an inactive market.
 *   - type=premium OHLC are FRACTIONS, not prices. Use toPremiumPoints for those.
 *
 * Rows come back ascending by ts. Bitget already sends them ascending, but we sort
 * defensively because every downstream join and statistic assumes order.
 */

import { toNum, toTs } from "@/lib/bitget/decode";
import type { CandleRow } from "@/lib/schema/bitget";
import type { Candle, PremiumPoint } from "@/lib/compute/types";

/** Decode one row, or null when it is unusable (absent ts, non-finite close). */
export function toCandle(row: CandleRow): Candle | null {
  const ts = toTs(row[0]);
  const close = toNum(row[4]);
  if (ts === null || close === null) return null;
  const open = toNum(row[1]);
  const high = toNum(row[2]);
  const low = toNum(row[3]);
  return {
    ts,
    open: open ?? close,
    high: high ?? close,
    low: low ?? close,
    close,
    baseVolume: toNum(row[5]),
    quoteVolume: toNum(row[6]),
  };
}

/** Decode a payload, dropping unusable rows. Never throws; never returns garbage. */
export function toCandles(rows: CandleRow[]): Candle[] {
  const out: Candle[] = [];
  for (const row of rows) {
    const candle = toCandle(row);
    if (candle !== null) out.push(candle);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Premium rows: the close is a FRACTION of the index price. We keep the close only,
 * because an OHLC of fractions has no meaning we would publish.
 */
export function toPremiumPoints(rows: CandleRow[]): PremiumPoint[] {
  const out: PremiumPoint[] = [];
  for (const row of rows) {
    const ts = toTs(row[0]);
    const close = toNum(row[4]);
    if (ts === null || close === null) continue;
    out.push({ ts, premiumFraction: close });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Index a candle series by ts. Duplicate timestamps keep the LAST row. */
export function indexByTs(candles: Candle[]): Map<number, Candle> {
  const map = new Map<number, Candle>();
  for (const candle of candles) map.set(candle.ts, candle);
  return map;
}

/** The observation window of a series, for the mandatory "as of / over" label. */
export function windowOf(candles: { ts: number }[]): { fromTs: number; toTs: number; n: number } | null {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) return null;
  return { fromTs: first.ts, toTs: last.ts, n: candles.length };
}