# Nightjar

A 7x24 research desk for **tokenized US equities on Bitget**. Bitget lists rTokens - `RAAPLUSDT` and
1,174 others - that trade around the clock, but the US cash market that actually prices the underlying
does not. Every rToken has a USDT perpetual that settles against a **composite reference index** built
from several venues. When that reference market is closed, and especially at the weekend, the rToken
drifts away from the index while the perpetual stays pinned to it. Nightjar measures that gap - the
**basis** - explains it, prices what it would cost to act on it, and states what would falsify the read.
It is an investigation with a published audit trail, and it **cannot trade**: it holds no Bitget
credentials and exposes no order controls of any kind.

The nightjar is a bird that is invisible by day and whose churring song carries through the dark. It is
awake and working precisely when everything else has gone quiet - which is the exact window this product
exists for.

> Bitget AI Hackathon S2 - Track 3 (AI Trading Desk) / **Personalized Research Workbench**.
> Live: <https://nightjar-seven.vercel.app> - Source: <https://github.com/jamesedward0x/nightjar>

---

## The finding

Sign convention, used everywhere and restated on every screen: **positive basis = the rToken trades
ABOVE the reference index** (`lib/compute/basis.ts`, exported as `BASIS_SIGN_CONVENTION`).

The golden numbers below are a regression set, not a slide. They are computed by `lib/compute/` from the
recorded snapshots in `lib/fixtures/` (24 recordings, manifest stamped 2026-09-13), so they reproduce
offline with no network and no key. Sample: `RAAPLUSDT` 1H spot candles joined **by timestamp** to
`AAPLUSDT` `type=index` 1H candles - 1,000 recorded rToken hours, 70 with no matching index timestamp,
leaving **930 matched hourly observations** in a window that ran 2026-08-02 to 2026-09-13.

| Session bucket (classified in `America/New_York`) | n | Mean abs basis |
|---|---|---|
| Regular trading hours, 09:30-16:00 ET | 180 | **0.057%** |
| Weekday off-hours | 532 | **0.0905%** |
| Weekend - reference market closed | 218 | **0.3054%** |
| All matched hours | 930 | - |

| Statistic | Value |
|---|---|
| Maximum abs basis | **1.0749%** at 2026-08-29T13:00Z (a Saturday) |
| Perp vs rToken tracking tightness | the perpetual tracked the index **~2.9x more tightly** |
| Hours beyond 0.5% | **43** |
| Hours beyond 1.0% | **1** |
| Weekend / RTH mean tracking error | **~5.4x** (0.3054 / 0.057, `weekendDislocationRatio`) |

Read that as a mechanism, not a curiosity. During RTH there is a live reference price to arbitrage
against, and the rToken tracks it to within six basis points. When the cash market shuts, that anchor
disappears; the rToken is then priced by whoever is in the room, and mean tracking error rises by a
factor of five. The perpetual does **not** detach, because it settles against a composite index that
keeps publishing. So the dislocation is rToken-specific, and `lib/compute/analogues.ts` flags exactly
that case (`rTokenSpecificDetachment`).

Two consequences the desk is built around:

1. **The 1H candle endpoint is capped at 1,000 rows**, so the observation window slides forward every
   hour. Every published statistic therefore carries its window (`n`, `fromTs`, `toTs`) - a mean without
   a window is not a measurement.
2. **Liquidity, not price, is the binding constraint.** The rToken's 24h turnover runs roughly 30-50x
   below the perp's and top-of-book spread typically 0.3-0.5%, so a basis you cannot exit is not an
   opportunity. `lib/compute/liquidity.ts` prices the exit from the order book and the public tape.

---

## Why this is not a chatbot

This is the load-bearing section. Every claim below has a mechanism and a file.

**1. The numbers exist before the model speaks.** `lib/llm/loop.ts` gathers the full evidence pack for
the symbol as step 1 - before any gateway call - and pushes it to the browser as an `evidence` SSE
event. The headline basis, the chart and all six panels are populated in ~2-4s while Qwen is still
reasoning. Narrative is the last thing to arrive, not the first.

**2. The model writes sentences; code writes numbers.** Every figure in the memo comes from a tool
result produced by `lib/compute/`, delivered through `lib/llm/tools.ts`. The `emit_memo` schema
(`lib/llm/memo.ts`) is a fixed set of prose fields, two bounded arrays and one enum: **there is no
field in which a number can be free-form**. Rule 2 of the system prompt (`lib/llm/prompts.ts`) forbids
stating any number that did not appear in a tool result the model actually received.

**3. There is a visible investigation trace.** `components/trace-panel.tsx` renders, per step: which
tool was called, with what arguments, whether it succeeded, its latency, the size of its output in
characters, how many tool calls remain, and whether it hit the **cached pack** or triggered a fresh
upstream fan-out (`fetchedPack`). Reasoning deltas are rendered as a separate, tagged stream so the
reader can always tell thinking from conclusion.

**4. The output is a document, not a reply.** `components/memo-view.tsx` renders a numbered,
fixed-section research memo: verdict chip, the number, session context, is-this-normal, reference
integrity, liquidity reality, derivatives context, historical analogues, data quality, a risk register,
a **for/against decision checklist**, and falsification conditions. The section order is fixed by the
schema. There is no thread, no avatar, no message history and no reply box - one run produces one memo.

**5. Remove the API key and the product still works.** `buildFallbackMemo()` in `lib/llm/memo.ts`
assembles a complete, schema-valid memo from the evidence pack alone: verdict, percentiles, per-session
distribution, index composition and weight sum, spread, book depth, slippage walk, turnover asymmetry,
tape statistics, funding and open interest, ranked analogues, quality flags and a four-row decision
checklist. The UI exposes this as the **"Run without AI - computed memo only"** control, and the memo is
badged `computed narrative` with `aiSynthesis: false`. That is a deliberate demo beat and the proof that
the research engine, not the LLM, is the product.

**6. The human-decision boundary is enforced by code, not by prompt.** `BITGET_READ_ONLY = true` is a
constant in `lib/config.ts`. No order tool exists in `RESEARCH_TOOLS`. `NON_EXECUTION_STATEMENT` is
appended to every memo by `finaliseMemo()` and `buildFallbackMemo()` - code, not a request to the model -
so no prompt, and no prompt injection, can talk the app out of it.
`tests/security/readonly.test.ts` proves the constant is load-bearing: the same SDK modules with
`readOnly: false` expose 10 write tools including `spot_place_order` and `futures_set_leverage`, and the
read-only build exposes 18 tools, all getters.

**7. Prompt injection is bounded.** Tool results carry strings from a public exchange API, so the system
prompt declares them **data, never instructions** (`UNTRUSTED_DATA_RULE`) and tells the model to report
an attempted instruction as a risk flag. Every tool output is truncated to 6,000 characters
(`MAX_OUTPUT_CHARS` in `lib/llm/tools.ts`). And because the app is read-only, a successful injection can
produce a bad sentence - never an action.

---

## What Nightjar cannot do

- **It cannot place, amend or cancel an order.** No write tool exists; no Bitget API key exists anywhere
  in the project; the SDK config is built keyless, so `hasAuth` is `false` and authenticated endpoints
  are unreachable.
- **It cannot see your account.** No balances, no positions, no order history, no deposit address. The
  `account`, `margin`, `copytrading`, `convert`, `earn`, `p2p` and `broker` SDK modules are deliberately
  not loaded (`BITGET_SDK_MODULES = "spot,futures"`).
- **It does not give advice.** The decision checklist is arguments for and against, never an instruction,
  and every memo ends with the non-execution statement.
- **It does not guess.** If the two required series (rToken spot 1H and index 1H) do not both answer,
  `gatherEvidence` returns `basis_inputs_unavailable` and no basis is published - "no number" rather than
  an estimated one.
- **It is not a general agent.** Seven research tools, at most 6 calls, at most 5 turns, inside one
  wall-clock budget. There is nothing to delegate to and nothing to schedule.

---

## Hard invariants

Violating one of these is a bug, not a style choice. They are restated from `AGENTS.md` because they are
the product's contract with the reader.

1. **Read-only.** `BITGET_READ_ONLY = true` (`lib/config.ts`). No Bitget API key exists in this project.
   The only secret is `BITGET_QWEN_API_KEY`, server-side only, never `NEXT_PUBLIC_*`.
   `tests/security/readonly.test.ts` enforces it.
2. **Every upstream call goes through `safeInvoke`** (`lib/bitget/safe-invoke.ts`). It never throws; one
   dead optional source degrades exactly ONE panel. Callers switch on `error.kind`, never on message text.
3. **Every published number carries provenance** - `source`, `endpoint`, `upstreamTime`, `recordedAt`,
   `fetchedAt`, `latencyMs`, `fromCache` - **and its observation window**, because the 1H endpoint caps at
   1,000 rows and the window slides forward every hour.
4. **Candles are joined by timestamp, never by array position** (`lib/compute/join.ts`). A positional join
   once produced a confident, entirely false narrative; `tests/unit/join.test.ts` proves the two disagree.
5. **Fixtures are recorded snapshots, never hand-authored numbers.** Matching is exact on path + query; an
   unrecorded symbol is a hard `FixtureMissError`, never a silent substitution. They are served only when
   `NIGHTJAR_MODE=fixture`, and then the UI shows a permanent NOT-LIVE banner.
6. **Cache TTLs live only in `CACHE_TTL_MS`** (`lib/config.ts`), each justified in place. `/discount-rate`
   ignores `?symbol` and returns ~427 KB, so it has a 24h TTL and is never called per request.
7. **Serverless budget:** `MAX_SYMBOLS_PER_QUERY = 4`, `MAX_TOOL_CALLS = 6`, and a wall-clock budget that
   is clamped to what the platform actually grants.
8. **Qwen is called via `POST /responses` on `https://hackathon.bitgetops.com/v1` only** - the sole
   surface verified end-to-end for tool calling, streaming and reasoning traces.
9. **Positive basis = rToken ABOVE the reference index.**

---

## Architecture

Seven layers. The rule that shapes all of them: **bytes in, numbers out, sentences last** - and each of
those three is owned by a different layer that cannot do the other two.

```
  Browser (components/workbench.tsx)
      |  POST /api/research  { question, symbol, disableAi }
      v  <== Server-Sent Events: start, evidence, trace*, memo, done
  app/api/research/route.ts        transport only: maxDuration=60, heartbeat, no-buffering headers
      |
      v
  lib/llm/loop.ts                  the bounded loop: evidence first, then model, always a memo
      |                                |
      |                                +-- lib/llm/qwen.ts   POST /responses (stream + non-stream)
      |                                +-- lib/llm/tools.ts  7 tools, pure projections of the pack
      |                                +-- lib/llm/memo.ts   schema, validate, repair once, fall back
      v
  lib/research/evidence.ts         ONE pack per symbol, ~15 upstream calls, per-source status
      |
      +---> lib/compute/           PURE research engine: basis, sessions, stats, liquidity,
      |                            quality, analogues, join, candles. No I/O, no LLM, no env reads.
      v
  lib/bitget/                      client -> ratelimit -> cache -> safe-invoke -> endpoints
      |                            + lib/schema/bitget.ts (Zod for every payload)
      v
  Bitget public REST v3 (keyless)  |  fixture mode: lib/fixtures/ (24 recorded snapshots)
```

| Layer | Path | What it owns | What it may not do |
|---|---|---|---|
| Transport | `lib/bitget/client.ts` | The only place bytes leave the process. SDK transport over 11 public v3 market paths. | Read a credential, call an authenticated method. |
| Endpoints | `lib/bitget/endpoints.ts` | Typed specs for `/instruments`, `/tickers`, `/candles`, `/history-candles`, `/index-components`, `/orderbook`, `/fills`, `/current-fund-rate`, `/history-fund-rate`, `/open-interest`, `/discount-rate`, with the verified limits (1000 / 100 / 20 / 100 rows). | Invent a parameter. `interval`, not `granularity`. |
| Rate limit | `lib/bitget/ratelimit.ts` | Token bucket (20 burst, refill 10/s, process-wide) plus bounded exponential backoff with jitter, on an injectable clock. | Block indefinitely - one `take()` has a `maxWaitMs` ceiling. |
| Cache | `lib/bitget/cache.ts` | In-memory TTL cache with **in-flight coalescing**, so concurrent identical calls produce one upstream request. TTLs come only from `CACHE_TTL_MS`. | Be treated as authoritative state. It cold-starts empty. |
| Error boundary | `lib/bitget/safe-invoke.ts`, `errors.ts` | Turns every failure into a value with a machine-readable `kind`, a retryable flag and an operator-safe hint. | Throw. |
| Universe | `lib/bitget/universe.ts` | Derives the tradable set from both instrument lists: 1,761 spot rows / 787 futures rows resolve to **207 dual-listed pairs and 93 perp-only names**, plus symbol resolution (`AAPL`, `rAAPL`, `RAAPLUSDT` all match). | Guess a listing. |
| Schema | `lib/schema/bitget.ts` | A Zod schema for every upstream payload, written from recordings. Success is `code: "0"` **or** `"00000"`. | Pass an unvalidated payload downstream. |
| Compute | `lib/compute/` | The deterministic research engine. `basis.ts`, `candles.ts`, `sessions.ts` (New York via luxon, DST-aware, never a hardcoded UTC offset), `stats.ts`, `liquidity.ts` (book walk, slippage curve, tape, turnover asymmetry), `quality.ts`, `analogues.ts`, `join.ts` (timestamp join). | Any I/O, any LLM call, any `process.env` read. It is pure, so it is testable and so the fallback memo and the live memo cannot disagree. |
| Evidence | `lib/research/evidence.ts` | One pack per symbol: the fan-out, per-source status and latency, provenance, and the hand-off of decoded candles to compute. | Contain arithmetic of its own. |
| LLM | `lib/llm/` | `qwen.ts` (gateway client, stream and non-stream), `tools.ts` (7 tools, each a pure projection of the cached pack), `prompts.ts`, `memo.ts`, `vocabulary.ts` (labels only, so the client never imports zod), `loop.ts`. | Produce a number. |
| Contract | `lib/research/contract.ts` | The type-only SSE wire contract shared by server and browser. Type-only so zod and luxon never enter the client bundle. | Import a runtime value. |
| API | `app/api/research/route.ts` | POST to SSE: request validation, symbol resolution, budget, heartbeat, headers. | Make a research decision - those all live in the loop. |
| API | `app/api/health/route.ts` | Per-source status and latency, mode, cache stats, fixture count. Reports Qwen credential **presence** only - never the value - and never calls the gateway. | Report a secret. |
| UI | `app/page.tsx`, `components/` | `workbench.tsx` (desk + SSE reader), `basis-chart.tsx` (hand-rolled SVG, symmetric y-axis, session bands), `evidence-panels.tsx`, `memo-view.tsx`, `trace-panel.tsx`. | Compute a number, or render a model sentence inside a data panel. |

### Why the tools are projections, not fetchers

The evidence pack is gathered **once** per symbol and cached in the `ToolContext`. Every one of the seven
tools is a pure projection of that pack, so whether Qwen calls two tools or six, the upstream fan-out is
the same ~15 Bitget calls. `executeTool` reports `fetchedPack: false` for a repeat symbol - visible in the
trace as `cached pack`. A naive design where each tool fetched its own data would blow the serverless
budget on the second question.

The seven tools: `get_basis_snapshot`, `get_basis_distribution`, `get_reference_composition`,
`get_liquidity_profile`, `find_analogues`, `get_derivatives_context`, `compare_symbols` - plus the
mandatory `emit_memo`.

### What the Qwen gateway actually does (probed, not assumed)

`scripts/probe-qwen.mjs`, results committed in `scripts/qwen-probe-result.json`:

- `POST /v1/responses` is the only surface verified for tool calling, streaming and reasoning traces.
  `POST /chat/completions` also answers (probe B: HTTP 200) but is deliberately not depended on.
- Tools use the **flat** schema `{type:"function", name, description, parameters}`. The nested
  Chat-Completions shape does not apply.
- `tool_choice: "required"` and named-object forms return **HTTP 400**: *"The tool_choice parameter does
  not support being set to required or object in thinking mode."* So the loop uses `tool_choice: "auto"`
  plus a hard system-prompt instruction to call `emit_memo`, then **validate -> repair once -> fall back**.
- `strict` `json_schema` is accepted but **silently ignored** - it returned prose.
- It is a reasoning model: on probe A, **29 of 34 output tokens were reasoning**. `reasoning.effort` is
  accepted but had no measurable effect, so latency is planned around streaming, never around effort.
- Observed latency **3-25s per call**. Hence `max_output_tokens >= 2000` (the app defaults to 4000, because
  reasoning tokens count against it) and a hard wall-clock budget.
- `store: false` on every call: no server-side retention of our prompts.

---

## The bounded agent loop

`lib/llm/loop.ts`. The order of operations is the design.

1. **Gather evidence before any model call.** `gatherEvidence(symbol)` runs first; on success the pack goes
   into the `ToolContext` and is published as an `evidence` event. Numbers reach the screen in ~2-4s while
   the model is still thinking, and the fallback memo always has data to stand on. On failure the loop
   emits `error` with the real `kind` and stops - it does not invent a pack.
2. **Stream the turn.** `streamResponse` forwards reasoning deltas, batched at 160 characters or 900ms
   (`REASONING_FLUSH_CHARS` / `REASONING_FLUSH_MS`) so the trace is readable rather than one frame per
   token. If the stream path fails for any non-abort reason, the same turn is retried non-streaming via
   `createResponse` rather than lost.
3. **Execute tool calls through the cached-pack projector.** A repeated symbol never re-fetches; a symbol
   that already failed is remembered in `ctx.failures` so it cannot re-trigger a full fan-out. Every call
   emits a `tool_call` trace entry with its arguments and remaining budget, then a `tool_result` entry with
   `ok`, `latencyMs`, `chars` and `fetchedPack`. When a genuinely new pack was fetched, evidence is
   re-published immediately, so a second name's numbers appear the moment they exist.
4. **Require `emit_memo`, validate it, repair once, else fall back.** Arguments are parsed and checked
   against `memoSchema`. On failure the Zod issues are fed back verbatim as the tool output plus a repair
   instruction - exactly once (`MAX_MEMO_REPAIRS = 1`). A second failure, a prose-only answer after one
   nudge (`MAX_PROSE_NUDGES = 1`), or any exhausted brake ends the run in `buildFallbackMemo()`.

**Three independent brakes**, all enforced in the loop:

| Brake | Value | What it stops |
|---|---|---|
| `MAX_TOOL_CALLS` | 6 | A model that keeps asking for data instead of concluding. |
| `MAX_TURNS` | 5 | A model that keeps talking to itself. |
| Wall-clock budget | `resolveResearchBudgetMs()` | Everything else, including a slow gateway. |

The clock reserves `BUDGET_RESERVE_MS` (**12s**) at the end: the soft deadline trips before the hard one, so
there is always time left to emit the fallback memo instead of being killed mid-sentence by the platform. A
hard `setTimeout` aborts the in-flight work at the full budget, and a client disconnect aborts through the
same controller.

**The loop never throws to its caller.** A dead gateway, an expired budget, a schema-invalid memo and a
client disconnect all end in a `memo` event plus a `done` event. The only path with no memo is
`no_evidence`, and that is reported as an `error` event with a hint pointing at `/api/health`.

### The serverless budget, honestly

`app/api/research/route.ts` exports the **literal** `maxDuration = 60`, because Next.js statically analyses
segment config and rejects an imported identifier. `resolveResearchBudgetMs()` in `lib/config.ts` clamps
`RESEARCH_TIMEOUT_MS` to `(FUNCTION_MAX_DURATION_S - FUNCTION_TEARDOWN_S) * 1000`, so `RESEARCH_TIMEOUT_MS=90000`
yields a **real 55s budget** on Hobby, with a 15s floor. `tests/unit/budget.test.ts` asserts the literal, the
constant and the clamp cannot drift apart. Vercel Hobby allows 60s; Pro allows 300s.

---

## The SSE contract

`POST /api/research` with `{ question, symbol?, disableAi? }`. `question` is 3-600 characters; `symbol` is
optional and resolved against the universe, so a bare question works (the route scans the text for tickers,
longest first, so `RAAPL` beats `AAPL`). POST rather than GET because `EventSource` cannot carry a body and
a research brief does not belong in a URL; the browser reads the stream with `fetch()` and a small manual
parser in `components/workbench.tsx`, which also lets it abort on unmount.

| Event | Payload | Meaning |
|---|---|---|
| `start` | `requestId`, `question`, `symbol`, `mode`, `budgetMs`, `aiConfigured` | The run is open. Emitted before any upstream call. |
| `evidence` | `packs: ClientPack[]` | One projected pack per symbol: snapshot, per-session distribution, observation window, reference composition, liquidity, derivatives, analogues, episodes, exceedances, quality flags, per-source status and the chart series (downsampled to 240 points by `lib/research/payload.ts`, endpoints always kept). Emitted at least twice: before the model speaks, and again at the end. |
| `trace` | `entry: { seq, at, kind, ... }` | `kind` is `reasoning`, `tool_call`, `tool_result` or `note`. Tool entries carry `tool`, `args`, `ok`, `latencyMs`, `chars`, `symbol`, `fetchedPack`, `remaining`. `seq` exists so the client renders in arrival order. |
| `memo` | `memo: ResearchMemo` | The document. Always present unless the run ended in `no_evidence`. Carries `aiSynthesis`, `banner`, `signConvention`, `nonExecutionStatement` and token `usage`. |
| `done` | `stats: LoopStats` | `aiSynthesis`, `fallbackReason`, `turns`, `toolCalls`, `latencyMs`, `budgetMs`, `usage`, `model`. `fallbackReason` is null only when Qwen wrote the memo. |
| `error` | `kind`, `message`, `hint?` | A real failure with a machine-readable kind. `no_evidence` is terminal; anything else can still be followed by a memo. |

Event order for a successful run:

```
start -> evidence -> (trace: reasoning / tool_call / tool_result, interleaved) -> evidence -> memo -> done
```

A run that cannot reach Qwen - no key configured, gateway down, or `disableAi: true` - still emits
`start -> evidence -> memo -> done`, with `memo.aiSynthesis === false` and a `fallbackReason` that says why.

Transport details that matter in production: `content-type: text/event-stream`, `cache-control: no-store,
no-transform`, `x-accel-buffering: no`, `dynamic = "force-dynamic"`, and a **15s comment heartbeat**
(`: heartbeat`) because a reasoning turn can be silent for 25s and an idle proxy will otherwise hang up.

---

## Data-quality honesty

What we know is broken, and what we do about it.

- **rToken SPOT candle volume is unreliable and is never used for a liquidity claim.** It disagrees across
  intervals and with `tickers.turnover24h`: one 1D row claimed 72,780,449 base volume ($23.88bn quote) for an
  instrument whose 24h turnover that weekend was $11,116, and another claimed 34.171 while a single 1H row
  inside the same day claimed 10,775,389. As a control, BTCUSDT's 24 x 1H base volume matched
  `tickers.volume24h` to within 1.4% - so the field is fine for crypto and broken for rToken spot.
  `lib/compute/quality.ts` sets `RTOKEN_SPOT_CANDLE_VOLUME_TRUSTED = false`, **detects** the disagreement
  from whatever data is in hand, and emits it as a flag the UI must render. `VOLUME_DISCLOSURE` is injected
  into the system prompt so the model discloses it too. Liquidity comes from the order book, the public tape
  and `turnover24h` instead.
- **The 1H candle endpoint caps at 1,000 rows** (~41 days) and `/history-candles` at 100, so the observation
  window slides forward every hour. Every distribution statistic is published with its `n` and its window.
- **A dead optional source blanks one panel with a stated reason.** Only the rToken spot 1H and index 1H
  series are required; without both there is no basis and therefore no product. Everything else - premium
  candles, index components, order book, tape, tickers, funding, open interest - degrades independently and
  is listed in the pack's `sources` with its status, so the reader can see which panel is missing and why.
- **Staleness is detected, not assumed.** A series whose last bucket is more than 3h old (one hour is the
  bucket size of the whole study) raises a staleness flag naming the series.
- **Price data reconciles.** Across 1m/1H/1D, across v2 and v3, and across spot/index/perp. The price and
  basis layer is the trustworthy core, which is why the whole product stands on it.
- **Absent is not zero** (`lib/bitget/decode.ts`): a missing scalar decodes to `null`, never to `0`, because
  a zero basis would read as "perfectly tracking".
- **Fixture mode is labelled forever.** `NIGHTJAR_MODE=fixture` replays the recordings, the mode bar says
  **NOT LIVE** with the recording timestamp, the headline carries a `NOT LIVE - fixture` chip, and the
  system prompt is switched to a clause ordering the model to describe the data as a recorded snapshot and
  quote its original recording time.

---

## Local development

**Prerequisites:** Node >= 20 (developed on v24, CI runs v24) and pnpm (CI pins pnpm 12 in
`.github/workflows/ci.yml`). On Windows use `pnpm.cmd` - the PowerShell execution policy blocks the `.ps1`
shim, so `npm.ps1` / `pnpm.ps1` will not run.

There is deliberately **no `packageManager` field in `package.json`**. pnpm 10+ re-fetches that pinned
version from the registry before every command, which breaks offline development. CI pins pnpm in the
workflow instead.

```powershell
cd D:\Bitget\nightjar
pnpm.cmd install
Copy-Item .env.example .env.local    # optional - everything works with no secrets set
pnpm.cmd dev                         # http://localhost:3000
```

With no `BITGET_QWEN_API_KEY` the desk still runs end to end: every number is live and keyless, and the
memo is computed by `lib/llm/memo.ts`. The mode bar will read `Qwen key absent - computed memos only`.

### Environment variables

Names only; values are never committed and never printed. `.env.example` is the canonical list. **No
variable may ever be prefixed `NEXT_PUBLIC_`** - `tests/security/readonly.test.ts` fails the build if one
appears, and the Qwen key must stay server-side.

| Variable | Purpose |
|---|---|
| `BITGET_QWEN_API_KEY` | The only secret in the project. Read once by `lib/llm/qwen.ts`, never logged, never returned to a client. `/api/health` reports its **presence**, never its value. |
| `QWEN_BASE_URL` | Defaults to `https://hackathon.bitgetops.com/v1`. |
| `QWEN_MODEL` | Defaults to `qwen3.8-max`. |
| `BITGET_API_BASE_URL` | Defaults to `https://api.bitget.com`. Keyless - never add credentials. |
| `NIGHTJAR_MODE` | `live` (default) or `fixture`. Fixture mode replays `lib/fixtures/` and the UI shows a permanent NOT-LIVE banner. |
| `NIGHTJAR_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. Field names matching key/token/secret are always redacted. |
| `MAX_TOOL_CALLS` | Overrides the tool budget. Default 6; bounded in code. |
| `RESEARCH_TIMEOUT_MS` | Requested wall-clock budget. Default 90000; **clamped** to the platform limit. |
| `FUNCTION_MAX_DURATION_S` | Must equal the literal `maxDuration` in `app/api/research/route.ts`. Default 60 (Hobby); Pro allows 300. |

### Two runtime modes

| `NIGHTJAR_MODE` | Behaviour |
|---|---|
| `live` (default) | Real keyless calls to `https://api.bitget.com/api/v3/market/*`. |
| `fixture` | Replays the 24 recordings in `lib/fixtures/`, matching exactly on path + query. An unrecorded symbol is a hard `FixtureMissError`, never a silent substitution. `next.config.ts` includes `lib/fixtures/**/*.json` in the serverless bundle trace, because Next's file tracer cannot follow a runtime `readFileSync`. |

### Commands

| Command | Cost | When |
|---|---|---|
| `pnpm.cmd dev` | - | inner loop while building the UI |
| `pnpm.cmd typecheck` | ~6s | after every edit |
| `pnpm.cmd test` | ~3s, fully offline | after every edit |
| `pnpm.cmd build` | ~27s | only before declaring a phase done |
| `pnpm.cmd lint` | - | ESLint flat config |
| `pnpm.cmd verify` | ~50s | lint + typecheck + test + build, at the end of a bundle |
| `pnpm.cmd record-fixtures` | network | re-record `lib/fixtures/` from the live API |

The fast loop is `typecheck` + `test`. Test suite: 110 `it(...)` cases across 9 files in `tests/unit`,
`tests/contract` and `tests/security`, node environment, 20s timeout, `@/*` aliased to the repo root in both
`tsconfig.json` and `vitest.config.ts`.

---

## Deployment on Vercel

The repo is <https://github.com/jamesedward0x/nightjar>, imported into Vercel with auto-deploy on push to
`main`. It is live at **<https://nightjar-seven.vercel.app>**. CI (`.github/workflows/ci.yml`) runs a secret
leak guard, then lint, typecheck, test and build on Node 24 / pnpm 12.

### Set the environment variables

1. Vercel dashboard -> your project -> **Settings** -> **Environment Variables**.
2. Add each name from the table above. At minimum: `BITGET_QWEN_API_KEY`. Everything else has a working
   default in `lib/config.ts`.
3. Tick **Production** *and* **Preview** for each one, or preview deployments will silently fall back to
   computed memos only.
4. Mark `BITGET_QWEN_API_KEY` as **Sensitive** so its value cannot be read back out of the dashboard.
5. **Redeploy** - environment changes do not apply to an existing deployment.

Optional: set `FUNCTION_MAX_DURATION_S` to `300` on a Pro plan, and edit the literal
`export const maxDuration = 60;` in `app/api/research/route.ts` to match. `tests/unit/budget.test.ts`
asserts the two agree, so changing one without the other fails CI - on purpose.

### Verify without leaking the key

```powershell
curl.exe -s https://nightjar-seven.vercel.app/api/health
```

`sources.qwen.status` is `"ok"` when the key is present and `"not_configured"` when it is not. The probe
kind is `env-presence`: the value is never read into the response and the gateway is never called from
`/api/health`. The same payload reports `readOnly: true`, the runtime mode, per-source Bitget latency, the
derived universe counts and the cache statistics.

---

## Phase state

Target submission 20 Sep 2026. This table is mirrored in `AGENTS.md`.

| Phase | Scope | State |
|---|---|---|
| 0 | Approve the research base | done |
| 1 | Scaffold + verified read-only data layer | done |
| 2 | Deterministic compute engine (basis, sessions, liquidity, analogues) | done |
| 3 | Qwen agent loop + structured memo | done |
| 4 | LUI, streaming, charts | in progress (UI) |
| 5 | Hardening: fixtures, tests, observability, security | not started |
| 6 | Vercel deployment + reproducible README | deployed at <https://nightjar-seven.vercel.app> |
| 7 | Submission package | not started |

---

## Repository layout

```
app/
  page.tsx                     server-rendered desk: resolves universe, mode, AI presence, budget
  layout.tsx, globals.css      shell and styling
  api/research/route.ts        POST -> SSE. maxDuration = 60 (literal), 15s heartbeat, no-buffering headers
  api/health/route.ts          per-source status and latency; Qwen credential PRESENCE only
components/
  workbench.tsx                the desk: brief bar, presets, "run without AI", SSE reader, layout
  basis-chart.tsx              hand-rolled SVG. Symmetric y-axis, session bands, perp overlay
  evidence-panels.tsx          tracking error by session, reference integrity, exit economics,
                               derivatives context, historical analogues, data quality and provenance
  memo-view.tsx                the fixed-section research document
  trace-panel.tsx              investigation trace + budget bar
lib/
  config.ts                    modes, base URLs, every cache TTL, the read-only constant, the budget clamp
  bitget/
    client.ts                  the only place bytes leave the process
    endpoints.ts               typed wrappers for the 11 public v3 market paths
    universe.ts                207 dual-listed / 93 perp-only, derived and cached, symbol resolution
    cache.ts                   TTL cache with in-flight coalescing
    ratelimit.ts               token bucket (20 burst / 10 per s) + bounded backoff with jitter
    safe-invoke.ts             the never-throws boundary
    errors.ts                  error taxonomy
    decode.ts                  wire scalars -> numbers, honestly (absent is not zero)
  schema/bitget.ts             a Zod schema for every upstream payload
  compute/                     the PURE research engine: basis, candles, sessions, stats, liquidity,
                               quality, analogues, join, types
  research/
    evidence.ts                one evidence pack per symbol, ~15 upstream calls, per-source status
    payload.ts                 server -> client projection and chart downsampling
    contract.ts                the type-only SSE wire contract
    format.ts                  client-side formatters; derives nothing
  llm/
    loop.ts                    the bounded loop
    qwen.ts                    gateway client (stream + non-stream)
    tools.ts                   7 tools + emit_memo, all projections of the cached pack
    memo.ts                    schema, validation, one repair pass, deterministic fallback
    prompts.ts                 the system prompt and its hard rules
    vocabulary.ts              labels only, so the client never imports zod
  fixtures/                    24 recorded snapshots + manifest + loader
  observability/logger.ts      JSON logs; fields named key/token/secret are redacted
tests/
  unit/                        basis, join, sessions, stats, ratelimit, budget
  contract/                    every recording still parses; the universe join rule
  security/readonly.test.ts    the read-only guarantee, machine-checked against the real SDK
scripts/
  record-fixtures.mjs          re-record the corpus
  probe-qwen.mjs               the gateway probe
  qwen-probe-result.json       its committed output
  probe-sdk.mjs, probe-params.mjs
.github/workflows/ci.yml       secret guard, lint, typecheck, test, build
```

---

## Hackathon alignment

Track 3 is judged on four named axes. Each design decision below is aimed at one of them.

| Judging axis | What serves it | Where to check |
|---|---|---|
| **Feature depth** (data sources / Skill integration count and effectiveness) | 11 public v3 market endpoint families, not one: instruments, tickers, candles, history-candles, index-components, orderbook, fills, current-fund-rate, history-fund-rate, open-interest, discount-rate. A derived 207-pair / 93-perp-only universe. Transport through the official `@bitget-ai/bitget-agent-sdk` v1.2.0 in read-only mode. Seven research tools, each an effective projection rather than a redundant fetch. | `lib/bitget/endpoints.ts`, `lib/bitget/universe.ts`, `tests/security/readonly.test.ts`, `lib/llm/tools.ts` |
| **Research quality** | A measured, reproducible finding (930 matched hours, per-session tracking error, ranked analogues, falsification conditions). Timestamp joins. New York session classification via luxon so the boundary survives DST. Every number carries provenance and an observation window. A first-class data-quality report that detects a real upstream defect instead of hiding it. | `lib/compute/*`, `lib/research/evidence.ts`, the golden numbers above |
| **LUI fluency** | A natural-language brief drives a bounded agent that chooses its own tools; reasoning streams live; the trace shows every call, its arguments, latency, size and cache status; a prose-only answer is rejected and forced into structure; a schema-invalid memo gets exactly one repair pass. It degrades gracefully instead of failing: no key, dead gateway or expired budget all still produce a complete document. | `lib/llm/loop.ts`, `lib/llm/prompts.ts`, `components/trace-panel.tsx` |
| **Personalized thesis** | One sharp thesis - the reference market sleeps, the rToken does not - investigated for the name the reader holds, in the session they are actually in, with their exit cost priced from the live book rather than quoted from a slide. Four preset briefs (dislocation check, closed-market risk, exit economics, reference integrity) and a free-text brief, over any of 207 dual-listed names. | `components/workbench.tsx`, `lib/compute/liquidity.ts`, `lib/compute/analogues.ts` |

Honest note on Skill integration: the optional `bitget-signal` research Skills / MCP data service is **not**
wired in. `/api/health` reports it as `signal-mcp: not_configured` rather than claiming it. Every unstructured
news source we probed was dead or key-gated, so the product is built on Bitget market data that actually
answers - which is also why it demos reliably.

---

## Licence and attribution

The repository currently ships **no `LICENCE` file**, so the default is all rights reserved by the author.
This is intentional for a hackathon submission and should be revisited before any public reuse.

Attribution:

- Market data: **Bitget public REST API v3** (`https://api.bitget.com/api/v3/market/*`), keyless and
  read-only. All prices, candles, order books, tapes, funding and open interest are Bitget's. Recorded
  snapshots in `lib/fixtures/` are real responses, kept for offline tests and reproducible research; they
  are labelled NOT LIVE whenever they are served.
- Transport: **`@bitget-ai/bitget-agent-sdk`** v1.2.0, configured `readOnly: true` and keyless.
- Language model: **Qwen** (`qwen3.8-max`) via the Bitget hackathon gateway at
  `https://hackathon.bitgetops.com/v1`, `POST /responses`, `store: false`.
- Open source: **Next.js 15**, **React 19**, **TypeScript** (strict + `noUncheckedIndexedAccess`),
  **zod**, **luxon**, **vitest**, **ESLint**. The basis chart is hand-rolled SVG - no charting dependency.

Nothing in this repository is investment advice, and nothing in it can execute a trade.
