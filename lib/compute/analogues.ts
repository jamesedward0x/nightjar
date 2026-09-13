/**
 * Analogue retrieval - "has this happened before, and what followed?"
 *
 * The sample is bounded by the 1000-row 1H ceiling (about 41 days), and that bound is
 * published with every result. Within it we can do something genuinely useful and
 * entirely deterministic: rank the widest dislocations, group contiguous hours into
 * episodes, and report what the basis did 6h and 24h later.
 *
 * All ten of the largest dislocations in the recorded AAPL sample fall on one weekend
 * (Sat 2026-08-29 / Sun 2026-08-30), peaking at +1.075% at 13:00 UTC while the perp
 * sat within 0.006% of the index. That episode must rank #1; the regression test
 * asserts it, because if the ranking ever stops finding it the engine is broken.
 */

import { classifySession } from "@/lib/compute/sessions";
import { round } from "@/lib/compute/stats";
import type { BasisPoint } from "@/lib/compute/types";

export const HOUR_MS = 3_600_000;

export interface AnalogueFollow {
  /** Hours ahead we looked. */
  horizonHours: number;
  basisPct: number | null;
  /** True when the absolute basis shrank over the horizon, i.e. it reverted. */
  reverted: boolean | null;
}

export interface Analogue {
  rank: number;
  ts: number;
  session: ReturnType<typeof classifySession>["kind"];
  basisPct: number;
  absBasisPct: number;
  rTokenClose: number;
  indexClose: number;
  perpBasisPct: number | null;
  /** True when the perp tracked the index tightly while the rToken detached. */
  rTokenSpecificDetachment: boolean;
  followed: AnalogueFollow[];
}

function pointAt(byTs: Map<number, BasisPoint>, ts: number, hours: number): BasisPoint | null {
  return byTs.get(ts + hours * HOUR_MS) ?? null;
}

/** The N widest dislocations in the window, ranked by |basis|, with what followed. */
export function findAnalogues(points: BasisPoint[], n = 5, horizonsHours: readonly number[] = [6, 24]): Analogue[] {
  const byTs = new Map<number, BasisPoint>();
  for (const p of points) byTs.set(p.ts, p);
  const ranked = [...points].sort((a, b) => Math.abs(b.basisPct) - Math.abs(a.basisPct)).slice(0, Math.max(0, n));
  return ranked.map((p, i) => ({
    rank: i + 1,
    ts: p.ts,
    session: p.session,
    basisPct: round(p.basisPct, 4),
    absBasisPct: round(Math.abs(p.basisPct), 4),
    rTokenClose: p.rTokenClose,
    indexClose: p.indexClose,
    perpBasisPct: p.perpBasisPct === null ? null : round(p.perpBasisPct, 4),
    rTokenSpecificDetachment:
      p.perpBasisPct !== null && Math.abs(p.basisPct) > 5 * Math.max(Math.abs(p.perpBasisPct), 1e-9),
    followed: horizonsHours.map((h) => {
      const later = pointAt(byTs, p.ts, h);
      const reverted = later === null ? null : Math.abs(later.basisPct) < Math.abs(p.basisPct);
      return { horizonHours: h, basisPct: later === null ? null : round(later.basisPct, 4), reverted };
    }),
  }));
}

export interface Episode {
  startTs: number;
  endTs: number;
  hours: number;
  peakTs: number;
  peakBasisPct: number;
  meanAbsBasisPct: number;
  sessionAtPeak: ReturnType<typeof classifySession>["kind"];
  /** Basis 24h after the episode ended, when the window still covers it. */
  basisAfter24h: number | null;
}

/**
 * Group contiguous hours whose |basis| exceeds a threshold into episodes. A premium
 * that persisted for 26 hours is a different fact from a one-hour spike, and this is
 * how the memo can tell them apart.
 */
export function groupEpisodes(points: BasisPoint[], thresholdPct: number): Episode[] {
  const byTs = new Map<number, BasisPoint>();
  for (const p of points) byTs.set(p.ts, p);
  const episodes: Episode[] = [];
  let current: BasisPoint[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    let peak = current[0];
    if (!peak) return;
    let absSum = 0;
    for (const p of current) {
      absSum += Math.abs(p.basisPct);
      if (peak && Math.abs(p.basisPct) > Math.abs(peak.basisPct)) peak = p;
    }
    const start = current[0];
    const end = current[current.length - 1];
    if (!start || !end || !peak) return;
    const after = byTs.get(end.ts + 24 * HOUR_MS);
    episodes.push({
      startTs: start.ts,
      endTs: end.ts,
      hours: current.length,
      peakTs: peak.ts,
      peakBasisPct: round(peak.basisPct, 4),
      meanAbsBasisPct: round(absSum / current.length, 4),
      sessionAtPeak: peak.session,
      basisAfter24h: after ? round(after.basisPct, 4) : null,
    });
    current = [];
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const exceeds = Math.abs(p.basisPct) >= thresholdPct;
    const previous = points[i - 1];
    const contiguous = previous !== undefined && p.ts - previous.ts === HOUR_MS;
    if (exceeds && (current.length === 0 || contiguous)) current.push(p);
    else flush();
  }
  flush();
  return episodes.sort((a, b) => Math.abs(b.peakBasisPct) - Math.abs(a.peakBasisPct));
}

/** How many hours in the window exceeded a threshold, and in which sessions. */
export function exceedanceCounts(
  points: BasisPoint[],
  thresholdsPct: readonly number[] = [0.5, 1],
): { thresholdPct: number; count: number; rth: number; offhours: number; weekend: number }[] {
  return thresholdsPct.map((thresholdPct) => {
    const hits = points.filter((p) => Math.abs(p.basisPct) > thresholdPct);
    return {
      thresholdPct,
      count: hits.length,
      rth: hits.filter((p) => p.session === "rth").length,
      offhours: hits.filter((p) => p.session === "offhours").length,
      weekend: hits.filter((p) => p.session === "weekend").length,
    };
  });
}