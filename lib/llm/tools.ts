/**
 * The tool catalogue Qwen may call, and the executor that answers them.
 *
 * Design decision that keeps us inside a serverless budget: the evidence pack is
 * gathered ONCE per symbol and cached in the ToolContext. Every tool below is a pure
 * PROJECTION of that pack. So whether Qwen calls two tools or six, the upstream
 * fan-out is the same ~15 Bitget calls per symbol. A naive design where each tool
 * fetched its own data would blow the timeout on the second question.
 *
 * Tool outputs are compact on purpose. They are also untrusted input to the model, so
 * every string is truncated and the system prompt states that no tool output may alter
 * the model's instructions. Combined with readOnly:true, a successful prompt injection
 * can produce a bad sentence, never an action.
 */

import { z } from "zod";
import { MAX_SYMBOLS_PER_QUERY } from "@/lib/config";
import { VERDICT_LABELS, classifyVerdict, isoTs, pct } from "@/lib/llm/memo";
import { round } from "@/lib/compute/stats";
import { gatherEvidence, type EvidencePack } from "@/lib/research/evidence";
import { createLogger } from "@/lib/observability/logger";
import type { QwenTool } from "@/lib/llm/qwen";

const log = createLogger("llm.tools");

export const MEMO_TOOL_NAME = "emit_memo";

/** Hard cap on any single tool result, in characters. Protects the token budget. */
const MAX_OUTPUT_CHARS = 6000;

const symbolSchema = z.object({
  symbol: z.string().min(1).max(24).describe("Underlying ticker or Bitget symbol, e.g. AAPL, rAAPL or RAAPLUSDT"),
});

const analoguesSchema = symbolSchema.extend({
  count: z.number().int().min(1).max(10).optional().describe("How many historical dislocations to return. Default 5."),
});

const compareSchema = z.object({
  symbols: z
    .array(z.string().min(1).max(24))
    .min(1)
    .max(MAX_SYMBOLS_PER_QUERY)
    .describe(`Up to ${MAX_SYMBOLS_PER_QUERY} tickers to compare, e.g. ["AAPL","NVDA","TSLA"]`),
});

const memoParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["discount", "fair_pricing", "premium", "elevated_premium", "extreme_dislocation", "insufficient_data"],
      description: "Your overall read of the current basis.",
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    bottom_line: { type: "string", description: "2-3 sentences directly answering the question asked." },
    the_number: { type: "string", description: "Current basis vs reference, sign convention stated, plus the perp basis for contrast." },
    session_context: { type: "string", description: "Is the reference market open, which session is this reading from, and why that matters." },
    is_this_normal: { type: "string", description: "The reading placed as a percentile of the observed distribution, split by session." },
    reference_integrity: { type: "string", description: "The venue decomposition of the index, per-venue price, any staleness or divergence." },
    liquidity_reality: { type: "string", description: "Spread, depth in dollars, recent tape, turnover vs the perp, framed as cost to exit." },
    derivatives_context: { type: "string", description: "Funding rate with its caps and interval, open interest, and whether they corroborate the spot read." },
    analogues: { type: "string", description: "The widest historical dislocations in the window and what followed." },
    risk_flags: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { flag: { type: "string" }, evidence: { type: "string", description: "The specific datum this flag is tied to." } },
        required: ["flag", "evidence"],
      },
    },
    data_quality: { type: "string", description: "Sources used, their health, and known defects. Must mention the candle-volume defect whenever volume is discussed." },
    decision_checklist: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          option: { type: "string", enum: ["hold", "trim", "hedge_with_perp", "wait_for_open", "add"] },
          argument_for: { type: "string" },
          argument_against: { type: "string" },
        },
        required: ["option", "argument_for", "argument_against"],
      },
      description: "Arguments for and against each course of action. Never an instruction.",
    },
    what_would_change_this_view: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string" },
      description: "Falsification conditions.",
    },
  },
  required: [
    "verdict",
    "confidence",
    "bottom_line",
    "the_number",
    "session_context",
    "is_this_normal",
    "reference_integrity",
    "liquidity_reality",
    "derivatives_context",
    "analogues",
    "risk_flags",
    "data_quality",
    "decision_checklist",
    "what_would_change_this_view",
  ],
} as const;

/** The catalogue advertised to the model. Descriptions are the model's only documentation. */
export const RESEARCH_TOOLS: QwenTool[] = [
  {
    type: "function",
    name: "get_basis_snapshot",
    description:
      "Current rToken-vs-reference basis for one tokenized equity: prices, basis percent with sign convention, the perp basis for contrast, the session it was measured in, and the observation window. Call this first for any single-name question.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { symbol: { type: "string", description: "Ticker or symbol, e.g. AAPL, rAAPL or RAAPLUSDT" } },
      required: ["symbol"],
    },
  },
  {
    type: "function",
    name: "get_basis_distribution",
    description:
      "The empirical distribution of |basis| split into regular trading hours, weekday off-hours and weekend, with means, maxima, percentiles, the weekend-to-RTH dislocation ratio, the perp-tracking ratio, and exceedance counts. This is how you answer 'is this normal?'.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { symbol: { type: "string", description: "Ticker or symbol" } },
      required: ["symbol"],
    },
  },
  {
    type: "function",
    name: "get_reference_composition",
    description:
      "The recipe of the composite reference index the perpetual settles against: each constituent venue, its spot pair, its equivalent price and its weight, plus whether the weights sum to 1. Use this to judge whether the reference itself is trustworthy.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { symbol: { type: "string", description: "Ticker or symbol" } },
      required: ["symbol"],
    },
  },
  {
    type: "function",
    name: "get_liquidity_profile",
    description:
      "Exit economics: bid/ask spread, depth in dollars per level and cumulative, a slippage curve at several notionals, public tape statistics, and 24h turnover asymmetry versus the perp. Never derived from candle volume, which is unreliable for rToken spot.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { symbol: { type: "string", description: "Ticker or symbol" } },
      required: ["symbol"],
    },
  },
  {
    type: "function",
    name: "find_analogues",
    description:
      "The widest historical dislocations inside the observation window, ranked, each with what the basis did 6h and 24h later, plus contiguous episodes above a threshold. Use this for 'has this happened before and what followed'.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        symbol: { type: "string", description: "Ticker or symbol" },
        count: { type: "number", description: "How many to return, 1-10. Default 5." },
      },
      required: ["symbol"],
    },
  },
  {
    type: "function",
    name: "get_derivatives_context",
    description:
      "Perpetual funding rate with its interval and caps, whether it is pinned at a cap, and open interest. Use this to test whether the derivative corroborates or contradicts the spot read.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { symbol: { type: "string", description: "Ticker or symbol" } },
      required: ["symbol"],
    },
  },
  {
    type: "function",
    name: "compare_symbols",
    description: `Side-by-side basis snapshots for up to ${MAX_SYMBOLS_PER_QUERY} names. Costs one evidence pack per symbol, so only call it when the question genuinely compares names.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        symbols: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_SYMBOLS_PER_QUERY, description: "Tickers to compare" },
      },
      required: ["symbols"],
    },
  },
  {
    type: "function",
    name: MEMO_TOOL_NAME,
    description:
      "MANDATORY FINAL STEP. Emit the structured research memo. You must call this exactly once to finish every research task, after you have gathered enough evidence. Every numeric claim in it must come from a tool result you actually received.",
    parameters: memoParameters,
  },
];

export const TOOL_NAMES = RESEARCH_TOOLS.map((t) => t.name);

// ------------------------------------------------------------------ context

export interface ToolContext {
  /** One evidence pack per symbol, gathered lazily and reused across tool calls. */
  packs: Map<string, EvidencePack>;
  /** Failures, so a repeated bad symbol does not re-trigger a full fan-out. */
  failures: Map<string, { kind: string; message: string }>;
  now: number;
  /** Injected so the loop can stop fetching once the budget is spent. */
  isAborted: () => boolean;
}

export function createToolContext(now: number, isAborted: () => boolean): ToolContext {
  return { packs: new Map(), failures: new Map(), now, isAborted };
}

async function evidenceFor(ctx: ToolContext, symbol: string): Promise<EvidencePack | { error: { kind: string; message: string } }> {
  const key = symbol.trim().toUpperCase();
  const cached = ctx.packs.get(key);
  if (cached) return cached;
  const priorFailure = ctx.failures.get(key);
  if (priorFailure) return { error: priorFailure };
  if (ctx.isAborted()) return { error: { kind: "loop_budget_exceeded", message: "Budget spent before this symbol could be fetched." } };
  const result = await gatherEvidence(symbol, { now: ctx.now });
  if (!result.ok) {
    const failure = { kind: result.kind, message: result.message };
    ctx.failures.set(key, failure);
    return { error: failure };
  }
  ctx.packs.set(result.pack.base.toUpperCase(), result.pack);
  ctx.packs.set(key, result.pack);
  return result.pack;
}

function clampOutput(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= MAX_OUTPUT_CHARS) return json;
  return json.slice(0, MAX_OUTPUT_CHARS) + '","_truncated":true}';
}

function packHeader(pack: EvidencePack) {
  return {
    symbol: pack.base,
    rTokenSymbol: pack.rTokenSymbol,
    perpSymbol: pack.perpSymbol,
    mode: pack.mode,
    degraded: pack.degraded,
    generatedAt: isoTs(pack.generatedAt),
    observationWindow: pack.observationWindow
      ? { from: isoTs(pack.observationWindow.fromTs), to: isoTs(pack.observationWindow.toTs), matchedHours: pack.observationWindow.n }
      : null,
    unmatchedSpotHoursDropped: pack.joinStats?.droppedLeft ?? null,
  };
}

// ---------------------------------------------------------------- projections

function projectSnapshot(pack: EvidencePack) {
  const s = pack.snapshot;
  if (!s) return { ...packHeader(pack), error: "No basis could be computed for this window." };
  return {
    ...packHeader(pack),
    asOf: isoTs(s.asOf),
    session: { kind: s.session.kind, label: s.session.label, newYorkTime: s.session.ny.iso, dst: s.session.dst, referenceMarketOpen: s.session.referenceMarketOpen },
    rTokenPrice: round(s.rTokenPrice, 4),
    referenceIndexPrice: round(s.indexPrice, 4),
    perpPrice: s.perpPrice === null ? null : round(s.perpPrice, 4),
    basisPct: round(s.basisPct, 4),
    perpBasisPct: s.perpBasisPct === null ? null : round(s.perpBasisPct, 4),
    signConvention: s.signConvention,
    verdict: { code: classifyVerdict(s.basisPct), label: VERDICT_LABELS[classifyVerdict(s.basisPct)] },
    percentileOverall: s.percentileOverall === null ? null : round(s.percentileOverall, 1),
    percentileWithinSession: s.percentileWithinSession === null ? null : round(s.percentileWithinSession, 1),
    hoursAtOrAbove0p5PctEndingNow: pack.currentRunHours,
    formatted: { basis: pct(s.basisPct), perpBasis: pct(s.perpBasisPct) },
  };
}

function projectDistribution(pack: EvidencePack) {
  const by = pack.bySession;
  const bucket = (b: { n: number; signed: { mean: number; meanAbs: number; median: number; max: number; min: number; p95: number } | null; absolute: { meanAbs: number; max: number; p95: number; n: number } | null }) => ({
    hours: b.n,
    meanAbsBasisPct: b.absolute ? round(b.absolute.meanAbs, 4) : null,
    medianAbsBasisPct: b.absolute ? round(b.absolute.meanAbs, 4) : null,
    maxAbsBasisPct: b.absolute ? round(b.absolute.max, 4) : null,
    p95AbsBasisPct: b.absolute ? round(b.absolute.p95, 4) : null,
    meanSignedBasisPct: b.signed ? round(b.signed.mean, 4) : null,
  });
  return {
    ...packHeader(pack),
    buckets: by
      ? { regularTradingHours: bucket(by.rth), weekdayOffHours: bucket(by.offhours), weekend: bucket(by.weekend), wholeSample: bucket(by.all) }
      : null,
    weekendToRthDislocationRatio: pack.weekendDislocationRatio === null ? null : round(pack.weekendDislocationRatio, 2),
    perpTracksIndexTighterBy: pack.perpTrackingRatio === null ? null : round(pack.perpTrackingRatio, 2),
    exceedances: pack.exceedances,
    note: "Buckets are classified in America/New_York so the session boundary survives the DST transition. The 1H feed caps at 1000 rows, so this window slides forward every hour and must always be quoted alongside these statistics.",
  };
}

function projectLiquidity(pack: EvidencePack) {
  const l = pack.liquidity;
  const ob = l?.orderbook ?? null;
  return {
    ...packHeader(pack),
    spread: ob ? { bestBid: ob.bestBid, bestAsk: ob.bestAsk, mid: ob.midPrice === null ? null : round(ob.midPrice, 4), absolute: ob.spreadAbs === null ? null : round(ob.spreadAbs, 4), pct: ob.spreadPct === null ? null : round(ob.spreadPct, 4) } : null,
    depth: ob
      ? {
          bidNotionalTotalUsd: round(ob.bids.totalNotional, 2),
          bidTop5NotionalUsd: round(ob.bids.top5Notional, 2),
          askNotionalTotalUsd: round(ob.asks.totalNotional, 2),
          levels: ob.bids.levels.length,
          bidSupportWithin1PctUsd: l?.bidSupportWithin1Pct ?? null,
          topBidLevels: ob.bids.levels.slice(0, 5).map((lv) => ({ price: lv.price, size: round(lv.size, 6), notionalUsd: round(lv.notional, 2), cumulativeNotionalUsd: round(lv.cumulativeNotional, 2) })),
        }
      : null,
    exitCostCurve:
      l?.slippage.map((s) => ({
        sellNotionalUsd: s.notional,
        averageFillPrice: s.walk.averagePrice,
        slippagePctVsTouch: s.walk.slippagePct,
        levelsConsumed: s.walk.levelsConsumed,
        bookCanAbsorbIt: s.walk.fullyFilled,
        filledNotionalUsd: s.walk.filledNotional,
      })) ?? [],
    tape: l?.tape
      ? {
          publicPrints: l.tape.tradeCount,
          spanHours: l.tape.spanHours,
          totalNotionalUsd: l.tape.totalNotional,
          medianTradeUsd: l.tape.medianTradeNotional,
          largestTradeUsd: l.tape.largestTradeNotional,
          buyShareOfNotional: l.tape.buyShare,
          minutesSinceLastPrint: l.tape.ageOfLastTradeMs === null ? null : round(l.tape.ageOfLastTradeMs / 60000, 1),
        }
      : null,
    turnoverAsymmetry: l?.turnover ?? null,
    volumePolicy: "Derived from the public tape and the order book. rToken spot CANDLE volume is unreliable and is never used here.",
  };
}

function projectAnalogues(pack: EvidencePack, count?: number) {
  return {
    ...packHeader(pack),
    ranked: (count ? pack.analogues.slice(0, count) : pack.analogues).map((a) => ({
      rank: a.rank,
      at: isoTs(a.ts),
      session: a.session,
      basisPct: a.basisPct,
      perpBasisPct: a.perpBasisPct,
      rTokenSpecificDetachment: a.rTokenSpecificDetachment,
      followed: a.followed.map((f) => ({ hoursLater: f.horizonHours, basisPct: f.basisPct, reverted: f.reverted })),
    })),
    episodes: pack.episodes.slice(0, 5).map((e) => ({
      from: isoTs(e.startTs),
      to: isoTs(e.endTs),
      hours: e.hours,
      peakBasisPct: e.peakBasisPct,
      peakAt: isoTs(e.peakTs),
      meanAbsBasisPct: e.meanAbsBasisPct,
      sessionAtPeak: e.sessionAtPeak,
      basis24hAfterEnd: e.basisAfter24h,
    })),
    caveat: "Restricted to the observation window above. This is a ~41-day ceiling imposed by the 1H feed, not the full listing history.",
  };
}

function projectDerivatives(pack: EvidencePack) {
  const d = pack.derivatives;
  return {
    ...packHeader(pack),
    funding: d
      ? {
          ratePctPerInterval: d.fundingRatePct === null ? null : round(d.fundingRatePct, 5),
          intervalHours: d.fundingIntervalHours === null ? null : round(d.fundingIntervalHours, 2),
          capMinPct: d.minFundingRatePct === null ? null : round(d.minFundingRatePct, 4),
          capMaxPct: d.maxFundingRatePct === null ? null : round(d.maxFundingRatePct, 4),
          pinnedAtCap: d.atCap,
          nextUpdate: isoTs(d.nextUpdateTs),
        }
      : null,
    openInterest: d ? { contracts: d.openInterestBase === null ? null : round(d.openInterestBase, 4), asOf: isoTs(d.openInterestTs) } : null,
    available: d !== null,
  };
}

function projectComparison(pack: EvidencePack) {
  const s = pack.snapshot;
  const ob = pack.liquidity?.orderbook ?? null;
  return {
    symbol: pack.base,
    rTokenSymbol: pack.rTokenSymbol,
    basisPct: s ? round(s.basisPct, 4) : null,
    perpBasisPct: s?.perpBasisPct === null || s?.perpBasisPct === undefined ? null : round(s.perpBasisPct, 4),
    verdict: s ? classifyVerdict(s.basisPct) : "insufficient_data",
    session: s ? s.session.kind : null,
    percentileOverall: s?.percentileOverall === null || s?.percentileOverall === undefined ? null : round(s.percentileOverall, 1),
    spreadPct: ob?.spreadPct === null || ob?.spreadPct === undefined ? null : round(ob.spreadPct, 4),
    bidDepthUsd: ob ? round(ob.bids.totalNotional, 2) : null,
    turnoverRatioPerpToSpot: pack.liquidity?.turnover?.ratio ?? null,
    degraded: pack.degraded,
    error: s ? null : "basis unavailable",
  };
}

// ----------------------------------------------------------------- executor

export interface ToolExecution {
  ok: boolean;
  /** JSON string handed back to the model as the tool result. */
  output: string;
  tool: string;
  latencyMs: number;
  /** True when this call triggered a fresh upstream fan-out (vs a cached pack). */
  fetchedPack: boolean;
  symbol: string | null;
}

export async function executeTool(ctx: ToolContext, name: string, rawArgs: string): Promise<ToolExecution> {
  const started = Date.now();
  const before = ctx.packs.size;
  try {
    const output = await dispatch(ctx, name, rawArgs);
    return {
      ok: true,
      output: clampOutput(output),
      tool: name,
      latencyMs: Date.now() - started,
      fetchedPack: ctx.packs.size > before,
      symbol: safeSymbol(rawArgs),
    };
  } catch (err) {
    const message = (err as Error)?.message ?? "tool failed";
    log.warn("tool.failed", { tool: name, message });
    return {
      ok: false,
      output: clampOutput({ tool: name, error: message, guidance: "Report this source as unavailable in the memo. Do not invent a value for it." }),
      tool: name,
      latencyMs: Date.now() - started,
      fetchedPack: ctx.packs.size > before,
      symbol: safeSymbol(rawArgs),
    };
  }
}

function safeSymbol(rawArgs: string): string | null {
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    if (typeof parsed.symbol === "string") return parsed.symbol;
    if (Array.isArray(parsed.symbols)) return parsed.symbols.join(",");
  } catch {
    /* not JSON - no symbol to report */
  }
  return null;
}

async function dispatch(ctx: ToolContext, name: string, rawArgs: string): Promise<unknown> {
  if (name === "compare_symbols") {
    const parsed = compareSchema.parse(JSON.parse(rawArgs));
    const results: unknown[] = [];
    for (const symbol of parsed.symbols) {
      const pack = await evidenceFor(ctx, symbol);
      results.push("error" in pack ? { symbol, error: pack.error } : projectComparison(pack));
    }
    return { comparison: results, requested: parsed.symbols.length, cap: MAX_SYMBOLS_PER_QUERY };
  }

  if (name === "find_analogues") {
    const parsed = analoguesSchema.parse(JSON.parse(rawArgs));
    const pack = await evidenceFor(ctx, parsed.symbol);
    if ("error" in pack) return { symbol: parsed.symbol, error: pack.error };
    return projectAnalogues(pack, parsed.count);
  }

  const parsed = symbolSchema.parse(JSON.parse(rawArgs));
  const pack = await evidenceFor(ctx, parsed.symbol);
  if ("error" in pack) return { symbol: parsed.symbol, error: pack.error };

  switch (name) {
    case "get_basis_snapshot":
      return projectSnapshot(pack);
    case "get_basis_distribution":
      return projectDistribution(pack);
    case "get_reference_composition":
      return { ...packHeader(pack), reference: pack.reference ?? { available: false, reason: "index-components did not answer for this run" } };
    case "get_liquidity_profile":
      return projectLiquidity(pack);
    case "get_derivatives_context":
      return projectDerivatives(pack);
    default:
      return { error: "Unknown tool " + name, availableTools: TOOL_NAMES };
  }
}

/** Provenance summary for the UI panel: which packs were built and from what. */
export function summariseContext(ctx: ToolContext) {
  const seen = new Set<string>();
  const packs: EvidencePack[] = [];
  for (const pack of ctx.packs.values()) {
    if (seen.has(pack.base)) continue;
    seen.add(pack.base);
    packs.push(pack);
  }
  return packs;
}
