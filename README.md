# Nightjar

A 7x24 research desk for **tokenized US equities on Bitget**. It watches the rToken (e.g. `RAAPLUSDT`)
against the composite reference index its perpetual settles against (`AAPLUSDT`, `type=index`) and tells
you what drifted while the market that prices the stock was closed.

The nightjar is a bird that is invisible by day and whose churring song carries through the dark. It is
awake and working precisely when everything else has gone quiet - which is exactly the window this
product exists for.

> **Bitget AI Hackathon S2 - Track 3 (AI Trading Desk) - Personalized Research Workbench.**

---

## Status

**Phase 1 of 8 - the verified Bitget data layer.** See `.planning/DECISION.md` for the full plan.

| Phase | Scope | State |
|---|---|---|
| 0 | Approve the research base | done, signed off 2026-09-13 |
| 1 | Scaffold + verified read-only data layer | **in progress** |
| 2 | Deterministic compute engine (basis, sessions, liquidity, analogues) | not started |
| 3 | Qwen agent loop + structured memo | not started |
| 4 | LUI, streaming, charts | not started |
| 5 | Hardening: fixtures, tests, observability, security | not started |
| 6 | Vercel deployment + reproducible README | not started |
| 7 | Submission package | not started |

What exists today: a Next.js 15 app whose home page renders **one live number** - the rToken basis -
that has travelled through the whole real stack (rate limit, retry, cache, Zod validation, provenance)
and can say where it came from and how old it is. Plus `/api/health`, a recorded fixture corpus, and a
test suite that runs fully offline.

---

## The finding this is built on

Bitget lists **1,175 stock rTokens** on spot and **300 tokenized-equity USDT perpetuals**. Exactly
**207 names exist on both venues**, and **93 have a perp with no spot rToken**. For a dual-listed name,
the perp settles against a composite index whose recipe is published by
`/api/v3/market/index-components`: **Binance + Hyperliquid + Pyth, equal weight 0.3333 each**.

Joining the rToken's 1H spot candles to that index **by timestamp** (never by array position) over
**2026-08-02 20:00 UTC - 2026-09-13 11:00 UTC** (930 matched hours, AAPL):

| Session (America/New_York) | n | Mean abs basis |
|---|---|---|
| Regular trading hours | 180 | **0.057%** |
| Weekday off-hours | 535 | **0.087%** |
| Weekend | 215 | **0.315%** |

Weekend dislocation is **~5.5x** the RTH level; the single worst hour reached **1.075%**
(2026-08-29). Over the same window the perp tracked its own index ~5x more tightly, and the rToken's
24h turnover was roughly **30-50x** thinner than the perp's, with a top-of-book spread typically
**0.3-0.5%**. Every published claim carries its observation window, because the 1000-row 1H ceiling
makes the window slide forward every hour.

### Reproduce it yourself, keyless

```bash
# 1. rToken spot hourly candles (the param is `interval`, NOT `granularity`)
curl -s "https://api.bitget.com/api/v3/market/candles?category=SPOT&symbol=RAAPLUSDT&interval=1H&limit=1000"

# 2. The composite reference index the perp settles against
curl -s "https://api.bitget.com/api/v3/market/candles?category=USDT-FUTURES&symbol=AAPLUSDT&interval=1H&type=index&limit=1000"

# 3. Join BY TIMESTAMP, basis = (spot - index) / index, bucket by session in America/New_York.

# 4. The index recipe almost nobody knows exists
curl -s "https://api.bitget.com/api/v3/market/index-components?symbol=AAPLUSDT"

# 5. The liquidity asymmetry
curl -s "https://api.bitget.com/api/v3/market/tickers?category=SPOT&symbol=RAAPLUSDT"
curl -s "https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES&symbol=AAPLUSDT"
```

---

## Quickstart

Requires **Node >= 20** (developed on v24) and **pnpm 12**.

```bash
pnpm install
cp .env.example .env.local   # optional: everything works with no secrets set
pnpm dev                     # http://localhost:3000
```

Verify the stack:

```bash
curl -s http://localhost:3000/api/health | jq .
```

### Two runtime modes

| `NIGHTJAR_MODE` | Behaviour |
|---|---|
| `live` (default) | Real keyless calls to `https://api.bitget.com/api/v3/market/*`. |
| `fixture` | Replays the recordings in `lib/fixtures/`. Matching is **exact on path + query**; a symbol we never recorded is a hard `fixture_miss`, never a silent substitution. The UI must show a permanent "NOT LIVE" banner in this mode. |

Record a fresh fixture corpus with `pnpm record-fixtures`.

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm lint` | ESLint (flat config) |
| `pnpm typecheck` | `tsc --noEmit`, strict + `noUncheckedIndexedAccess` |
| `pnpm test` | Vitest, **fully offline** |
| `pnpm record-fixtures` | Re-record `lib/fixtures/` from the live API |
| `pnpm verify` | lint + typecheck + test + build |

---

## The read-only guarantee

Nightjar **cannot trade**. That is architectural, not a promise:

- The SDK config is built once by `getSdkConfig()` with `readOnly: true` and **no credentials**, so
  `hasAuth` is `false` and authenticated endpoints are unreachable.
- `BITGET_SDK_MODULES` is `"spot,futures"`. The SDK v1.2.0 has **no `market` module** -
  `loadConfig({modules:"market"})` throws `ConfigError` - and we deliberately exclude `account`, so no
  tool in our set can read a balance or a deposit address.
- With `readOnly: true` the tool set is **18 tools, zero writes**. The same modules with
  `readOnly: false` yield **28 tools including 10 writes** (`spot_place_order`, `futures_set_leverage`,
  ...). `tests/security/readonly.test.ts` pins that delta, so flipping the constant fails CI.
- All reads go through `publicGet` against **11 public v3 market paths** - `/instruments`, `/tickers`,
  `/candles`, `/history-candles`, `/index-components`, `/orderbook`, `/fills`, `/current-fund-rate`,
  `/history-fund-rate`, `/open-interest`, `/discount-rate`. The same test asserts no source file calls
  `privateGet`/`privatePost` and that the **complete set of env vars the server reads** is an allowlist
  containing exactly one secret: the Qwen gateway key.

Human decision boundary: the product outputs research, provenance and a data-quality verdict. It never
places, sizes or suggests an executable order.

---

## Layout

```
app/
  page.tsx                 the Phase 1 headline: one basis number + its provenance
  api/health/route.ts      per-source status and latency, never reports a secret
lib/
  config.ts                modes, base URLs, every cache TTL, the read-only invariant
  bitget/
    client.ts              the only place bytes leave the process (SDK transport, v3 paths)
    endpoints.ts           typed wrappers for the 11 public endpoints
    universe.ts            207 dual-listed / 93 perp-only, derived + cached, symbol resolution
    cache.ts               TTL cache with in-flight coalescing
    ratelimit.ts           token bucket (20 burst / 10 per s) + bounded backoff with jitter
    safe-invoke.ts         the never-throws boundary; failures come back as values
    errors.ts              error taxonomy
    decode.ts              wire scalars -> numbers, honestly (absent is not zero)
  schema/bitget.ts         Zod schemas; success is code "0" OR "00000"
  fixtures/                24 recorded snapshots + manifest + loader
  observability/logger.ts  structured logs; fields named key/token/secret are redacted
tests/
  contract/                every recording still parses; the universe join rule
  security/                the read-only guarantee, machine-checked
  unit/                    token bucket and backoff, on an injectable clock
scripts/
  record-fixtures.mjs      re-record the corpus
  probe-*.mjs              the throwaway probes that produced the verified facts
```

---

## Gotchas already paid for

- **v3 signals success with `code: "00000"`, not `"0"`.** Testing only for `"0"` turns every good
  HTTP 200 into a thrown error. Both are accepted (`isSuccessCode`).
- **The candle param is `interval`, not `granularity`**, and SPOT candles take **no `type`** while
  FUTURES candles require one to distinguish `market | index | premium`.
- **`/discount-rate` ignores `?symbol`** and returns ~427KB for every coin. It is cached with a 24h
  TTL and never called per request.
- **`/candles` caps at 1000 rows** and `/history-candles` at 100, so any published window must be
  stated explicitly.
- **Join candles by timestamp.** Joining by array position silently misaligns the two series.
- **The SDK does not export `safeInvoke`**, despite the Agent Hub docs describing one. Ours is
  `lib/bitget/safe-invoke.ts`.

---

## Limitations (honest, and deliberate)

- No credentials, so nothing account-scoped: no balances, no positions, no order history.
- The 1000-row candle ceiling bounds every historical claim to a rolling ~41-day window.
- Bitget publishes **no rate limit** for the v3 market endpoints, so we assume a tight one and stay
  well under it.
- The in-memory cache is per instance and cold-starts empty; nothing here is authoritative state.
- Phase 1 renders one number. The research engine, the agent loop and the UI are Phases 2-4.
