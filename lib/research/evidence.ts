/**
 * Evidence pack assembly.
 *
 * This is the seam between the data layer (lib/bitget) and the compute engine
 * (lib/compute). It fans out the upstream calls for ONE name, records what answered
 * and what did not, and hands the compute engine decoded candles. It contains no
 * arithmetic of its own and no LLM: numbers come from lib/compute, sentences from Qwen.
 *
 * Degradation is the design. Every optional source is independent, so a dead funding
 * endpoint removes one panel and the memo still completes with a visible gap. The only
 * hard requirements are the rToken spot candles and the index candles - without both
 * there is no basis, and therefore no product.
 *
 * Fan-out is ~15 calls for a single symbol, which is why MAX_SYMBOLS_PER_QUERY is 4:
 * the whole pack has to fit inside one serverless invocation.
 */

import { toNum, toTs } from "@/lib/bitget/decode";
import {
  FUTURES,
  SPOT,
  getCandles,
  getCurrentFundRate,
  getFills,
  getIndexComponents,
  getOpenInterest,
  getOrderbook,
  getPremiumCandles,
  getTicker,
} from "@/lib/bitget/endpoints";
import { findPair, type DualListedPair } from "@/lib/bitget/universe";
import type { SafeResult } from "@/lib/bitget/safe-invoke";
import { resolveMode, type RuntimeMode } from "@/lib/config";
import { toCandles, toPremiumPoints, windowOf } from "@/lib/compute/candles";
import { buildBasisSeries, basisBySession, latestSnapshot, perpTrackingRatio, weekendDislocationRatio, currentRunLength, type BasisBySession, type BasisSnapshot } from "@/lib/compute/basis";
import { joinByTimestamp, joinWithOptional, type JoinStats } from "@/lib/compute/join";
import { buildLiquidityProfile, type LiquidityProfile } from "@/lib/compute/liquidity";
import { buildQualityReport, detectStaleness, detectVolumeInconsistency, type DataQualityReport } from "@/lib/compute/quality";
import { exceedanceCounts, findAnalogues, groupEpisodes, type Analogue, type Episode } from "@/lib/compute/analogues";
import type { BasisPoint, Candle, ComputeProvenance, PremiumPoint } from "@/lib/compute/types";
import type { IndexComponent, Ticker } from "@/lib/schema/bitget";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger("research.evidence");

/** One hour is the bucket size of the whole study; 3h stale means the feed stopped. */
const STALE_TOLERANCE_MS = 3 * 3_600_000;

export interface SourceRecord {
  id: string;
  status: "ok" | "degraded" | "unavailable";
  /** Whether the app cannot function without it. */
  required: boolean;
  kind?: string;
  message?: string;
  latencyMs: number;
  fromCache: boolean;
  source: string;
  fetchedAt: number;
  recordedAt: string | null;
  upstreamTime: number | null;
}

export interface DerivativesContext {
  fundingRatePct: number | null;
  fundingIntervalHours: number | null;
  minFundingRatePct: number | null;
  maxFundingRatePct: number | null;
  nextUpdateTs: number | null;
  openInterestBase: number | null;
  openInterestTs: number | null;
  /** True when funding is pinned at a cap, which is itself information. */
  atCap: boolean | null;
}

export interface ReferenceComposition {
  symbol: string;
  components: { exchange: string; spotPair: string | null; equivalentPrice: number | null; weight: number | null }[];
  /** Weights should total 1. If they do not, the reference is not what the docs say. */
  weightSum: number | null;
  venueCount: number;
}

export interface EvidencePack {
  base: string;
  rTokenSymbol: string;
  perpSymbol: string;
  generatedAt: number;
  mode: RuntimeMode;
  /** True when any optional source failed. Drives the LIVE (degraded) badge. */
  degraded: boolean;
  observationWindow: { fromTs: number; toTs: number; n: number } | null;
  snapshot: BasisSnapshot | null;
  bySession: BasisBySession | null;
  weekendDislocationRatio: number | null;
  perpTrackingRatio: number | null;
  /** Hours the current dislocation has persisted at >= 0.5%. */
  currentRunHours: number;
  series: BasisPoint[];
  premium: PremiumPoint[];
  joinStats: JoinStats | null;
  reference: ReferenceComposition | null;
  liquidity: LiquidityProfile | null;
  derivatives: DerivativesContext | null;
  analogues: Analogue[];
  episodes: Episode[];
  exceedances: ReturnType<typeof exceedanceCounts>;
  quality: DataQualityReport;
  sources: SourceRecord[];
  provenance: ComputeProvenance[];
}

export type EvidenceResult =
  | { ok: true; pack: EvidencePack }
  | { ok: false; kind: string; message: string; hint?: string; sources: SourceRecord[] };

class Collector {
  readonly records: SourceRecord[] = [];
  readonly provenance: ComputeProvenance[] = [];

  /** Unwrap a SafeResult into data-or-null while recording what happened. */
  take<T>(id: string, result: SafeResult<T>, required: boolean): T | null {
    if (result.ok) {
      this.records.push({
        id,
        status: "ok",
        required,
        latencyMs: result.latencyMs,
        fromCache: result.fromCache,
        source: result.source,
        fetchedAt: result.fetchedAt,
        recordedAt: result.recordedAt,
        upstreamTime: result.upstreamTime,
      });
      this.provenance.push({
        endpoint: result.endpoint,
        source: result.source,
        fetchedAt: result.fetchedAt,
        latencyMs: result.latencyMs,
        fromCache: result.fromCache,
        upstreamTime: result.upstreamTime,
        recordedAt: result.recordedAt,
      });
      return result.data;
    }
    this.records.push({
      id,
      status: required ? "unavailable" : "degraded",
      required,
      kind: result.error.kind,
      message: result.error.message,
      latencyMs: result.latencyMs,
      fromCache: false,
      source: result.source,
      fetchedAt: result.fetchedAt,
      recordedAt: null,
      upstreamTime: null,
    });
    log.warn("source.degraded", { id, kind: result.error.kind, required });
    return null;
  }
}

function pickTicker(rows: Ticker[] | null, symbol: string): Ticker | null {
  if (!rows) return null;
  return rows.find((r) => r.symbol === symbol) ?? rows[0] ?? null;
}

function referenceComposition(symbol: string, raw: { symbol: string; componentList: IndexComponent[] } | null): ReferenceComposition | null {
  if (!raw) return null;
  const components = raw.componentList.map((c) => ({
    exchange: c.exchange,
    spotPair: c.spotPair || null,
    equivalentPrice: toNum(c.equivalentPrice),
    weight: toNum(c.weight),
  }));
  const weights = components.map((c) => c.weight).filter((w): w is number => w !== null);
  const weightSum = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) : null;
  return { symbol: raw.symbol || symbol, components, weightSum, venueCount: components.length };
}

function derivatives(fundingRows: { fundingRate?: string | null; fundingRateInterval?: string | null; minFundingRate?: string | null; maxFundingRate?: string | null; nextUpdate?: string | null }[] | null, oi: { list: { openInterest?: string | null }[]; ts?: string | null } | null): DerivativesContext | null {
  const row = fundingRows?.[0] ?? null;
  const fundingRate = row ? toNum(row.fundingRate) : null;
  const intervalHoursRaw = row ? toNum(row.fundingRateInterval) : null;
  const min = row ? toNum(row.minFundingRate) : null;
  const max = row ? toNum(row.maxFundingRate) : null;
  const latestOi = oi?.list?.[0] ?? null;
  if (!row && !oi) return null;
  return {
    fundingRatePct: fundingRate === null ? null : fundingRate * 100,
    fundingIntervalHours: intervalHoursRaw === null ? null : intervalHoursRaw / 3_600_000,
    minFundingRatePct: min === null ? null : min * 100,
    maxFundingRatePct: max === null ? null : max * 100,
    nextUpdateTs: row ? toTs(row.nextUpdate) : null,
    openInterestBase: latestOi ? toNum(latestOi.openInterest) : null,
    openInterestTs: oi ? toTs(oi.ts) : null,
    atCap:
      fundingRate === null || min === null || max === null
        ? null
        : Math.abs(fundingRate - min) < 1e-12 || Math.abs(fundingRate - max) < 1e-12,
  };
}

export interface EvidenceOptions {
  /** 1H candle depth. The endpoint ceiling is 1000 rows (~41 days). */
  hourlyLimit?: number;
  analogueCount?: number;
  episodeThresholdPct?: number;
  now?: number;
}

/**
 * Build the full evidence pack for one dual-listed name.
 * Required: rToken spot 1H candles + index 1H candles. Everything else degrades.
 */
export async function gatherEvidence(base: string, options: EvidenceOptions = {}): Promise<EvidenceResult> {
  const now = options.now ?? Date.now();
  const mode = resolveMode();
  const collector = new Collector();

  const pairResult = await findPair(base);
  const pair: DualListedPair | null = collector.take("universe", pairResult, true);
  if (!pair) {
    return {
      ok: false,
      kind: pairResult.ok ? "internal" : pairResult.error.kind,
      message: pairResult.ok ? "Universe returned no pair." : pairResult.error.message,
      hint: pairResult.ok ? undefined : pairResult.error.hint,
      sources: collector.records,
    };
  }

  const hourlyLimit = options.hourlyLimit ?? 1000;
  const [spotHourlyRes, indexHourlyRes, perpHourlyRes, premiumRes, spotDailyRes, indexCompRes, bookRes, fillsRes, spotTickerRes, perpTickerRes, fundingRes, oiRes] =
    await Promise.all([
      getCandles({ category: SPOT, symbol: pair.rTokenSymbol, interval: "1H", limit: hourlyLimit }),
      getCandles({ category: FUTURES, symbol: pair.perpSymbol, interval: "1H", type: "index", limit: hourlyLimit }),
      getCandles({ category: FUTURES, symbol: pair.perpSymbol, interval: "1H", type: "market", limit: hourlyLimit }),
      getPremiumCandles(pair.perpSymbol, "1H", hourlyLimit),
      getCandles({ category: SPOT, symbol: pair.rTokenSymbol, interval: "1D", limit: 30 }),
      getIndexComponents(pair.perpSymbol),
      getOrderbook(SPOT, pair.rTokenSymbol),
      getFills(SPOT, pair.rTokenSymbol),
      getTicker(SPOT, pair.rTokenSymbol),
      getTicker(FUTURES, pair.perpSymbol),
      getCurrentFundRate(pair.perpSymbol),
      getOpenInterest(pair.perpSymbol),
    ]);

  const spotHourlyRaw = collector.take("candles-spot-1h", spotHourlyRes, true);
  const indexHourlyRaw = collector.take("candles-index-1h", indexHourlyRes, true);
  const perpHourlyRaw = collector.take("candles-perp-1h", perpHourlyRes, false);
  const premiumRaw = collector.take("candles-premium-1h", premiumRes, false);
  const spotDailyRaw = collector.take("candles-spot-1d", spotDailyRes, false);
  const indexCompRaw = collector.take("index-components", indexCompRes, false);
  const book = collector.take("orderbook-spot", bookRes, false);
  const fills = collector.take("fills-spot", fillsRes, false);
  const spotTicker = pickTicker(collector.take("tickers-spot", spotTickerRes, false), pair.rTokenSymbol);
  const perpTicker = pickTicker(collector.take("tickers-perp", perpTickerRes, false), pair.perpSymbol);
  const fundingRaw = collector.take("current-fund-rate", fundingRes, false);
  const oiRaw = collector.take("open-interest", oiRes, false);

  if (!spotHourlyRaw || !indexHourlyRaw) {
    return {
      ok: false,
      kind: "basis_inputs_unavailable",
      message:
        "Cannot compute a basis: " +
        (!spotHourlyRaw ? `rToken spot 1H candles (${pair.rTokenSymbol}) ` : "") +
        (!indexHourlyRaw ? `index 1H candles (${pair.perpSymbol})` : "") +
        " did not return data. No basis is published rather than an estimated one.",
      hint: "Check /api/health for the failing source, then retry.",
      sources: collector.records,
    };
  }

  const spotHourly: Candle[] = toCandles(spotHourlyRaw);
  const indexHourly: Candle[] = toCandles(indexHourlyRaw);
  const perpHourly: Candle[] = perpHourlyRaw ? toCandles(perpHourlyRaw) : [];
  const spotDaily: Candle[] = spotDailyRaw ? toCandles(spotDailyRaw) : [];
  const premium: PremiumPoint[] = premiumRaw ? toPremiumPoints(premiumRaw) : [];

  const threeWay = joinWithOptional(spotHourly, indexHourly, perpHourly.length > 0 ? perpHourly : null);
  const series = buildBasisSeries(threeWay.rows, threeWay.optionalByTs);
  const bySession = series.length > 0 ? basisBySession(series) : null;
  const snapshot = latestSnapshot(series);

  // --- data quality: the candle-volume defect is detected, never assumed away ---
  const flags = detectVolumeInconsistency({
    daily: spotDaily,
    hourly: spotHourly,
    turnover24h: spotTicker ? toNum(spotTicker.turnover24h) : null,
  });
  const spotWindow = windowOf(spotHourly);
  const indexWindow = windowOf(indexHourly);
  const staleSpot = detectStaleness(`rToken spot 1H (${pair.rTokenSymbol})`, spotWindow?.toTs ?? null, now, STALE_TOLERANCE_MS);
  const staleIndex = detectStaleness(`index 1H (${pair.perpSymbol})`, indexWindow?.toTs ?? null, now, STALE_TOLERANCE_MS);
  if (staleSpot) flags.push(staleSpot);
  if (staleIndex) flags.push(staleIndex);
  const quality = buildQualityReport(flags);

  const liquidity = buildLiquidityProfile(book, fills, spotTicker, perpTicker, now);
  const derivs = derivatives(fundingRaw, oiRaw);
  const joinOnly = joinByTimestamp(spotHourly, indexHourly);

  const degraded = collector.records.some((r) => r.status !== "ok");
  const pack: EvidencePack = {
    base: pair.base,
    rTokenSymbol: pair.rTokenSymbol,
    perpSymbol: pair.perpSymbol,
    generatedAt: now,
    mode,
    degraded,
    observationWindow: windowOf(series),
    snapshot,
    bySession,
    weekendDislocationRatio: bySession ? weekendDislocationRatio(bySession) : null,
    perpTrackingRatio: perpTrackingRatio(series),
    currentRunHours: currentRunLength(series, 0.5),
    series,
    premium,
    joinStats: joinOnly.stats,
    reference: referenceComposition(pair.perpSymbol, indexCompRaw),
    liquidity,
    derivatives: derivs,
    analogues: findAnalogues(series, options.analogueCount ?? 5),
    episodes: groupEpisodes(series, options.episodeThresholdPct ?? 0.5),
    exceedances: exceedanceCounts(series),
    quality,
    sources: collector.records,
    provenance: collector.provenance,
  };

  log.info("evidence.built", {
    base: pair.base,
    mode,
    hours: series.length,
    degraded,
    sources: collector.records.length,
    latencyMs: Date.now() - now,
  });
  return { ok: true, pack };
}