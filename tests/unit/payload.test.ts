/**
 * The server -> client projection.
 *
 * Two promises are pinned here. The payload stays small enough to stream, and nothing is
 * recomputed on the way out: projectPack only thins and selects, which is exactly why the
 * computed fallback memo and the AI memo show a reader identical figures.
 *
 * The pack under test is a real one - gatherEvidence() in fixture mode against the recorded
 * AAPL corpus - so these assertions also fail if the compute engine changes the shape of
 * EvidencePack without ClientPack following it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_CHART_POINTS, downsample, projectPack, projectPacks } from "@/lib/research/payload";
import { gatherEvidence, type EvidencePack } from "@/lib/research/evidence";

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
 * The AAPL corpus was recorded at 2026-09-13T11:50Z, so building the pack "as of" just
 * after that keeps the staleness detector quiet: these tests exercise the projection,
 * not a fixture that has gone cold.
 */
const FIXTURE_NOW = Date.parse("2026-09-13T12:00:00.000Z");

let gathered: EvidencePack | null = null;

beforeAll(async () => {
  enterFixtureMode();
  try {
    const result = await gatherEvidence("AAPL", { now: FIXTURE_NOW });
    if (!result.ok) throw new Error("fixture gather failed: " + result.kind + " - " + result.message);
    gathered = result.pack;
  } finally {
    exitFixtureMode();
  }
});

beforeEach(enterFixtureMode);
afterEach(exitFixtureMode);
afterAll(exitFixtureMode);

/** The one real pack, or a loud failure that names the actual problem. */
function thePack(): EvidencePack {
  if (!gathered) throw new Error("test bug: the AAPL fixture pack was never built");
  return gathered;
}

/** The same pack wearing a different identity, for the de-duplication test. */
function variant(base: string, rTokenSymbol: string): EvidencePack {
  return { ...thePack(), base, rTokenSymbol };
}

/** Everything except the two fields projectPack is allowed to touch. */
function wireShape(raw: unknown): Record<string, unknown> {
  const { premium, series, ...rest } = raw as EvidencePack;
  void premium;
  void series;
  return rest as unknown as Record<string, unknown>;
}

describe("downsample", () => {
  const source = Array.from({ length: 930 }, (_, index) => index);

  it("returns the input unchanged when it already fits", () => {
    const short = [1, 2, 3];
    expect(downsample(short, 10), "fewer points than the cap is not a chart problem").toBe(short);
    expect(downsample(short, 3), "exactly at the cap is not a chart problem").toBe(short);
    expect(downsample([], MAX_CHART_POINTS), "an empty series stays empty").toEqual([]);
    // max < 2 cannot keep both endpoints, so thinning is refused rather than faked.
    expect(downsample(source, 1), "a one-point cap is refused").toBe(source);
    expect(downsample(source, 0), "a zero cap is refused").toBe(source);
  });

  it("caps the series at max", () => {
    expect(MAX_CHART_POINTS, "chart resolution is a documented constant").toBe(240);
    for (const max of [2, 3, 17, 240, 929]) {
      expect(downsample(source, max).length, "length at cap " + String(max)).toBe(max);
    }
    expect(downsample(source, source.length + 5).length, "never padded beyond the source").toBe(source.length);
  });

  it("always keeps the first and the last point", () => {
    for (const max of [2, 5, 240]) {
      const out = downsample(source, max);
      expect(out[0], "first point at cap " + String(max)).toBe(source[0]);
      expect(out.at(-1), "last point at cap " + String(max)).toBe(source.at(-1));
    }
  });

  it("never reorders and never invents a point", () => {
    const out = downsample(source, MAX_CHART_POINTS);
    let previousIndex = -1;
    for (const value of out) {
      // indexOf is -1 for an invented point, which also fails the ordering check below.
      const index = source.indexOf(value);
      expect(index, "point " + String(value) + " must come from the source, still in order").toBeGreaterThan(
        previousIndex,
      );
      previousIndex = index;
    }
  });

  it("keeps both ends of the real 930-hour basis series", () => {
    const series = thePack().series;
    expect(series.length, "the recorded fixture is longer than the chart cap").toBeGreaterThan(MAX_CHART_POINTS);
    const out = downsample(series, MAX_CHART_POINTS);
    expect(out.length, "capped for the wire").toBe(MAX_CHART_POINTS);
    expect(out[0]?.ts, "the window start survives thinning").toBe(series[0]?.ts);
    expect(out.at(-1)?.ts, "the window end survives thinning").toBe(series.at(-1)?.ts);
  });
});

describe("projectPack", () => {
  it("drops the premium series the UI never renders", () => {
    const client = projectPack(thePack()) as unknown as Record<string, unknown>;
    expect(thePack().premium.length, "the source pack really does carry a premium series").toBeGreaterThan(0);
    expect("premium" in client, "premium must not cross the wire").toBe(false);
    expect(client["premium"], "and it must not be present as undefined either").toBeUndefined();
  });

  it("downsamples series to MAX_CHART_POINTS and nothing else about it", () => {
    const pack = thePack();
    const client = projectPack(pack);
    expect(client.series.length, "the wire series is capped").toBe(MAX_CHART_POINTS);
    expect(client.series, "thinning is the same pure function the chart cap uses").toEqual(
      downsample(pack.series, MAX_CHART_POINTS),
    );
    expect(client.series[0]?.ts, "the observation window shown on screen is the real one").toBe(
      pack.observationWindow?.fromTs,
    );
    expect(client.series.at(-1)?.ts, "never a cropped one").toBe(pack.observationWindow?.toTs);
  });

  it("preserves every other field of the pack unchanged", () => {
    const pack = thePack();
    const client = projectPack(pack);
    expect(client.base, "base").toBe(pack.base);
    expect(client.rTokenSymbol, "rTokenSymbol").toBe(pack.rTokenSymbol);
    expect(client.perpSymbol, "perpSymbol").toBe(pack.perpSymbol);
    expect(client.observationWindow, "observationWindow is the FULL sample, not the thinned one").toEqual(
      pack.observationWindow,
    );
    expect(client.snapshot, "snapshot").toEqual(pack.snapshot);
    expect(client.bySession, "bySession").toEqual(pack.bySession);
    expect(client.sources, "sources").toEqual(pack.sources);
    expect(client.quality, "quality").toEqual(pack.quality);
    expect(wireShape(client), "projectPack selects and thins; it never recomputes").toEqual(wireShape(pack));
  });
});

describe("projectPacks", () => {
  it("de-duplicates by base and preserves first-seen order", () => {
    const packs = [
      variant("AAPL", "RAAPLUSDT"),
      variant("MSFT", "RMSFTUSDT"),
      variant("AAPL", "RAAPLUSDT-LATER-DUPLICATE"),
      variant("TSLA", "RTSLAUSDT"),
    ];
    const out = projectPacks(packs);
    expect(
      out.map((client) => client.base),
      "one pack per distinct base, in the order they were gathered",
    ).toEqual(["AAPL", "MSFT", "TSLA"]);
    expect(out[0]?.rTokenSymbol, "the FIRST pack seen for a base wins").toBe("RAAPLUSDT");
  });

  it("projects every pack it keeps, and returns an empty list for none", () => {
    expect(projectPacks([]), "no packs in, no packs out").toEqual([]);
    const out = projectPacks([thePack(), thePack()]);
    expect(out, "the same base twice is still one pack").toHaveLength(1);
    const only = out[0] as unknown as Record<string, unknown> | undefined;
    expect(only && "premium" in only, "the kept pack is projected, not passed through raw").toBe(false);
    expect(out[0]?.series.length ?? MAX_CHART_POINTS + 1, "and its series is capped").toBeLessThanOrEqual(
      MAX_CHART_POINTS,
    );
  });
});