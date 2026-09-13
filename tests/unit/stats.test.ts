/**
 * Statistics. The percentile definition matters because "is this normal?" is a
 * judge-facing claim: we use linear interpolation between closest ranks (type 7,
 * the R/NumPy/Excel PERCENTILE.INC definition) so our numbers match a spreadsheet.
 */

import { describe, expect, it } from "vitest";
import {
  mean,
  median,
  percentile,
  percentileRankOfAbs,
  round,
  stdDev,
  summarize,
  sum,
  zScore,
} from "@/lib/compute/stats";

describe("percentile", () => {
  it("interpolates between closest ranks", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([15, 20, 35, 40, 50], 40)).toBeCloseTo(29, 10);
  });

  it("does not require sorted input", () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
  });

  it("clamps out-of-range p and handles singletons and empties", () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([1, 2, 3], 250)).toBe(3);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("central tendency and spread", () => {
  it("computes mean, median and sum", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3])).toBe(2);
    expect(sum([1, 2, 3])).toBe(6);
    expect(mean([])).toBeNull();
  });

  it("uses the population standard deviation", () => {
    expect(stdDev([1, 2, 3])).toBeCloseTo(Math.sqrt(2 / 3), 12);
    expect(stdDev([5, 5, 5])).toBe(0);
    expect(stdDev([])).toBeNull();
  });

  it("returns null from summarize on an empty sample rather than inventing zeros", () => {
    expect(summarize([])).toBeNull();
  });

  it("summarizes a signed sample, reporting mean and meanAbs separately", () => {
    const s = summarize([-1, 1]);
    expect(s).not.toBeNull();
    expect(s?.mean).toBe(0);
    expect(s?.meanAbs).toBe(1);
    expect(s?.min).toBe(-1);
    expect(s?.max).toBe(1);
    expect(s?.n).toBe(2);
  });
});

describe("percentileRankOfAbs", () => {
  it("places a reading within the absolute distribution", () => {
    expect(percentileRankOfAbs([0.1, 0.2, 0.3, 0.4], 0.4)).toBeCloseTo(87.5, 10);
    expect(percentileRankOfAbs([0.1, 0.2, 0.3, 0.4], 0.05)).toBeCloseTo(0, 10);
  });

  it("ignores sign, because a discount and a premium of equal size are equally unusual", () => {
    expect(percentileRankOfAbs([0.1, -0.2, 0.3], -0.3)).toBeCloseTo(percentileRankOfAbs([0.1, -0.2, 0.3], 0.3), 10);
  });

  it("handles ties at the midpoint so an exact duplicate is not the 100th percentile", () => {
    expect(percentileRankOfAbs([1, -2, 3], 2)).toBeCloseTo(50, 10);
  });

  it("returns null on an empty sample", () => {
    expect(percentileRankOfAbs([], 1)).toBeNull();
  });
});

describe("zScore", () => {
  it("is zero at the mean", () => {
    expect(zScore([1, 2, 3], 2)).toBeCloseTo(0, 12);
  });

  it("returns null when the sample has no variance instead of dividing by zero", () => {
    expect(zScore([5, 5, 5], 7)).toBeNull();
  });
});

describe("round", () => {
  it("rounds to the requested precision", () => {
    expect(round(1.23456, 3)).toBe(1.235);
    expect(round(0.0567, 3)).toBe(0.057);
  });
});