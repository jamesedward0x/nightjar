/**
 * The read-only guarantee, machine-checked.
 *
 * DECISION.md 6.9 makes "Nightjar cannot trade" an architectural claim rather than a
 * sentence in the README. This file is the evidence, and it runs against the real SDK
 * (v1.2.0), not a mock:
 *
 *   1. the config the app actually builds is readOnly, keyless, and limited to the two
 *      public market modules;
 *   2. buildTools() on that config yields ZERO write tools, and every tool name is a getter;
 *   3. readOnly:true is load-bearing - the same modules with readOnly:false DO expose order
 *      placement and leverage changes, so flipping the constant is a caught regression;
 *   4. the SDK still has no "market" module, which is why BITGET_SDK_MODULES is spot,futures;
 *   5. every endpoint spec is one of the 11 public v3 market paths and carries no auth param;
 *   6. no source file calls an authenticated SDK method or reads a credential;
 *   7. .env.example declares exactly one secret name and nothing NEXT_PUBLIC_.
 *
 * If a future SDK version changes any of this, these tests fail and we re-verify before
 * shipping. That is the point.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTools, loadConfig } from "@bitget-ai/bitget-agent-sdk";

import { BITGET_MARKET_PREFIX, BITGET_READ_ONLY, BITGET_SDK_MODULES } from "@/lib/config";
import { getSdkConfig, resetSdkConfig } from "@/lib/bitget/client";
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

const READ_MODULES = BITGET_SDK_MODULES.split(",");
const PRIVATE_MODULES = ["account", "margin", "copytrading", "convert", "earn", "p2p", "broker"];
const WRITE_VERBS = /place|cancel|modify|submit|withdraw|transfer|leverage|update_config|create|delete|approve|revoke|repay|borrow/i;
const AUTH_PARAMS = /api[_-]?key|sign|signature|passphrase|secret|access[_-]?token/i;

/**
 * The complete public v3 market surface Nightjar touches (DECISION.md 6.6). Exactly the
 * 11 endpoint families the submission claims - no more, no less.
 */
const PUBLIC_MARKET_PATHS = [
  "/instruments",
  "/tickers",
  "/candles",
  "/history-candles",
  "/index-components",
  "/orderbook",
  "/fills",
  "/current-fund-rate",
  "/history-fund-rate",
  "/open-interest",
  "/discount-rate",
];

const ALL_SPECS = [
  instrumentsSpec(SPOT),
  instrumentsSpec(FUTURES),
  tickersSpec(SPOT),
  tickersSpec(SPOT, "RAAPLUSDT"),
  tickersSpec(FUTURES),
  tickersSpec(FUTURES, "AAPLUSDT"),
  candlesSpec({ category: SPOT, symbol: "RAAPLUSDT", interval: "1H" }),
  candlesSpec({ category: SPOT, symbol: "RAAPLUSDT", interval: "1D" }),
  candlesSpec({ category: FUTURES, symbol: "AAPLUSDT", interval: "1H", type: "market" }),
  candlesSpec({ category: FUTURES, symbol: "AAPLUSDT", interval: "1H", type: "index" }),
  candlesSpec({ category: FUTURES, symbol: "AAPLUSDT", interval: "1H", type: "premium" }),
  historyCandlesSpec({ category: SPOT, symbol: "RAAPLUSDT", interval: "1D" }),
  historyCandlesSpec({ category: FUTURES, symbol: "AAPLUSDT", interval: "1D", type: "index" }),
  indexComponentsSpec("AAPLUSDT"),
  orderbookSpec(SPOT, "RAAPLUSDT"),
  orderbookSpec(FUTURES, "AAPLUSDT"),
  fillsSpec(SPOT, "RAAPLUSDT"),
  fillsSpec(FUTURES, "AAPLUSDT"),
  currentFundRateSpec("AAPLUSDT"),
  historyFundRateSpec("AAPLUSDT"),
  openInterestSpec("AAPLUSDT"),
  discountRateSpec(),
];

/** Every server-side source file, so nothing can hide a credential read in a new module. */
function serverSources(): string[] {
  const files: string[] = [];
  for (const root of ["app", "lib"]) {
    for (const entry of readdirSync(root, { recursive: true })) {
      const name = String(entry);
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      files.push(root + "/" + name.split("\\").join("/"));
    }
  }
  return files.sort();
}

/**
 * The complete set of environment variables server code may read. There is deliberately
 * no Bitget credential in it: market data is keyless, and the only secret the project
 * holds is the Qwen gateway key, which /api/health checks for PRESENCE and never logs.
 */
const ALLOWED_ENV = [
  "BITGET_QWEN_API_KEY",
  "QWEN_BASE_URL",
  "QWEN_MODEL",
  "BITGET_API_BASE_URL",
  "NIGHTJAR_MODE",
  "NIGHTJAR_LOG_LEVEL",
  // Phase 3 tuning knobs. Both are bounded in code (MAX_TOOL_CALLS default 6,
  // RESEARCH_TIMEOUT_MS clamped to the platform limit), so a hostile value cannot
  // turn into an unbounded loop or an unbounded function.
  "MAX_TOOL_CALLS",
  "RESEARCH_TIMEOUT_MS",
  // Both are read through a defaulted `env: NodeJS.ProcessEnv = process.env` parameter, so
  // the process.env.NAME scan below cannot see them. Listed explicitly so the allowlist
  // stays a true inventory of what this app reads.
  "FUNCTION_MAX_DURATION_S",
  "QWEN_MAX_OUTPUT_TOKENS",
];

describe("the SDK config Nightjar actually runs with", () => {
  resetSdkConfig();
  const config = getSdkConfig();

  it("is read-only, keyless, and limited to the two public market modules", () => {
    expect(BITGET_READ_ONLY, "BITGET_READ_ONLY is a hard invariant").toBe(true);
    expect(config.readOnly).toBe(true);
    expect(
      config.hasAuth,
      "getSdkConfig() picked up credentials from the environment. Nightjar must run keyless - unset BITGET_API_KEY / BITGET_SECRET_KEY / BITGET_PASSPHRASE.",
    ).toBe(false);
    expect(config.apiKey).toBeUndefined();
    expect(config.secretKey).toBeUndefined();
    expect(config.passphrase).toBeUndefined();
    expect(config.modules).toEqual(READ_MODULES);
    expect(config.modules.filter((module) => PRIVATE_MODULES.includes(module))).toEqual([]);
    expect(config.baseUrl).toBe("https://api.bitget.com");
  });

  it("builds a tool set with no write verb in it at all", () => {
    const tools = buildTools(config);
    // 18 read tools from spot+futures as recorded against SDK v1.2.0. If this number
    // moves, the surface changed: re-verify read-only status before shipping.
    expect(tools.length, "SDK tool count changed - re-verify the read-only guarantee").toBe(18);
    expect(tools.filter((tool) => tool.isWrite).map((tool) => tool.name)).toEqual([]);
    expect(tools.filter((tool) => !/(^|_)get_/.test(tool.name)).map((tool) => tool.name)).toEqual([]);
    expect(tools.filter((tool) => WRITE_VERBS.test(tool.name)).map((tool) => tool.name)).toEqual([]);
    expect(tools.filter((tool) => !READ_MODULES.includes(tool.module)).map((tool) => tool.name)).toEqual([]);
  });

  it("proves readOnly:true is what removes the write tools, so flipping it cannot be silent", () => {
    const writable = buildTools(loadConfig({ modules: BITGET_SDK_MODULES, readOnly: false }));
    const writeNames = writable.filter((tool) => tool.isWrite).map((tool) => tool.name);
    // Observed against v1.2.0: 28 tools, 10 of them writes, including these.
    expect(writeNames.length, "readOnly:false no longer exposes writes - re-check this test's premise").toBeGreaterThan(0);
    expect(writeNames).toContain("spot_place_order");
    expect(writeNames).toContain("futures_place_order");
    expect(writeNames).toContain("futures_set_leverage");

    const readOnlyNames = new Set(buildTools(config).map((tool) => tool.name));
    expect(
      writeNames.filter((name) => readOnlyNames.has(name)),
      "a write tool leaked into the read-only tool set",
    ).toEqual([]);
  });

  it("still has no 'market' module, which is why BITGET_SDK_MODULES is spot,futures", () => {
    // DECISION.md 11.7. If a future SDK adds one, this fails and we re-decide the surface.
    expect(() => loadConfig({ modules: "market", readOnly: true })).toThrow(/Unknown module/);
    expect(READ_MODULES).toEqual(["spot", "futures"]);
  });
});

describe("the endpoint surface", () => {
  it("calls only the 11 public v3 market paths, with no auth parameter anywhere", () => {
    expect(BITGET_MARKET_PREFIX).toBe("/api/v3/market");
    for (const spec of ALL_SPECS) {
      expect(PUBLIC_MARKET_PATHS, spec.id).toContain(spec.path);
      expect(spec.path.startsWith("/"), spec.id).toBe(true);
      const authParams = Object.keys(spec.query ?? {}).filter((name) => AUTH_PARAMS.test(name));
      expect(authParams, spec.id + " must not send credentials").toEqual([]);
    }
    // The allowlist is exactly what we call: no unused entry hiding an endpoint we
    // do not actually use, and no path we call that is not on the list.
    const called = new Set(ALL_SPECS.map((spec) => spec.path));
    expect([...called].sort()).toEqual([...PUBLIC_MARKET_PATHS].sort());
    const ids = ALL_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size, "two specs share an id, so they would share a cache entry").toBe(ids.length);
  });
});

describe("the source itself", () => {
  const sources = serverSources();

  it("scans every server source file, not just the ones we remembered", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources).toContain("lib/bitget/client.ts");
    expect(sources).toContain("app/api/health/route.ts");
  });

  it("never calls an authenticated SDK method", () => {
    for (const rel of sources) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel + " must not call privateGet/privatePost").not.toMatch(/\.\s*private(Get|Post)\s*\(/);
    }
  });

  it("reads no environment variable outside the allowlist, and no exchange credential at all", () => {
    const seen = new Map<string, string[]>();
    for (const rel of sources) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel + " must not push a secret into the client bundle").not.toMatch(/process\.env\.NEXT_PUBLIC_/);
      for (const match of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        const name = match[1] ?? "";
        if (!name) continue;
        const where = seen.get(name) ?? [];
        where.push(rel);
        seen.set(name, where);
      }
    }
    const unexpected = [...seen.keys()].filter((name) => !ALLOWED_ENV.includes(name)).sort();
    expect(unexpected, "undeclared env read; add it to ALLOWED_ENV only after review").toEqual([]);
    expect(
      [...seen.keys()].filter((name) => /SECRET|PASSPHRASE|PRIVATE_KEY/.test(name)),
      "Nightjar must never hold a Bitget API secret",
    ).toEqual([]);
    expect([...seen.keys()].filter((name) => name.endsWith("API_KEY"))).toEqual(["BITGET_QWEN_API_KEY"]);
  });

  it("ships exactly one secret name in .env.example, and nothing client-visible", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    const declared = env
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));
    expect(declared.filter((name) => /KEY|SECRET|TOKEN|PASSPHRASE/.test(name))).toEqual(["BITGET_QWEN_API_KEY"]);
    expect(declared.filter((name) => name.startsWith("NEXT_PUBLIC_"))).toEqual([]);
    expect(declared).toContain("NIGHTJAR_MODE");
  });
});
