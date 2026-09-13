/**
 * Server -> client projection of an evidence pack.
 *
 * Two jobs. First, keep the payload small: the raw 1H series is up to 1000 points and
 * the premium series is the same length again, and neither is renderable at that
 * resolution on a chart. Second, keep the contract stable: the browser depends on
 * ClientPack, not on the internal EvidencePack, so the compute engine can change
 * without breaking the UI.
 *
 * Nothing here computes a number. It selects and thins what lib/compute already
 * produced, which is why the fallback memo and the live memo show identical figures.
 */

import type { BasisPoint } from "@/lib/compute/types";
import type { ClientPack } from "@/lib/research/contract";
import type { EvidencePack } from "@/lib/research/evidence";

/** Chart resolution. 240 hourly points is ~10 days and reads clearly at 900px wide. */
export const MAX_CHART_POINTS = 240;

/**
 * Thin a series to at most `max` points, always keeping the first and last so the
 * observation window shown on screen is the real one, never a cropped one.
 */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 2) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    const point = points[Math.round(i * stride)];
    if (point !== undefined) out.push(point);
  }
  return out;
}

export function projectPack(pack: EvidencePack): ClientPack {
  const { premium, ...rest } = pack;
  // premium is deliberately dropped: the UI renders basis, not the raw fraction series.
  void premium;
  return { ...rest, series: downsample(pack.series, MAX_CHART_POINTS) };
}

/** One projected pack per distinct base symbol, in the order they were gathered. */
export function projectPacks(packs: EvidencePack[]): ClientPack[] {
  const seen = new Set<string>();
  const out: ClientPack[] = [];
  for (const pack of packs) {
    if (seen.has(pack.base)) continue;
    seen.add(pack.base);
    out.push(projectPack(pack));
  }
  return out;
}

/** The points the chart draws: timestamp, session, both basis series. */
export type ChartPoint = Pick<BasisPoint, "ts" | "session" | "basisPct" | "perpBasisPct">;