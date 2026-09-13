/**
 * Fixture loading. Fixtures are RECORDED snapshots of real Bitget responses
 * (scripts/record-fixtures.mjs), never hand-authored numbers.
 *
 * Two hard rules from DECISION.md 7.7:
 *   1. Fixtures are only ever served when NIGHTJAR_MODE=fixture, and the UI must
 *      then show a permanent "FIXTURE MODE - recorded data, NOT live" banner.
 *   2. Every fixture datum carries its ORIGINAL recording timestamp, so a judge
 *      can never mistake a snapshot for a live price.
 *
 * Matching is exact on path + query. A symbol we never recorded is a hard miss,
 * not a silent substitution - returning AAPL data for an MSFT question would be
 * the single worst thing this app could do.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { NightjarError } from "@/lib/bitget/errors";

export const FIXTURE_VERSION = 1;

const recordedResponseSchema = z
  .object({
    code: z.string(),
    msg: z.string().nullish(),
    requestTime: z.union([z.string(), z.number()]).nullish(),
    data: z.unknown(),
  })
  .passthrough();

export const fixtureSchema = z.object({
  fixtureVersion: z.number(),
  name: z.string(),
  recordedAt: z.string(),
  endpoint: z.string(),
  request: z.object({
    path: z.string(),
    query: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
  httpStatus: z.number(),
  latencyMs: z.number(),
  response: recordedResponseSchema,
  truncated: z
    .object({ originalLength: z.number(), keptLength: z.number() })
    .nullish(),
});

export type Fixture = z.infer<typeof fixtureSchema>;

export type FixtureQuery = Record<string, string | number | undefined>;

/** Canonical match key: path + sorted, stringified, non-empty query params. */
export function fixtureKey(path: string, query: FixtureQuery = {}): string {
  const parts: string[] = [];
  for (const name of Object.keys(query).sort()) {
    const value = query[name];
    if (value === undefined || value === null || value === "") continue;
    parts.push(name + "=" + String(value));
  }
  return path + (parts.length ? "?" + parts.join("&") : "");
}

export class FixtureMissError extends NightjarError {
  readonly key: string;
  constructor(key: string, available: string[]) {
    super(
      "fixture_miss",
      "No recorded fixture for " +
        key +
        ". Recorded: " +
        (available.length ? available.join(", ") : "(none)") +
        ". Re-run pnpm record-fixtures, or switch NIGHTJAR_MODE to live.",
    );
    this.name = "FixtureMissError";
    this.key = key;
  }
}

function fixtureDir(): string {
  return join(process.cwd(), "lib", "fixtures");
}

interface FixtureIndex {
  /** match key -> fixture file name (relative to lib/fixtures) */
  byKey: Map<string, string>;
  /** fixture name -> file name */
  byName: Map<string, string>;
  recordedAt: string | null;
}

let indexCache: FixtureIndex | null = null;

/**
 * Build the lookup index from the files actually on disk. The recorder writes a
 * sidecar index.json; if it is missing or stale we fall back to reading each
 * fixture's own request block, so the loader never depends on a build step.
 */
function buildIndex(): FixtureIndex {
  const dir = fixtureDir();
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  let recordedAt: string | null = null;

  const sidecarPath = join(dir, "index.json");
  if (existsSync(sidecarPath)) {
    try {
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
        recordedAt?: string;
        entries?: Array<{ key: string; name: string; file: string }>;
      };
      recordedAt = sidecar.recordedAt ?? null;
      for (const entry of sidecar.entries ?? []) {
        byKey.set(entry.key, entry.file);
        byName.set(entry.name, entry.file);
      }
      if (byKey.size > 0) return { byKey, byName, recordedAt };
    } catch {
      // Fall through to the scan; a corrupt sidecar must not take fixture mode down.
    }
  }

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { byKey, byName, recordedAt };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    recordedAt?: string;
    fixtures?: Array<{ name: string; file: string }>;
  };
  recordedAt = manifest.recordedAt ?? null;

  for (const entry of manifest.fixtures ?? []) {
    const absolute = join(process.cwd(), entry.file);
    if (!existsSync(absolute)) continue;
    try {
      const parsed = fixtureSchema.parse(JSON.parse(readFileSync(absolute, "utf8")));
      byKey.set(fixtureKey(parsed.request.path, parsed.request.query), entry.file);
      byName.set(parsed.name, entry.file);
    } catch {
      // Skip an unparseable fixture rather than failing the whole index.
    }
  }
  return { byKey, byName, recordedAt };
}

function index(): FixtureIndex {
  if (!indexCache) indexCache = buildIndex();
  return indexCache;
}

/** Test/diagnostic hook. */
export function resetFixtureIndex(): void {
  indexCache = null;
}

export function listFixtureKeys(): string[] {
  return [...index().byKey.keys()].sort();
}

export function fixtureMeta(): { count: number; recordedAt: string | null; keys: string[] } {
  const idx = index();
  return { count: idx.byKey.size, recordedAt: idx.recordedAt, keys: [...idx.byKey.keys()].sort() };
}

function readFixtureFile(file: string): Fixture {
  const absolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) ? file : join(process.cwd(), file);
  return fixtureSchema.parse(JSON.parse(readFileSync(absolute, "utf8")));
}

/** Load one recorded fixture by exact request match. Throws FixtureMissError on a miss. */
export function loadFixture(path: string, query: FixtureQuery = {}): Fixture {
  const key = fixtureKey(path, query);
  const idx = index();
  const file = idx.byKey.get(key);
  if (!file) throw new FixtureMissError(key, [...idx.byKey.keys()].sort());
  return readFixtureFile(file);
}

/** Load by fixture name (used by contract tests, which assert name-by-name). */
export function loadFixtureByName(name: string): Fixture {
  const idx = index();
  const file = idx.byName.get(name);
  if (!file) throw new FixtureMissError("name:" + name, [...idx.byName.keys()].sort());
  return readFixtureFile(file);
}

/**
 * Present a recorded fixture as if it had just come off the wire.
 * requestTime is the RECORDING time, which is the honest "as of" for this datum.
 */
export function fixtureAsEnvelope(fixture: Fixture): {
  code: string;
  msg?: string;
  requestTime?: number;
  data: unknown;
  endpoint: string;
  recordedAt: string;
  truncated: { originalLength: number; keptLength: number } | null;
} {
  const raw = Number(fixture.response.requestTime);
  return {
    code: fixture.response.code,
    msg: typeof fixture.response.msg === "string" ? fixture.response.msg : undefined,
    requestTime: Number.isFinite(raw) && raw > 0 ? raw : Date.parse(fixture.recordedAt),
    data: fixture.response.data,
    endpoint: fixture.endpoint,
    recordedAt: fixture.recordedAt,
    truncated: fixture.truncated ?? null,
  };
}
