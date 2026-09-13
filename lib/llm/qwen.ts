/**
 * The Bitget Qwen gateway client.
 *
 * Everything here is written against behaviour we PROBED, not behaviour the docs
 * promise (scripts/probe-qwen.mjs, results in scripts/qwen-probe-result.json):
 *
 *   - POST /v1/responses works. It is the only surface verified for tool calling.
 *   - Tools use the FLAT schema {type:"function", name, description, parameters}.
 *     The nested {type:"function", function:{...}} Chat-Completions shape does not apply.
 *   - tool_choice:"required" and named-object forms return HTTP 400:
 *     "does not support being set to required or object in thinking mode".
 *     So we use "auto" plus a hard system-prompt instruction to call emit_memo.
 *   - It is a reasoning model: on one probe, 29 of 34 output tokens were reasoning.
 *     reasoning.effort is accepted but had no measurable effect, so latency is planned
 *     around streaming, never around effort.
 *   - Observed latency is 3-25s per call. Hence max_output_tokens >= 2000 (reasoning
 *     counts against it) and a hard wall-clock budget in the loop.
 *   - store:false on every call: no server-side retention of our prompts.
 *
 * The API key is read once, never logged, never returned to a client.
 */

import { ConfigError, NetworkError, NightjarError } from "@/lib/bitget/errors";
import { QWEN_GATEWAY_BASE } from "@/lib/config";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger("llm.qwen");

export const DEFAULT_QWEN_MODEL = "qwen3.8-max";
/** Reasoning tokens count against this, so a memo step needs real headroom. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

export interface QwenConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxOutputTokens: number;
  /**
   * Whether to run the model in thinking mode. MEASURED on the gateway with an identical
   * emit_memo tool call:
   *
   *   enable_thinking:false ->  3.9s,  134 output tokens,   0 reasoning tokens
   *   enable_thinking:true  -> 34.5s, 1195 output tokens, 438 reasoning tokens
   *
   * Nearly 9x. And the reasoning buys nothing here: every number in the memo is computed by
   * deterministic code and handed to the model pre-validated, so there is no arithmetic left
   * for it to reason its way to. A live Vercel run with thinking ON burned the entire 55s
   * budget on ~2000 reasoning tokens re-verifying those numbers and was killed one sentence
   * before it emitted the memo.
   *
   * `reasoning.effort` is NOT a substitute: it is accepted but measured to change nothing
   * (11 vs 11 vs 17 reasoning tokens for low / minimal / absent). `enable_thinking` is the
   * only knob that works. Env: QWEN_ENABLE_THINKING.
   */
  thinking: boolean;
  /** Sent as `reasoning.effort` only when thinking is on. Empty omits the field. */
  reasoningEffort: string;
}

/** Returns null when no key is configured - the caller must fall back, not crash. */
export function resolveQwenConfig(env: NodeJS.ProcessEnv = process.env): QwenConfig | null {
  const apiKey = env.BITGET_QWEN_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: (env.QWEN_BASE_URL?.trim() || QWEN_GATEWAY_BASE).replace(/\/+$/, ""),
    model: env.QWEN_MODEL?.trim() || DEFAULT_QWEN_MODEL,
    apiKey,
    maxOutputTokens: Number(env.QWEN_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS,
    thinking: resolveEnableThinking(env.QWEN_ENABLE_THINKING),
    reasoningEffort: resolveReasoningEffort(env.QWEN_REASONING_EFFORT) || DEFAULT_REASONING_EFFORT,
  };
}

/** "off" and "" both mean: do not send the field at all. */
export function resolveReasoningEffort(raw: string | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off" || value === "none") return "";
  return value;
}

export const DEFAULT_REASONING_EFFORT = "low";

/** Off by default, for the measured 9x latency difference documented on QwenConfig.thinking. */
export const DEFAULT_ENABLE_THINKING = false;

export function resolveEnableThinking(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return DEFAULT_ENABLE_THINKING;
  return value === "true" || value === "1" || value === "on" || value === "yes";
}

/** The flat tool schema the gateway actually accepts. */
export interface QwenTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface QwenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface QwenFunctionCall {
  type: "function_call";
  callId: string;
  name: string;
  /** Raw JSON text. Parsing and validating it is the caller's job, never ours. */
  arguments: string;
}

export interface QwenMessage {
  type: "message";
  role: string;
  text: string;
}

export interface QwenReasoning {
  type: "reasoning";
  text: string;
}

export type QwenOutput = QwenFunctionCall | QwenMessage | QwenReasoning;

export interface QwenResult {
  id: string | null;
  status: string;
  output: QwenOutput[];
  usage: QwenUsage;
  latencyMs: number;
}

export type QwenInputItem =
  | { role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface CreateResponseOptions {
  config: QwenConfig;
  instructions: string;
  input: QwenInputItem[] | string;
  tools?: QwenTool[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

function parseUsage(raw: unknown): QwenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const details = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(details.reasoning_tokens),
    totalTokens: num(u.total_tokens),
  };
}

/**
 * Normalise the gateway's output array into the three shapes we care about.
 * Unknown item types are dropped rather than guessed at.
 */
function parseOutput(raw: unknown): QwenOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: QwenOutput[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const type = item?.type;
    if (type === "function_call") {
      out.push({
        type: "function_call",
        callId: String(item.call_id ?? item.id ?? ""),
        name: String(item.name ?? ""),
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? "{}"),
      });
    } else if (type === "reasoning") {
      const summary = Array.isArray(item.summary) ? (item.summary as Record<string, unknown>[]) : [];
      const text = summary.map((s) => String(s?.text ?? "")).filter(Boolean).join("\n");
      if (text) out.push({ type: "reasoning", text });
    } else if (type === "message") {
      const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
      const text = content
        .map((c) => String(c?.text ?? ""))
        .filter(Boolean)
        .join("");
      if (text) out.push({ type: "message", role: String(item.role ?? "assistant"), text });
    }
  }
  return out;
}

function headers(config: QwenConfig): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: "Bearer " + config.apiKey,
    accept: "text/event-stream, application/json",
  };
}

function body(config: QwenConfig, options: CreateResponseOptions, stream: boolean): string {
  const payload: Record<string, unknown> = {
    model: config.model,
    input: options.input,
    instructions: options.instructions,
    store: false,
    stream,
    max_output_tokens: options.maxOutputTokens ?? config.maxOutputTokens,
  };
  payload.enable_thinking = config.thinking;
  if (config.thinking && config.reasoningEffort) payload.reasoning = { effort: config.reasoningEffort };
  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
    // NEVER "required" or an object: the gateway 400s in thinking mode. Probed, not assumed.
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = true;
  }
  return JSON.stringify(payload);
}

export class QwenHttpError extends NightjarError {
  readonly status: number;
  constructor(status: number, message: string) {
    super("qwen_http_" + status, message);
    this.name = "QwenHttpError";
    this.status = status;
  }
}

/** Non-streaming call. The shape verified end-to-end by the probe. */
export async function createResponse(options: CreateResponseOptions): Promise<QwenResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(options.config.baseUrl + "/responses", {
      method: "POST",
      headers: headers(options.config),
      body: body(options.config, options, false),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new NetworkError("Qwen gateway unreachable: " + ((err as Error)?.message ?? "unknown"));
  }
  const text = await res.text();
  if (!res.ok) {
    // Never include the request body in the error: it can contain the key's neighbours.
    throw new QwenHttpError(res.status, "Qwen gateway returned HTTP " + res.status + ": " + text.slice(0, 400));
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new NightjarError("qwen_bad_json", "Qwen gateway returned a non-JSON body: " + text.slice(0, 200));
  }
  const usage = parseUsage(parsed.usage);
  const latencyMs = Date.now() - started;
  log.info("response.created", {
    status: String(parsed.status ?? ""),
    latencyMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
  });
  return {
    id: typeof parsed.id === "string" ? parsed.id : null,
    status: String(parsed.status ?? "unknown"),
    output: parseOutput(parsed.output),
    usage,
    latencyMs,
  };
}

export interface StreamHandlers {
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onFunctionCall?: (call: QwenFunctionCall) => void;
}

/**
 * Streaming call. Used for the final memo step so the judge watches the answer
 * arrive instead of staring at a spinner for 25 seconds.
 *
 * Returns the same QwenResult as createResponse, assembled from the deltas, so the
 * caller can treat both paths identically. If the stream produces nothing usable we
 * throw and the loop falls back to a non-streaming retry.
 */
export async function streamResponse(
  options: CreateResponseOptions,
  handlers: StreamHandlers,
): Promise<QwenResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(options.config.baseUrl + "/responses", {
      method: "POST",
      headers: headers(options.config),
      body: body(options.config, options, true),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new NetworkError("Qwen gateway unreachable (stream): " + ((err as Error)?.message ?? "unknown"));
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new QwenHttpError(res.status, "Qwen stream failed HTTP " + res.status + ": " + text.slice(0, 400));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let responseId: string | null = null;
  let status = "unknown";
  let usage: QwenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  const calls = new Map<string, QwenFunctionCall>();

  const handleEvent = (eventName: string, data: Record<string, unknown>): void => {
    switch (eventName) {
      case "response.created": {
        const r = data.response as Record<string, unknown> | undefined;
        if (r && typeof r.id === "string") responseId = r.id;
        return;
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const delta = String(data.delta ?? "");
        if (!delta) return;
        reasoning += delta;
        handlers.onReasoningDelta?.(delta);
        return;
      }
      case "response.output_text.delta": {
        const delta = String(data.delta ?? "");
        if (!delta) return;
        text += delta;
        handlers.onTextDelta?.(delta);
        return;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (data.item ?? data) as Record<string, unknown>;
        if (item?.type !== "function_call") return;
        const callId = String(item.call_id ?? item.id ?? "");
        const call: QwenFunctionCall = {
          type: "function_call",
          callId,
          name: String(item.name ?? ""),
          arguments:
            typeof item.arguments === "string" && item.arguments.length > 0
              ? item.arguments
              : String(data.arguments ?? "{}"),
        };
        if (call.name) {
          calls.set(callId, call);
          handlers.onFunctionCall?.(call);
        }
        return;
      }
      case "response.completed": {
        const r = data.response as Record<string, unknown> | undefined;
        if (r) {
          status = String(r.status ?? status);
          if (typeof r.id === "string") responseId = r.id;
          usage = parseUsage(r.usage);
        }
        return;
      }
      case "error": {
        throw new NightjarError("qwen_stream_error", "Qwen stream error: " + JSON.stringify(data).slice(0, 300));
      }
      default:
        return;
    }
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const payload = dataLines.join("\n");
      if (payload && payload !== "[DONE]") {
        try {
          handleEvent(eventName, JSON.parse(payload) as Record<string, unknown>);
        } catch (err) {
          if (err instanceof NightjarError) throw err;
          log.warn("stream.unparsable_frame", { event: eventName });
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  const output: QwenOutput[] = [];
  if (reasoning) output.push({ type: "reasoning", text: reasoning });
  for (const call of calls.values()) output.push(call);
  if (text) output.push({ type: "message", role: "assistant", text });
  if (output.length === 0) {
    throw new NightjarError("qwen_empty_stream", "Qwen stream closed without producing any output.");
  }
  const latencyMs = Date.now() - started;
  log.info("response.streamed", { status, latencyMs, outputTokens: usage.outputTokens, calls: calls.size });
  return { id: responseId, status, output, usage, latencyMs };
}

/** Throw early with a clear message when the key is missing, so the UI can explain it. */
export function requireQwenConfig(env: NodeJS.ProcessEnv = process.env): QwenConfig {
  const config = resolveQwenConfig(env);
  if (!config) {
    throw new ConfigError("BITGET_QWEN_API_KEY is not configured; AI synthesis is unavailable and the deterministic memo will be used instead.");
  }
  return config;
}