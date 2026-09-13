/**
 * The Bitget transport. One place knows how bytes leave this process.
 *
 * Three verified facts shape this file (DECISION.md 11.7):
 *
 *  1. The Agent SDK v1.2.0 has NO "market" module. Its modules are
 *     spot|futures|account|margin|copytrading|convert|earn|p2p|broker, and
 *     loadConfig({modules:"market"}) throws ConfigError. Public market data lives
 *     in "spot" and "futures", so that is what we load - always with readOnly:true.
 *  2. The SDK's own tools call v2 endpoints. Our research base is v3. So we use the
 *     SDK's BitgetRestClient as a hardened HTTP transport (timeouts, error taxonomy,
 *     rate limiting) and pass it v3 paths. We get the SDK's discipline without
 *     inheriting the wrong API version.
 *  3. v3 signals success with code "00000". Testing only for "0" turns every good
 *     response into a thrown error. Both are accepted here.
 *
 * Credentials: none. loadConfig is called with no apiKey, so hasAuth is false and
 * private endpoints cannot be reached. Bitget market data is keyless by design.
 */

import {
  BitgetRestClient,
  NetworkError,
  RateLimitError,
  loadConfig,
  type BitgetConfig,
  type ToolContext,
} from "@bitget-ai/bitget-agent-sdk";
import type { ZodError, ZodType } from "zod";

import {
  BITGET_MARKET_PREFIX,
  BITGET_READ_ONLY,
  BITGET_SDK_MODULES,
  resolveMode,
  type CacheTtlKey,
  type RuntimeMode,
} from "@/lib/config";
import { bitgetCache, cacheKey, ttlFor, type WrapResult } from "@/lib/bitget/cache";
import { toNum } from "@/lib/bitget/decode";
import { NightjarError, SchemaValidationError } from "@/lib/bitget/errors";
import { bitgetBucket, withBackoff } from "@/lib/bitget/ratelimit";
import { fixtureAsEnvelope, loadFixture, type FixtureQuery } from "@/lib/fixtures/loader";
import { isSuccessCode } from "@/lib/schema/bitget";
import { createLogger, errMessage } from "@/lib/observability/logger";

const log = createLogger("bitget.client");

export type Query = FixtureQuery;
export type TransportSource = RuntimeMode;

export interface RawEnvelope {
  code: string;
  msg?: string;
  requestTime?: number | string;
  data: unknown;
  endpoint?: string;
  /** Set only by the fixture transport: when this snapshot was actually recorded. */
  recordedAt?: string;
  latencyMs?: number;
}

/** A validated, provenance-stamped response. Every number in the app descends from one of these. */
export interface RestEnvelope<T> {
  data: T;
  source: TransportSource;
  endpoint: string;
  /**
   * Upstream's own requestTime. In fixture mode this is the RECORDING time, which is
   * the honest "as of" for the datum - never a claim that the price is current.
   */
  upstreamTime: number | null;
  recordedAt: string | null;
  latencyMs: number;
}

export type RestTransport = (path: string, query: Query) => Promise<RawEnvelope>;

// ------------------------------------------------------------------ SDK config

let configCache: BitgetConfig | null = null;

/**
 * The production SDK config, built once. readOnly:true is a hard invariant: it is
 * what removes write tools from the tool set before any handler could run.
 * tests/security/readonly.test.ts asserts this machine-checkably.
 */
export function getSdkConfig(): BitgetConfig {
  if (configCache) return configCache;
  const config = loadConfig({ modules: BITGET_SDK_MODULES, readOnly: BITGET_READ_ONLY });
  // CliOptions has no baseUrl parameter, so the only way to point the client at the
  // SDK's MockServer in tests is to override the resolved config. Never user input.
  const override = process.env.BITGET_API_BASE_URL;
  configCache = override ? { ...config, baseUrl: override } : config;
  return configCache;
}

/** Test hook: drop the cached config so an env change takes effect. */
export function resetSdkConfig(): void {
  configCache = null;
  clientCache = null;
}

let clientCache: BitgetRestClient | null = null;

export function getRestClient(): BitgetRestClient {
  if (!clientCache) clientCache = new BitgetRestClient(getSdkConfig());
  return clientCache;
}

/** Context handed to SDK tool handlers. Read-only by construction. */
export function getToolContext(): ToolContext {
  return { config: getSdkConfig(), client: getRestClient() };
}

// ------------------------------------------------------------------ transports

function cleanQuery(query: Query): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(query)) {
    const value = query[name];
    if (value === undefined || value === null || value === "") continue;
    out[name] = String(value);
  }
  return out;
}

/** Real network calls through the SDK client. */
export const liveTransport: RestTransport = async (path, query) => {
  const startedAt = Date.now();
  const result = await getRestClient().publicGet(BITGET_MARKET_PREFIX + path, cleanQuery(query));
  return {
    code: String(result.raw?.code ?? ""),
    msg: typeof result.raw?.msg === "string" ? result.raw.msg : undefined,
    requestTime: result.raw?.requestTime,
    data: result.data,
    endpoint: result.endpoint,
    latencyMs: Date.now() - startedAt,
  };
};

/** Recorded snapshots. Throws FixtureMissError rather than substituting a near-miss. */
export const fixtureTransport: RestTransport = async (path, query) => {
  const envelope = fixtureAsEnvelope(loadFixture(path, query));
  return {
    code: envelope.code,
    msg: envelope.msg,
    requestTime: envelope.requestTime,
    data: envelope.data,
    endpoint: envelope.endpoint,
    recordedAt: envelope.recordedAt,
    latencyMs: 0,
  };
};

export function resolveTransport(mode: RuntimeMode = resolveMode()): RestTransport {
  return mode === "fixture" ? fixtureTransport : liveTransport;
}

// --------------------------------------------------------------------- errors

/**
 * Only transport-level failures are retried. A well-formed response carrying a
 * business error code (bad parameter, unknown symbol) is NOT retryable - retrying
 * it would burn rate limit and hide a real bug.
 */
export function isRetryableUpstreamError(err: unknown): boolean {
  if (err instanceof RateLimitError || err instanceof NetworkError) return true;
  if (err instanceof NightjarError) return err.kind === "network" || err.kind === "upstream_unavailable";
  // Node's fetch surfaces connection failures as a bare TypeError("fetch failed").
  if (err instanceof TypeError) return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(err.message);
  return false;
}

function summarizeIssues(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.length ? issue.path.join(".") : "(root)") + ": " + issue.message)
    .join("; ");
}

// ------------------------------------------------------------------------ GET

export interface RestGetOptions {
  transport?: RestTransport;
  maxAttempts?: number;
  /** Only for tests. Production always pays the bucket. */
  skipRateLimit?: boolean;
}

/**
 * One GET against /api/v3/market, with rate limiting, bounded backoff, success-code
 * checking and provenance. Throws on failure; use safeFetch() for the value form.
 */
export async function restGet(path: string, query: Query = {}, options: RestGetOptions = {}): Promise<RestEnvelope<unknown>> {
  const mode = resolveMode();
  const transport = options.transport ?? resolveTransport(mode);
  const startedAt = Date.now();
  // The canonical label for this call, built from the request WE made: method + v3 path +
  // sorted query. Deliberately not the transport's echoed endpoint - the live SDK returns a
  // bare path with no query, so two different calls would carry identical provenance and a
  // reader could not tell which ticker produced a number. This string is byte-identical to
  // what scripts/record-fixtures.mjs writes, so live and fixture mode label the same way.
  const endpoint = cacheKey("GET " + BITGET_MARKET_PREFIX + path, query);

  const { value: raw } = await withBackoff(
    async () => {
      if (mode === "live" && !options.skipRateLimit) await bitgetBucket.take(1);
      return transport(path, query);
    },
    isRetryableUpstreamError,
    { maxAttempts: options.maxAttempts ?? 3 },
  );

  if (!isSuccessCode(raw.code)) {
    throw new NightjarError(
      "upstream_error_code",
      "Bitget returned code " + JSON.stringify(raw.code) + " (" + (raw.msg ?? "no message") + ") for " + endpoint,
    );
  }

  const envelope: RestEnvelope<unknown> = {
    data: raw.data,
    source: mode,
    endpoint,
    upstreamTime: toNum(raw.requestTime),
    recordedAt: raw.recordedAt ?? null,
    latencyMs: raw.latencyMs ?? Date.now() - startedAt,
  };
  log.debug("rest.get", { endpoint, source: mode, latencyMs: envelope.latencyMs });
  return envelope;
}

// ------------------------------------------------------- cached + validated GET

export interface EndpointSpec<T> {
  /** Stable id used in cache keys, logs and the health endpoint. */
  id: string;
  /** Path under /api/v3/market, e.g. "/tickers". */
  path: string;
  query?: Query;
  schema: ZodType<T>;
  ttl: CacheTtlKey;
  transport?: RestTransport;
}

/**
 * The one read path the rest of the app uses: rate-limited, retried, cached,
 * coalesced and schema-validated. A payload that does not match its schema is an
 * error, never a partially-typed object - we would rather show "source degraded"
 * than publish a number we cannot vouch for.
 */
export async function fetchEndpoint<T>(spec: EndpointSpec<T>): Promise<WrapResult<RestEnvelope<T>>> {
  const key = spec.id + "|" + cacheKey(spec.path, spec.query);
  return bitgetCache.wrap(key, ttlFor(spec.ttl), async () => {
    const envelope = await restGet(spec.path, spec.query, { transport: spec.transport });
    const parsed = spec.schema.safeParse(envelope.data);
    if (!parsed.success) {
      const issues = summarizeIssues(parsed.error);
      log.error("schema.validation_failed", { endpoint: spec.id, issues });
      throw new SchemaValidationError(spec.id, issues, { cause: parsed.error });
    }
    return { ...envelope, data: parsed.data };
  });
}

export { errMessage };
