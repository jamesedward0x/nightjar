/**
 * The research universe: which tokenized US equities have BOTH a spot rToken and a
 * USDT perpetual, and which have only the perpetual.
 *
 * Why this file exists separately from endpoints.ts: everything Nightjar claims is
 * a comparison between an rToken and the reference price its perp settles against.
 * That comparison is only meaningful for a name that exists on both venues, so the
 * dual-listed set is the app's actual domain. Deriving it once, caching it, and
 * resolving every user-supplied symbol through it is what stops us from answering
 * a question about a name we cannot price.
 *
 * The derivation rule (verified against the 2026-09-13 recording, 787 futures rows
 * and 1,761 spot rows -> exactly 207 dual-listed / 93 perp-only, no collisions):
 *
 *   1. Futures side: symbolType === "stock" AND quoteCoin === "USDT"  -> 300 rows.
 *      baseCoin is the bare ticker (AAPL). This is the authoritative list of
 *      tokenized-equity perps; it is what defines a "name" for us.
 *   2. Spot side: symbolType === "stock" -> 1,175 rows. An rToken's baseCoin is
 *      the ticker with a lower-case "r" prefix (rAAPL) and its symbol is that plus
 *      the quote coin (RAAPLUSDT).
 *   3. Join on EXACT string equality: spotBaseCoin === "r" + futuresBaseCoin.
 *
 * Two deliberate non-shortcuts in step 3:
 *   - Case matters. Bitget uses a lower-case "r" prefix, and upper-casing both
 *     sides would silently merge unrelated names.
 *   - No fuzzy or prefix matching. Spot carries pre-IPO rows whose baseCoin does
 *     NOT start with "r" (preSPCX, preOPAI as recorded). A "starts with r" or
 *     "contains" rule would wrongly pair the OPENAI perp with preOPAI. Exact
 *     equality keeps OPENAI in perpOnly, which is the truth.
 *
 * The universe is derived from the two /instruments calls, so it inherits their
 * 6h TTL and their provenance. It is never hand-maintained.
 */

import { bitgetCache, ttlFor } from "@/lib/bitget/cache";
import type { TransportSource } from "@/lib/bitget/client";
import { FUTURES, SPOT, getInstruments } from "@/lib/bitget/endpoints";
import { UnknownSymbolError, UpstreamDegradedError } from "@/lib/bitget/errors";
import { classifyError, safeInvoke, type SafeOk, type SafeResult } from "@/lib/bitget/safe-invoke";
import { toTs } from "@/lib/bitget/decode";
import { createLogger } from "@/lib/observability/logger";
import type { Instrument } from "@/lib/schema/bitget";

const log = createLogger("bitget.universe");

/** Bitget's rToken prefix. Lower-case, exact. See the file header before changing this. */
export const RTOKEN_PREFIX = "r";
/** The only quote coin a tokenized-equity perp settles in. */
export const UNIVERSE_QUOTE_COIN = "USDT";
export const UNIVERSE_SYMBOL_TYPE = "stock";
export const UNIVERSE_CACHE_KEY = "universe";

/** A name that trades on both venues - the only kind Nightjar can fully analyse. */
export interface DualListedPair {
  /** Bare ticker, e.g. "AAPL". The canonical key for a name. */
  base: string;
  /** USDT perpetual symbol, e.g. "AAPLUSDT". Use for index/premium candles, funding, OI. */
  perpSymbol: string;
  /** Spot rToken symbol, e.g. "RAAPLUSDT". Use for spot candles, orderbook, fills. */
  rTokenSymbol: string;
  /** Spot rToken base coin, e.g. "rAAPL". */
  rTokenBaseCoin: string;
  perpStatus: string;
  rTokenStatus: string;
  perpLaunchTime: number | null;
  rTokenLaunchTime: number | null;
}

/** A perp with no spot rToken. Still researchable against its own index, but there is no basis to compute. */
export interface PerpOnlySymbol {
  base: string;
  perpSymbol: string;
  status: string;
}

export interface UniverseCounts {
  /** Futures rows with symbolType=stock and quoteCoin=USDT. */
  futuresStock: number;
  /** Spot rows with symbolType=stock (includes pre-IPO rows that are not rTokens). */
  spotStock: number;
  dualListed: number;
  perpOnly: number;
}

/** Where this snapshot came from. Carried so the UI can label the universe with a real "as of". */
export interface UniverseProvenance {
  source: TransportSource;
  spotEndpoint: string;
  futuresEndpoint: string;
  spotTime: number | null;
  futuresTime: number | null;
  spotRecordedAt: string | null;
  futuresRecordedAt: string | null;
}

export interface Universe {
  pairs: DualListedPair[];
  perpOnly: PerpOnlySymbol[];
  counts: UniverseCounts;
  /**
   * The OLDER of the two /instruments timestamps. A derived view is only as fresh
   * as its stalest input, so this is deliberately not the newer one.
   */
  asOf: number | null;
  provenance: UniverseProvenance;
}

function isStock(row: Instrument): boolean {
  return row.symbolType === UNIVERSE_SYMBOL_TYPE;
}

function isUniversePerp(row: Instrument): boolean {
  return isStock(row) && row.quoteCoin === UNIVERSE_QUOTE_COIN;
}

function statusOf(row: Instrument): string {
  return row.status ?? "";
}

function oldest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** The same "stalest input wins" rule as oldest(), for ISO recording stamps. */
function oldestRecording(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

/**
 * Pure derivation. Split out from the fetch so tests can run it against recorded
 * fixtures and assert the 207 / 93 split without touching the network or the cache.
 */
export function deriveUniverse(spot: Instrument[], futures: Instrument[], provenance: UniverseProvenance): Universe {
  const spotStock = spot.filter(isStock);
  // First row wins on a duplicate baseCoin. The 2026-09-13 recording has none; this
  // keeps a future duplicate from producing two pairs for one name.
  const spotByBaseCoin = new Map<string, Instrument>();
  for (const row of spotStock) {
    if (!spotByBaseCoin.has(row.baseCoin)) spotByBaseCoin.set(row.baseCoin, row);
  }

  const futuresStock = futures.filter(isUniversePerp);
  const pairs: DualListedPair[] = [];
  const perpOnly: PerpOnlySymbol[] = [];

  for (const perp of futuresStock) {
    const rToken = spotByBaseCoin.get(RTOKEN_PREFIX + perp.baseCoin);
    if (rToken) {
      pairs.push({
        base: perp.baseCoin,
        perpSymbol: perp.symbol,
        rTokenSymbol: rToken.symbol,
        rTokenBaseCoin: rToken.baseCoin,
        perpStatus: statusOf(perp),
        rTokenStatus: statusOf(rToken),
        perpLaunchTime: toTs(perp.launchTime),
        rTokenLaunchTime: toTs(rToken.launchTime),
      });
    } else {
      perpOnly.push({ base: perp.baseCoin, perpSymbol: perp.symbol, status: statusOf(perp) });
    }
  }

  pairs.sort((left, right) => left.base.localeCompare(right.base));
  perpOnly.sort((left, right) => left.base.localeCompare(right.base));

  const universe: Universe = {
    pairs,
    perpOnly,
    counts: {
      futuresStock: futuresStock.length,
      spotStock: spotStock.length,
      dualListed: pairs.length,
      perpOnly: perpOnly.length,
    },
    asOf: oldest(provenance.spotTime, provenance.futuresTime),
    provenance,
  };

  log.debug("universe.derived", {
    dualListed: universe.counts.dualListed,
    perpOnly: universe.counts.perpOnly,
    futuresStock: universe.counts.futuresStock,
    spotStock: universe.counts.spotStock,
    source: provenance.source,
  });
  return universe;
}

// ------------------------------------------------------------------- resolution

interface UniverseIndex {
  byBase: Map<string, DualListedPair>;
  byPerpSymbol: Map<string, DualListedPair>;
  byRTokenSymbol: Map<string, DualListedPair>;
  byRTokenBaseCoin: Map<string, DualListedPair>;
}

const indexCache = new WeakMap<Universe, UniverseIndex>();

function indexOf(universe: Universe): UniverseIndex {
  const existing = indexCache.get(universe);
  if (existing) return existing;
  const index: UniverseIndex = {
    byBase: new Map(),
    byPerpSymbol: new Map(),
    byRTokenSymbol: new Map(),
    byRTokenBaseCoin: new Map(),
  };
  for (const pair of universe.pairs) {
    index.byBase.set(pair.base.toUpperCase(), pair);
    index.byPerpSymbol.set(pair.perpSymbol.toUpperCase(), pair);
    index.byRTokenSymbol.set(pair.rTokenSymbol.toUpperCase(), pair);
    index.byRTokenBaseCoin.set(pair.rTokenBaseCoin.toUpperCase(), pair);
  }
  indexCache.set(universe, index);
  return index;
}

/**
 * Resolve anything a human or the model might say into one dual-listed pair.
 * Accepts AAPL, aaplusdt, RAAPLUSDT, raapl - case-insensitively, but only against
 * the four exact forms above. Returns null rather than guessing: an unmatched
 * symbol must surface as "not in the universe", never as a near-miss answer.
 */
export function matchPair(universe: Universe, input: string): DualListedPair | null {
  const needle = input.trim().toUpperCase();
  if (!needle) return null;
  const index = indexOf(universe);
  return (
    index.byBase.get(needle) ??
    index.byPerpSymbol.get(needle) ??
    index.byRTokenSymbol.get(needle) ??
    index.byRTokenBaseCoin.get(needle) ??
    null
  );
}

/** True when input names a perp that has no spot rToken (so no basis is computable). */
export function isPerpOnly(universe: Universe, input: string): boolean {
  const needle = input.trim().toUpperCase();
  return universe.perpOnly.some((row) => row.base.toUpperCase() === needle || row.perpSymbol.toUpperCase() === needle);
}

// ----------------------------------------------------------------------- fetch

async function loadUniverse(): Promise<Universe> {
  const [spotResult, futuresResult] = await Promise.all([getInstruments(SPOT), getInstruments(FUTURES)]);
  if (!spotResult.ok) {
    throw new UpstreamDegradedError("bitget-rest", "SPOT /instruments unavailable: " + spotResult.error.kind + " - " + spotResult.error.message);
  }
  if (!futuresResult.ok) {
    throw new UpstreamDegradedError("bitget-rest", "USDT-FUTURES /instruments unavailable: " + futuresResult.error.kind + " - " + futuresResult.error.message);
  }
  return deriveUniverse(spotResult.data, futuresResult.data, {
    source: spotResult.source,
    spotEndpoint: spotResult.endpoint,
    futuresEndpoint: futuresResult.endpoint,
    spotTime: spotResult.upstreamTime,
    futuresTime: futuresResult.upstreamTime,
    spotRecordedAt: spotResult.recordedAt,
    futuresRecordedAt: futuresResult.recordedAt,
  });
}

/**
 * The cached universe. Both /instruments calls are themselves cached, so a warm
 * process pays nothing here; a cold one pays two keyless GETs and then derives.
 */
export async function getUniverse(): Promise<SafeResult<Universe>> {
  const result = await safeInvoke("bitget-rest", UNIVERSE_CACHE_KEY, async () => {
    const wrapped = await bitgetCache.wrap(UNIVERSE_CACHE_KEY, ttlFor("universe"), loadUniverse);
    if (wrapped.fromCache || wrapped.coalesced) log.debug("universe.cache", { fromCache: wrapped.fromCache, coalesced: wrapped.coalesced });
    return wrapped.value;
  });
  return result.ok ? stampProvenance(result) : result;
}

/**
 * safeInvoke cannot know a DERIVED view's provenance, so it defaults recordedAt and
 * upstreamTime to null. The universe already carries both inputs' stamps, so lift them
 * onto the result: the UI reads "fixture - recorded <when>" from recordedAt and "as of"
 * from upstreamTime. Leaving them null would render a fixture-backed universe as
 * unlabelled data, which DECISION.md 7.7 forbids.
 */
function stampProvenance(result: SafeOk<Universe>): SafeOk<Universe> {
  const { spotRecordedAt, futuresRecordedAt } = result.data.provenance;
  return {
    ...result,
    upstreamTime: result.data.asOf,
    recordedAt: oldestRecording(spotRecordedAt, futuresRecordedAt),
  };
}

/** Resolve a user- or model-supplied symbol to a dual-listed pair, or explain why not. */
export async function findPair(input: string): Promise<SafeResult<DualListedPair>> {
  const universe = await getUniverse();
  if (!universe.ok) return universe;
  const pair = matchPair(universe.data, input);
  if (!pair) {
    const reason = isPerpOnly(universe.data, input)
      ? " has a Bitget perpetual but no spot rToken, so there is no rToken-vs-reference basis to research."
      : " is not a dual-listed tokenized equity on Bitget.";
    return {
      ok: false,
      error: { ...classifyError(new UnknownSymbolError(input)), message: input.trim() + reason },
      source: universe.source,
      endpoint: UNIVERSE_CACHE_KEY + ":match",
      fetchedAt: Date.now(),
      latencyMs: 0,
    };
  }
  return { ...universe, data: pair, endpoint: UNIVERSE_CACHE_KEY + ":match" };
}

/** Test hook: drop the cached universe without touching the instruments cache. */
export function resetUniverse(): void {
  bitgetCache.delete(UNIVERSE_CACHE_KEY);
}
