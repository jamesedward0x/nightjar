/**
 * The bounded research loop. This is the thing that makes Nightjar an investigation
 * rather than a chatbot: it gathers evidence, spends a hard budget doing so, and always
 * terminates in a structured memo - written by Qwen when Qwen cooperates, written by code
 * when it does not.
 *
 * The order of operations is deliberate:
 *
 *   1. Gather the evidence pack for the target symbol FIRST, before any model call, and
 *      push it to the client. Numbers appear on screen in ~2-4s while the model is still
 *      thinking, and the deterministic fallback memo always has data to stand on.
 *   2. Stream the model turn. Reasoning deltas are forwarded (batched) so the UI can show
 *      the desk working.
 *   3. Execute tool calls through lib/llm/tools.ts, which projects the cached pack. A
 *      repeated symbol never re-fetches.
 *   4. Require emit_memo. Validate it. Repair exactly once. Then fall back.
 *
 * Three independent brakes, all enforced here: MAX_TOOL_CALLS, MAX_TURNS and the
 * wall-clock budget from resolveResearchBudgetMs(). The clock reserves
 * BUDGET_RESERVE_MS at the end so there is always time left to emit the fallback memo
 * instead of being killed mid-sentence by the platform.
 *
 * Failure is a value. Nothing in this file throws to the caller: a dead gateway, an
 * expired budget or a client disconnect all end in a memo plus a done event.
 */

import { BUDGET_RESERVE_MS, MAX_TOOL_CALLS, resolveMode, resolveResearchBudgetMs } from "@/lib/config";
import { createLogger, errMessage, newRequestId } from "@/lib/observability/logger";
import { gatherEvidence, type EvidencePack } from "@/lib/research/evidence";
import { projectPacks } from "@/lib/research/payload";
import type { ClientPack, LoopStats, ResearchEvent, TraceEntry } from "@/lib/research/contract";
import {
  createResponse,
  streamResponse,
  resolveQwenConfig,
  type QwenConfig,
  type QwenFunctionCall,
  type QwenInputItem,
  type QwenMessage,
  type QwenResult,
} from "@/lib/llm/qwen";
import {
  MEMO_TOOL_NAME,
  RESEARCH_TOOLS,
  createToolContext,
  executeTool,
  summariseContext,
  type ToolContext,
} from "@/lib/llm/tools";
import {
  buildFallbackMemo,
  finaliseMemo,
  repairInstruction,
  validateMemoArguments,
  type ResearchMemo,
} from "@/lib/llm/memo";
import { PROSE_NUDGE, buildInstructions, buildUserMessage, defaultPromptContext } from "@/lib/llm/prompts";

const log = createLogger("llm.loop");

/** Model round-trips. Tool calls are capped separately; the wall clock caps everything. */
export const MAX_TURNS = 5;
/** One nudge when the model answers in prose instead of calling emit_memo. */
export const MAX_PROSE_NUDGES = 1;
/** One repair pass on a schema-invalid memo, per DECISION.md 7.3. */
export const MAX_MEMO_REPAIRS = 1;

/** Forward reasoning in readable chunks rather than one SSE frame per token. */
const REASONING_FLUSH_CHARS = 160;
const REASONING_FLUSH_MS = 900;

export interface ResearchRequest {
  question: string;
  /** Resolved dual-listed base symbol, e.g. "AAPL". The caller resolves it, not us. */
  symbol: string;
  emit: (event: ResearchEvent) => void;
  requestId?: string;
  budgetMs?: number;
  /** Client disconnect. Aborts in-flight gateway and upstream work. */
  signal?: AbortSignal;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function addUsage(total: Usage, delta: QwenResult["usage"]): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.reasoningTokens += delta.reasoningTokens;
}

/** Parse tool arguments for the trace panel only. Never throws, never trusted. */
function traceArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: String(raw).slice(0, 200) };
  } catch {
    return { unparsed: String(raw).slice(0, 200) };
  }
}

/**
 * Stream-first gateway call. Streaming is what keeps a 25s reasoning turn from feeling
 * dead, but if the stream path fails for any non-abort reason we retry the same turn
 * non-streaming rather than losing it - the probe showed both surfaces answer.
 */
async function callQwen(
  config: QwenConfig,
  instructions: string,
  input: QwenInputItem[],
  signal: AbortSignal,
  onReasoning: (delta: string) => void,
): Promise<QwenResult> {
  const options = {
    config,
    instructions,
    input,
    tools: RESEARCH_TOOLS,
    signal,
    maxOutputTokens: config.maxOutputTokens,
  };
  try {
    return await streamResponse(options, { onReasoningDelta: onReasoning });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    log.warn("loop.stream_failed_retrying_unstreamed", { message: errMessage(err) });
    return await createResponse(options);
  }
}

/** The pack a fallback memo should be built from: the requested symbol if we have it. */
function memoPack(ctx: ToolContext, symbol: string, preFetched: EvidencePack | null): EvidencePack | null {
  return ctx.packs.get(symbol.trim().toUpperCase()) ?? summariseContext(ctx)[0] ?? preFetched;
}

export async function runResearchTurn(request: ResearchRequest): Promise<LoopStats> {
  const startedAt = Date.now();
  const requestId = request.requestId ?? newRequestId();
  const mode = resolveMode();
  const budgetMs = request.budgetMs ?? resolveResearchBudgetMs();
  const maxToolCalls = Number(process.env.MAX_TOOL_CALLS) || MAX_TOOL_CALLS;
  const softDeadline = startedAt + Math.max(5_000, budgetMs - BUDGET_RESERVE_MS);
  const promptCtx = defaultPromptContext(mode);
  const qwen = resolveQwenConfig();

  const controller = new AbortController();
  let timedOut = false;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
  const onOuterAbort = (): void => controller.abort();
  request.signal?.addEventListener("abort", onOuterAbort);

  let seq = 0;
  const emit = request.emit;
  const trace = (entry: Omit<TraceEntry, "seq" | "at">): void => {
    emit({ type: "trace", entry: { ...entry, seq: seq, at: Date.now() } });
    seq += 1;
  };

  const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let turns = 0;
  let toolCalls = 0;
  let memo: ResearchMemo | null = null;
  let fallbackReason: string | null = null;
  let packs: ClientPack[] = [];

  const stats = (): LoopStats => ({
    aiSynthesis: memo?.aiSynthesis === true,
    fallbackReason,
    turns,
    toolCalls,
    latencyMs: Date.now() - startedAt,
    budgetMs,
    usage: usage.outputTokens > 0 || usage.inputTokens > 0 ? usage : null,
    model: qwen ? qwen.model : null,
  });

  emit({
    type: "start",
    requestId,
    question: request.question,
    symbol: request.symbol,
    mode,
    budgetMs,
    aiConfigured: qwen !== null,
  });

  const ctx: ToolContext = createToolContext(
    startedAt,
    () => timedOut || controller.signal.aborted || Date.now() > softDeadline,
  );

  const publishEvidence = (): void => {
    packs = projectPacks(summariseContext(ctx));
    emit({ type: "evidence", packs });
  };

  try {
    // --- 1. evidence before narrative -------------------------------------
    const pre = await gatherEvidence(request.symbol, { now: startedAt });
    let preFetched: EvidencePack | null = null;
    if (pre.ok) {
      preFetched = pre.pack;
      ctx.packs.set(pre.pack.base.toUpperCase(), pre.pack);
      publishEvidence();
    } else {
      // No data means no research. Report it honestly and stop; the UI shows the gap.
      log.error("loop.no_evidence", { symbol: request.symbol, kind: pre.kind });
      emit({ type: "error", kind: pre.kind, message: pre.message, hint: pre.hint });
      fallbackReason = "no evidence could be gathered for " + request.symbol;
      emit({ type: "done", stats: stats() });
      return stats();
    }

    // --- 2. no key: the deterministic memo is the product, not a stub -------
    if (!qwen) {
      fallbackReason = "BITGET_QWEN_API_KEY is not configured on this deployment.";
      memo = buildFallbackMemo(preFetched, fallbackReason);
      trace({ kind: "note", text: "AI synthesis disabled - emitting the computed memo." });
      emit({ type: "memo", memo });
      emit({ type: "done", stats: stats() });
      return stats();
    }

    // --- 3. the loop -------------------------------------------------------
    const instructions = buildInstructions(promptCtx);
    const input: QwenInputItem[] = [{ role: "user", content: buildUserMessage(request.question, promptCtx) }];

    let reasoningBuffer = "";
    let lastReasoningFlush = Date.now();
    const flushReasoning = (): void => {
      const text = reasoningBuffer.trim();
      reasoningBuffer = "";
      lastReasoningFlush = Date.now();
      if (text) trace({ kind: "reasoning", text });
    };
    const onReasoning = (delta: string): void => {
      reasoningBuffer += delta;
      if (reasoningBuffer.length >= REASONING_FLUSH_CHARS || Date.now() - lastReasoningFlush >= REASONING_FLUSH_MS) {
        flushReasoning();
      }
    };

    let nudges = 0;
    let repairs = 0;

    while (!memo && !fallbackReason && turns < MAX_TURNS && !ctx.isAborted()) {
      turns += 1;
      let result: QwenResult;
      try {
        result = await callQwen(qwen, instructions, input, controller.signal, onReasoning);
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || timedOut) {
          fallbackReason = "the " + Math.round(budgetMs / 1000) + "s research budget expired mid-turn";
        } else {
          fallbackReason = "Qwen gateway call failed: " + errMessage(err);
          log.warn("loop.qwen_failed", { turn: turns, message: errMessage(err) });
        }
        break;
      }
      flushReasoning();
      addUsage(usage, result.usage);

      const calls = result.output.filter((item): item is QwenFunctionCall => item.type === "function_call");
      const prose = result.output
        .filter((item): item is QwenMessage => item.type === "message")
        .map((item) => item.text)
        .join("\n")
        .trim();

      if (calls.length === 0) {
        if (nudges >= MAX_PROSE_NUDGES) {
          fallbackReason = "the model answered in prose instead of calling emit_memo";
          break;
        }
        nudges += 1;
        trace({ kind: "note", text: "Prose answer rejected - forcing a structured memo." });
        if (prose) input.push({ role: "assistant", content: prose.slice(0, 2000) });
        input.push({ role: "user", content: PROSE_NUDGE });
        continue;
      }

      // The transcript must carry every call we answer, in order, before the outputs.
      for (const call of calls) {
        input.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments });
      }

      for (const call of calls) {
        if (call.name === MEMO_TOOL_NAME) {
          const validation = validateMemoArguments(call.arguments);
          if (validation.ok) {
            memo = finaliseMemo(validation.body, usage);
            input.push({ type: "function_call_output", call_id: call.callId, output: '{"accepted":true}' });
            continue;
          }
          if (repairs >= MAX_MEMO_REPAIRS) {
            fallbackReason = "emit_memo failed schema validation twice: " + validation.issues;
            input.push({
              type: "function_call_output",
              call_id: call.callId,
              output: JSON.stringify({ accepted: false, errors: validation.issues }),
            });
            continue;
          }
          repairs += 1;
          trace({ kind: "note", text: "Memo failed validation - one repair pass: " + validation.issues.slice(0, 240) });
          input.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({ accepted: false, errors: validation.issues, repair: repairInstruction(validation.issues) }),
          });
          continue;
        }

        if (toolCalls >= maxToolCalls) {
          trace({ kind: "note", text: "Tool budget exhausted at " + maxToolCalls + " calls." });
          input.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({
              error: "tool budget exhausted",
              instruction: "Call emit_memo now using only the evidence you already received.",
            }),
          });
          continue;
        }

        toolCalls += 1;
        trace({
          kind: "tool_call",
          tool: call.name,
          args: traceArgs(call.arguments),
          remaining: maxToolCalls - toolCalls,
          symbol: null,
        });
        const execution = await executeTool(ctx, call.name, call.arguments);
        trace({
          kind: "tool_result",
          tool: execution.tool,
          ok: execution.ok,
          latencyMs: execution.latencyMs,
          chars: execution.output.length,
          symbol: execution.symbol,
          fetchedPack: execution.fetchedPack,
        });
        input.push({ type: "function_call_output", call_id: call.callId, output: execution.output });
        // Progressive rendering: a new symbol's numbers appear the moment they exist.
        if (execution.fetchedPack) publishEvidence();
        if (ctx.isAborted()) {
          fallbackReason = timedOut
            ? "the " + Math.round(budgetMs / 1000) + "s research budget expired during tool execution"
            : "the research turn was cancelled";
          break;
        }
      }
    }

    if (!memo && !fallbackReason && turns >= MAX_TURNS) {
      fallbackReason = "reached the " + MAX_TURNS + "-turn limit without a valid emit_memo call";
    }
    if (!memo && !fallbackReason && ctx.isAborted()) {
      fallbackReason = timedOut
        ? "the " + Math.round(budgetMs / 1000) + "s research budget expired"
        : "the research turn was cancelled";
    }

    // --- 4. always terminate in a memo --------------------------------------
    if (!memo) {
      const pack = memoPack(ctx, request.symbol, preFetched);
      if (!pack) {
        emit({
          type: "error",
          kind: "no_evidence",
          message: "No evidence pack was available to build a memo from.",
          hint: "Check /api/health for the failing Bitget source.",
        });
      } else {
        memo = buildFallbackMemo(pack, fallbackReason ?? "unknown reason");
      }
    }
    if (memo) emit({ type: "memo", memo });
    publishEvidence();
    log.info("loop.finished", {
      requestId,
      ai: memo?.aiSynthesis === true,
      turns,
      toolCalls,
      latencyMs: Date.now() - startedAt,
      reason: fallbackReason,
    });
    emit({ type: "done", stats: stats() });
    return stats();
  } catch (err) {
    // Should be unreachable: every helper here returns failures as values. If it does
    // happen, degrade to the computed memo rather than dropping the stream.
    const message = errMessage(err);
    log.error("loop.unexpected", { requestId, message });
    const pack = memoPack(ctx, request.symbol, null);
    fallbackReason = "internal error in the research loop: " + message;
    if (pack) {
      memo = buildFallbackMemo(pack, fallbackReason);
      emit({ type: "memo", memo });
    } else {
      emit({ type: "error", kind: "internal", message });
    }
    publishEvidence();
    emit({ type: "done", stats: stats() });
    return stats();
  } finally {
    clearTimeout(hardTimer);
    request.signal?.removeEventListener("abort", onOuterAbort);
  }
}