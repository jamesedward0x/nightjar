/**
 * TIMESTAMP-KEYED joins only. DECISION.md 2.6 F7.
 *
 * Of 1,000 recorded rToken spot hourly rows, 70 had no matching index timestamp -
 * the two series start on different days and contain different gaps. An earlier
 * positional join silently paired unrelated hours and produced a FALSE narrative
 * ("rToken stuck at 326 while the index ran to 335") that the timestamp-keyed join
 * disproved. Any code that aligns these series by array position publishes wrong
 * research, so the positional variant is exported under a name that cannot be
 * mistaken for safe, and tests/unit/join.test.ts proves the two disagree.
 */

import { indexByTs } from "@/lib/compute/candles";
import type { Candle, JoinedRow } from "@/lib/compute/types";

export interface JoinStats {
  leftRows: number;
  rightRows: number;
  matched: number;
  /** Left rows with no partner. Reported, never silently dropped. */
  droppedLeft: number;
}

export interface JoinResult {
  rows: JoinedRow[];
  stats: JoinStats;
  fromTs: number | null;
  toTs: number | null;
}

/**
 * Inner-join two series on exact ts equality. Output is ascending and contains only
 * hours present in BOTH series - a basis computed against a missing partner is not a
 * basis, it is a fabrication.
 */
export function joinByTimestamp(left: Candle[], right: Candle[]): JoinResult {
  const rightByTs = indexByTs(right);
  const rows: JoinedRow[] = [];
  for (const candle of left) {
    const partner = rightByTs.get(candle.ts);
    if (partner === undefined) continue;
    rows.push({ ts: candle.ts, left: candle, right: partner });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    rows,
    stats: {
      leftRows: left.length,
      rightRows: right.length,
      matched: rows.length,
      droppedLeft: left.length - rows.length,
    },
    fromTs: first ? first.ts : null,
    toTs: last ? last.ts : null,
  };
}

/** Three-way join: left/right required, third optional and possibly sparse. */
export function joinWithOptional(
  left: Candle[],
  right: Candle[],
  optional: Candle[] | null,
): { rows: JoinedRow[]; optionalByTs: Map<number, Candle>; stats: JoinStats } {
  const joined = joinByTimestamp(left, right);
  return {
    rows: joined.rows,
    optionalByTs: indexByTs(optional ?? []),
    stats: joined.stats,
  };
}

/**
 * UNSAFE - EXISTS ONLY SO A TEST CAN PROVE IT IS WRONG.
 * Pairs rows by array index with no regard for timestamps. Never call from app code.
 */
export function unsafePositionalJoin_DO_NOT_USE(left: Candle[], right: Candle[]): JoinedRow[] {
  const n = Math.min(left.length, right.length);
  const rows: JoinedRow[] = [];
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    if (!l || !r) continue;
    rows.push({ ts: l.ts, left: l, right: r });
  }
  return rows;
}