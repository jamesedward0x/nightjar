/**
 * The wire contract between the research loop, the SSE route and the browser.
 *
 * This file is TYPE-ONLY plus tiny pure constants, so the client bundle can import it
 * without pulling zod, the Bitget client or the LLM code across the boundary. Every
 * `import type` here is erased at build time - keep it that way.
 *
 * Event order for a successful run:
 *   start -> evidence -> reasoning* / tool_call / tool_result (interleaved)
 *         -> evidence -> memo -> done
 * A run that cannot reach Qwen still emits start -> evidence -> memo -> done, with
 * memo.aiSynthesis=false. There is no path that ends without a memo or an error.
 */

import type { ResearchMemo } from "@/lib/llm/memo";
import type { EvidencePack } from "@/lib/research/evidence";
import type { BasisPoint } from "@/lib/compute/types";
import type { RuntimeMode } from "@/lib/config";

/** The pack minus the two fields the UI never renders, with the series downsampled. */
export type ClientPack = Omit<EvidencePack, "premium" | "series"> & {
  series: BasisPoint[];
};

export interface LoopStats {
  /** True only when Qwen produced and passed schema validation for the memo. */
  aiSynthesis: boolean;
  /** Why code wrote the memo instead. Null when aiSynthesis is true. */
  fallbackReason: string | null;
  turns: number;
  toolCalls: number;
  latencyMs: number;
  budgetMs: number;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
  model: string | null;
}

export interface TraceEntry {
  /** Sequence number, so the client can render in arrival order. */
  seq: number;
  at: number;
  kind: "reasoning" | "tool_call" | "tool_result" | "note";
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  latencyMs?: number;
  chars?: number;
  symbol?: string | null;
  fetchedPack?: boolean;
  remaining?: number;
}

export type ResearchEvent =
  | { type: "start"; requestId: string; question: string; symbol: string; mode: RuntimeMode; budgetMs: number; aiConfigured: boolean }
  | { type: "evidence"; packs: ClientPack[] }
  | { type: "trace"; entry: TraceEntry }
  | { type: "memo"; memo: ResearchMemo }
  | { type: "done"; stats: LoopStats }
  | { type: "error"; kind: string; message: string; hint?: string };

export const RESEARCH_EVENT_TYPES = ["start", "evidence", "trace", "memo", "done", "error"] as const;