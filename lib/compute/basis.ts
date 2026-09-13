/**
 * Basis - the distance between a tokenized equity and the reference price its own
 * perpetual settles against.
 *
 * SIGN CONVENTION, stated once and asserted in tests/unit/basis.test.ts:
 *
 *     basisPct = (rTokenClose - indexClose) / indexClose * 100
 *     POSITIVE = the rToken trades ABOVE the reference (a premium).
 *     NEGATIVE = the rToken trades BELOW the reference (a discount).
 *
 * Why the sign matters rather than being cosmetic: DECISION.md 2.6 F3 found that the
 * sign is session-informative. Liquid RTH hours print a persistent small DISCOUNT
 * (arbitrage working); the large weekend readings are all PREMIUMS (a thin venue
 * being pushed around by retail flow with no reference to pull it back). An absolute
 * value would erase exactly the distinction the research rests on.
 *
 * Every function here is pure. Feeding it candles is the caller's job.
 */

import { classifySession } from "@/lib/compute/sessions";
import { summarize, percentileRankOfAbs, type Distribution } from "@/lib/compute/stats";
import type { BasisPoint, Candle, JoinedRow } from "@/lib/compute/types";

export const BASIS_SIGN_CONVENTION = "positive = rToken ABOVE the reference index (premium); negative = below (discount)";

/** Percentage distance of price from reference. Returns null on a non-positive reference. */
export function basisPct(price: number, reference: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(reference) || reference <= 0) return null;
  return ((price - reference) / reference) * 100;
}

/**
 * Align joined rToken/index hours into basis points, optionally carrying the perp.
 * Hours where the basis is undefined (bad reference) are dropped, not zero-filled:
 * a zero basis would read as "perfectly tracking", which is a lie.
 */
export function buildBasisSeries(rows: JoinedRow[], perpByTs?: Map<number, Candle> | null): BasisPoint[] {
  const points: BasisPoint[] = [];
  for (const row of rows) {
    const b = basisPct(row.left.close, row.right.close);
    if (b === null) continue;
    const perp = perpByTs?.get(row.ts);
    const perpBasis = perp ? basisPct(perp.close, row.right.close) : null;
    points.push({
      ts: row.ts,
      session: classifySession(row.ts).kind,
      rTokenClose: row.left.close,
      indexClose: row.right.close,
      perpClose: perp ? perp.close : null,
      basisPct: b,
      perpBasisPct: perpBasis,
    });
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

export interface SessionBucket {
  n: number;
  /** Distribution of the SIGNED basis. */
  signed: Distribution | null;
  /** Distribution of |basis| - the tracking-error measure the findings quote. */
  absolute: Distribution | null;
}

export interface BasisBySession {
  rth: SessionBucket;
  offhours: SessionBucket;
  weekend: SessionBucket;
  all: SessionBucket;
}

function bucket(points: BasisPoint[]): SessionBucket {
  const signed = points.map((p) => p.basisPct);
  const absolute = signed.map(Math.abs);
  return { n: points.length, signed: summarize(signed), absolute: summarize(absolute) };
}

/** Split the series into the three reporting buckets, plus the whole sample. */
export function basisBySession(points: BasisPoint[]): BasisBySession {
  const rth: BasisPoint[] = [];
  const offhours: BasisPoint[] = [];
  const weekend: BasisPoint[] = [];
  for (const p of points) {
    if (p.session === "rth") rth.push(p);
    else if (p.session === "offhours") offhours.push(p);
    else weekend.push(p);
  }
  return { rth: bucket(rth), offhours: bucket(offhours), weekend: bucket(weekend), all: bucket(points) };
}

/**
 * How many times worse is weekend tracking error than RTH? This single ratio IS the
 * product thesis (observed ~5.4x on the recorded AAPL sample), so it is computed,
 * never hardcoded. Null when either bucket is empty or RTH is perfectly flat.
 */
export function weekendDislocationRatio(bySession: BasisBySession): number | null {
  const w = bySession.weekend.absolute?.meanAbs ?? null;
  const r = bySession.rth.absolute?.meanAbs ?? null;
  if (w === null || r === null || r === 0) return null;
  return w / r;
}

/** Perp vs rToken tracking quality against the same index. Observed ~3x tighter. */
export function perpTrackingRatio(points: BasisPoint[]): number | null {
  const rTokenAbs = points.map((p) => Math.abs(p.basisPct));
  const perpAbs = points.filter((p) => p.perpBasisPct !== null).map((p) => Math.abs(p.perpBasisPct as number));
  const a = summarize(rTokenAbs)?.meanAbs ?? null;
  const b = summarize(perpAbs)?.meanAbs ?? null;
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

export interface BasisSnapshot {
  asOf: number;
  session: ReturnType<typeof classifySession>;
  rTokenPrice: number;
  indexPrice: number;
  perpPrice: number | null;
  basisPct: number;
  perpBasisPct: number | null;
  signConvention: typeof BASIS_SIGN_CONVENTION;
  /** Where this reading sits in its own session bucket, 0-100. */
  percentileWithinSession: number | null;
  /** Where this reading sits in the whole sample, 0-100. */
  percentileOverall: number | null;
  observationWindow: { fromTs: number; toTs: number; n: number };
}

/**
 * The current reading plus the context that makes it interpretable. The 1H candle
 * endpoint is capped at 1000 rows, so the window slides forward every hour and MUST
 * be published alongside any statistic derived from it.
 */
export function latestSnapshot(points: BasisPoint[]): BasisSnapshot | null {
  const last = points[points.length - 1];
  const first = points[0];
  if (!last || !first) return null;
  const sameSession = points.filter((p) => p.session === last.session).map((p) => p.basisPct);
  return {
    asOf: last.ts,
    session: classifySession(last.ts),
    rTokenPrice: last.rTokenClose,
    indexPrice: last.indexClose,
    perpPrice: last.perpClose,
    basisPct: last.basisPct,
    perpBasisPct: last.perpBasisPct,
    signConvention: BASIS_SIGN_CONVENTION,
    percentileWithinSession: percentileRankOfAbs(sameSession, last.basisPct),
    percentileOverall: percentileRankOfAbs(points.map((p) => p.basisPct), last.basisPct),
    observationWindow: { fromTs: first.ts, toTs: last.ts, n: points.length },
  };
}

/**
 * Consecutive-run length ending at the last point, in hours. A dislocation that has
 * persisted for 30 hours is a different fact from a one-hour spike, and the memo says
 * so; this is how it knows.
 */
export function currentRunLength(points: BasisPoint[], thresholdPct: number): number {
  let run = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (!p) break;
    if (Math.abs(p.basisPct) < thresholdPct) break;
    run++;
  }
  return run;
}