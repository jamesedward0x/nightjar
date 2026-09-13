/**
 * GET /api/health - per-source status and latency.
 *
 * Two design rules:
 *   1. It never reports a secret. For Qwen it reports PRESENCE of credentials, not
 *      the value, and it does not call the gateway (a live LLM probe belongs to
 *      Phase 3, where it can be bounded and streamed).
 *   2. A degraded optional source degrades the payload, not the response. Only the
 *      primary source - Bitget market data - can turn this into a 503.
 *
 * The Bitget probe deliberately bypasses the response cache so latencyMs is a real
 * measurement of the wire rather than of our own memory. The whole payload is then
 * cached for CACHE_TTL_MS.health so a monitoring loop cannot become our load test.
 */

import { NextResponse } from "next/server";

import { bitgetCache, ttlFor } from "@/lib/bitget/cache";
import { restGet } from "@/lib/bitget/client";
import { FUTURES } from "@/lib/bitget/endpoints";
import { safeInvoke, type SafeError } from "@/lib/bitget/safe-invoke";
import { getUniverse } from "@/lib/bitget/universe";
import { fixtureMeta } from "@/lib/fixtures/loader";
import { createLogger } from "@/lib/observability/logger";
import { BITGET_READ_ONLY, BITGET_REST_BASE, QWEN_GATEWAY_BASE, resolveMode } from "@/lib/config";

export const dynamic = "force-dynamic";

const log = createLogger("api.health");

/** A name we recorded a fixture for, so health works identically in live and fixture mode. */
const HEALTH_PROBE_SYMBOL = "AAPLUSDT";
const HEALTH_CACHE_KEY = "health";

type Health = "ok" | "degraded" | "not_configured";

interface SourceReport {
  status: Health;
  /** Milliseconds for this probe. null when the source was not exercised. */
  latencyMs: number | null;
  kind: string;
  detail?: Record<string, unknown>;
  error?: SafeError;
}

interface HealthPayload {
  status: "ok" | "degraded";
  mode: string;
  readOnly: boolean;
  checkedAt: string;
  /** True when this payload was served from the 15s health cache. */
  cached: boolean;
  sources: {
    "bitget-rest": SourceReport;
    "bitget-universe": SourceReport;
    qwen: SourceReport;
    "signal-mcp": SourceReport;
  };
  fixtures: { count: number; recordedAt: string | null } | null;
  cache: ReturnType<typeof bitgetCache.stats>;
  runtime: { node: string; platform: string };
}

async function probeBitgetRest(): Promise<SourceReport> {
  const result = await safeInvoke("bitget-rest", "/api/v3/market/tickers", () =>
    // maxAttempts 1: health must fail fast and report the real state, not a retried one.
    restGet("/tickers", { category: FUTURES, symbol: HEALTH_PROBE_SYMBOL }, { maxAttempts: 1 }),
  );
  if (!result.ok) {
    return { status: "degraded", latencyMs: result.latencyMs, kind: "http-get", error: result.error };
  }
  return {
    status: "ok",
    latencyMs: result.latencyMs,
    kind: "http-get",
    detail: {
      base: BITGET_REST_BASE,
      probe: "GET /api/v3/market/tickers?category=USDT-FUTURES&symbol=" + HEALTH_PROBE_SYMBOL,
      source: result.source,
      // safeInvoke wraps the envelope as data and cannot know its provenance, so the real
      // upstream timestamp is on the envelope, not on the SafeResult.
      upstreamTime: result.data.upstreamTime,
      authenticated: false,
    },
  };
}

async function probeUniverse(): Promise<SourceReport> {
  const result = await getUniverse();
  if (!result.ok) {
    return { status: "degraded", latencyMs: result.latencyMs, kind: "derived", error: result.error };
  }
  const universe = result.data;
  return {
    status: "ok",
    latencyMs: result.latencyMs,
    kind: "derived",
    detail: {
      dualListed: universe.counts.dualListed,
      perpOnly: universe.counts.perpOnly,
      futuresStock: universe.counts.futuresStock,
      spotStock: universe.counts.spotStock,
      asOf: universe.asOf,
      fromCache: result.fromCache,
    },
  };
}

/**
 * Credentials presence only. The key itself is never read into the response, and
 * the gateway is never called here.
 */
function probeQwen(): SourceReport {
  const configured = (process.env.BITGET_QWEN_API_KEY ?? "").trim().length > 0;
  return {
    status: configured ? "ok" : "not_configured",
    latencyMs: null,
    kind: "env-presence",
    detail: {
      baseUrl: process.env.QWEN_BASE_URL ?? QWEN_GATEWAY_BASE,
      model: process.env.QWEN_MODEL ?? "qwen3.8-max",
      // Verified wire format: POST /v1/responses with the flat tool schema.
      api: "responses",
      store: false,
      exercised: false,
      note: "Credential presence only, never the value. The bounded live probe is POST /api/research, which streams the agent loop over SSE.",
    },
  };
}

function probeSignalMcp(): SourceReport {
  return {
    status: "not_configured",
    latencyMs: null,
    kind: "optional",
    detail: {
      note: "bitget-signal research Skills / MCP data service are optional and not wired in this phase.",
    },
  };
}

async function buildHealth(): Promise<HealthPayload> {
  const [rest, universe] = await Promise.all([probeBitgetRest(), probeUniverse()]);
  const mode = resolveMode();
  const meta = mode === "fixture" ? fixtureMeta() : null;
  const degraded = rest.status !== "ok";
  const payload: HealthPayload = {
    status: degraded ? "degraded" : "ok",
    mode,
    readOnly: BITGET_READ_ONLY,
    checkedAt: new Date().toISOString(),
    cached: false,
    sources: {
      "bitget-rest": rest,
      "bitget-universe": universe,
      qwen: probeQwen(),
      "signal-mcp": probeSignalMcp(),
    },
    fixtures: meta ? { count: meta.count, recordedAt: meta.recordedAt } : null,
    cache: bitgetCache.stats(),
    runtime: { node: process.versions.node, platform: process.platform },
  };
  if (degraded) log.warn("health.degraded", { kind: rest.error?.kind, message: rest.error?.message });
  return payload;
}

export async function GET(): Promise<NextResponse> {
  const wrapped = await bitgetCache.wrap(HEALTH_CACHE_KEY, ttlFor("health"), buildHealth);
  const body: HealthPayload = { ...wrapped.value, cached: wrapped.fromCache || wrapped.coalesced };
  return NextResponse.json(body, {
    status: body.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
