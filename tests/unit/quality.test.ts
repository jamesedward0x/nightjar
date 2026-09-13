import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectVolumeInconsistency } from "@/lib/compute/quality";
import type { Candle } from "@/lib/compute/types";
import { buildFallbackMemo, memoSchema } from "@/lib/llm/memo";
import { gatherEvidence } from "@/lib/research/evidence";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAY0 = Date.parse("2026-08-01T00:00:00.000Z");
/** The window the recorded corpus covers, so the test uses a realistic row count. */
const DAYS = 90;
/** The day that disagrees hardest, to prove the aggregate names the worst offender. */
const WORST_INDEX = 5;

function candle(ts: number, baseVolume: number | null, quoteVolume: number | null): Candle {
  return { ts, open: 100, high: 101, low: 99, close: 100, baseVolume, quoteVolume };
}

/**
 * Every daily row claims 1000 base units while its own 24 hourly rows sum to 24, so
 * every row offends the interval check by ~41x. One day offends by ~4166x. Against a
 * 24h turnover of 1, every quote volume is also implausible. This is the shape the
 * real rToken feed has, and it is what produced 72 duplicate flags.
 */
function corruptCorpus() {
  const daily: Candle[] = [];
  const hourly: Candle[] = [];
  for (let d = 0; d < DAYS; d += 1) {
    const dayStart = DAY0 + d * DAY_MS;
    daily.push(candle(dayStart, d === WORST_INDEX ? 100_000 : 1000, 1_000_000));
    for (let h = 0; h < 24; h += 1) hourly.push(candle(dayStart + h * HOUR_MS, 1, 100));
  }
  return { daily, hourly };
}

const ORIGINAL_MODE = process.env.NIGHTJAR_MODE;

beforeAll(() => {
  // The suite must never reach the network: fixture mode plus a fetch that throws.
  process.env.NIGHTJAR_MODE = "fixture";
  vi.stubGlobal("fetch", () => {
    throw new Error("tests/unit/quality.test.ts must not reach the network");
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_MODE === undefined) delete process.env.NIGHTJAR_MODE;
  else process.env.NIGHTJAR_MODE = ORIGINAL_MODE;
});

describe("detectVolumeInconsistency aggregation", () => {
  const flags = detectVolumeInconsistency({ ...corruptCorpus(), turnover24h: 1 });
  const byCode = (code: string) => flags.filter((f) => f.code === code);

  it("emits ONE flag per defect, not one per offending row", () => {
    // The shipped bug: 90 daily rows produced 72 identical flags, which overflowed
    // the memo's data_quality cap, the risk panel and the tool projection at once.
    expect(byCode("candle_volume_interval_inconsistent"), "interval defect collapses").toHaveLength(1);
    expect(byCode("candle_volume_implausible_vs_ticker"), "ticker defect collapses").toHaveLength(1);
    expect(flags, "exactly one flag per defect code").toHaveLength(2);
    expect(new Set(flags.map((f) => f.code)).size, "codes are unique").toBe(flags.length);
  });

  it("keeps the per-row arithmetic checkable in the aggregate", () => {
    const interval = byCode("candle_volume_interval_inconsistent")[0];
    expect(interval, "interval flag exists").toBeDefined();
    expect(interval?.severity).toBe("critical");
    expect(interval?.evidence.daysAffected, "every row offended").toBe(DAYS);
    expect(interval?.evidence.daysCompared, "every row was compared").toBe(DAYS);
    expect(interval?.evidence.worstDay, "the worst day is named").toBe(
      new Date(DAY0 + WORST_INDEX * DAY_MS).toISOString().slice(0, 10),
    );
    expect(interval?.evidence.worstHourlyRows, "the hourly rows behind it").toBe(24);

    const ticker = byCode("candle_volume_implausible_vs_ticker")[0];
    expect(ticker?.evidence.daysAffected).toBe(DAYS);
    expect(ticker?.evidence.turnover24h, "the denominator is recorded").toBe(1);
  });

  it("keeps each message inside the risk-flag caps the memo enforces", () => {
    // memoSchema allows flag <= 300 and evidence <= 400 characters. A message that
    // grows with the row count would eventually breach it, so this is the real bound.
    for (const flag of flags) {
      expect(flag.message.length, `${flag.code} message length`).toBeLessThanOrEqual(400);
      expect(flag.message.length, `${flag.code} message is substantive`).toBeGreaterThan(60);
    }
  });

  it("raises nothing when the intervals agree", () => {
    const daily = [candle(DAY0, 24, 2400)];
    const hourly: Candle[] = [];
    for (let h = 0; h < 24; h += 1) hourly.push(candle(DAY0 + h * HOUR_MS, 1, 100));
    expect(detectVolumeInconsistency({ daily, hourly, turnover24h: 2400 })).toHaveLength(0);
  });

  it("skips rows it cannot judge rather than inventing a ratio", () => {
    const daily = [candle(DAY0, null, null)];
    const hourly = [candle(DAY0, null, null)];
    expect(detectVolumeInconsistency({ daily, hourly, turnover24h: null })).toHaveLength(0);
  });
});

describe("the fallback memo under a flag-heavy pack", () => {
  it("keeps data_quality inside the schema cap now that the 1D leg loads", async () => {
    const res = await gatherEvidence("AAPL", { now: Date.parse("2026-09-13T12:00:00.000Z") });
    expect(res.ok, "fixture corpus builds a pack").toBe(true);
    if (!res.ok) return;
    const pack = res.pack;

    // Guards the evidence.ts limit fix: with limit=30 the 1D request missed the
    // recording permanently, the daily leg was empty, and this check never ran at all.
    expect(pack.sources.find((s) => s.id === "candles-spot-1d")?.status, "1D leg answers").toBe("ok");
    expect(
      pack.quality.flags.some((f) => f.code.startsWith("candle_volume")),
      "the volume cross-check actually fires",
    ).toBe(true);

    const memo = buildFallbackMemo(pack, "test");
    expect(memoSchema.shape.data_quality.safeParse(memo.data_quality).success, "data_quality fits the cap").toBe(true);
    expect(memo.data_quality.length, "and is comfortably under it").toBeLessThanOrEqual(700);
    // The standing disclosure must survive truncation: it is the honesty field.
    expect(memo.data_quality, "disclosure is intact").toContain("rToken spot candle volume is unreliable");
    expect(memoSchema.safeParse(memo).success, "the whole memo still validates").toBe(true);
  });
});