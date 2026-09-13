/**
 * The Phase 1 page proves exactly one thing: a number on screen that travelled
 * through the real stack - rate limit, retry, cache, schema validation,
 * provenance - and can say where it came from and how old it is.
 *
 * The number is the rToken basis: how far the spot tokenized equity sits from the
 * composite reference price its perpetual settles against. That gap is the whole
 * product thesis, so it is the right thing to render first.
 *
 * Phase 2 replaces the inline arithmetic below with lib/compute/basis.ts. The sign
 * convention is already the one Phase 2 will use: POSITIVE = rToken ABOVE reference.
 */

import { toNum } from "@/lib/bitget/decode";
import { FUTURES, SPOT, getTicker } from "@/lib/bitget/endpoints";
import type { SafeError } from "@/lib/bitget/safe-invoke";
import { findPair, getUniverse } from "@/lib/bitget/universe";
import { resolveMode } from "@/lib/config";

export const dynamic = "force-dynamic";

/** The name we recorded fixtures for, so fixture mode and live mode render the same page. */
const DEMO_SYMBOL = "AAPL";

interface HeadlineOk {
  ok: true;
  base: string;
  rTokenSymbol: string;
  perpSymbol: string;
  spotLast: number;
  indexPrice: number;
  basisPct: number;
  source: string;
  asOf: number | null;
  recordedAt: string | null;
  latencyMs: number;
  fromCache: boolean;
  endpoints: string[];
  dualListed: number | null;
  perpOnly: number | null;
}

interface HeadlineErr {
  ok: false;
  stage: string;
  error: SafeError;
}

type Headline = HeadlineOk | HeadlineErr;

async function headline(): Promise<Headline> {
  const pairResult = await findPair(DEMO_SYMBOL);
  if (!pairResult.ok) return { ok: false, stage: "universe", error: pairResult.error };
  const pair = pairResult.data;

  const [spotResult, futuresResult, universeResult] = await Promise.all([
    getTicker(SPOT, pair.rTokenSymbol),
    getTicker(FUTURES, pair.perpSymbol),
    getUniverse(),
  ]);

  if (!spotResult.ok) return { ok: false, stage: "spot-ticker", error: spotResult.error };
  if (!futuresResult.ok) return { ok: false, stage: "futures-ticker", error: futuresResult.error };

  const spotRow = spotResult.data[0];
  const futuresRow = futuresResult.data[0];
  const spotLast = toNum(spotRow?.lastPrice);
  // indexPrice is the composite reference (Binance + Hyperliquid + Pyth, equal weight).
  const indexPrice = toNum(futuresRow?.indexPrice);

  if (spotLast === null || indexPrice === null || indexPrice === 0) {
    return {
      ok: false,
      stage: "decode",
      error: {
        kind: "missing_field",
        message: "Bitget returned no usable price for " + pair.rTokenSymbol + " or " + pair.perpSymbol + ".",
        retryable: true,
        hint: "Upstream may be mid-maintenance. The value is absent, not zero - we refuse to print a basis from it.",
      },
    };
  }

  return {
    ok: true,
    base: pair.base,
    rTokenSymbol: pair.rTokenSymbol,
    perpSymbol: pair.perpSymbol,
    spotLast,
    indexPrice,
    basisPct: ((spotLast - indexPrice) / indexPrice) * 100,
    source: spotResult.source,
    // The older of the two quotes: a basis is only as fresh as its stalest leg.
    asOf: oldest(spotResult.upstreamTime, futuresResult.upstreamTime),
    recordedAt: spotResult.recordedAt ?? futuresResult.recordedAt,
    latencyMs: Math.max(spotResult.latencyMs, futuresResult.latencyMs),
    fromCache: spotResult.fromCache || futuresResult.fromCache,
    endpoints: [spotResult.endpoint, futuresResult.endpoint],
    dualListed: universeResult.ok ? universeResult.data.counts.dualListed : null,
    perpOnly: universeResult.ok ? universeResult.data.counts.perpOnly : null,
  };
}

function oldest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function price(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function signedPct(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(4) + "%";
}

function when(ms: number | null): string {
  return ms === null ? "unknown" : new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

export default async function Page() {
  const mode = resolveMode();
  const result = await headline();

  return (
    <main>
      <h1>Nightjar</h1>
      <p className="sub">
        A 7x24 research desk for Bitget tokenized US equities. It keeps watch while the market that prices them is
        closed. Read-only: it never places an order, and a human always decides.
      </p>

      {mode === "fixture" ? (
        <div className="banner">
          <strong>FIXTURE MODE</strong> - the numbers below are a recorded snapshot, <strong>NOT live data</strong>.
          {result.ok && result.recordedAt ? " Recorded " + result.recordedAt + "." : ""} Set{" "}
          <code>NIGHTJAR_MODE=live</code> for real-time quotes.
        </div>
      ) : (
        <div className="banner live">
          Live mode - keyless Bitget public market data. Every figure below carries its own upstream timestamp.
        </div>
      )}

      <h2>Headline basis - {DEMO_SYMBOL}</h2>

      {result.ok ? (
        <div className="panel">
          <div className={"basis " + (result.basisPct >= 0 ? "pos" : "neg")}>{signedPct(result.basisPct)}</div>
          <p className="note">
            {result.rTokenSymbol} spot vs the {result.perpSymbol} composite reference index. Positive means the rToken
            trades <strong>above</strong> its reference.
          </p>
          <div style={{ marginTop: 16 }}>
            <Row label="rToken spot last" value={"$" + price(result.spotLast)} />
            <Row label="Composite reference index" value={"$" + price(result.indexPrice)} />
            <Row label="Data as of" value={when(result.asOf)} />
            <Row label="Source" value={result.source + (result.fromCache ? " (cache)" : "")} />
            <Row label="Fetch latency" value={result.latencyMs + " ms"} />
            <Row
              label="Tradable universe"
              value={
                result.dualListed === null
                  ? "unavailable"
                  : result.dualListed + " dual-listed / " + result.perpOnly + " perp-only"
              }
            />
          </div>
          <p className="note">
            Endpoints:{" "}
            {result.endpoints.map((endpoint, index) => (
              <span key={endpoint}>
                {index > 0 ? ", " : ""}
                <code>{endpoint}</code>
              </span>
            ))}
          </p>
        </div>
      ) : (
        <div className="panel">
          <div className="basis">
            <span className="status bad">source degraded</span>
          </div>
          <p className="note">
            Nightjar would rather show a labelled gap than invent a number. Failed at <code>{result.stage}</code>.
          </p>
          <div style={{ marginTop: 16 }}>
            <Row label="Reason" value={result.error.kind} />
            <Row label="Retryable" value={result.error.retryable ? "yes" : "no"} />
            <Row label="Message" value={result.error.message} />
            {result.error.hint ? <Row label="Next step" value={result.error.hint} /> : null}
          </div>
        </div>
      )}

      <h2>What this build proves</h2>
      <div className="panel">
        <Row label="Transport" value="Bitget REST v3 market, keyless, read-only" />
        <Row label="SDK" value="@bitget-ai/bitget-agent-sdk (spot + futures modules)" />
        <Row label="Validation" value="every payload parsed by a Zod schema written from a recording" />
        <Row label="Resilience" value="token-bucket rate limit + bounded exponential backoff" />
        <Row label="Cache" value="in-memory TTL with in-flight coalescing; no durable state" />
        <Row label="Health" value="/api/health - per-source status and latency" />
      </div>

      <footer>
        Nightjar - Bitget AI Hackathon S2, Track 3 (AI Trading Desk) / Personalized Research Workbench. Research output
        only; nothing here is investment advice and nothing here trades.
      </footer>
    </main>
  );
}
