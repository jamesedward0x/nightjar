# Nightjar - Hackathon Submission

| | |
|---|---|
| **Project name** | Nightjar |
| **Hackathon** | Bitget AI Hackathon S2 |
| **Track** | Track 3 - AI Trading Desk / **Personalized Research Workbench** |
| **Live demo** | <https://nightjar-seven.vercel.app> |
| **Source** | <https://github.com/jamesedward0x/nightjar> |
| **Model** | Qwen `qwen3.8-max` via `POST https://hackathon.bitgetops.com/v1/responses` |
| **Can it trade?** | **No.** Read-only by architecture. No Bitget credential exists in the project. |

**One-line pitch:** a 7x24 research desk that measures, explains and prices the gap between a Bitget
tokenized US equity and the reference index its own perpetual settles against - precisely during the hours
when the market that prices the underlying is closed.

---

## The problem

Bitget lists tokenized US equities (rTokens, e.g. `RAAPLUSDT`) that trade around the clock. The US cash
market that actually prices the underlying does not. Each rToken has a USDT perpetual that settles against a
**composite reference index** built from several venues, and that index keeps publishing whether or not the
cash market is open.

So there are three prices for one stock, and they do not move together:

1. the **rToken spot** price, set by whoever is in the room;
2. the **reference index**, a composite of external venues;
3. the **perpetual**, pinned to the index by funding and settlement.

When the cash market shuts - overnight, and above all at the weekend - the arbitrage that normally holds the
rToken to a live reference disappears. A 7x24 holder is exposed to that drift and has no desk watching it,
and no way to know whether a wide gap is normal for the session, whether the reference itself is still
intact, or what it would actually cost to exit. Existing tools show a price. None of them show the gap, its
history, its liquidity, and the case for and against acting on it.

## The measured finding

Sign convention: **positive basis = rToken ABOVE the reference index.**

Computed by `lib/compute/` from recorded Bitget snapshots in `lib/fixtures/` - 1,000 recorded `RAAPLUSDT` 1H
spot hours joined **by timestamp** to `AAPLUSDT` `type=index` 1H candles, 70 unmatched, leaving **930 matched
hourly observations** over a window running 2026-08-02 to 2026-09-13:

| Session bucket (America/New_York) | n | Mean abs basis |
|---|---|---|
| Regular trading hours, 09:30-16:00 ET | 180 | **0.057%** |
| Weekday off-hours | 532 | **0.0905%** |
| Weekend - reference market closed | 218 | **0.3054%** |

| Statistic | Value |
|---|---|
| Maximum abs basis | **1.0749%** at 2026-08-29T13:00Z (Saturday) |
| Perp vs rToken tracking | the perpetual tracked the index **~2.9x more tightly** |
| Hours beyond 0.5% / beyond 1.0% | **43 / 1** |
| Weekend vs RTH mean tracking error | **~5.4x** |

The mechanism is visible in the data: with a live reference, the rToken tracks to within six basis points.
With the cash market shut, mean tracking error rises about fivefold - and the perpetual does **not** detach,
because its reference keeps publishing. The dislocation is rToken-specific, and it coincides with the thinnest
liquidity of the week: rToken 24h turnover runs roughly 30-50x below the perp's, with a top-of-book spread
typically 0.3-0.5%. A gap you cannot exit is not an opportunity, which is why the desk prices the exit.

These numbers are a regression set. They reproduce offline, with no network and no API key, from the recorded
fixtures - and in the live product every one of them is recomputed for the name and the session you ask about.

---

## What we built

- **A deterministic research engine** (`lib/compute/`) that is pure - no I/O, no LLM, no `process.env` reads.
  Basis series, per-session distributions, percentile ranking, order-book walk and slippage curve, tape
  statistics, turnover asymmetry, funding and open interest, ranked historical analogues with 6h/24h follow-on,
  contiguous-episode grouping, exceedance counts and a data-quality report.
- **An evidence pack per symbol** (`lib/research/evidence.ts`): ~15 upstream calls fanned out once, each with
  its own status, latency and provenance, assembled into a single object that both the UI and the model read.
- **A bounded Qwen agent loop** (`lib/llm/loop.ts`) with seven research tools that are pure projections of the
  cached pack - so six tool calls cost the same upstream fan-out as two. Three independent brakes: 6 tool
  calls, 5 turns, and a wall-clock budget clamped to what the platform actually grants.
- **A structured research memo** (`lib/llm/memo.ts`) with a fixed section order, Zod-validated, one repair
  pass, and a deterministic fallback that code writes from the evidence pack.
- **A streaming desk UI** (`components/workbench.tsx`) that shows numbers first and narrative last, with the
  investigation trace - every tool call, its arguments, latency, output size and cache status - in a rail
  beside the document.
- **A verified read-only data layer** (`lib/bitget/`): keyless transport over 11 public v3 market endpoint
  families, a token-bucket rate limiter with bounded backoff, a TTL cache with in-flight coalescing, a
  never-throws error boundary, and a Zod schema for every payload written from recordings.
- **24 recorded fixtures** (`lib/fixtures/`) with a manifest, exact path+query matching and a hard miss rather
  than a silent substitution - so CI and the whole test suite run offline.

### Differentiators

1. **Numbers before narrative.** The evidence pack is gathered and streamed *before* the model is called, so
   the headline basis, the chart and all six panels are on screen in ~2-4s while Qwen is still reasoning.
2. **The model cannot author a number.** Every figure comes from a `lib/compute/` tool result, and the
   `emit_memo` schema has no free-form numeric field. Prose-only answers are rejected and forced into
   structure; a schema-invalid memo gets exactly one repair pass, then code writes it.
3. **It works with the API key removed.** `buildFallbackMemo()` produces a complete, sourced, schema-valid
   memo from the evidence pack alone. The UI exposes this as **"Run without AI - computed memo only"**. That
   is the proof the research engine, not the LLM, is the product.
4. **The audit trail is rendered, not logged.** The trace panel shows which tool ran, with what arguments,
   whether it succeeded, how long it took, how many characters it returned, whether it hit the cached pack or
   triggered a fresh fan-out, and how much budget is left - with reasoning kept visually separate from
   conclusions.
5. **Read-only is enforced by code and by test.** `BITGET_READ_ONLY = true`, no order tool exists, the SDK
   config is keyless, and `tests/security/readonly.test.ts` proves that flipping the constant would expose
   10 write tools including `spot_place_order` - so the guarantee cannot silently regress.
6. **Data-quality defects are published, not hidden.** The rToken spot candle-volume field is broken; the app
   detects the disagreement, refuses to use it for any liquidity claim, and says so in the memo, the UI and
   the system prompt.
7. **Honest degradation.** One dead optional source blanks exactly one panel with a stated reason. No key,
   dead gateway or expired budget still produces a full document rather than an error screen.
8. **Built for a serverless budget, not against it.** The route exports a literal `maxDuration = 60`, the
   budget is clamped to `(60 - 5) * 1000 = 55s`, 12s is reserved at the end for the fallback memo, and a
   unit test asserts the literal and the constant cannot drift.

---

## Three-minute demo script

Run it against the live deployment, or locally with `pnpm.cmd dev`.

| # | Time | Do this | Say this |
|---|---|---|---|
| 1 | 0:00 | Open <https://nightjar-seven.vercel.app>. | "This is a research desk for tokenized US equities on Bitget. Note the mode bar: LIVE, read-only - cannot trade, and the budget this run gets." |
| 2 | 0:05 | Do nothing. The page auto-runs AAPL on load. | "I have not typed anything. The desk resolves the tradable universe - 207 dual-listed pairs - and starts investigating." |
| 3 | 0:10 | Point at the headline as it populates: signed basis to 4 decimals, rToken / index / perp prices, percentiles, observation window, matched hours. | "Every number here arrived **before the model said a word**. The evidence pack is gathered first and streamed first." |
| 4 | 0:25 | Point at the chart and the six panels below it: tracking error by session, reference index integrity, exit economics, derivatives context, historical analogues, data quality and provenance. | "This is the finding. Regular hours 0.057% mean tracking error, weekend 0.3054% - about five times worse - over 930 matched hours. The perp overlay tracks the index far more tightly." |
| 5 | 0:50 | Point at the **Investigation trace** rail on the right. | "This is the audit trail. Reasoning, then `get_basis_snapshot`, its arguments, its latency, its output size, and whether it hit the cached pack or fetched. The budget bar shows how much of the 55 seconds is left." |
| 6 | 1:20 | Wait for the memo to assemble. Read the verdict chip and the first two sections. | "The memo arrives last. It is a fixed-section research document - not a reply bubble. Verdict, the number, session context, is-this-normal, reference integrity, liquidity reality, derivatives, analogues, data quality." |
| 7 | 1:45 | Scroll to **Risk flags**, the **Decision checklist - arguments, not instructions**, and **What would change this view**. | "For and against, never an instruction. And falsification conditions, so a reader knows what would prove this wrong." |
| 8 | 2:00 | Scroll to the footer and read the non-execution statement. | "That sentence is appended by code, not requested from the model. No prompt can talk the app out of it." |
| 9 | 2:10 | **Tick "Run without AI - computed memo only"**, then click **Re-run investigation**. | "Now the interesting part. Same question, same numbers - and no language model involved at all." |
| 10 | 2:25 | Point at the memo badge, which now reads **computed narrative**, and at the banner. | "The badge says computed. Every figure is identical, because the model never wrote any of them. Remove the API key and the product still works. That is the proof the research engine is the product." |
| 11 | 2:40 | Open `/api/health` in a new tab: <https://nightjar-seven.vercel.app/api/health>. | "Per-source status and latency, the mode, `readOnly: true`, the derived universe counts - and `sources.qwen.status`, which reports whether a key is **present**. It never reports the value, and it never calls the gateway. That is how you verify a deployment without leaking a secret." |
| 12 | 2:55 | Close. | "One thesis, measured on Bitget's own data, reproducible offline, and a hard boundary between research and execution." |

Fallback if the network is down during judging: set `NIGHTJAR_MODE=fixture` and run locally. The desk replays
the 24 recorded snapshots, the mode bar says **NOT LIVE** with the recording timestamp, and every number in
the finding above is exactly what it renders.

---

## Read-only and the human-decision boundary

**Nightjar cannot trade.** This is architectural, not a promise in a README:

- `BITGET_READ_ONLY = true` is a constant in `lib/config.ts`.
- The SDK config is built **keyless**, so `hasAuth` is `false` and authenticated endpoints are unreachable.
  There is no Bitget API key, secret or passphrase anywhere in this project, and no environment variable that
  could carry one.
- `BITGET_SDK_MODULES = "spot,futures"`. The `account`, `margin`, `copytrading`, `convert`, `earn`, `p2p` and
  `broker` modules are never loaded, so no tool can read a balance, a position or a deposit address.
- `tests/security/readonly.test.ts` runs against the real SDK, not a mock, and pins the delta: `readOnly: true`
  yields **18 tools, all getters, zero writes**; the same modules with `readOnly: false` yield **10 write tools**
  including `spot_place_order`, `futures_place_order` and `futures_set_leverage`. Flipping the constant fails CI.
- No order tool exists in `RESEARCH_TOOLS`. The seven tools are all read projections.
- `NON_EXECUTION_STATEMENT` is appended to every memo by code (`finaliseMemo` and `buildFallbackMemo` in
  `lib/llm/memo.ts`), never requested from the model. It also renders in the page footer.
- The system prompt (`lib/llm/prompts.ts`, rule 4) tells the model to refuse plainly if asked to place, amend
  or cancel an order or move funds, and never to imply it could act, schedule or delegate anything.
- Rule 10 frames the decision checklist as arguments for and against, never as an instruction to act.

**Prompt injection is bounded.** Tool results carry strings from a public exchange API, so the system prompt
declares them data and never instructions (`UNTRUSTED_DATA_RULE`), and orders the model to report an attempted
instruction as a risk flag. Every tool output is truncated to 6,000 characters. And because the app is
read-only, a successful injection can produce a bad sentence - never an action.

**The human decides.** Nightjar outputs research, provenance and a data-quality verdict. It never places,
sizes or suggests an executable order.

---

## Technical highlights a judge should check

| Highlight | File | What to look for |
|---|---|---|
| The read-only guarantee, machine-checked against the real SDK | `tests/security/readonly.test.ts` | 18 read tools vs 10 write tools; the 11 public v3 paths allowlisted both ways; no `privateGet`/`privatePost` in any server source; an env allowlist with exactly one secret; `.env.example` declares no `NEXT_PUBLIC_*`. |
| Evidence gathered before the model is called | `lib/llm/loop.ts` | Step 1 runs `gatherEvidence`, publishes an `evidence` event, and only then builds the prompt. |
| Tools as projections, not fetchers | `lib/llm/tools.ts` | `evidenceFor()` returns the cached pack; `executeTool` reports `fetchedPack`, so a repeat symbol costs zero upstream calls. |
| The memo schema and the deterministic fallback | `lib/llm/memo.ts` | `memoSchema` (no free-form numeric field), `validateMemoArguments`, `repairInstruction`, and `buildFallbackMemo` - a complete sourced memo with no LLM. |
| Structured output without `tool_choice: "required"` | `lib/llm/qwen.ts`, `scripts/qwen-probe-result.json` | The committed probe: flat tool schema, HTTP 400 on `tool_choice: "required"` in thinking mode, `strict` `json_schema` silently ignored, 29 of 34 output tokens were reasoning, `store: false`. |
| The bounded loop's three brakes and its 12s reserve | `lib/llm/loop.ts`, `lib/config.ts` | `MAX_TOOL_CALLS = 6`, `MAX_TURNS = 5`, `resolveResearchBudgetMs()`, `BUDGET_RESERVE_MS = 12_000`. The loop never throws to its caller. |
| The serverless budget cannot drift | `app/api/research/route.ts`, `tests/unit/budget.test.ts` | A literal `export const maxDuration = 60` (Next.js rejects an imported identifier), asserted against `FUNCTION_MAX_DURATION_S`, with the clamp and the 15s floor tested. |
| Timestamp joins, and the positional join that lies | `lib/compute/join.ts`, `tests/unit/join.test.ts` | 70 of 1,000 rToken hours have no index partner; the positional variant is exported under a name that cannot be mistaken for safe, and a test proves the two disagree. |
| DST-aware session classification | `lib/compute/sessions.ts`, `tests/unit/sessions.test.ts` | New York via luxon, never a hardcoded UTC offset; the weekend boundary is NY-based, not UTC-based; a test asserts the UTC window actually moves across the transition. |
| Liquidity priced from the book and the tape, never from candle volume | `lib/compute/liquidity.ts` | `RTOKEN_SPOT_CANDLE_VOLUME_TRUSTED = false` in `lib/compute/quality.ts`; the book walk, slippage curve and turnover asymmetry. |
| The data-quality detector | `lib/compute/quality.ts` | The three-way proof that rToken spot candle volume is broken, the BTCUSDT control, staleness detection, and `VOLUME_DISCLOSURE` injected into the prompt. |
| The never-throws boundary and provenance | `lib/bitget/safe-invoke.ts`, `lib/bitget/errors.ts` | Every failure returns a value with a machine-readable `kind`; every success carries `source`, `endpoint`, `upstreamTime`, `recordedAt`, `fetchedAt`, `latencyMs`, `fromCache`. |
| Rate limiting and cache coalescing on an injectable clock | `lib/bitget/ratelimit.ts`, `lib/bitget/cache.ts`, `tests/unit/ratelimit.test.ts` | 20-burst / 10-per-second token bucket, bounded backoff with jitter, in-flight coalescing, tested offline with zero real waiting. |
| The type-only wire contract | `lib/research/contract.ts` | Every import is `import type`, so zod and luxon never enter the client bundle. `lib/llm/vocabulary.ts` exists for the same reason. |
| SSE transport that survives proxies and reasoning silence | `app/api/research/route.ts` | 15s comment heartbeat, `cache-control: no-store, no-transform`, `x-accel-buffering: no`, `force-dynamic`. |
| Health that never leaks a secret | `app/api/health/route.ts` | `probeQwen()` is `env-presence` only: it reports `ok` or `not_configured`, never calls the gateway, never reads the value into the payload. |
| Fixtures are recordings, not authored numbers | `lib/fixtures/`, `lib/fixtures/loader.ts`, `scripts/record-fixtures.mjs`, `tests/contract/fixtures.test.ts` | 24 snapshots with a manifest, exact path+query matching, `FixtureMissError` on a miss, and `next.config.ts` tracing them into the serverless bundle. |
| The chart refuses to mislead | `components/basis-chart.tsx` | Hand-rolled SVG, y-axis symmetric around zero so "above the reference" and "below" look identical, session bands drawn from the data's own labels, perp overlaid. |

---

## Honest limitations

We would rather state these than have a judge find them.

- **rToken SPOT candle volume is unreliable.** It disagrees across intervals and with `tickers.turnover24h` -
  one 1D row claimed $23.88bn of quote volume for an instrument whose 24h turnover was $11,116. We never use it
  for a liquidity claim; `lib/compute/quality.ts` detects and reports the disagreement, and liquidity comes from
  the order book, the public tape and `turnover24h` instead.
- **The 1H candle endpoint caps at 1,000 rows** (~41 days) and `/history-candles` at 100, so every historical
  claim is bounded to a rolling window that slides forward each hour. We publish the window with the statistic.
- **A dead optional source blanks one panel** with a stated reason. Only the rToken spot 1H and index 1H series
  are required; without both, no basis is published at all - we would rather show nothing than an estimate.
- **Nothing is account-scoped.** No balances, positions or order history, because holding credentials would
  break the read-only guarantee and the publicly-accessible-demo requirement.
- **The cache is in-memory, per instance, and cold-starts empty.** Nothing in this app is authoritative state.
- **Bitget publishes no rate limit** for the v3 market endpoints, so we assume a tight one (20 burst / 10 per
  second) and stay well under it.
- **No unstructured-information source is wired in.** Every news / earnings / transcript source we probed was
  dead or key-gated, and the optional `bitget-signal` Skills / MCP data service is reported by `/api/health` as
  `signal-mcp: not_configured` rather than claimed. The research is built entirely on market data that answers.
- **Qwen latency is 3-25s per call** and it is a reasoning model, so a full AI-synthesised run takes tens of
  seconds. That is why the numbers render first and why the budget is clamped to the platform's real ceiling.
- **The finding is measured on AAPL.** The engine runs over all 207 dual-listed pairs, but the golden regression
  set is one name; a different underlying has its own distribution and its own liquidity.
- **Phase 5 hardening is not finished** and the UI is still in progress. See the phase table in `README.md`.

---

## Team, repository and links

| | |
|---|---|
| **Product** | Nightjar |
| **Repository** | <https://github.com/jamesedward0x/nightjar> |
| **Live deployment** | <https://nightjar-seven.vercel.app> |
| **Health endpoint** | <https://nightjar-seven.vercel.app/api/health> |
| **Track** | Bitget AI Hackathon S2 - Track 3 (AI Trading Desk) / Personalized Research Workbench |
| **Team name** | `[TO FILL IN]` |
| **Members** | `[TO FILL IN - name, role, Bitget UID, contact]` |
| **Primary contact** | `[TO FILL IN - email / Telegram / X handle]` |
| **Demo video** | `[TO FILL IN - link]` |
| **X post / retweet** | `[TO FILL IN - link to the official Bitget post we retweeted, still TBD in the rules]` |
| **Licence** | No `LICENCE` file in the repository; all rights reserved by the author for the duration of the hackathon. |

Nothing in this submission is investment advice. Nightjar is research output only, and it cannot execute a
trade.
