/**
 * Contract tests: the recorded corpus in lib/fixtures IS Nightjar's wire contract.
 *
 * These assert the three things that would silently break the app if they drifted:
 *   1. Every recording still parses against the Zod schema written from it.
 *   2. The sidecar index.json keys are byte-identical to what fixtureKey() computes
 *      at runtime - otherwise fixture mode misses and the app degrades to "no data".
 *   3. Every EndpointSpec in lib/bitget/endpoints.ts resolves to a real recording,
 *      so the code paths we ship are exactly the paths we verified against Bitget.
 *
 * A miss must FAIL, never substitute. Returning AAPL data for an MSFT question is
 * the single worst thing this app could do (DECISION.md 7.7).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  FIXTURE_VERSION,
  FixtureMissError,
  fixtureKey,
  fixtureMeta,
  listFixtureKeys,
  loadFixture,
  loadFixtureByName,
} from "@/lib/fixtures/loader";
import {
  candlesSchema,
  currentFundRateSchema,
  discountRateSchema,
  fillsSchema,
  historyFundRateSchema,
  indexComponentsSchema,
  instrumentsSchema,
  isSuccessCode,
  openInterestSchema,
  orderbookSchema,
  tickersSchema,
} from "@/lib/schema/bitget";
import {
  FUTURES,
  SPOT,
  candlesSpec,
  currentFundRateSpec,
  discountRateSpec,
  fillsSpec,
  historyCandlesSpec,
  historyFundRateSpec,
  indexComponentsSpec,
  instrumentsSpec,
  openInterestSpec,
  orderbookSpec,
  tickersSpec,
} from "@/lib/bitget/endpoints";
import { fixtureTransport, restGet, type EndpointSpec, type Query } from "@/lib/bitget/client";
import { BITGET_MARKET_PREFIX } from "@/lib/config";
import { ttlFor } from "@/lib/bitget/cache";

const FIXTURE_DIR = join(process.cwd(), "lib", "fixtures");

/** Query params of an endpoint label, order-insensitively, for comparing two labels. */
function paramsOf(endpoint: string): string[] {
  const query = endpoint.split("?")[1] ?? "";
  return query.split("&").filter(Boolean).sort();
}
const FIXTURE_COUNT = 24;

/** The one dual-listed name recorded end to end: the AAPL perp + the rAAPL spot rToken. */
const SPOT_SYMBOL = "RAAPLUSDT";
const PERP_SYMBOL = "AAPLUSDT";

/** Fixture name -> the schema its recorded data must satisfy. Covers all 24 recordings. */
const SCHEMA_BY_NAME: Record<string, ZodTypeAny> = {
  "instruments-spot": instrumentsSchema,
  "instruments-usdt-futures": instrumentsSchema,
  "tickers-spot-all": tickersSchema,
  "tickers-spot-symbol": tickersSchema,
  "tickers-futures-all": tickersSchema,
  "tickers-futures-symbol": tickersSchema,
  "candles-spot-market-1d": candlesSchema,
  "candles-spot-market-1h": candlesSchema,
  "candles-futures-market-1h": candlesSchema,
  "candles-futures-index-1d": candlesSchema,
  "candles-futures-index-1h": candlesSchema,
  "candles-futures-premium-1d": candlesSchema,
  "candles-futures-premium-1h": candlesSchema,
  "history-candles-spot-1d": candlesSchema,
  "history-candles-futures-index-1d": candlesSchema,
  "orderbook-spot": orderbookSchema,
  "orderbook-futures": orderbookSchema,
  "fills-spot": fillsSchema,
  "fills-futures": fillsSchema,
  "index-components": indexComponentsSchema,
  "current-fund-rate": currentFundRateSchema,
  "history-fund-rate": historyFundRateSchema,
  "open-interest": openInterestSchema,
  "discount-rate": discountRateSchema,
};

/**
 * The only three payloads the recorder trimmed, with the exact original sizes it
 * reported. Truncation is declared, never silent: a judge reading the fixture can
 * see that /discount-rate really returned 503 coins and that we kept 5.
 */
const DECLARED_TRUNCATIONS: Record<string, { originalLength: number; keptLength: number }> = {
  "discount-rate": { originalLength: 503, keptLength: 5 },
  "tickers-spot-all": { originalLength: 1761, keptLength: 40 },
  "tickers-futures-all": { originalLength: 787, keptLength: 40 },
};

interface RecordedSpec {
  name: string;
  path: string;
  query: Query;
}

function specOf<T>(name: string, spec: EndpointSpec<T>): RecordedSpec {
  return { name, path: spec.path, query: spec.query ?? {} };
}

interface ParseOutcome {
  success: boolean;
  error?: { issues: Array<{ path: Array<string | number>; message: string }> };
}

function parseDetail(parsed: ParseOutcome): string {
  if (parsed.success) return "ok";
  return (parsed.error?.issues ?? [])
    .slice(0, 3)
    .map((issue) => issue.path.join(".") + ": " + issue.message)
    .join(" | ");
}

function schemaFor(name: string): ZodTypeAny {
  const schema = SCHEMA_BY_NAME[name];
  if (!schema) throw new Error("test bug: no schema mapped for fixture " + name);
  return schema;
}

const ALL_NAMES = Object.keys(SCHEMA_BY_NAME).sort();

/** Every spec the app can emit, spelled with the symbols that were actually recorded. */
const RECORDED_SPECS: RecordedSpec[] = [
  specOf("instruments-spot", instrumentsSpec(SPOT)),
  specOf("instruments-usdt-futures", instrumentsSpec(FUTURES)),
  specOf("tickers-spot-all", tickersSpec(SPOT)),
  specOf("tickers-spot-symbol", tickersSpec(SPOT, SPOT_SYMBOL)),
  specOf("tickers-futures-all", tickersSpec(FUTURES)),
  specOf("tickers-futures-symbol", tickersSpec(FUTURES, PERP_SYMBOL)),
  specOf("candles-spot-market-1d", candlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1D" })),
  specOf("candles-spot-market-1h", candlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1H" })),
  specOf(
    "candles-futures-market-1h",
    candlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1H", type: "market" }),
  ),
  specOf(
    "candles-futures-index-1d",
    candlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1D", type: "index" }),
  ),
  specOf(
    "candles-futures-index-1h",
    candlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1H", type: "index" }),
  ),
  specOf(
    "candles-futures-premium-1d",
    candlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1D", type: "premium" }),
  ),
  specOf(
    "candles-futures-premium-1h",
    candlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1H", type: "premium" }),
  ),
  specOf("history-candles-spot-1d", historyCandlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1D" })),
  specOf(
    "history-candles-futures-index-1d",
    historyCandlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1D", type: "index" }),
  ),
  specOf("orderbook-spot", orderbookSpec(SPOT, SPOT_SYMBOL)),
  specOf("orderbook-futures", orderbookSpec(FUTURES, PERP_SYMBOL)),
  specOf("fills-spot", fillsSpec(SPOT, SPOT_SYMBOL)),
  specOf("fills-futures", fillsSpec(FUTURES, PERP_SYMBOL)),
  specOf("index-components", indexComponentsSpec(PERP_SYMBOL)),
  specOf("current-fund-rate", currentFundRateSpec(PERP_SYMBOL)),
  specOf("history-fund-rate", historyFundRateSpec(PERP_SYMBOL)),
  specOf("open-interest", openInterestSpec(PERP_SYMBOL)),
  specOf("discount-rate", discountRateSpec()),
];

describe("recorded fixture corpus", () => {
  it("holds exactly the 24 recordings the schema map and spec list cover", () => {
    expect(fixtureMeta().count).toBe(FIXTURE_COUNT);
    expect(listFixtureKeys()).toHaveLength(FIXTURE_COUNT);
    expect(ALL_NAMES).toHaveLength(FIXTURE_COUNT);
    expect(RECORDED_SPECS.map((entry) => entry.name).sort()).toEqual(ALL_NAMES);

    const files = readdirSync(FIXTURE_DIR).filter(
      (file) => file.endsWith(".json") && file !== "index.json" && file !== "manifest.json",
    );
    expect(files.sort()).toEqual(ALL_NAMES.map((name) => name + ".json"));
  });

  it("parses every fixture and validates its payload against the matching schema", () => {
    for (const name of ALL_NAMES) {
      const fixture = loadFixtureByName(name);
      expect(fixture.name, name).toBe(name);
      expect(fixture.fixtureVersion, name).toBe(FIXTURE_VERSION);
      expect(fixture.httpStatus, name).toBe(200);
      expect(isSuccessCode(fixture.response.code), name + " code " + String(fixture.response.code)).toBe(true);

      const parsed = schemaFor(name).safeParse(fixture.response.data);
      expect(parsed.success, name + " -> " + parseDetail(parsed)).toBe(true);
    }
  });

  it("stamps every fixture with a real recording time and a resolvable endpoint", () => {
    for (const name of ALL_NAMES) {
      const fixture = loadFixtureByName(name);
      expect(Number.isNaN(Date.parse(fixture.recordedAt)), name + " recordedAt").toBe(false);

      const requestTime = Number(fixture.response.requestTime);
      expect(Number.isFinite(requestTime) && requestTime > 0, name + " requestTime").toBe(true);
      expect(Math.abs(requestTime - Date.parse(fixture.recordedAt)), name + " clock skew").toBeLessThan(600000);
      expect(fixture.endpoint.startsWith("GET /api/v3/market" + fixture.request.path), name + " endpoint").toBe(true);
      expect(fixture.latencyMs, name + " latencyMs").toBeGreaterThanOrEqual(0);
    }
  });

  it("declares truncation for exactly the three large payloads and keeps the row count honest", () => {
    for (const name of ALL_NAMES) {
      const fixture = loadFixtureByName(name);
      const expected = DECLARED_TRUNCATIONS[name];

      if (!expected) {
        expect(fixture.truncated ?? null, name + " must never be silently truncated").toBeNull();
        continue;
      }

      expect(fixture.truncated, name).toEqual(expected);
      expect(expected.keptLength).toBeLessThan(expected.originalLength);
      const rows = fixture.response.data;
      expect(Array.isArray(rows), name + " truncated payload is a flat array").toBe(true);
      expect(rows).toHaveLength(expected.keptLength);
    }
  });
});

describe("sidecar index.json", () => {
  interface SidecarEntry {
    key: string;
    name: string;
    file: string;
  }

  const sidecar = JSON.parse(readFileSync(join(FIXTURE_DIR, "index.json"), "utf8")) as {
    recordedAt: string;
    entries: SidecarEntry[];
  };

  it("is byte-compatible with the keys fixtureKey() computes at runtime", () => {
    expect(sidecar.entries).toHaveLength(FIXTURE_COUNT);
    expect(fixtureMeta().recordedAt).toBe(sidecar.recordedAt);

    for (const entry of sidecar.entries) {
      const fixture = loadFixtureByName(entry.name);
      expect(fixtureKey(fixture.request.path, fixture.request.query), entry.name).toBe(entry.key);
      expect(entry.file, entry.name).toBe("lib/fixtures/" + entry.name + ".json");
      expect(listFixtureKeys(), entry.name).toContain(entry.key);
    }
  });

  it("normalises query order and drops empty params, so matching cannot depend on spelling", () => {
    expect(fixtureKey("/tickers", { symbol: PERP_SYMBOL, category: "SPOT" })).toBe(
      fixtureKey("/tickers", { category: "SPOT", symbol: PERP_SYMBOL }),
    );
    expect(fixtureKey("/discount-rate", { symbol: "" })).toBe("/discount-rate");
    expect(fixtureKey("/discount-rate", { symbol: undefined })).toBe("/discount-rate");
    expect(fixtureKey("/candles", { limit: 1000 })).toBe("/candles?limit=1000");
    expect(sidecar.entries.map((entry) => entry.key)).toContain("/discount-rate");
  });
});

describe("endpoint specs resolve to recordings", () => {
  it("loads every spec the app can emit, with no fixture miss", () => {
    for (const entry of RECORDED_SPECS) {
      const fixture = loadFixture(entry.path, entry.query);
      expect(fixture.name, entry.name + " " + fixtureKey(entry.path, entry.query)).toBe(entry.name);

      const parsed = schemaFor(entry.name).safeParse(fixture.response.data);
      expect(parsed.success, entry.name + " -> " + parseDetail(parsed)).toBe(true);
    }
  });

  it("records SPOT candles without a type param and FUTURES candles with one", () => {
    expect(candlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1D" }).query).toEqual({
      category: "SPOT",
      symbol: SPOT_SYMBOL,
      interval: "1D",
      limit: 1000,
    });
    expect(candlesSpec({ category: FUTURES, symbol: PERP_SYMBOL, interval: "1D", type: "index" }).query).toEqual({
      category: "USDT-FUTURES",
      symbol: PERP_SYMBOL,
      interval: "1D",
      type: "index",
      limit: 1000,
    });
    // /history-candles rejects 200+ with code 40020 - probed, not assumed.
    expect(historyCandlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1D" }).query?.limit).toBe(100);
    expect(historyCandlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1D", limit: 5000 }).query?.limit).toBe(
      100,
    );
    expect(candlesSpec({ category: SPOT, symbol: SPOT_SYMBOL, interval: "1D", limit: 5000 }).query?.limit).toBe(1000);
  });

  it("labels every envelope with the exact request that produced it", async () => {
    for (const entry of RECORDED_SPECS) {
      const fixture = loadFixture(entry.path, entry.query);
      const envelope = await restGet(entry.path, entry.query, {
        transport: fixtureTransport,
        skipRateLimit: true,
        maxAttempts: 1,
      });

      // Provenance IS the product: a reader must be able to see which call produced a
      // number. The label is canonical (method + v3 path + sorted query), which is the
      // same string fixtures are matched and cached on, so it cannot drift by mode.
      expect(envelope.endpoint, entry.name).toBe("GET " + BITGET_MARKET_PREFIX + fixtureKey(entry.path, entry.query));
      // The recorder writes the label in request order; the parameter SET must still match.
      expect(paramsOf(fixture.endpoint), entry.name).toEqual(paramsOf(envelope.endpoint));
      for (const [name, value] of Object.entries(entry.query ?? {})) {
        if (value === undefined || value === "") continue;
        expect(envelope.endpoint, entry.name + " dropped " + name).toContain(name + "=" + String(value));
      }

      // And the datum must still be able to say when it was really observed.
      expect(envelope.recordedAt, entry.name).toBe(fixture.recordedAt);
      expect(envelope.upstreamTime, entry.name).toBe(Number(fixture.response.requestTime));
      expect(envelope.latencyMs, entry.name).toBe(0);
    }
  });

  it("caches /discount-rate for 24h and never parameterises it by symbol", () => {
    // It ignores ?symbol and returns ~427KB for every coin, so calling it per request is
    // the single easiest way to blow a serverless budget (DECISION.md 7.4).
    const spec = discountRateSpec();
    expect(spec.query).toEqual({});
    expect(fixtureKey(spec.path, spec.query)).toBe("/discount-rate");
    expect(ttlFor(spec.ttl)).toBe(24 * 60 * 60 * 1000);
  });

  it("fails closed on an unrecorded request instead of substituting a nearby one", () => {
    expect(() => loadFixture("/tickers", { category: "SPOT", symbol: "RMSFTUSDT" })).toThrowError(FixtureMissError);
    expect(() => loadFixture("/candles", { category: "SPOT", symbol: SPOT_SYMBOL, interval: "4H" })).toThrowError(
      FixtureMissError,
    );
    expect(() => loadFixtureByName("tickers-spot-symbol-msft")).toThrowError(FixtureMissError);

    try {
      loadFixture("/tickers", { category: "SPOT", symbol: "RMSFTUSDT" });
      throw new Error("expected a FixtureMissError");
    } catch (err) {
      expect(err).toBeInstanceOf(FixtureMissError);
      const miss = err as FixtureMissError;
      expect(miss.kind).toBe("fixture_miss");
      // The message must name the miss AND list what we do have, so it is actionable.
      expect(miss.message).toContain("/tickers?category=SPOT&symbol=RMSFTUSDT");
      expect(miss.message).toContain("record-fixtures");
    }
  });
});
