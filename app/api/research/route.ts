/**
 * POST /api/research - the research turn, streamed as Server-Sent Events.
 *
 * POST rather than GET because EventSource cannot carry a body and a question does not
 * belong in a URL. The browser reads the stream with fetch() and a manual SSE parser
 * (components/workbench.tsx), which also lets us abort it on unmount.
 *
 * Three platform facts shape this file:
 *   - maxDuration must equal the budget the loop is given. resolveResearchBudgetMs()
 *     clamps RESEARCH_TIMEOUT_MS to (maxDuration - teardown), so a Hobby 60s function
 *     gets a 55s research budget rather than being killed mid-memo.
 *   - Buffering: no-transform plus x-accel-buffering:no, and a 15s comment heartbeat,
 *     because a reasoning turn can be silent for 25s and an idle proxy will hang up.
 *   - force-dynamic: a research turn must never be cached or statically prerendered.
 *
 * The route owns transport only. Every research decision lives in lib/llm/loop.ts, so
 * the same loop is unit-testable without HTTP.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveResearchBudgetMs } from "@/lib/config";
import { getUniverse, matchPair } from "@/lib/bitget/universe";
import { runResearchTurn } from "@/lib/llm/loop";
import type { ResearchEvent } from "@/lib/research/contract";
import { createLogger, errMessage } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Must stay a literal: Next.js statically analyses segment config and rejects an
 * imported identifier. tests/unit/budget.test.ts asserts it equals
 * FUNCTION_MAX_DURATION_S, which is what resolveResearchBudgetMs() clamps against.
 */
export const maxDuration = 60;

const log = createLogger("api.research");

/** Heartbeat interval. Must be well under any proxy idle timeout. */
const HEARTBEAT_MS = 15_000;

const requestSchema = z.object({
  question: z.string().min(3).max(600),
  symbol: z.string().min(1).max(24).optional(),
});

type Resolved = { ok: true; symbol: string; matched: boolean } | { ok: false; message: string; hint?: string };

/** Candidate tickers in a free-text question, longest first so RAAPL beats AAPL. */
function tickerCandidates(question: string): string[] {
  const found = question.toUpperCase().match(/[A-Z]{1,6}/g) ?? [];
  return Array.from(new Set(found)).sort((a, b) => b.length - a.length);
}

/**
 * Resolve the name under investigation. An explicit symbol must match the universe;
 * a bare question falls back to scanning the text, then to the first dual-listed pair,
 * so the desk always has something real to research rather than asking a follow-up.
 */
async function resolveSymbol(question: string, explicit: string | null): Promise<Resolved> {
  const universeResult = await getUniverse();
  if (!universeResult.ok) {
    return {
      ok: false,
      message: "The tradable universe could not be loaded, so no symbol can be resolved.",
      hint: universeResult.error.hint ?? "Check /api/health for the failing Bitget source.",
    };
  }
  const universe = universeResult.data;
  const candidates = explicit ? [explicit] : tickerCandidates(question);
  for (const candidate of candidates) {
    const pair = matchPair(universe, candidate);
    if (pair) return { ok: true, symbol: pair.base, matched: true };
  }
  if (explicit) {
    return {
      ok: false,
      message: explicit + " is not a dual-listed tokenized equity on Bitget.",
      hint: "Nightjar needs both an rToken spot market and the USDT perpetual that references it.",
    };
  }
  const first = universe.pairs[0];
  if (!first) return { ok: false, message: "Bitget reports no dual-listed rToken/perp pairs right now." };
  return { ok: true, symbol: first.base, matched: false };
}

function badRequest(message: string, status: number, hint?: string): NextResponse {
  return NextResponse.json({ error: message, hint }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request): Promise<Response | NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Request body must be JSON: { question: string, symbol?: string }.", 400);
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest("Invalid request: " + parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; "), 400);
  }

  const question = parsed.data.question.trim();
  const explicit = parsed.data.symbol?.trim() || null;
  const resolved = await resolveSymbol(question, explicit);
  if (!resolved.ok) {
    log.warn("research.symbol_unresolved", { explicit, message: resolved.message });
    return badRequest(resolved.message, 422, resolved.hint);
  }

  const budgetMs = resolveResearchBudgetMs();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(sink) {
      let closed = false;
      const write = (frame: string): void => {
        if (closed) return;
        try {
          sink.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };
      const send = (event: ResearchEvent): void => {
        write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
      };
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
      // Flush headers immediately so the browser can start reading before turn one.
      write(": open\n\n");

      try {
        await runResearchTurn({
          question,
          symbol: resolved.symbol,
          budgetMs,
          emit: send,
          signal: request.signal,
        });
      } catch (err) {
        const message = errMessage(err);
        log.error("research.unhandled", { message });
        send({ type: "error", kind: "internal", message });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          try {
            sink.close();
          } catch {
            /* already closed by a client disconnect */
          }
          closed = true;
        }
      }
    },
    cancel() {
      log.info("research.client_disconnected", { symbol: resolved.symbol });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": resolved.symbol,
    },
  });
}