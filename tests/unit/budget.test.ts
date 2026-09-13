/**
 * The serverless budget is the one number in this project that can silently lie: it is
 * declared twice (a literal `maxDuration` in the route, because Next.js statically
 * analyses segment config and rejects an imported identifier, and FUNCTION_MAX_DURATION_S
 * in lib/config.ts, which resolveResearchBudgetMs() clamps against). If they drift, the
 * loop is given more time than the platform allows and the memo is killed mid-stream.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUDGET_RESERVE_MS,
  FUNCTION_MAX_DURATION_S,
  FUNCTION_TEARDOWN_S,
  MAX_TOOL_CALLS,
  resolveResearchBudgetMs,
} from "@/lib/config";

const ROUTE = "app/api/research/route.ts";

/** ProcessEnv has no index signature, so a literal object needs this one cast. */
const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe("the route's declared maxDuration", () => {
  const src = readFileSync(join(process.cwd(), ROUTE), "utf8");
  const match = src.match(/export const maxDuration\s*=\s*(\d+)\s*;/);

  it("is a literal, because Next.js rejects an imported identifier here", () => {
    expect(match, "no `export const maxDuration = <literal>` found in " + ROUTE).not.toBeNull();
  });

  it("matches FUNCTION_MAX_DURATION_S, so the clamp and the platform agree", () => {
    expect(Number(match?.[1])).toBe(FUNCTION_MAX_DURATION_S);
  });

  it("stays inside the Vercel Hobby ceiling of 60s", () => {
    expect(FUNCTION_MAX_DURATION_S).toBeLessThanOrEqual(60);
  });
});

describe("resolveResearchBudgetMs", () => {
  it("clamps a 90s request to the platform limit minus teardown", () => {
    expect(resolveResearchBudgetMs(env({ RESEARCH_TIMEOUT_MS: "90000" }))).toBe(
      (FUNCTION_MAX_DURATION_S - FUNCTION_TEARDOWN_S) * 1000,
    );
  });

  it("honours a request that already fits", () => {
    expect(resolveResearchBudgetMs(env({ RESEARCH_TIMEOUT_MS: "20000" }))).toBe(20000);
  });

  it("never returns less than 15s, or the fallback memo could not be emitted", () => {
    expect(resolveResearchBudgetMs(env({ RESEARCH_TIMEOUT_MS: "1" }))).toBeGreaterThanOrEqual(15000);
  });

  it("leaves room for the fallback memo after the soft deadline", () => {
    const budget = resolveResearchBudgetMs(env({ RESEARCH_TIMEOUT_MS: "90000" }));
    expect(BUDGET_RESERVE_MS).toBeGreaterThan(0);
    expect(BUDGET_RESERVE_MS).toBeLessThan(budget);
  });

  it("falls back to RESEARCH_TIMEOUT_MS when the env is unset", () => {
    expect(resolveResearchBudgetMs(env({}))).toBe((FUNCTION_MAX_DURATION_S - FUNCTION_TEARDOWN_S) * 1000);
  });
});

describe("the tool-call budget", () => {
  it("is small enough that a looping model cannot spend the whole function", () => {
    expect(MAX_TOOL_CALLS).toBeLessThanOrEqual(8);
    expect(MAX_TOOL_CALLS).toBeGreaterThanOrEqual(4);
  });
});