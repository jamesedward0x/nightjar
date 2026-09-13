/**
 * The dead-end guarantee.
 *
 * Nightjar's claim is that removing the model does not remove the product. These tests run
 * the real loop - lib/llm/loop.ts - against the recorded AAPL fixtures with
 * BITGET_QWEN_API_KEY deleted and global fetch stubbed to throw, so a network call would
 * fail the suite instead of passing silently. Three promises are pinned:
 *
 *   1. No key: start -> evidence -> memo -> done, and the memo is schema-valid, so the UI
 *      renders exactly the same screen with or without AI.
 *   2. disableAi WITH a key configured: still deterministic. "Kill the key" is a demo beat,
 *      not the only brake on the model.
 *   3. A symbol that cannot be resolved degrades to an error event plus done, and never
 *      throws to its caller.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MEMO_REPAIRS, MAX_PROSE_NUDGES, MAX_TURNS, runResearchTurn, type ResearchRequest } from "@/lib/llm/loop";
import { memoSchema } from "@/lib/llm/memo";
import { BASIS_SIGN_CONVENTION } from "@/lib/compute/basis";
import { FALLBACK_BANNER, MEMO_VERDICTS, NON_EXECUTION_STATEMENT, classifyVerdict } from "@/lib/llm/vocabulary";
import { MAX_CHART_POINTS } from "@/lib/research/payload";
import { resolveResearchBudgetMs } from "@/lib/config";
import type { LoopStats, ResearchEvent } from "@/lib/research/contract";

const QUESTION = "Is AAPL dislocated from its reference index?";
const QWEN_KEY_ENV = "BITGET_QWEN_API_KEY";

const ORIGINAL_ENV = {
  mode: process.env.NIGHTJAR_MODE,
  apiKey: process.env[QWEN_KEY_ENV],
};

/** Fixture mode on, and the key either absent or exactly what the test says it is. */
function applyEnv(apiKey: string | undefined): void {
  process.env.NIGHTJAR_MODE = "fixture";
  if (apiKey === undefined) delete process.env[QWEN_KEY_ENV];
  else process.env[QWEN_KEY_ENV] = apiKey;
}

function restoreEnv(): void {
  if (ORIGINAL_ENV.mode === undefined) delete process.env.NIGHTJAR_MODE;
  else process.env.NIGHTJAR_MODE = ORIGINAL_ENV.mode;
  if (ORIGINAL_ENV.apiKey === undefined) delete process.env[QWEN_KEY_ENV];
  else process.env[QWEN_KEY_ENV] = ORIGINAL_ENV.apiKey;
}

/**
 * Any network call at all is a failed test. Deliberately never cleared: one accumulated
 * record that this whole file stayed offline, including the shared run in beforeAll.
 */
const fetchSpy = vi.fn(() => {
  throw new Error("offline test: the research loop attempted a network call");
});

beforeEach(() => {
  applyEnv(undefined);
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
});

afterAll(restoreEnv);

interface Turn {
  events: ResearchEvent[];
  /** What runResearchTurn returned. Null when it threw, which is itself the failure. */
  stats: LoopStats | null;
  thrown: unknown;
}

async function runTurn(overrides: Partial<ResearchRequest> = {}): Promise<Turn> {
  const events: ResearchEvent[] = [];
  let stats: LoopStats | null = null;
  let thrown: unknown = null;
  try {
    stats = await runResearchTurn({
      question: QUESTION,
      symbol: "AAPL",
      emit: (event) => events.push(event),
      ...overrides,
    });
  } catch (err) {
    thrown = err;
  }
  return { events, stats, thrown };
}

/** Every event of one type, in arrival order. */
function pick<T extends ResearchEvent["type"]>(
  events: ResearchEvent[],
  type: T,
): Extract<ResearchEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ResearchEvent, { type: T }> => event.type === type);
}

/** The order a reader sees. Traces may interleave anywhere, so they are filtered out. */
function sequenceOf(events: ResearchEvent[]): string[] {
  return events.filter((event) => event.type !== "trace").map((event) => event.type);
}

/** The 14 fields memoSchema requires. The model writes the sentences; code writes the numbers. */
const MEMO_BODY_FIELDS = [
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
] as const;

/** The five fields code owns, which no prompt can talk the loop out of. */
const CODE_OWNED_FIELDS = ["aiSynthesis", "banner", "nonExecutionStatement", "signConvention", "usage"] as const;

/** A failure message that survives the test run: the Zod issues, verbatim. */
function parseDetail(parsed: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }): string {
  if (parsed.success) return "ok";
  return (parsed.error?.issues ?? [])
    .slice(0, 6)
    .map((issue) => (issue.path.length > 0 ? issue.path.join(".") + ": " : "") + issue.message)
    .join("; ");
}

describe("runResearchTurn with no BITGET_QWEN_API_KEY", () => {
  let deterministic: Turn | null = null;

  beforeAll(async () => {
    applyEnv(undefined);
    vi.stubGlobal("fetch", fetchSpy);
    deterministic = await runTurn();
  });

  /** The one keyless run every assertion in this block shares. */
  async function theRun(): Promise<Turn> {
    if (!deterministic) throw new Error("test bug: the keyless run never happened");
    return deterministic;
  }

  it("emits start -> evidence -> memo -> done and no error event", async () => {
    const run = await theRun();
    expect(run.thrown, "the loop returns failures as values; it never throws to its caller").toBeNull();
    expect(sequenceOf(run.events), "traces are allowed anywhere, so they are filtered out").toEqual([
      "start",
      "evidence",
      "memo",
      "done",
    ]);
    expect(pick(run.events, "error"), "there is no path that ends in an error when evidence exists").toEqual([]);
    expect(pick(run.events, "memo"), "exactly one memo").toHaveLength(1);
    expect(pick(run.events, "done"), "exactly one done").toHaveLength(1);
  });

  it("announces the run honestly before any narrative exists", async () => {
    const run = await theRun();
    const start = pick(run.events, "start").at(0);
    expect(start?.mode, "recorded fixtures are served only in fixture mode").toBe("fixture");
    expect(start?.symbol, "the symbol the caller resolved").toBe("AAPL");
    expect(start?.question, "the question asked").toBe(QUESTION);
    expect(start?.aiConfigured, "no key means start already says AI is not configured").toBe(false);
    expect(start?.budgetMs, "the budget is clamped to the platform limit in exactly one place").toBe(
      resolveResearchBudgetMs(),
    );
  });

  it("labels the memo as computed rather than generated", async () => {
    const run = await theRun();
    const memo = pick(run.events, "memo").at(-1)?.memo;
    expect(memo, "the loop always terminates in a memo event").toBeDefined();
    expect(memo?.aiSynthesis, "code wrote this memo and it must say so").toBe(false);
    expect(memo?.banner, "a computed memo is never presented as AI synthesis").not.toBeNull();
    expect(memo?.banner ?? "", "and the banner is the documented one").toContain(FALLBACK_BANNER);
    expect(memo?.nonExecutionStatement, "appended by code, so no prompt can remove it").toBe(NON_EXECUTION_STATEMENT);
    expect(memo?.signConvention, "restated so the headline number cannot be misread").toBe(BASIS_SIGN_CONVENTION);
    expect(memo?.usage, "no tokens were spent").toBeNull();
  });

  it("lets classifyVerdict choose the verdict, not the model", async () => {
    const run = await theRun();
    const memo = pick(run.events, "memo").at(-1)?.memo;
    const pack = pick(run.events, "evidence")
      .at(-1)
      ?.packs.find((candidate) => candidate.base === "AAPL");
    const basisPct = pack?.snapshot?.basisPct;
    expect(typeof basisPct, "the recorded AAPL fixture must produce a basis reading").toBe("number");
    expect(Number.isFinite(basisPct ?? Number.NaN), "and that reading must be finite").toBe(true);
    expect(memo?.verdict, "the verdict is a pure function of the computed basis").toBe(classifyVerdict(basisPct));
    expect(
      (MEMO_VERDICTS as readonly string[]).includes(memo?.verdict ?? ""),
      "the verdict comes from the controlled vocabulary",
    ).toBe(true);
  });

  it("produces a memo that satisfies memoSchema, so the UI renders identically with or without AI", async () => {
    const run = await theRun();
    const memo = pick(run.events, "memo").at(-1)?.memo;
    const body = Object.fromEntries(MEMO_BODY_FIELDS.map((field) => [field, memo?.[field]]));
    expect(parseDetail(memoSchema.safeParse(body)), "the computed fallback memo must be schema-valid").toBe("ok");
  });

  it("carries exactly the 14 schema fields plus the 5 code-owned fields", async () => {
    const run = await theRun();
    expect([...MEMO_BODY_FIELDS].sort(), "this test tracks memoSchema instead of drifting from it").toEqual(
      Object.keys(memoSchema.shape).sort(),
    );
    const memo = pick(run.events, "memo").at(-1)?.memo;
    expect(Object.keys(memo ?? {}).sort(), "the wire shape of a memo is fixed").toEqual(
      [...MEMO_BODY_FIELDS, ...CODE_OWNED_FIELDS].sort(),
    );
  });

  it("reports a deterministic run in done.stats and touches the network zero times", async () => {
    const run = await theRun();
    const stats = pick(run.events, "done").at(-1)?.stats;
    expect(stats, "the loop always closes with a done event").toBeDefined();
    expect(stats?.aiSynthesis, "no model wrote this").toBe(false);
    expect(stats?.model, "no model was configured").toBeNull();
    expect(stats?.turns, "zero model round trips").toBe(0);
    expect(stats?.toolCalls, "zero tool calls").toBe(0);
    expect(stats?.usage, "zero tokens billed").toBeNull();
    expect(typeof stats?.fallbackReason, "the reason is published, never hidden").toBe("string");
    expect(stats?.fallbackReason ?? "", "and it names the missing key").toMatch(/BITGET_QWEN_API_KEY/);
    expect(stats?.latencyMs ?? -1, "latency is measured, not guessed").toBeGreaterThanOrEqual(0);
    expect(stats?.budgetMs ?? 0, "the budget is published next to the spend").toBeGreaterThan(0);
    const traceKinds = pick(run.events, "trace").map((event) => event.entry.kind);
    expect(
      traceKinds.every((kind) => kind === "note"),
      "without a model there is no reasoning and no tool traffic to trace",
    ).toBe(true);
    expect(fetchSpy, "the deterministic path makes no network call at all").not.toHaveBeenCalled();
    expect(run.stats?.aiSynthesis, "the returned stats agree with the emitted ones").toBe(stats?.aiSynthesis);
    expect(run.stats?.turns, "turns").toBe(stats?.turns);
    expect(run.stats?.toolCalls, "toolCalls").toBe(stats?.toolCalls);
    expect(run.stats?.fallbackReason, "fallbackReason").toBe(stats?.fallbackReason);
  });

  it("publishes a renderable AAPL pack before the memo", async () => {
    const run = await theRun();
    const packs = pick(run.events, "evidence").at(-1)?.packs ?? [];
    expect(packs.length, "the final evidence event carries at least one pack").toBeGreaterThan(0);
    const pack = packs.find((candidate) => candidate.base === "AAPL");
    expect(pack, "the requested symbol is the one published").toBeDefined();
    expect(pack?.mode, "and it says it came from the recorded corpus").toBe("fixture");
    expect(pack?.series.length ?? 0, "the chart has something to draw").toBeGreaterThan(0);
    expect(pack?.series.length ?? 0, "thinned for the wire").toBeLessThanOrEqual(MAX_CHART_POINTS);
    // The recorded AAPL window is ~930 matched hours. Asserted as a floor rather than
    // pinned, so re-recording the fixtures does not break this test.
    expect(pack?.observationWindow?.n ?? 0, "the window published is the full recorded sample").toBeGreaterThan(500);
    expect(pack?.series.at(0)?.ts, "thinning keeps the real window start").toBe(pack?.observationWindow?.fromTs);
    expect(pack?.series.at(-1)?.ts, "thinning keeps the real window end").toBe(pack?.observationWindow?.toTs);
    expect(
      packs.filter((candidate) => candidate.base === "AAPL"),
      "one pack per base symbol",
    ).toHaveLength(1);
  });
});

describe("loop invariants", () => {
  it("exports the three brakes at their documented values", () => {
    expect(MAX_TURNS, "model round trips per research turn").toBe(5);
    expect(MAX_PROSE_NUDGES, "one nudge when the model answers in prose instead of calling emit_memo").toBe(1);
    expect(MAX_MEMO_REPAIRS, "one schema repair pass, per DECISION.md 7.3").toBe(1);
  });
});

describe("disableAi with a key configured", () => {
  it("still takes the deterministic path - the switch, not the missing key, is the brake", async () => {
    applyEnv("test-key-not-real");
    const run = await runTurn({ disableAi: true });

    expect(run.thrown, "the loop returns failures as values").toBeNull();
    expect(fetchSpy, "a switched-off run must never dial the Qwen gateway").not.toHaveBeenCalled();
    expect(sequenceOf(run.events), "identical event order to the keyless run").toEqual([
      "start",
      "evidence",
      "memo",
      "done",
    ]);
    expect(pick(run.events, "start").at(0)?.aiConfigured, "aiConfigured describes THIS run, not the deployment").toBe(
      false,
    );

    const stats = pick(run.events, "done").at(-1)?.stats;
    expect(stats?.aiSynthesis, "no AI synthesis happened").toBe(false);
    expect(stats?.model, "no model is named for a run that never called one").toBeNull();
    expect(stats?.turns, "zero round trips").toBe(0);
    expect(stats?.toolCalls, "zero tool calls").toBe(0);
    expect(stats?.fallbackReason ?? "", "the reason says AI was switched off").toMatch(/switched off/i);

    const memo = pick(run.events, "memo").at(-1)?.memo;
    expect(memo?.aiSynthesis, "the memo agrees with the stats").toBe(false);
    expect(memo?.banner ?? "", "and it is banner-labelled as computed").toContain(FALLBACK_BANNER);
    expect(memo?.nonExecutionStatement, "the human-decision boundary survives the switch").toBe(NON_EXECUTION_STATEMENT);
    const body = Object.fromEntries(MEMO_BODY_FIELDS.map((field) => [field, memo?.[field]]));
    expect(parseDetail(memoSchema.safeParse(body)), "the switched-off memo is schema-valid too").toBe("ok");
  });
});

describe("a symbol that cannot be resolved", () => {
  it("emits error and done, and does not throw", async () => {
    const run = await runTurn({ symbol: "ZZZZNOTREAL" });

    expect(run.thrown, "an unresolvable symbol is a value, never an exception").toBeNull();
    expect(sequenceOf(run.events), "no evidence means no memo, but the stream still closes").toEqual([
      "start",
      "error",
      "done",
    ]);

    const error = pick(run.events, "error").at(0);
    expect(error?.kind, "callers switch on kind, never on message text").toBe("unknown_symbol");
    expect(error?.message ?? "", "the message names the symbol it could not resolve").toContain("ZZZZNOTREAL");
    expect(pick(run.events, "memo"), "no memo is invented without evidence").toEqual([]);

    const stats = pick(run.events, "done").at(-1)?.stats;
    expect(stats?.aiSynthesis, "nothing was synthesised").toBe(false);
    expect(typeof stats?.fallbackReason, "done still explains why the run ended").toBe("string");
    expect(stats?.fallbackReason ?? "", "and it names the symbol").toContain("ZZZZNOTREAL");
    expect(fetchSpy, "an unknown symbol must not provoke a network call either").not.toHaveBeenCalled();
  });
});