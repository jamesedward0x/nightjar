/**
 * safeInvoke - the never-throws boundary between upstream data and the UI.
 *
 * The Agent SDK v1.2.0 does NOT export a safeInvoke helper, despite the Agent Hub
 * docs describing one (DECISION.md 11.7). This is ours. It exists so that one dead
 * optional source degrades ONE panel on the page instead of failing the request.
 *
 * The SDK's own toToolErrorPayload() shapes errors for MCP tool results. We keep it
 * for SDK tool calls and add our own classifier for everything else, because our
 * failures also include schema mismatches, fixture misses and loop budgets.
 */

import { toToolErrorPayload } from "@bitget-ai/bitget-agent-sdk";

import { fetchEndpoint, type EndpointSpec, type RestEnvelope, type TransportSource } from "@/lib/bitget/client";
import type { WrapResult } from "@/lib/bitget/cache";
import {
  LoopBudgetExceededError,
  LlmStructureError,
  NightjarError,
  SchemaValidationError,
  UnknownSymbolError,
  UpstreamDegradedError,
} from "@/lib/bitget/errors";
import { FixtureMissError } from "@/lib/fixtures/loader";
import { errMessage, createLogger } from "@/lib/observability/logger";

const log = createLogger("bitget.safe-invoke");

export interface SafeError {
  /** Machine-readable. The UI switches on this; it never parses message text. */
  kind: string;
  message: string;
  retryable: boolean;
  /** Optional operator-facing next step. Safe to show; never contains a secret. */
  hint?: string;
}

export interface SafeOk<T> {
  ok: true;
  data: T;
  source: TransportSource;
  endpoint: string;
  /** Upstream requestTime, or the fixture's recording time. The honest "as of". */
  upstreamTime: number | null;
  recordedAt: string | null;
  fetchedAt: number;
  latencyMs: number;
  fromCache: boolean;
  coalesced: boolean;
}

export interface SafeErr {
  ok: false;
  error: SafeError;
  source: TransportSource;
  endpoint: string;
  fetchedAt: number;
  latencyMs: number;
}

export type SafeResult<T> = SafeOk<T> | SafeErr;

export function classifyError(err: unknown): SafeError {
  if (err instanceof FixtureMissError) {
    return {
      kind: "fixture_miss",
      message: err.message,
      retryable: false,
      hint: "Record this request first: pnpm record-fixtures. Fixture mode never substitutes a similar symbol.",
    };
  }
  if (err instanceof SchemaValidationError) {
    return {
      kind: "schema_validation",
      message: err.message,
      retryable: false,
      hint: "Upstream changed shape. Re-record fixtures and update lib/schema/bitget.ts.",
    };
  }
  if (err instanceof UnknownSymbolError) {
    return { kind: "unknown_symbol", message: err.message, retryable: false, hint: "Check the symbol against the instrument universe." };
  }
  if (err instanceof LoopBudgetExceededError) {
    return { kind: "loop_budget_exceeded", message: err.message, retryable: false, hint: "Narrow the question; the agent hit its call or wall-clock budget." };
  }
  if (err instanceof LlmStructureError) {
    return { kind: "llm_structure", message: err.message, retryable: true, hint: "Model output failed validation twice. Retry once." };
  }
  if (err instanceof UpstreamDegradedError) {
    return { kind: "upstream_degraded", message: err.message, retryable: true };
  }
  if (err instanceof NightjarError) {
    return { kind: err.kind, message: err.message, retryable: err.kind === "network" || err.kind === "upstream_unavailable" };
  }
  // SDK errors: reuse the SDK's own classification so our taxonomy matches its docs.
  const payload = toToolErrorPayload(err);
  if (payload && payload.ok === false && payload.error) {
    const type = payload.error.type;
    return {
      kind: type === "RateLimitError" ? "rate_limited" : type === "NetworkError" ? "network" : "bitget_" + type.toLowerCase(),
      message: payload.error.message,
      retryable: type === "RateLimitError" || type === "NetworkError",
      hint: payload.error.suggestion,
    };
  }
  return { kind: "internal", message: errMessage(err), retryable: false };
}

/**
 * Run an async operation and return its outcome as a value. Never throws.
 * source is the label the UI and /api/health show, e.g. "bitget-rest" or "qwen".
 */
export async function safeInvoke<T>(source: string, endpoint: string, fn: () => Promise<T>): Promise<SafeResult<T>> {
  const fetchedAt = Date.now();
  try {
    const data = await fn();
    return {
      ok: true,
      data,
      source: source === "bitget-rest" ? (process.env.NIGHTJAR_MODE === "fixture" ? "fixture" : "live") : (source as TransportSource),
      endpoint,
      upstreamTime: null,
      recordedAt: null,
      fetchedAt,
      latencyMs: Date.now() - fetchedAt,
      fromCache: false,
      coalesced: false,
    };
  } catch (err) {
    const error = classifyError(err);
    log.warn("invoke.failed", { source, endpoint, kind: error.kind, message: error.message });
    return { ok: false, error, source: source as TransportSource, endpoint, fetchedAt, latencyMs: Date.now() - fetchedAt };
  }
}

function flatten<T>(source: string, spec: EndpointSpec<T>, wrapped: WrapResult<RestEnvelope<T>>): SafeOk<T> {
  const envelope = wrapped.value;
  return {
    ok: true,
    data: envelope.data,
    source: envelope.source,
    endpoint: envelope.endpoint,
    upstreamTime: envelope.upstreamTime,
    recordedAt: envelope.recordedAt,
    fetchedAt: Date.now(),
    latencyMs: envelope.latencyMs,
    fromCache: wrapped.fromCache,
    coalesced: wrapped.coalesced,
  };
}

/**
 * The call the rest of the app actually uses: cached, validated, provenance-stamped
 * and never-throwing. Failure comes back as {ok:false} with a machine-readable kind,
 * so a degraded source renders as a labelled gap instead of an empty string.
 */
export async function safeFetch<T>(spec: EndpointSpec<T>): Promise<SafeResult<T>> {
  const fetchedAt = Date.now();
  try {
    return flatten(spec.id, spec, await fetchEndpoint(spec));
  } catch (err) {
    const error = classifyError(err);
    log.warn("fetch.failed", { endpoint: spec.id, kind: error.kind, message: error.message });
    return {
      ok: false,
      error,
      source: process.env.NIGHTJAR_MODE === "fixture" ? "fixture" : "live",
      endpoint: spec.id,
      fetchedAt,
      latencyMs: Date.now() - fetchedAt,
    };
  }
}
