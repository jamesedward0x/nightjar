/**
 * The Research Memo: schema, validation, bounded repair, and the deterministic
 * fallback that guarantees the demo can never dead-end.
 *
 * Two rules shape this file.
 *
 * 1. The gateway cannot be forced into structured output. tool_choice:"required"
 *    400s in thinking mode and strict json_schema is accepted but silently ignored
 *    (it returned prose). So the strategy is INSTRUCT -> VALIDATE -> REPAIR ONCE ->
 *    FALL BACK. Never trust the model to be well-formed; never let a malformed
 *    answer become an empty screen.
 *
 * 2. The model writes sentences; code writes numbers. The fallback memo below is
 *    assembled entirely from the evidence pack, which is why removing
 *    BITGET_QWEN_API_KEY still yields a complete, sourced research memo. That is the
 *    proof this is not a chatbot, and it is a deliberate demo beat.
 *
 * Section 11 always terminates with NON_EXECUTION_STATEMENT, appended by code rather
 * than requested from the model, so no prompt can talk us out of it.
 */

import { z } from "zod";
import { BASIS_SIGN_CONVENTION } from "@/lib/compute/basis";
import { round } from "@/lib/compute/stats";
import type { EvidencePack } from "@/lib/research/evidence";
import {
  DECISION_OPTIONS,
  FALLBACK_BANNER,
  MEMO_VERDICTS,
  NON_EXECUTION_STATEMENT,
  VERDICT_LABELS,
  classifyVerdict,
} from "@/lib/llm/vocabulary";

// Vocabulary lives in lib/llm/vocabulary.ts so the client can import the labels
// without dragging zod, the compute engine and luxon into the browser bundle.
export {
  DECISION_LABELS,
  DECISION_OPTIONS,
  FALLBACK_BANNER,
  MEMO_VERDICTS,
  NON_EXECUTION_STATEMENT,
  VERDICT_LABELS,
  VERDICT_TONE,
} from "@/lib/llm/vocabulary";
export type { DecisionOption, MemoVerdict } from "@/lib/llm/vocabulary";
export { classifyVerdict } from "@/lib/llm/vocabulary";

/** What the model must produce. Length floors stop it answering with one lazy clause. */
export const memoSchema = z.object({
  verdict: z.enum(MEMO_VERDICTS),
  confidence: z.enum(["low", "medium", "high"]),
  bottom_line: z.string().min(40).max(700),
  the_number: z.string().min(30).max(600),
  session_context: z.string().min(30).max(600),
  is_this_normal: z.string().min(30).max(900),
  reference_integrity: z.string().min(30).max(700),
  liquidity_reality: z.string().min(30).max(800),
  derivatives_context: z.string().min(30).max(700),
  analogues: z.string().min(30).max(800),
  risk_flags: z
    .array(z.object({ flag: z.string().min(5).max(300), evidence: z.string().min(5).max(400) }))
    .min(1)
    .max(8),
  data_quality: z.string().min(30).max(700),
  decision_checklist: z
    .array(
      z.object({
        option: z.enum(DECISION_OPTIONS),
        argument_for: z.string().min(10).max(400),
        argument_against: z.string().min(10).max(400),
      }),
    )
    .min(2)
    .max(5),
  what_would_change_this_view: z.array(z.string().min(10).max(300)).min(1).max(6),
});

export type MemoBody = z.infer<typeof memoSchema>;

export interface ResearchMemo extends MemoBody {
  /** False when code produced this memo instead of Qwen. The UI must say so. */
  aiSynthesis: boolean;
  banner: string | null;
  nonExecutionStatement: typeof NON_EXECUTION_STATEMENT;
  /** Restated so a reader can never misread the headline number. */
  signConvention: typeof BASIS_SIGN_CONVENTION;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
}

export type MemoValidation =
  | { ok: true; body: MemoBody }
  | { ok: false; issues: string };

/** Parse and validate raw function_call arguments. Never throws. */
export function validateMemoArguments(raw: string): MemoValidation {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, issues: "arguments were not valid JSON: " + ((err as Error).message ?? "parse error") };
  }
  const result = memoSchema.safeParse(json);
  if (result.success) return { ok: true, body: result.data };
  const issues = result.error.issues
    .slice(0, 12)
    .map((i) => (i.path.length > 0 ? i.path.join(".") + ": " : "") + i.message)
    .join("; ");
  return { ok: false, issues };
}

/** The single repair pass: feed the Zod errors back as a tool result, verbatim. */
export function repairInstruction(issues: string): string {
  return (
    "Your emit_memo arguments failed schema validation. Fix ONLY these problems and call emit_memo again " +
    "with the complete object. Do not add commentary.\n\nValidation errors:\n" +
    issues +
    "\n\nReminder: every numeric claim must come from a tool result you already received. " +
    "decision_checklist needs 2-5 entries using option values from: " +
    DECISION_OPTIONS.join(", ") +
    ". verdict must be one of: " +
    MEMO_VERDICTS.join(", ") +
    "."
  );
}

// --------------------------------------------------------------- formatting

export function pct(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unavailable";
  return (value >= 0 ? "+" : "") + round(value, digits).toFixed(digits) + "%";
}

export function usd(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unavailable";
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function isoTs(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "unknown time";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// classifyVerdict moved to lib/llm/vocabulary.ts so the client can import it without zod.

// --------------------------------------------------- deterministic fallback

/**
 * Build the memo with no LLM at all. This is the fallback path, the fixture-mode
 * path, and the proof that the research engine - not Qwen - is the product.
 */
export function buildFallbackMemo(pack: EvidencePack, reason?: string): ResearchMemo {
  const snap = pack.snapshot;
  const basis = snap ? snap.basisPct : null;
  const verdict = classifyVerdict(basis);
  const by = pack.bySession;
  const window_ = pack.observationWindow;
  const windowText = window_
    ? `${window_.n} matched hourly observations from ${isoTs(window_.fromTs)} to ${isoTs(window_.toTs)}`
    : "no matched observations in the window";
  const degradedSources = pack.sources.filter((s) => s.status !== "ok").map((s) => s.id);

  const percentileText =
    snap?.percentileOverall !== null && snap?.percentileOverall !== undefined
      ? `the ${round(snap.percentileOverall, 0)}th percentile of absolute dislocations in this window`
      : "an unranked percentile (no comparable sample)";

  const worst = snap && by ? by[snap.session.kind] : null;
  const worstText =
    worst && worst.absolute
      ? `Within ${snap?.session.kind ?? "these"} sessions specifically (n=${worst.n}), mean absolute basis is ${pct(worst.absolute.meanAbs)} and the maximum observed is ${pct(worst.absolute.max)}.`
      : "No per-session sample was available.";

  const ratioText =
    pack.weekendDislocationRatio !== null
      ? `Weekend tracking error runs ${round(pack.weekendDislocationRatio, 1)}x the regular-hours level.`
      : "The weekend-to-RTH ratio could not be computed from this window.";
  const perpText =
    pack.perpTrackingRatio !== null
      ? `Over the same window the perpetual tracked the index ${round(pack.perpTrackingRatio, 1)}x more tightly than the tokenized spot did.`
      : "Perp tracking could not be compared (no perp candles in the window).";

  const ob = pack.liquidity?.orderbook ?? null;
  const exit5k = pack.liquidity?.slippage.find((s) => s.notional >= 5000)?.walk ?? null;
  const liquidityText = ob
    ? `Top-of-book spread is ${ob.spreadPct !== null ? pct(ob.spreadPct, 3) : "unavailable"} on a mid of ${ob.midPrice !== null ? round(ob.midPrice, 2) : "unavailable"}. ` +
      `Resting bid support totals ${usd(ob.bids.totalNotional, 0)} across ${ob.bids.levels.length} levels, of which ${usd(ob.bids.top5Notional, 0)} sits in the top five. ` +
      (exit5k
        ? `Selling ${usd(exit5k.targetNotional, 0)} walks ${exit5k.levelsConsumed} level(s) for an average fill of ${exit5k.averagePrice !== null ? round(exit5k.averagePrice, 2) : "unavailable"}, ${pct(exit5k.slippagePct, 3)} of slippage against the touch` +
          (exit5k.fullyFilled ? "." : " - and the visible book cannot absorb the whole order at all.")
        : "No exit-size curve was available.")
    : "The order book was unavailable, so no exit cost could be priced.";

  const turnoverText = pack.liquidity?.turnover?.ratio
    ? ` 24h turnover is ${usd(pack.liquidity.turnover.spotTurnover24h, 0)} on the rToken against ${usd(pack.liquidity.turnover.perpTurnover24h, 0)} on the perp - a ${round(pack.liquidity.turnover.ratio, 0)}x asymmetry.`
    : "";

  const tapeText = pack.liquidity?.tape
    ? ` The tape shows ${pack.liquidity.tape.tradeCount} public prints spanning ${pack.liquidity.tape.spanHours ?? "an unknown"} hour(s), median size ${usd(pack.liquidity.tape.medianTradeNotional, 0)}, most recent ${pack.liquidity.tape.ageOfLastTradeMs !== null ? round(pack.liquidity.tape.ageOfLastTradeMs / 60000, 0) + " minute(s) ago" : "at an unknown time"}.`
    : "";

  const ref = pack.reference;
  const referenceText = ref
    ? `The ${ref.symbol} reference index is composed of ${ref.venueCount} venue(s): ` +
      ref.components
        .map((c) => `${c.exchange}${c.spotPair ? " (" + c.spotPair + ")" : ""} at ${c.equivalentPrice !== null ? round(c.equivalentPrice, 2) : "unavailable"} with weight ${c.weight !== null ? round(c.weight, 4) : "unavailable"}`)
        .join(", ") +
      `. Weights sum to ${ref.weightSum !== null ? round(ref.weightSum, 4) : "unavailable"}` +
      (ref.weightSum !== null && Math.abs(ref.weightSum - 1) > 0.01 ? ", which does NOT total 1 - treat the reference as suspect." : ".")
    : "The index composition endpoint did not answer, so the reference recipe is unverified for this run.";

  const d = pack.derivatives;
  const derivativesText = d
    ? `Funding is ${d.fundingRatePct !== null ? pct(d.fundingRatePct, 4) : "unavailable"} per ${d.fundingIntervalHours !== null ? round(d.fundingIntervalHours, 0) + "h interval" : "interval"}, next update ${isoTs(d.nextUpdateTs)}, capped at ${pct(d.minFundingRatePct, 2)} / ${pct(d.maxFundingRatePct, 2)}` +
      (d.atCap ? " and currently pinned AT that cap, which is itself a signal of one-sided pressure" : "") +
      `. Open interest is ${d.openInterestBase !== null ? round(d.openInterestBase, 2) : "unavailable"} contracts as of ${isoTs(d.openInterestTs)}.`
    : "Funding and open interest were unavailable, so the derivatives read is missing.";

  const analogueText =
    pack.analogues.length > 0
      ? `The widest dislocations in this window: ` +
        pack.analogues
          .slice(0, 5)
          .map(
            (a) =>
              `#${a.rank} ${isoTs(a.ts)} at ${pct(a.basisPct)} (${a.session}${a.rTokenSpecificDetachment ? ", rToken-specific - the perp held the index" : ""})`,
          )
          .join("; ") +
        (pack.episodes[0]
          ? `. The largest episode ran ${pack.episodes[0].hours} hour(s) from ${isoTs(pack.episodes[0].startTs)}, peaking at ${pct(pack.episodes[0].peakBasisPct)}` +
            (pack.episodes[0].basisAfter24h !== null ? `, and 24h after it ended the basis was ${pct(pack.episodes[0].basisAfter24h)}.` : ".")
          : ".")
      : "No dislocation exceeded the reporting threshold in this window.";

  const exceedText = pack.exceedances
    .map((e) => `|basis| > ${e.thresholdPct}%: ${e.count} hour(s) (${e.rth} RTH, ${e.offhours} off-hours, ${e.weekend} weekend)`)
    .join("; ");

  const flags =
    pack.quality.flags.length > 0
      ? pack.quality.flags.slice(0, 6).map((f) => ({ flag: f.code + " (" + f.severity + ")", evidence: f.message }))
      : [{ flag: "no anomalies detected", evidence: "Every series reconciled within tolerance for this run." }];

  const checklist: MemoBody["decision_checklist"] = [
    {
      option: "hold",
      argument_for: `The reference index is intact and the dislocation is ${basis !== null ? pct(basis) : "unquantified"}, which sits at ${percentileText}. Historically these converge once the reference market reopens.`,
      argument_against: `Convergence is not guaranteed, and exiting now would cost ${exit5k?.slippagePct !== null && exit5k?.slippagePct !== undefined ? pct(exit5k.slippagePct, 3) : "an unpriced amount"} in slippage on a ${usd(5000, 0)} order.${turnoverText}`,
    },
    {
      option: "wait_for_open",
      argument_for: `${snap?.session.label ?? "The current session"} is when tracking error is widest. Waiting for regular trading hours means pricing against a liquid reference instead of a thin one.`,
      argument_against: "The reference market can gap at the open - a ~2% hourly move has been observed - and a 7x24 holder is exposed to it whether or not they are watching.",
    },
    {
      option: "hedge_with_perp",
      argument_for: `The perp tracked the index ${pack.perpTrackingRatio !== null ? round(pack.perpTrackingRatio, 1) + "x" : "materially"} more tightly than the rToken over this window, so it is the cleaner instrument for expressing or hedging the view.`,
      argument_against: "Hedging introduces funding cost, liquidation risk and basis risk of its own, and it does not improve the liquidity of the rToken leg you are trying to exit.",
    },
    {
      option: "trim",
      argument_for: `Bid support within 1% of the touch is ${usd(pack.liquidity?.bidSupportWithin1Pct, 0)}. Reducing size now is cheaper than reducing it later into the same book.`,
      argument_against: `Trimming into a ${ob?.spreadPct !== null && ob?.spreadPct !== undefined ? pct(ob.spreadPct, 3) : "wide"} spread realises the cost immediately, and the dislocation may converge on its own.`,
    },
  ];

  return {
    verdict,
    confidence: snap ? (degradedSources.length > 2 ? "low" : "medium") : "low",
    bottom_line: snap
      ? `${pack.base} tokenized spot is ${VERDICT_LABELS[verdict].toLowerCase()} at ${pct(basis)} against its composite reference index (${pack.rTokenSymbol} ${round(snap.rTokenPrice, 2)} vs ${pack.perpSymbol} index ${round(snap.indexPrice, 2)}), measured ${isoTs(snap.asOf)} during ${snap.session.label.toLowerCase()}.`
      : `${pack.base} could not be priced: the basis inputs did not return data, so no verdict is offered rather than a guessed one.`,
    the_number: snap
      ? `Basis ${pct(basis)} (${BASIS_SIGN_CONVENTION}). rToken ${round(snap.rTokenPrice, 2)}, reference index ${round(snap.indexPrice, 2)}${snap.perpPrice !== null ? `, perp ${round(snap.perpPrice, 2)}` : ""}, perp basis ${pct(snap.perpBasisPct)}. As of ${isoTs(snap.asOf)}.`
      : "No basis could be computed for this window.",
    session_context: snap
      ? `${snap.session.label}. New York local time ${snap.session.ny.iso}, which is ${
          snap.session.dst ? "daylight saving time (EDT, UTC-4)" : "standard time (EST, UTC-5)"
        }, so the UTC offset of this session moves with the calendar and is never hardcoded. ` +
        `The market that actually prices ${pack.base} is ${snap.session.referenceMarketOpen ? "OPEN" : "CLOSED"}. ` +
        (snap.session.referenceMarketOpen
          ? "With the underlying live, the rToken is being arbitraged against a price that exists, which is why tracking is tightest here."
          : "With the underlying shut there is no live reference to arbitrage against, so the rToken is priced by whoever is in the room - which is precisely when it detaches.")
      : "Session context unavailable.",
    // Invariant 3: a distribution statistic without its observation window is meaningless,
    // because the 1H endpoint is capped at 1000 rows and the window slides forward hourly.
    is_this_normal: snap
      ? `This reading is ${percentileText}, drawn from ${windowText}. ${worstText} ${ratioText} ${perpText} ${exceedText}`
      : `No distribution was available to judge this reading against (${windowText}).`,
    reference_integrity: referenceText,
    liquidity_reality: liquidityText + turnoverText + tapeText,
    derivatives_context: derivativesText,
    analogues: analogueText,
    risk_flags: flags,
    data_quality:
      pack.quality.disclosure +
      (pack.quality.flags.length > 0
        ? " Flags raised this run: " + pack.quality.flags.map((f) => f.code).join(", ") + "."
        : " No inconsistency was detected in this run, but the field remains untrusted by policy.") +
      (degradedSources.length > 0 ? " Sources unavailable or degraded: " + degradedSources.join(", ") + "." : " All sources answered."),
    decision_checklist: checklist,
    what_would_change_this_view: [
      `The basis returning inside ${pct(0.1)} during regular trading hours would mean the dislocation was transient rather than structural.`,
      "A change in the reference index composition, or weights that stop summing to 1, would invalidate every comparison in this memo.",
      `Resting bid support moving materially from ${usd(pack.liquidity?.bidSupportWithin1Pct, 0)} would change the exit-cost conclusion more than any price move would.`,
      "Funding pinning at its cap in the opposite direction would suggest the perp, not the rToken, is the dislocated leg.",
    ],
    aiSynthesis: false,
    banner: FALLBACK_BANNER + (reason ? " Reason: " + reason : ""),
    nonExecutionStatement: NON_EXECUTION_STATEMENT,
    signConvention: BASIS_SIGN_CONVENTION,
    usage: null,
  };
}

/** Wrap a validated model body into the full memo, appending what code owns. */
export function finaliseMemo(
  body: MemoBody,
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null,
): ResearchMemo {
  return {
    ...body,
    aiSynthesis: true,
    banner: null,
    nonExecutionStatement: NON_EXECUTION_STATEMENT,
    signConvention: BASIS_SIGN_CONVENTION,
    usage,
  };
}