// Records real, keyless Bitget v3 market responses into lib/fixtures/.
// Fixtures are truthful snapshots of live data, never hand-authored numbers.
// Usage: node scripts/record-fixtures.mjs [--symbol AAPLUSDT] [--rtoken RAAPLUSDT]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "lib", "fixtures");
const BASE = "https://api.bitget.com/api/v3/market";
const SUCCESS_CODES = new Set(["0", "00000"]);

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PERP = argOf("--symbol", "AAPLUSDT");
const RTOKEN = argOf("--rtoken", "RAAPLUSDT");

const SPOT = "SPOT";
const FUT = "USDT-FUTURES";

/** name -> { path, query, keepRows? } */
const SPEC = [
  { name: "instruments-spot", path: "/instruments", query: { category: SPOT } },
  { name: "instruments-usdt-futures", path: "/instruments", query: { category: FUT } },
  { name: "tickers-spot-all", path: "/tickers", query: { category: SPOT }, keepRows: 40 },
  { name: "tickers-futures-all", path: "/tickers", query: { category: FUT }, keepRows: 40 },
  { name: "tickers-spot-symbol", path: "/tickers", query: { category: SPOT, symbol: RTOKEN } },
  { name: "tickers-futures-symbol", path: "/tickers", query: { category: FUT, symbol: PERP } },
  { name: "candles-spot-market-1h", path: "/candles", query: { category: SPOT, symbol: RTOKEN, interval: "1H", limit: "1000" } },
  { name: "candles-spot-market-1d", path: "/candles", query: { category: SPOT, symbol: RTOKEN, interval: "1D", limit: "1000" } },
  { name: "candles-futures-market-1h", path: "/candles", query: { category: FUT, symbol: PERP, interval: "1H", type: "market", limit: "1000" } },
  { name: "candles-futures-index-1h", path: "/candles", query: { category: FUT, symbol: PERP, interval: "1H", type: "index", limit: "1000" } },
  { name: "candles-futures-premium-1h", path: "/candles", query: { category: FUT, symbol: PERP, interval: "1H", type: "premium", limit: "1000" } },
  { name: "candles-futures-index-1d", path: "/candles", query: { category: FUT, symbol: PERP, interval: "1D", type: "index", limit: "1000" } },
  { name: "candles-futures-premium-1d", path: "/candles", query: { category: FUT, symbol: PERP, interval: "1D", type: "premium", limit: "1000" } },
  { name: "history-candles-spot-1d", path: "/history-candles", query: { category: SPOT, symbol: RTOKEN, interval: "1D", limit: "100" } },
  { name: "history-candles-futures-index-1d", path: "/history-candles", query: { category: FUT, symbol: PERP, interval: "1D", type: "index", limit: "100" } },
  { name: "index-components", path: "/index-components", query: { symbol: PERP } },
  { name: "orderbook-spot", path: "/orderbook", query: { category: SPOT, symbol: RTOKEN, limit: "20" } },
  { name: "orderbook-futures", path: "/orderbook", query: { category: FUT, symbol: PERP, limit: "20" } },
  { name: "fills-spot", path: "/fills", query: { category: SPOT, symbol: RTOKEN, limit: "100" } },
  { name: "fills-futures", path: "/fills", query: { category: FUT, symbol: PERP, limit: "100" } },
  { name: "current-fund-rate", path: "/current-fund-rate", query: { symbol: PERP } },
  { name: "history-fund-rate", path: "/history-fund-rate", query: { symbol: PERP, category: FUT, pageSize: "50" } },
  { name: "open-interest", path: "/open-interest", query: { symbol: PERP, category: FUT, limit: "50" } },
  { name: "discount-rate", path: "/discount-rate", query: {}, keepRows: 5 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRaw(pathname, query, attempt = 1) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { code: "PARSE_ERROR", msg: text.slice(0, 300) }; }
    return { url: url.pathname + url.search, status: res.status, latencyMs: Date.now() - started, body };
  } catch (err) {
    if (attempt < 3) {
      await sleep(800 * attempt);
      return fetchRaw(pathname, query, attempt + 1);
    }
    throw err;
  }
}

mkdirSync(FIXTURE_DIR, { recursive: true });

/**
 * Canonical match key: path + sorted, stringified, non-empty query params.
 * This MUST stay byte-identical to fixtureKey() in lib/fixtures/loader.ts, or
 * fixture mode silently misses every recording. tests/contract/fixture-index.test.ts
 * asserts the two agree.
 */
const fixtureKey = (pathname, query) => {
  const parts = [];
  for (const name of Object.keys(query || {}).sort()) {
    const value = query[name];
    if (value === undefined || value === null || value === "") continue;
    parts.push(name + "=" + String(value));
  }
  return pathname + (parts.length ? "?" + parts.join("&") : "");
};

const recordedAt = new Date().toISOString();
const manifest = [];
/** Sidecar lookup table: match key -> file. Lets the loader skip parsing 1.4MB of fixtures. */
const indexEntries = [];
const failures = [];

for (const spec of SPEC) {
  let attempt;
  try {
    attempt = await fetchRaw(spec.path, spec.query);
  } catch (err) {
    failures.push({ name: spec.name, error: String(err && err.message ? err.message : err) });
    console.log(`FAIL(net) ${spec.name}: ${err && err.message}`);
    await sleep(150);
    continue;
  }

  const code = attempt.body && attempt.body.code !== undefined ? String(attempt.body.code) : undefined;
  const ok = attempt.status === 200 && (code === undefined || SUCCESS_CODES.has(code));

  if (!ok) {
    failures.push({
      name: spec.name,
      httpStatus: attempt.status,
      code,
      msg: attempt.body && attempt.body.msg,
    });
    console.log(`FAIL ${spec.name}: HTTP ${attempt.status} code=${code} msg=${attempt.body && attempt.body.msg}`);
    await sleep(150);
    continue;
  }

  let data = attempt.body.data;
  let truncated = null;
  if (spec.keepRows && Array.isArray(data) && data.length > spec.keepRows) {
    truncated = { originalLength: data.length, keptLength: spec.keepRows };
    data = data.slice(0, spec.keepRows);
  }

  const fixture = {
    fixtureVersion: 1,
    name: spec.name,
    recordedAt,
    endpoint: "GET " + attempt.url,
    request: { path: spec.path, query: spec.query },
    httpStatus: attempt.status,
    latencyMs: attempt.latencyMs,
    response: { code: attempt.body.code, msg: attempt.body.msg, requestTime: attempt.body.requestTime, data },
    truncated,
  };

  const file = join(FIXTURE_DIR, spec.name + ".json");
  writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");

  const rowCount = Array.isArray(data) ? data.length : null;
  manifest.push({
    name: spec.name,
    file: "lib/fixtures/" + spec.name + ".json",
    endpoint: fixture.endpoint,
    recordedAt,
    rows: rowCount,
    truncated,
    bytes: JSON.stringify(fixture).length,
  });
  indexEntries.push({
    key: fixtureKey(spec.path, spec.query),
    name: spec.name,
    file: "lib/fixtures/" + spec.name + ".json",
    recordedAt,
    endpoint: fixture.endpoint,
  });
  console.log(`ok   ${spec.name}  rows=${rowCount ?? "obj"}  ${fixture.endpoint}`);
  await sleep(150);
}

writeFileSync(
  join(FIXTURE_DIR, "manifest.json"),
  JSON.stringify({ fixtureVersion: 1, recordedAt, base: BASE, perpSymbol: PERP, rTokenSymbol: RTOKEN, count: manifest.length, fixtures: manifest, failures }, null, 2) + "\n",
);

indexEntries.sort((left, right) => left.key.localeCompare(right.key));
writeFileSync(
  join(FIXTURE_DIR, "index.json"),
  JSON.stringify(
    { fixtureVersion: 1, generatedAt: new Date().toISOString(), recordedAt, base: BASE, count: indexEntries.length, entries: indexEntries },
    null,
    2,
  ) + "\n",
);

console.log(`\n=== recorded ${manifest.length}/${SPEC.length} fixtures into lib/fixtures/ ===`);
if (failures.length) {
  console.log("FAILURES: " + JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
