/**
 * Regression guard on the PUBLISHED FINDINGS.
 *
 * Every figure Nightjar submits - the memo, the charts, the README, the demo script - is
 * derived from the EvidencePack this file rebuilds out of the recorded corpus in
 * lib/fixtures/. These assertions pin that derivation, end to end, through the real
 * gatherEvidence() in lib/research/evidence.ts. They are the guard the rest of the repo
 * refers to: lib/compute/analogues.ts says "that episode must rank #1; the regression
 * test asserts it", and this is the test.
 *
 * READ THIS BEFORE EDITING AN EXPECTATION BELOW.
 *
 * A failure here means the research engine changed behaviour, NOT that the test is wrong.
 * The corpus is a fixed set of recorded snapshots (lib/fixtures/manifest.json, recordedAt
 * 2026-09-13T11:50:07.005Z) and `now` is a fixed timestamp, so every number below is
 * reproducible offline to the last bit. Nothing here is flaky, nothing reads the clock,
 * nothing touches the network (fetch is stubbed to throw), and nothing needs
 * BITGET_QWEN_API_KEY.
 *
 * If one of these numbers genuinely moved, that is a finding about the product and it has
 * to be re-published deliberately - not quietly re-pinned to make CI green. Counts are
 * pinned EXACTLY because they are integers over a fixed corpus. Percentages and ratios are
 * pinned with an explicit tolerance so a rounding change in lib/compute cannot raise a
 * false alarm. The peak timestamp is pinned exactly.
 *
 * Tolerances below come from toBeCloseTo's +/- 0.5 x 10^-digits:
 *   3 digits -> +/- 0.0005   percentages published to 3-4 dp (mean |basis| per session)
 *   4 digits -> +/- 0.00005  percentages published to 4 dp (the maximum dislocation)
 *   1 digit  -> +/- 0.05     the perp/rToken tracking ratio, published as "~2.9x"
 *   2 digits -> +/- 0.005    the weekend/RTH tracking-error ratio
 *
 * Measured from the corpus on 2026-09-14. Two places where the measurement is deliberately
 * narrower than prose elsewhere in the repo are called out inline, not papered over.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatherEvidence, type EvidencePack } from "@/lib/research/evidence";
import type { BasisPoint, SessionKind } from "@/lib/compute/types";
import type { AnalogueFollow } from "@/lib/compute/analogues";

/** Recorded snapshots are served only in fixture mode (AGENTS.md invariant 5). */
const ORIGINAL_MODE = process.env.NIGHTJAR_MODE;

function enterFixtureMode(): void {
  process.env.NIGHTJAR_MODE = "fixture";
}

function exitFixtureMode(): void {
  if (ORIGINAL_MODE === undefined) delete process.env.NIGHTJAR_MODE;
  else process.env.NIGHTJAR_MODE = ORIGINAL_MODE;
}

/**
 * Any network call at all is a failed test. This suite must be runnable on a plane.
 */
const offlineFetch = vi.fn(() => {
  throw new Error("offline test: the findings suite attempted a network call");
});

/**
 * The corpus was recorded at 2026-09-13T11:50:07.005Z and the newest 1H candle in it
 * opens at 2026-09-13T11:00:00Z. Building the pack "as of" one hour after that newest
 * candle makes the study deterministic and keeps the 3h staleness detector quiet, so a
 * failure below is about the arithmetic and never about a fixture that has gone cold.
 */
const FIXTURE_NOW = Date.parse("2026-09-13T12:00:00.000Z");

/** The hour the 1000-row 1H window starts and ends on, as recorded. */
const WINDOW_FROM_TS = Date.parse("2026-08-02T20:00:00.000Z");
const WINDOW_TO_TS = Date.parse("2026-09-13T11:00:00.000Z");

/** The single worst dislocation in the corpus: Sat 2026-08-29 13:00 UTC. */
const PEAK_TS = Date.parse("2026-08-29T13:00:00.000Z");

/** 1H candle rows requested, and the endpoint ceiling that forces the window to slide. */
const REQUESTED_ROWS = 1000;

/**
 * The published top five widest dislocations: timestamp, NY session, |basis| in %.
 * Note ranks 3 and 4 are session "offhours", not "weekend": UTC Saturday 02:00 and 03:00
 * are still Friday evening in New York, and lib/compute/sessions.ts classifies on the NY
 * calendar on purpose. Pinning the mix is what stops that boundary silently becoming UTC.
 */
const TOP_FIVE: ReadonlyArray<{ iso: string; session: SessionKind; absBasisPct: number }> = [
  { iso: "2026-08-29T13:00:00.000Z", session: "weekend", absBasisPct: 1.0749 },
  { iso: "2026-08-29T06:00:00.000Z", session: "weekend", absBasisPct: 0.9123 },
  { iso: "2026-08-29T02:00:00.000Z", session: "offhours", absBasisPct: 0.8706 },
  { iso: "2026-08-29T03:00:00.000Z", session: "offhours", absBasisPct: 0.8363 },
  { iso: "2026-08-29T04:00:00.000Z", session: "weekend", absBasisPct: 0.8316 },
];

type ExceedanceRow = EvidencePack["exceedances"][number];
type BucketName = "rth" | "offhours" | "weekend" | "all";

let gathered: EvidencePack | null = null;

beforeAll(async () => {
  vi.stubGlobal("fetch", offlineFetch);
  enterFixtureMode();
  try {
    // ONE gather for the whole suite: the corpus is ~1.5 MB of recordings and the
    // fan-out is 13 upstream calls, so re-building per test would be pure waste.
    const result = await gatherEvidence("AAPL", { now: FIXTURE_NOW });
    if (!result.ok) throw new Error("fixture gather failed: " + result.kind + " - " + result.message);
    gathered = result.pack;
  } finally {
    exitFixtureMode();
  }
});

beforeEach(enterFixtureMode);
afterEach(exitFixtureMode);

afterAll(() => {
  vi.unstubAllGlobals();
  exitFixtureMode();
});

function thePack(): EvidencePack {
  if (!gathered) throw new Error("test bug: the AAPL fixture pack was never built");
  return gathered;
}

// NonNullable: EvidencePack["bySession"] is `BasisBySession | null`, and the guard below
// throws on null, so declaring the nullable type here would defeat the narrowing.
function buckets(): NonNullable<EvidencePack["bySession"]> {
  const by = thePack().bySession;
  if (!by) throw new Error("test bug: the fixture pack has no session buckets");
  return by;
}

/** mean |basis| for one session - the tracking-error figure the findings quote. */
function meanAbsBasisPct(bucket: BucketName): number {
  const dist = buckets()[bucket].absolute;
  if (!dist) throw new Error("test bug: the " + bucket + " bucket has no |basis| distribution");
  return dist.meanAbs;
}

/** mean of the SIGNED basis, so the sign convention stays checkable (invariant 9). */
function meanSignedBasisPct(bucket: BucketName): number {
  const dist = buckets()[bucket].signed;
  if (!dist) throw new Error("test bug: the " + bucket + " bucket has no signed distribution");
  return dist.mean;
}

/** The widest hour in the series, found here rather than trusted from a summary field. */
function widestPoint(): BasisPoint {
  const series = thePack().series;
  if (series.length === 0) throw new Error("test bug: the fixture pack has an empty basis series");
  return series.reduce((worst, point) => (Math.abs(point.basisPct) > Math.abs(worst.basisPct) ? point : worst));
}

function exceedanceAt(thresholdPct: number): ExceedanceRow {
  const row = thePack().exceedances.find((candidate) => candidate.thresholdPct === thresholdPct);
  if (!row) throw new Error("test bug: no exceedance row for threshold " + String(thresholdPct) + "%");
  return row;
}

/** One horizon row of one ranked analogue, or a loud failure. A null reading is data. */
function followAt(rank: number, horizonHours: number): AnalogueFollow {
  const analogue = thePack().analogues.find((candidate) => candidate.rank === rank);
  if (!analogue) throw new Error("test bug: the pack publishes no analogue at rank " + String(rank));
  const follow = analogue.followed.find((candidate) => candidate.horizonHours === horizonHours);
  if (!follow) throw new Error("test bug: rank " + String(rank) + " has no " + String(horizonHours) + "h horizon");
  return follow;
}

function sourceStatus(id: string): string {
  const record = thePack().sources.find((candidate) => candidate.id === id);
  if (!record) throw new Error("test bug: the pack has no source record for " + id);
  return record.status;
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

describe("the published findings, reproduced from the recorded corpus", () => {
  describe("the observation window", () => {
    it("covers 930 matched hourly observations, and says where the other 70 went", () => {
      const pack = thePack();
      const join = pack.joinStats;
      expect(join, "the pack publishes its join stats rather than hiding the mismatch").not.toBeNull();
      expect(join?.matched, "930 matched hourly observations in the window").toBe(930);
      expect(join?.leftRows, "the rToken leg is requested at the endpoint ceiling").toBe(REQUESTED_ROWS);
      expect(join?.rightRows, "the index leg is requested at the endpoint ceiling").toBe(REQUESTED_ROWS);
      expect(join?.droppedLeft, "hours with no index candle are dropped, never zero-filled").toBe(70);
      expect(pack.series.length, "the basis series is exactly the matched hours").toBe(join?.matched ?? -1);
    });

    it("publishes the window it measured over, and never runs past `now`", () => {
      const window = thePack().observationWindow;
      expect(window, "invariant 3: a published number carries its observation window").not.toBeNull();
      expect(window?.n, "the window covers all 930 observations").toBe(930);
      expect(window?.fromTs, "window opens " + iso(WINDOW_FROM_TS)).toBe(WINDOW_FROM_TS);
      expect(window?.toTs, "window closes on the newest recorded candle").toBe(WINDOW_TO_TS);
      expect(window?.toTs ?? Number.NaN, "the window cannot extend past the as-of time").toBeLessThanOrEqual(FIXTURE_NOW);
      expect(thePack().generatedAt, "the pack is stamped with the as-of time it was given").toBe(FIXTURE_NOW);
    });

    it("rests on recorded candles for every source the findings actually need", () => {
      const pack = thePack();
      expect(pack.mode, "these findings come from the recorded corpus, not a live call").toBe("fixture");
      expect(pack.base, "the one dual-listed name recorded end to end").toBe("AAPL");
      expect(pack.rTokenSymbol, "rToken leg").toBe("RAAPLUSDT");
      expect(pack.perpSymbol, "perp leg").toBe("AAPLUSDT");
      for (const id of ["universe", "candles-spot-1h", "candles-index-1h", "candles-perp-1h"]) {
        expect(sourceStatus(id), id + " answered from a recording").toBe("ok");
      }
      // Degradation is a documented rule, not a mood: the flag is exactly "some source
      // was not ok". The 1D spot leg used to miss permanently here, because evidence.ts
      // asked for interval=1D&limit=30 while the recorder saved limit=1000 and matching
      // is exact (invariant 5). The request now matches the recording, so every source
      // the findings need answers and the pack is not degraded.
      expect(
        pack.degraded,
        "degraded is true exactly when some source is not ok",
      ).toBe(pack.sources.some((record) => record.status !== "ok"));
      expect(pack.degraded, "no source misses once the 1D limit matches the recording").toBe(false);
      expect(sourceStatus("candles-spot-1d"), "the 1D spot leg answers from its recording").toBe("ok");
    });
  });

  describe("tracking error by session", () => {
    it("reproduces the published mean |basis| for each session", () => {
      expect(buckets().rth.n, "RTH hours in the window").toBe(180);
      expect(meanAbsBasisPct("rth"), "mean |basis| during regular trading hours").toBeCloseTo(0.057, 3);

      expect(buckets().offhours.n, "off-hours in the window").toBe(532);
      expect(meanAbsBasisPct("offhours"), "mean |basis| off-hours").toBeCloseTo(0.0905, 4);

      expect(buckets().weekend.n, "weekend hours in the window").toBe(218);
      expect(meanAbsBasisPct("weekend"), "mean |basis| at the weekend").toBeCloseTo(0.3054, 4);
    });

    it("buckets the whole sample and nothing but the sample", () => {
      expect(buckets().all.n, "the whole sample").toBe(930);
      expect(
        buckets().rth.n + buckets().offhours.n + buckets().weekend.n,
        "the three sessions partition the window with no overlap and no gap",
      ).toBe(buckets().all.n);
    });

    it("orders the sessions rth < offhours < weekend, which is the whole thesis", () => {
      const rth = meanAbsBasisPct("rth");
      const offhours = meanAbsBasisPct("offhours");
      const weekend = meanAbsBasisPct("weekend");
      expect(offhours, "off-hours tracking is worse than RTH").toBeGreaterThan(rth);
      expect(weekend, "weekend tracking is worse than off-hours").toBeGreaterThan(offhours);
    });

    it("reports the weekend/RTH tracking-error ratio, computed rather than hardcoded", () => {
      const pack = thePack();
      const ratio = pack.weekendDislocationRatio;
      expect(ratio, "both buckets are populated, so the ratio exists").not.toBeNull();
      expect(ratio ?? Number.NaN, "materially greater than 1 - this ratio IS the product thesis").toBeGreaterThan(3);
      // Published as "~5.3x". Measured 5.3856, i.e. ~5.4x, which is what the doc comment
      // in lib/compute/basis.ts already says. Pinned to the measurement, not to the prose.
      expect(ratio ?? Number.NaN, "weekend tracking error is ~5.4x the RTH figure").toBeCloseTo(5.3856, 2);
      expect(
        ratio ?? Number.NaN,
        "the ratio is the quotient of the two published means, not an independent constant",
      ).toBeCloseTo(meanAbsBasisPct("weekend") / meanAbsBasisPct("rth"), 10);
    });

    it("keeps the sign, so liquid RTH reads as a small persistent discount", () => {
      // Invariant 9: positive basis = rToken ABOVE the reference. RTH's signed mean is
      // negative while its absolute mean is not, which is the arbitrage-still-working
      // signature the memo describes. An |x| refactor would erase exactly this.
      expect(meanSignedBasisPct("rth"), "RTH prints a discount, not a premium").toBeLessThan(0);
      expect(Math.abs(meanSignedBasisPct("rth")), "and the discount is small").toBeLessThan(0.1);
    });
  });

  describe("the worst dislocation", () => {
    it("peaks at +1.0749% at 2026-08-29T13:00:00Z", () => {
      const peak = widestPoint();
      expect(peak.ts, "the widest hour is 2026-08-29T13:00:00Z").toBe(PEAK_TS);
      expect(peak.basisPct, "maximum |basis| in the window").toBeCloseTo(1.0749, 4);
      expect(peak.basisPct, "the peak is a PREMIUM - the rToken above its reference").toBeGreaterThan(0);
      expect(peak.session, "it happened while the reference market was shut").toBe("weekend");
      expect(buckets().all.absolute?.max ?? Number.NaN, "the sample maximum agrees").toBeCloseTo(1.0749, 4);
      expect(buckets().weekend.absolute?.max ?? Number.NaN, "and it is a weekend hour").toBeCloseTo(1.0749, 4);
    });

    it("was rToken-specific: the perp kept tracking the index through it", () => {
      const peak = widestPoint();
      const perp = peak.perpBasisPct;
      expect(perp, "the perp leg is present for this hour").not.toBeNull();
      // The header comment in lib/compute/analogues.ts says the perp sat "within 0.006%"
      // of the index here. The corpus measures -0.0076%, i.e. within 0.008%. Pinned to
      // the measurement; the claim that matters - two orders of magnitude tighter than
      // the rToken - holds either way.
      expect(perp ?? Number.NaN, "the perp basis at the peak, as recorded").toBeCloseTo(-0.0076, 4);
      expect(Math.abs(perp ?? Number.NaN), "the perp never left the index by more than 0.02%").toBeLessThan(0.02);
      expect(
        Math.abs(peak.basisPct) / Math.abs(perp ?? Number.NaN),
        "the rToken moved over 100x further from the index than the perp did",
      ).toBeGreaterThan(100);
    });

    it("reverted within 24 hours, and reports no 6h reading rather than inventing one", () => {
      const after6h = followAt(1, 6);
      const after24h = followAt(1, 24);
      // 13:00 + 6h is one of the 70 hours the join dropped, so the honest answer is
      // "no observation, and therefore no reversion claim" - not an interpolated one.
      expect(after6h.basisPct, "the 6h-ahead hour has no basis point in the corpus").toBeNull();
      expect(after6h.reverted, "so no reversion claim is made for it either").toBeNull();
      expect(after24h.basisPct ?? Number.NaN, "24h later the premium had roughly halved").toBeCloseTo(0.7113, 4);
      expect(after24h.reverted, "24h later |basis| had shrunk, i.e. it reverted").toBe(true);
    });
  });

  describe("perp vs rToken tracking", () => {
    it("shows the perp tracking the index ~2.9x more tightly than the rToken", () => {
      const pack = thePack();
      const ratio = pack.perpTrackingRatio;
      expect(ratio, "both legs are present across the window, so the ratio exists").not.toBeNull();
      expect(ratio ?? Number.NaN, "the perp tracks the index materially better").toBeGreaterThan(1);
      expect(ratio ?? Number.NaN, "published as ~2.9x tighter").toBeCloseTo(2.9, 1);
    });

    it("compares the two legs over the same 930 hours, not over whichever subset answered", () => {
      const withPerp = thePack().series.filter((point) => point.perpBasisPct !== null).length;
      expect(withPerp, "every matched hour also has a perp candle, so the contrast is complete").toBe(930);
    });
  });

  describe("exceedance counts", () => {
    it("counts 43 hours beyond 0.5% and exactly 1 hour beyond 1%", () => {
      const pack = thePack();
      expect(pack.exceedances.length, "two thresholds are published").toBe(2);
      expect(
        pack.exceedances.map((row) => row.thresholdPct),
        "the published thresholds",
      ).toEqual([0.5, 1]);
      expect(exceedanceAt(0.5).count, "hours beyond 0.5%").toBe(43);
      expect(exceedanceAt(1).count, "hours beyond 1%").toBe(1);
    });

    it("puts every single exceedance outside regular trading hours", () => {
      for (const thresholdPct of [0.5, 1]) {
        const row = exceedanceAt(thresholdPct);
        expect(row.rth, "RTH never dislocated beyond " + String(thresholdPct) + "%").toBe(0);
        expect(row.rth + row.offhours + row.weekend, "the split accounts for every hour").toBe(row.count);
      }
      expect(exceedanceAt(0.5).offhours, "of the 43, two were weekday off-hours").toBe(2);
      expect(exceedanceAt(0.5).weekend, "and 41 were weekend hours").toBe(41);
      expect(exceedanceAt(1).weekend, "the one hour beyond 1% is the weekend peak").toBe(1);
    });

    it("agrees with the peak: the only hour beyond 1% is the widest hour", () => {
      expect(exceedanceAt(1).count, "exactly one hour cleared 1%").toBe(1);
      expect(
        thePack().series.filter((point) => Math.abs(point.basisPct) > 1).map((point) => point.ts),
        "and it is 2026-08-29T13:00:00Z",
      ).toEqual([PEAK_TS]);
    });
  });

  describe("the analogue ranking", () => {
    it("ranks the 2026-08-29T13:00Z peak first - the claim analogues.ts asks this test to make", () => {
      const analogues = thePack().analogues;
      expect(analogues.length, "five analogues are published by default").toBe(5);
      const rank1 = analogues[0];
      expect(rank1?.rank, "ranking starts at 1").toBe(1);
      expect(rank1?.ts, "the widest dislocation ranks first").toBe(PEAK_TS);
      expect(rank1?.absBasisPct ?? Number.NaN, "and carries the published magnitude").toBeCloseTo(1.0749, 4);
      expect(rank1?.basisPct ?? Number.NaN, "signed, so a premium cannot read as a discount").toBeCloseTo(1.0749, 4);
      expect(rank1?.session, "in the NY session it happened on").toBe("weekend");
      expect(rank1?.rTokenSpecificDetachment, "flagged as an rToken-specific detachment").toBe(true);
    });

    it("keeps the ranking equal to the widest hour in the series, so a sort regression cannot hide", () => {
      expect(thePack().analogues[0]?.ts, "rank 1 is the widest hour, recomputed independently").toBe(widestPoint().ts);
    });

    it("publishes the top five in descending order, all on that one weekend, all premiums", () => {
      const analogues = thePack().analogues;
      expect(analogues.length, "five published ranks").toBe(TOP_FIVE.length);
      let previous = Number.POSITIVE_INFINITY;
      TOP_FIVE.forEach((expected, index) => {
        const actual = analogues[index];
        const label = "rank " + String(index + 1) + " (" + expected.iso + ")";
        expect(actual?.rank, label + " is labelled correctly").toBe(index + 1);
        expect(actual ? iso(actual.ts) : "", label + " timestamp").toBe(expected.iso);
        expect(actual?.session, label + " NY session").toBe(expected.session);
        expect(actual?.absBasisPct ?? Number.NaN, label + " |basis|").toBeCloseTo(expected.absBasisPct, 4);
        expect(actual?.basisPct ?? Number.NaN, label + " is a premium").toBeGreaterThan(0);
        expect(actual?.absBasisPct ?? Number.NaN, label + " is no wider than the rank above it").toBeLessThanOrEqual(previous);
        expect(actual?.rTokenSpecificDetachment, label + " is rToken-specific").toBe(true);
        if (actual) previous = actual.absBasisPct;
      });
      // All five fall on UTC Saturday 2026-08-29, the same calendar day as the peak.
      expect(
        analogues.map((analogue) => iso(analogue.ts).slice(0, 10)),
        "the top five are one weekend event, not five unrelated spikes",
      ).toEqual(["2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29", "2026-08-29"]);
    });

    it("groups the peak into a multi-hour episode rather than a one-off print", () => {
      const worst = thePack().episodes[0];
      expect(worst, "episodes are published, sorted by peak width").toBeDefined();
      expect(worst ? iso(worst.peakTs) : "", "the widest episode peaks at the widest hour").toBe("2026-08-29T13:00:00.000Z");
      expect(worst?.peakBasisPct ?? Number.NaN, "with the published peak magnitude").toBeCloseTo(1.0749, 4);
      expect(worst?.hours ?? 0, "it persisted for hours, which is a different fact from a spike").toBe(7);
      expect(worst?.sessionAtPeak, "at the weekend").toBe("weekend");
    });
  });
});