# AGENTS.md - Nightjar

Read this first. Do NOT read `../.planning/DECISION.md` (149 KB) end to end; cite a section
number (e.g. DECISION.md 7.4) when you need detail from it.

## What this is

Next.js 15 / React 19 / TypeScript (strict) research desk for **tokenized US equities on Bitget**:
the rToken spot market vs the composite reference index its USDT perpetual settles against.
Bitget AI Hackathon S2, Track 3 - Personalized Research Workbench.
**Read-only product**: it never trades and never holds Bitget credentials.

## Canonical commands (PowerShell - use `pnpm.cmd`)

| Command | Cost | When |
|---|---|---|
| `pnpm.cmd dev` | - | inner loop while building UI |
| `pnpm.cmd typecheck` | ~6 s | after every edit |
| `pnpm.cmd test` | ~3 s, offline | after every edit |
| `pnpm.cmd build` | ~27 s | only before declaring a phase done |
| `pnpm.cmd verify` | ~50 s | lint + typecheck + test + build, end of a bundle |
| `pnpm.cmd record-fixtures` | network | re-record `lib/fixtures/` from the live API |

Fast loop is `typecheck` + `test`. Do not run `build` after every change.

## Invariants - violating one is a bug, not a style choice

1. **Read-only.** `BITGET_READ_ONLY = true` (`lib/config.ts`). No Bitget API key exists in this
   project. The only secret is `BITGET_QWEN_API_KEY`, server-side only, never `NEXT_PUBLIC_*`.
   `tests/security/readonly.test.ts` enforces this - keep it green.
2. **Every upstream call goes through `safeInvoke`** (`lib/bitget/safe-invoke.ts`). It never throws;
   one dead optional source degrades ONE panel. Callers switch on `error.kind`, never on message text.
3. **Every published number carries provenance** (`SafeOk`: source, endpoint, upstreamTime,
   recordedAt, fetchedAt, latencyMs, fromCache) **and its observation window** - the 1H candle
   endpoint is capped at 1000 rows, so the window slides forward every hour.
4. **Join candles by timestamp, never by array position.**
5. **Fixtures are recorded snapshots, never hand-authored numbers.** Exact match on path + query; an
   unrecorded symbol is a hard `FixtureMissError`, never a silent substitution. Served only when
   `NIGHTJAR_MODE=fixture`, and then the UI must show a permanent NOT-LIVE banner.
6. **Cache TTLs live only in `CACHE_TTL_MS`** (`lib/config.ts`), each justified in place.
   `discount-rate` ignores `?symbol` and returns ~427 KB - 24 h TTL, never per request.
7. **Serverless budget:** `MAX_SYMBOLS_PER_QUERY=4`, `MAX_TOOL_CALLS=6`, `RESEARCH_TIMEOUT_MS=90000`.
   The bounded agent loop must enforce these.
8. **Qwen is called via `POST /responses`** on `https://hackathon.bitgetops.com/v1` only - the sole
   surface verified for tool calling, streaming and reasoning traces. Do not switch to
   `/chat/completions`.
9. **Sign convention: positive basis = rToken ABOVE the reference index.**
10. `@/*` maps to the repo root (tsconfig + vitest alias). Tests live in
    `tests/{unit,contract,security}/*.test.ts`, node environment, 20 s timeout.

## Layout

- `lib/bitget/` - verified data layer (Phase 1, done): client, endpoints, ratelimit, cache,
  safe-invoke, errors, universe, decode.
- `lib/compute/` - deterministic research engine (Phase 2). **Does not exist yet.** No LLM in here, ever.
- `lib/schema/bitget.ts` - Zod schema for every upstream payload.
- `lib/fixtures/`, `lib/observability/logger.ts` (JSON logs; redacts key/token/secret), `lib/config.ts`.
- `app/` - App Router. `app/page.tsx` currently renders ONE live number (AAPL rToken basis); Phase 2
  moves that inline arithmetic into `lib/compute/basis.ts`.

## Execution protocol (how to go fast in this repo)

- Work in **phase bundles**, not one phase at a time. Keep going until the bundle's Definition of Done
  is green; do not stop mid-bundle to ask permission.
- After each green `typecheck` + `test`, commit. If `git status` fails because there is no repo, say so
  once and keep working - do not silently skip checkpointing.
- Do not re-polish plumbing that already passes tests. The gap to production is **user-visible research
  output** (Phases 2-4), not more data-layer hardening.
- If a live endpoint disagrees with a fixture, the fixture is stale: re-record it, never edit numbers.
- Update the phase table in `README.md` when a phase completes.
- **Never create files with `Set-Content -Encoding utf8`.** Windows PowerShell 5.1 prepends a UTF-8
  BOM. TypeScript and vitest tolerate it, so everything passes locally - but `pnpm/action-setup` does a
  raw `JSON.parse` of `package.json` and CI dies in 6 seconds with
  `SyntaxError: Unexpected token '<U+FEFF>'`. Write with
  `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))`, and after any
  bulk file write scan for `EF BB BF` before committing. (This broke CI once, on 2026-09-13.)

## Phase state (target submit 20 Sep 2026)

| Phase | Scope | State |
|---|---|---|
| 0 | Approve the research base | done |
| 1 | Scaffold + verified read-only data layer | done (45 tests green) |
| 2 | Deterministic compute engine (basis, sessions, liquidity, analogues) | **next** |
| 3 | Qwen agent loop + structured memo | not started |
| 4 | LUI, streaming, charts | not started |
| 5 | Hardening: fixtures, tests, observability, security | not started |
| 6 | Vercel deployment + reproducible README | not started |
| 7 | Submission package | not started |

Scope cuts if time runs out: DECISION.md 8.2, in that order. Never cut honest labelling of fixture
data or the human-decision boundary.
