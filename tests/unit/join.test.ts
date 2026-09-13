/**
 * F7: joins must be timestamp-keyed. An earlier positional join paired unrelated
 * hours and produced a false "rToken stuck while the index ran" narrative. The second
 * test below reproduces that class of error on purpose and asserts it disagrees with
 * the correct join, so the wrong approach can never be reintroduced quietly.
 */

import { describe, expect, it } from "vitest";
import { indexByTs, toCandle, toCandles, toPremiumPoints, windowOf } from "@/lib/compute/candles";
import { joinByTimestamp, joinWithOptional, unsafePositionalJoin_DO_NOT_USE } from "@/lib/compute/join";
import type { Candle } from "@/lib/compute/types";

const H = 3_600_000;
const T0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

function c(offsetHours: number, close: number): Candle {
  return { ts: T0 + offsetHours * H, open: close, high: close, low: close, close, baseVolume: null, quoteVolume: null };
}

describe("joinByTimestamp", () => {
  it("keeps only hours present in both series and reports what it dropped", () => {
    const left = [c(0, 10), c(1, 11), c(2, 12), c(3, 13)];
    const right = [c(0, 10), c(2, 12), c(3, 13), c(4, 14)];
    const result = joinByTimestamp(left, right);
    expect(result.rows.map((r) => r.ts)).toEqual([c(0, 0).ts, c(2, 0).ts, c(3, 0).ts]);
    expect(result.stats).toEqual({ leftRows: 4, rightRows: 4, matched: 3, droppedLeft: 1 });
    expect(result.fromTs).toBe(T0);
    expect(result.toTs).toBe(T0 + 3 * H);
  });

  it("never pairs a row with a partner from a different hour", () => {
    const left = [c(0, 10), c(5, 11)];
    const right = [c(1, 99), c(6, 99)];
    expect(joinByTimestamp(left, right).rows).toHaveLength(0);
  });

  it("returns an ascending series even when inputs are shuffled", () => {
    const result = joinByTimestamp([c(3, 1), c(1, 1), c(2, 1)], [c(2, 1), c(3, 1), c(1, 1)]);
    expect(result.rows.map((r) => r.ts)).toEqual([T0 + H, T0 + 2 * H, T0 + 3 * H]);
  });

  it("reports an empty window as null rather than as epoch zero", () => {
    expect(windowOf([])).toBeNull();
    expect(joinByTimestamp([], [c(0, 1)]).fromTs).toBeNull();
  });
});

describe("the positional join is wrong, provably", () => {
  it("misaligns series that start on different hours, exactly as the real data does", () => {
    // The rToken spot series and the index series start on different days and contain
    // different gaps: 70 of 1,000 recorded spot hours had no index partner.
    const spot = [c(0, 326), c(1, 326), c(2, 326), c(3, 326)];
    const index = [c(1, 326), c(2, 330), c(3, 333), c(4, 335)];

    const correct = joinByTimestamp(spot, index);
    const wrong = unsafePositionalJoin_DO_NOT_USE(spot, index);

    expect(correct.rows).toHaveLength(3);
    expect(wrong).toHaveLength(4);
    // The positional variant pairs hour 0 of spot with hour 1 of index, and so on:
    // every one of its pairs has a mismatched right-hand timestamp.
    for (const r of wrong) {
      const partner = indexByTs(index).get(r.ts);
      expect(partner?.ts === r.right.ts).toBe(false);
    }
    // And it therefore reports a different (false) basis for the same hour.
    const hour2Correct = correct.rows.find((r) => r.ts === T0 + 2 * H);
    const hour2Wrong = wrong.find((r) => r.ts === T0 + 2 * H);
    expect(hour2Correct?.right.close).toBe(330);
    expect(hour2Wrong?.right.close).toBe(333);
  });
});

describe("joinWithOptional", () => {
  it("adds a sparse third series without dropping required pairs", () => {
    const left = [c(0, 10), c(1, 11), c(2, 12)];
    const right = [c(0, 10), c(1, 11), c(2, 12)];
    const optional = [c(1, 10.5)];
    const result = joinWithOptional(left, right, optional);
    expect(result.rows).toHaveLength(3);
    expect(result.optionalByTs.get(T0 + H)?.close).toBe(10.5);
    expect(result.optionalByTs.get(T0)).toBeUndefined();
  });

  it("tolerates a null optional series", () => {
    expect(joinWithOptional([c(0, 1)], [c(0, 1)], null).optionalByTs.size).toBe(0);
  });
});

describe("candle decoding", () => {
  it("decodes a wire tuple of strings", () => {
    const decoded = toCandle(["1767225600000", "10", "11", "9", "10.5", "100", "1050"]);
    expect(decoded).toEqual({ ts: T0, open: 10, high: 11, low: 9, close: 10.5, baseVolume: 100, quoteVolume: 1050 });
  });

  it("treats Bitget's empty-string sentinel as absent, not as zero", () => {
    const decoded = toCandle(["1767225600000", "", "", "", "10.5", "", ""]);
    expect(decoded?.baseVolume).toBeNull();
    expect(decoded?.open).toBe(10.5); // falls back to close rather than inventing 0
  });

  it("drops rows with no usable timestamp or close", () => {
    expect(toCandle(["", "1", "1", "1", "1", "1", "1"])).toBeNull();
    expect(toCandle(["1767225600000", "1", "1", "1", "null", "1", "1"])).toBeNull();
    expect(toCandles([["1767225600000", "1", "1", "1", "null", "0", "0"], ["1767229200000", "1", "1", "1", "2", "0", "0"]])).toHaveLength(1);
  });

  it("decodes premium rows as fractions, not prices", () => {
    const points = toPremiumPoints([["1767225600000", "0", "0", "0", "0.001582839", "0", "0"]]);
    expect(points[0]?.premiumFraction).toBeCloseTo(0.001582839, 12);
  });
});