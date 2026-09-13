/**
 * Distribution statistics. Pure, dependency-free, and deliberately boring:
 * a percentile implemented three different ways is three chances to publish a
 * wrong "is this normal?" answer.
 *
 * Convention: percentile(values, p) uses linear interpolation between closest
 * ranks (the same "type 7" definition R, NumPy and Excel PERCENTILE.INC use),
 * so our numbers match what a judge would get from a spreadsheet.
 */

export interface Distribution {
  n: number;
  mean: number;
  meanAbs: number;
  median: number;
  min: number;
  max: number;
  /** Population standard deviation. We describe a sample we have, not infer one. */
  stdDev: number;
  p90: number;
  p95: number;
  p99: number;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Linear-interpolation percentile. Input need not be sorted; it is copied first. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const clamped = Math.min(100, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo];
  const hiVal = sorted[hi];
  if (loVal === undefined || hiVal === undefined) return null;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (rank - lo);
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export function stdDev(values: number[]): number | null {
  const m = mean(values);
  if (m === null || values.length === 0) return null;
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return Math.sqrt(acc / values.length);
}

/** Full summary, or null for an empty sample. Never throws. */
export function summarize(values: number[]): Distribution | null {
  const m = mean(values);
  const ma = mean(values.map(Math.abs));
  const sd = stdDev(values);
  const med = median(values);
  const p90 = percentile(values, 90);
  const p95 = percentile(values, 95);
  const p99 = percentile(values, 99);
  if (m === null || ma === null || sd === null || med === null || p90 === null || p95 === null || p99 === null) {
    return null;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { n: values.length, mean: m, meanAbs: ma, median: med, min, max, stdDev: sd, p90, p95, p99 };
}

/**
 * Where does |x| sit in |values|? Returned as 0-100.
 * This is the "is this normal?" answer: the share of historical hours whose absolute
 * dislocation was no larger than the one being looked at right now.
 */
export function percentileRankOfAbs(values: number[], x: number): number | null {
  if (values.length === 0) return null;
  const target = Math.abs(x);
  let below = 0;
  let equal = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (a < target) below++;
    else if (a === target) equal++;
  }
  // Midpoint handling of ties, so an exact duplicate reading does not read as 100th.
  return ((below + equal / 2) / values.length) * 100;
}

/** Population z-score against the sample. Null when the sample has no variance. */
export function zScore(values: number[], x: number): number | null {
  const m = mean(values);
  const sd = stdDev(values);
  if (m === null || sd === null || sd === 0) return null;
  return (x - m) / sd;
}

/** Round for display without pretending to more precision than we have. */
export function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}