/**
 * Shared vocabulary for the deterministic compute engine.
 *
 * Everything in lib/compute is PURE: it takes already-fetched, already-validated
 * data and returns numbers. No I/O, no LLM, no environment reads. That is what
 * makes the research core unit-testable offline against fixtures, and it is the
 * rule from DECISION.md 6.8 - "if it is a number, code produced it".
 */

import type { SessionKind } from "@/lib/compute/sessions";

export type { SessionKind };

/** A decoded candle. Wire rows are string tuples; see candles.ts. */
export interface Candle {
  /** Bucket open time, epoch ms. The ONLY join key we ever use. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * Base-asset volume. For rToken SPOT this field is UNRELIABLE (DECISION.md 2.6 F6):
   * it disagrees across intervals and with tickers.turnover24h. quality.ts detects the
   * disagreement; nothing downstream may read it for a liquidity claim.
   */
  baseVolume: number | null;
  quoteVolume: number | null;
}

/** A premium candle: OHLC are FRACTIONS (+0.001582 = +0.158%), not prices. */
export interface PremiumPoint {
  ts: number;
  premiumFraction: number;
}

/** One aligned hour across the series we compare. */
export interface BasisPoint {
  ts: number;
  session: SessionKind;
  rTokenClose: number;
  indexClose: number;
  perpClose: number | null;
  /** rToken spot vs the composite reference index. Positive = rToken ABOVE index. */
  basisPct: number;
  /** Perp vs the same index, for contrast. Null when the perp row is missing. */
  perpBasisPct: number | null;
}

/** A joined pair of candles sharing one timestamp. */
export interface JoinedRow {
  ts: number;
  left: Candle;
  right: Candle;
}

/** Provenance for a computed artefact, so every number can name its source. */
export interface ComputeProvenance {
  endpoint: string;
  source: string;
  fetchedAt: number;
  latencyMs: number;
  fromCache: boolean;
  upstreamTime: number | null;
  recordedAt: string | null;
}

/** A compute step that failed. Degradation is a value, never an exception. */
export type ComputeResult<T> =
  | { ok: true; value: T; provenance: ComputeProvenance[] }
  | { ok: false; kind: string; message: string; hint?: string };