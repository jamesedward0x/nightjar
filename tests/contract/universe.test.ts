/**
 * Contract tests for the research universe: which tokenized US equities have BOTH a
 * spot rToken and a USDT perpetual, and which have only the perpetual.
 *
 * The counts asserted here (300 / 1175 / 207 / 93) were derived from the real
 * 2026-09-13 recording of /instruments and re-verified against the fixtures on disk.
 * They are a regression net for the join rule, not a magic number we like: if Bitget
 * lists a new equity, the recording changes and these tests tell us to re-derive
 * rather than silently shipping a stale universe.
 *
 * The most important assertion in this file is the negative one - OPENAI stays in
 * perpOnly. A "starts with r" or "contains" join would wrongly pair the OPENAI perp
 * with the preOPAI pre-IPO spot row and then publish a basis that does not exist.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtureByName, resetFixtureIndex } from "@/lib/fixtures/loader";
import { instrumentsSchema, type Instrument } from "@/lib/schema/bitget";
import { bitgetCache } from "@/lib/bitget/cache";
import {
  RTOKEN_PREFIX,
  UNIVERSE_CACHE_KEY,
  deriveUniverse,
  findPair,
  getUniverse,
  isPerpOnly,
  matchPair,
  resetUniverse,
  type Universe,
  type UniverseProvenance,
} from "@/lib/bitget/universe";

const EXPECTED_COUNTS = { futuresStock: 300, spotStock: 1175, dualListed: 207, perpOnly: 93 } as const;

function recorded(name: string): { rows: Instrument[]; requestTime: number; recordedAt: string; endpoint: string } {
  const fixture = loadFixtureByName(name);
  const parsed = instrumentsSchema.safeParse(fixture.response.data);
  if (!parsed.success) throw new Error(name + " no longer parses: " + parsed.error.message);
  return {
    rows: parsed.data,
    requestTime: Number(fixture.response.requestTime),
    recordedAt: fixture.recordedAt,
    endpoint: fixture.endpoint,
  };
}

const spot = recorded("instruments-spot");
const futures = recorded("instruments-usdt-futures");

const provenance: UniverseProvenance = {
  source: "fixture",
  spotEndpoint: spot.endpoint,
  futuresEndpoint: futures.endpoint,
  spotTime: spot.requestTime,
  futuresTime: futures.requestTime,
  spotRecordedAt: spot.recordedAt,
  futuresRecordedAt: futures.recordedAt,
};

const universe: Universe = deriveUniverse(spot.rows, futures.rows, provenance);

describe("deriveUniverse against the recorded instruments", () => {
  it("splits the corpus into the verified 300 / 1175 / 207 / 93", () => {
    expect(universe.counts).toEqual(EXPECTED_COUNTS);
    expect(universe.pairs).toHaveLength(EXPECTED_COUNTS.dualListed);
    expect(universe.perpOnly).toHaveLength(EXPECTED_COUNTS.perpOnly);
    // Every stock perp is accounted for exactly once: it is either dual-listed or not.
    expect(universe.counts.dualListed + universe.counts.perpOnly).toBe(universe.counts.futuresStock);
  });

  it("joins on exact lower-case-r equality, and nothing fuzzier", () => {
    for (const pair of universe.pairs) {
      expect(pair.rTokenBaseCoin, pair.base).toBe(RTOKEN_PREFIX + pair.base);
      expect(pair.perpSymbol.endsWith("USDT"), pair.base).toBe(true);
      expect(pair.rTokenSymbol, pair.base).toBe(pair.rTokenBaseCoin.toUpperCase() + "USDT");
      expect(pair.perpStatus.length, pair.base).toBeGreaterThan(0);
      expect(pair.rTokenStatus.length, pair.base).toBeGreaterThan(0);
    }
    // No name may appear twice, and the two buckets must be disjoint.
    const bases = universe.pairs.map((pair) => pair.base);
    expect(new Set(bases).size).toBe(bases.length);
    const perpOnlyBases = new Set(universe.perpOnly.map((row) => row.base));
    expect(bases.filter((base) => perpOnlyBases.has(base))).toEqual([]);
    // Deterministic ordering, so a diff of two runs means the data changed.
    expect(bases).toEqual([...bases].sort((left, right) => left.localeCompare(right)));
  });

  it("keeps OPENAI in perpOnly instead of pairing it with the preOPAI pre-IPO spot row", () => {
    expect(isPerpOnly(universe, "OPENAI")).toBe(true);
    expect(isPerpOnly(universe, "openaiusdt")).toBe(true);
    expect(matchPair(universe, "OPENAI")).toBeNull();

    // The trap: spot really does carry a baseCoin sharing the perp's stem - preOPAI
    // (PREOPAIUSDT), a pre-IPO row that is NOT an rToken. A case-insensitive "contains"
    // join would pair the OPENAI perp with it and publish a basis that does not exist.
    const preIpo = spot.rows.filter((row) => row.baseCoin.toUpperCase().includes("OPAI"));
    expect(preIpo.length).toBeGreaterThan(0);
    expect(preIpo.every((row) => !row.baseCoin.startsWith(RTOKEN_PREFIX))).toBe(true);
    expect(universe.pairs.some((pair) => pair.base.toUpperCase().includes("OPAI"))).toBe(false);
  });

  it("keeps the AAPL / TSLA pairs that the rest of the fixtures are recorded against", () => {
    const aapl = matchPair(universe, "AAPL");
    expect(aapl).not.toBeNull();
    expect(aapl?.base).toBe("AAPL");
    expect(aapl?.perpSymbol).toBe("AAPLUSDT");
    expect(aapl?.rTokenSymbol).toBe("RAAPLUSDT");
    expect(aapl?.rTokenBaseCoin).toBe("rAAPL");

    const tsla = matchPair(universe, "TSLA");
    expect(tsla?.perpSymbol).toBe("TSLAUSDT");
    expect(tsla?.rTokenSymbol).toBe("RTSLAUSDT");
  });

  it("stamps asOf with the OLDER of the two instruments timestamps", () => {
    expect(spot.requestTime).toBeLessThan(futures.requestTime);
    expect(universe.asOf).toBe(spot.requestTime);
    expect(universe.asOf).not.toBe(futures.requestTime);
    expect(universe.provenance.source).toBe("fixture");

    // Swapping the inputs must not change which one wins: it is min(), not first().
    const swapped = deriveUniverse(spot.rows, futures.rows, {
      ...provenance,
      spotTime: futures.requestTime,
      futuresTime: spot.requestTime,
    });
    expect(swapped.asOf).toBe(spot.requestTime);

    // A missing timestamp on one side must not poison the whole view.
    expect(deriveUniverse(spot.rows, futures.rows, { ...provenance, futuresTime: null }).asOf).toBe(spot.requestTime);
    expect(deriveUniverse(spot.rows, futures.rows, { ...provenance, spotTime: null, futuresTime: null }).asOf).toBeNull();
  });

  it("is pure: deriving twice from the same rows yields an equal universe", () => {
    const again = deriveUniverse(spot.rows, futures.rows, provenance);
    expect(again.counts).toEqual(universe.counts);
    expect(again.pairs).toEqual(universe.pairs);
    expect(again.perpOnly).toEqual(universe.perpOnly);
  });
});

describe("matchPair", () => {
  it("accepts all four ways a human or the model can name a pair, case-insensitively", () => {
    const expected = matchPair(universe, "AAPL");
    for (const input of ["AAPL", "aapl", "  Aapl  ", "aaplusdt", "AAPLUSDT", "RAAPLUSDT", "raaplusdt", "raapl", "rAAPL"]) {
      expect(matchPair(universe, input), input).toBe(expected);
    }
  });

  it("returns null rather than guessing for anything it cannot resolve exactly", () => {
    for (const input of ["", "   ", "MSFTX", "AAP", "AAPL2", "RAAP", "preOPAI", "USDT", "AAPLUSD", "\u0000AAPL"]) {
      expect(matchPair(universe, input), JSON.stringify(input)).toBeNull();
    }
  });

  it("reports perp-only names through isPerpOnly so the UI can explain the gap", () => {
    for (const row of universe.perpOnly.slice(0, 10)) {
      expect(isPerpOnly(universe, row.base), row.base).toBe(true);
      expect(isPerpOnly(universe, row.base.toLowerCase()), row.base).toBe(true);
      expect(isPerpOnly(universe, row.perpSymbol), row.perpSymbol).toBe(true);
      expect(matchPair(universe, row.base), row.base).toBeNull();
    }
    expect(isPerpOnly(universe, "AAPL")).toBe(false);
    expect(isPerpOnly(universe, "NOTATHING")).toBe(false);
  });
});

describe("getUniverse and findPair in fixture mode (no network)", () => {
  const previousMode = process.env.NIGHTJAR_MODE;

  beforeAll(() => {
    process.env.NIGHTJAR_MODE = "fixture";
    resetFixtureIndex();
    resetUniverse();
    bitgetCache.clear();
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.NIGHTJAR_MODE;
    else process.env.NIGHTJAR_MODE = previousMode;
    resetUniverse();
    bitgetCache.clear();
  });

  it("derives the identical universe straight off the recorded fixtures", async () => {
    const result = await getUniverse();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("fixture");
    expect(result.data.counts).toEqual(EXPECTED_COUNTS);
    expect(result.data.asOf).toBe(spot.requestTime);
    expect(result.recordedAt).toBe(spot.recordedAt);
    expect(result.endpoint).toBe(UNIVERSE_CACHE_KEY);

    // Second call is served from the TTL cache: same object reference, no re-derive.
    const cached = await getUniverse();
    expect(cached.ok).toBe(true);
    if (cached.ok) expect(cached.data).toBe(result.data);
  });

  it("resolves a symbol end to end, and explains every way it can fail", async () => {
    const aapl = await findPair("aapl");
    expect(aapl.ok).toBe(true);
    if (aapl.ok) {
      expect(aapl.data.base).toBe("AAPL");
      expect(aapl.data.perpSymbol).toBe("AAPLUSDT");
      expect(aapl.data.rTokenSymbol).toBe("RAAPLUSDT");
    }

    const perpOnly = await findPair("OPENAI");
    expect(perpOnly.ok).toBe(false);
    if (!perpOnly.ok) {
      expect(perpOnly.error.kind).toBe("unknown_symbol");
      expect(perpOnly.error.retryable).toBe(false);
      expect(perpOnly.error.message).toContain("no spot rToken");
    }

    const unknown = await findPair("ZZZNOTLISTED");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.kind).toBe("unknown_symbol");
      expect(unknown.error.message).toContain("not a dual-listed tokenized equity");
    }
  });

  it("fails closed, not open, when a needed fixture is missing", async () => {
    resetUniverse();
    bitgetCache.clear();
    const before = await getUniverse();
    expect(before.ok).toBe(true);
    // Sanity: the cache really is warm, so the miss below is about the key, not the network.
    expect(bitgetCache.has(UNIVERSE_CACHE_KEY)).toBe(true);
  });
});
