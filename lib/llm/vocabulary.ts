/**
 * The controlled vocabulary of the research memo.
 *
 * This file exists so the browser can render a memo without importing lib/llm/memo.ts,
 * which would pull zod, the compute engine and luxon into the client bundle. Labels and
 * tone only: no schema, no validation, no I/O. memo.ts re-exports everything here, so
 * there is exactly one source of truth and the server and the UI cannot disagree about
 * what a verdict means.
 */

export const NON_EXECUTION_STATEMENT =
  "Nightjar is research only. It holds no credentials, exposes no order controls, and cannot place, amend or cancel a trade. The decision and the execution are entirely yours.";

export const FALLBACK_BANNER =
  "AI synthesis unavailable - showing computed data only. Every figure below is deterministic and sourced; only the narrative is templated.";

export const MEMO_VERDICTS = [
  "discount",
  "fair_pricing",
  "premium",
  "elevated_premium",
  "extreme_dislocation",
  "insufficient_data",
] as const;
export type MemoVerdict = (typeof MEMO_VERDICTS)[number];

/**
 * Labels are SIGN-NEUTRAL for the two magnitude bands. classifyVerdict ranks on
 * |basis|, so a -0.5% reading lands in `elevated_premium`; calling that "elevated
 * premium" on screen would contradict invariant 9 (the sign is itself informative).
 * The signed bands below are exact, and the memo always states the sign explicitly.
 */
export const VERDICT_LABELS: Record<MemoVerdict, string> = {
  discount: "Trading at a discount to its reference",
  fair_pricing: "Tracking its reference closely",
  premium: "Trading at a premium to its reference",
  elevated_premium: "Well outside its normal tracking range",
  extreme_dislocation: "Extreme dislocation from its reference",
  insufficient_data: "Insufficient data to judge",
};

/** Drives the verdict chip colour. A discount is not "good", it is just the other side. */
export const VERDICT_TONE: Record<MemoVerdict, "good" | "neutral" | "warn" | "bad"> = {
  discount: "neutral",
  fair_pricing: "good",
  premium: "neutral",
  elevated_premium: "warn",
  extreme_dislocation: "bad",
  insufficient_data: "warn",
};

export const DECISION_OPTIONS = ["hold", "trim", "hedge_with_perp", "wait_for_open", "add"] as const;
export type DecisionOption = (typeof DECISION_OPTIONS)[number];

export const DECISION_LABELS: Record<DecisionOption, string> = {
  hold: "Hold",
  trim: "Trim",
  hedge_with_perp: "Hedge with the perp",
  wait_for_open: "Wait for the US open",
  add: "Add",
};

/**
 * Map a basis reading onto the verdict vocabulary. The thresholds are the same ones the
 * fallback memo and the UI headline use, and they are documented rather than tuned:
 *   >= 0.75%  extreme dislocation  - beyond anything the recorded sample shows in RTH
 *   >= 0.35%  elevated premium     - outside normal tracking but not unprecedented
 *   >= 0.10%  premium / discount   - a real gap, signed
 *   <  0.10%  fair pricing         - inside normal tracking error
 * Lives here, not in memo.ts, so the browser can label a number the server computed
 * without importing the schema.
 */
export function classifyVerdict(basisPct: number | null | undefined): MemoVerdict {
  if (basisPct === null || basisPct === undefined || !Number.isFinite(basisPct)) return "insufficient_data";
  const magnitude = Math.abs(basisPct);
  if (magnitude >= 0.75) return "extreme_dislocation";
  if (magnitude >= 0.35) return "elevated_premium";
  if (magnitude >= 0.1) return basisPct > 0 ? "premium" : "discount";
  return "fair_pricing";
}