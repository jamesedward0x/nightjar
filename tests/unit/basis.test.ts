/**
 * The sign convention is the single most important contract in the compute engine:
 * positive = rToken ABOVE the reference index. DECISION.md 2.6 F3 found the sign is
 * itself informative (liquid RTH prints a discount, weekend dislocations are premiums),
 * so an accidental absolute value here would quietly delete the finding.
 */

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  BASIS_SIGN_CONVENTION,
  basisPct,
  buildBasisSeries,
  basisBySession,
  currentRunLength,
  latestSnapshot,
  perpTrackingRatio,
  weekendDislocationRatio,
} from "@/lib/compute/basis";
import type { Candle, JoinedRow } from "@/lib/compute/types";

const ts = (iso: string): number => DateTime.fromISO(iso, { zone: "utc" }).toMillis();

function candle(timestamp: number, close: number, extra: Partial<Candle> = {}): Candle {
  return { ts: timestamp, open: close, high: close, low: close, close, baseVolume: null, quoteVolume: null, ...extra };
}

function row(timestamp: number, rTokenClose: number, indexClose: number): JoinedRow {
  return { ts: timestamp, left: candle(timestamp, rTokenClose), right: candle(timestamp, indexClose) };
}

describe("basisPct sign convention", () => {
  it("is positive when the rToken trades above the reference", () => {
    expect(basisPct(105, 100)).toBeCloseTo(5, 12);
    expect(basisPct(324.0, 320.55)).toBeCloseTo(1.07627, 4);
  });

  it("is negative when the rToken trades below the reference", () => {
    expect(basisPct(95, 100)).toBeCloseTo(-5, 12);
  });

  it("is zero when they agree", () => {
    expect(basisPct(100, 100)).toBe(0);
  });

  it("refuses a non-positive or non-finite reference instead of returning Infinity", () => {
    expect(basisPct(100, 0)).toBeNull();
    expect(basisPct(100, -5)).toBeNull();
    expect(basisPct(Number.NaN, 100)).toBeNull();
  });

  it("documents the convention in a string the memo can print verbatim", () => {
    expect(BASIS_SIGN_CONVENTION).toMatch(/positive/i);
    expect(BASIS_SIGN_CONVENTION).toMatch(/ABOVE/i);
  });
});

describe("buildBasisSeries", () => {
  it("keeps the sign and attaches the session", () => {
    const rth = row(ts("2026-07-15T15:00:00Z"), 101, 100);
    const weekend = row(ts("2026-08-29T13:00:00Z"), 99, 100);
    const points = buildBasisSeries([rth, weekend]);
    expect(points).toHaveLength(2);
    expect(points[0]?.basisPct).toBeCloseTo(1, 12);
    expect(points[0]?.session).toBe("rth");
    expect(points[1]?.basisPct).toBeCloseTo(-1, 12);
    expect(points[1]?.session).toBe("weekend");
  });

  it("drops hours with an unusable reference rather than zero-filling them", () => {
    const bad = row(ts("2026-07-15T15:00:00Z"), 101, 0);
    const good = row(ts("2026-07-15T16:00:00Z"), 101, 100);
    const points = buildBasisSeries([bad, good]);
    expect(points).toHaveLength(1);
    expect(points[0]?.ts).toBe(good.ts);
  });

  it("carries the perp basis when a perp candle exists for that hour", () => {
    const t = ts("2026-07-15T15:00:00Z");
    const perpByTs = new Map([[t, candle(t, 100.2)]]);
    const points = buildBasisSeries([row(t, 101, 100)], perpByTs);
    expect(points[0]?.perpBasisPct).toBeCloseTo(0.2, 12);
    expect(points[0]?.perpClose).toBe(100.2);
  });

  it("returns ascending output even when the input is not", () => {
    const late = row(ts("2026-07-15T18:00:00Z"), 101, 100);
    const early = row(ts("2026-07-15T15:00:00Z"), 102, 100);
    const points = buildBasisSeries([late, early]);
    expect(points[0]?.ts).toBe(early.ts);
    expect(points[1]?.ts).toBe(late.ts);
  });
});

describe("basisBySession and the thesis ratio", () => {
  const points = buildBasisSeries([
    row(ts("2026-07-15T15:00:00Z"), 100.05, 100), // rth, +0.05%
    row(ts("2026-07-15T16:00:00Z"), 100.05, 100), // rth
    row(ts("2026-07-15T22:00:00Z"), 100.1, 100), // offhours
    row(ts("2026-08-29T13:00:00Z"), 101, 100), // weekend, +1%
  ]);

  it("buckets by session and keeps the whole sample", () => {
    const by = basisBySession(points);
    expect(by.rth.n).toBe(2);
    expect(by.offhours.n).toBe(1);
    expect(by.weekend.n).toBe(1);
    expect(by.all.n).toBe(4);
  });

  it("computes the weekend/RTH dislocation ratio instead of hardcoding it", () => {
    const by = basisBySession(points);
    expect(weekendDislocationRatio(by)).toBeCloseTo(20, 10); // 1.0 / 0.05
  });

  it("returns null for the ratio when a bucket is empty", () => {
    const rthOnly = basisBySession(points.slice(0, 2));
    expect(weekendDislocationRatio(rthOnly)).toBeNull();
  });
});

describe("perpTrackingRatio", () => {
  it("shows the perp tracking the index more tightly than the rToken", () => {
    const t = ts("2026-07-15T15:00:00Z");
    const perpByTs = new Map([[t, candle(t, 100.1)]]);
    const points = buildBasisSeries([row(t, 100.3, 100)], perpByTs);
    expect(perpTrackingRatio(points)).toBeCloseTo(3, 10); // 0.3 / 0.1
  });

  it("is null when no perp data is present", () => {
    expect(perpTrackingRatio(buildBasisSeries([row(ts("2026-07-15T15:00:00Z"), 101, 100)]))).toBeNull();
  });
});

describe("latestSnapshot", () => {
  const points = buildBasisSeries([
    row(ts("2026-07-15T15:00:00Z"), 100.1, 100),
    row(ts("2026-07-15T16:00:00Z"), 100.2, 100),
    row(ts("2026-08-29T13:00:00Z"), 101, 100),
  ]);

  it("publishes the observation window alongside the reading", () => {
    const snap = latestSnapshot(points);
    expect(snap?.observationWindow.n).toBe(3);
    expect(snap?.observationWindow.fromTs).toBe(points[0]?.ts);
    expect(snap?.observationWindow.toTs).toBe(points[2]?.ts);
  });

  it("places the reading as a percentile of its own session and of the sample", () => {
    const snap = latestSnapshot(points);
    expect(snap?.percentileOverall).toBeCloseTo(83.3333, 3);
    expect(snap?.percentileWithinSession).toBeCloseTo(50, 10); // only weekend hour in sample
  });

  it("restates the sign convention so a reader cannot misinterpret the number", () => {
    expect(latestSnapshot(points)?.signConvention).toBe(BASIS_SIGN_CONVENTION);
  });

  it("is null for an empty series", () => {
    expect(latestSnapshot([])).toBeNull();
  });
});

describe("currentRunLength", () => {
  it("counts consecutive hours at or above the threshold, ending now", () => {
    const points = buildBasisSeries([
      row(ts("2026-08-29T11:00:00Z"), 100.1, 100), // 0.1% - below
      row(ts("2026-08-29T12:00:00Z"), 100.8, 100), // 0.8% - above
      row(ts("2026-08-29T13:00:00Z"), 101.1, 100), // 1.1% - above
    ]);
    expect(currentRunLength(points, 0.5)).toBe(2);
  });

  it("is zero when the latest hour has reverted", () => {
    const points = buildBasisSeries([
      row(ts("2026-08-29T12:00:00Z"), 101, 100),
      row(ts("2026-08-29T13:00:00Z"), 100.1, 100),
    ]);
    expect(currentRunLength(points, 0.5)).toBe(0);
  });
});