/**
 * Session classification in America/New_York. DECISION.md 2.6 F8.
 *
 * RTH is 09:30-16:00 ET, which is 13:30-20:00 UTC under EDT and 14:30-21:00 UTC
 * under EST. Hardcoding a UTC offset would silently rot every March and November, so
 * every boundary here is computed from the real zone via luxon. The DST test in
 * tests/unit/sessions.test.ts asserts the UTC window actually moves.
 *
 * Three kinds, matching the buckets the findings are reported in:
 *   rth      - NYSE regular trading hours on a weekday
 *   offhours - weekday, outside RTH (pre-market, evening, and the overnight gap)
 *   weekend  - NY Saturday or Sunday, i.e. the reference market is shut entirely
 *
 * The weekend boundary is NY-based, not UTC-based. That matters: UTC Saturday 00:00
 * is still Friday evening in New York. Using a UTC day would move ~3 hours of the
 * recorded AAPL sample between buckets and blur the very effect we are measuring.
 */

import { DateTime } from "luxon";

export const NY_ZONE = "America/New_York";

/** 09:30 ET in minutes since NY midnight. */
export const RTH_START_MINUTE = 9 * 60 + 30;
/** 16:00 ET in minutes since NY midnight (exclusive upper bound). */
export const RTH_END_MINUTE = 16 * 60;

export type SessionKind = "rth" | "offhours" | "weekend";

export const SESSION_LABELS: Record<SessionKind, string> = {
  rth: "Regular trading hours (09:30-16:00 ET)",
  offhours: "Weekday off-hours",
  weekend: "Weekend - reference market closed",
};

export interface SessionInfo {
  kind: SessionKind;
  /** True only during RTH, i.e. when the reference market is actually pricing. */
  referenceMarketOpen: boolean;
  ny: { iso: string; weekday: number; hour: number; minute: number };
  /** True when New York is on daylight saving time at this instant. */
  dst: boolean;
  /** UTC offset of New York at this instant, in minutes (-240 EDT, -300 EST). */
  nyOffsetMinutes: number;
  label: string;
}

/** Classify one instant. Pure: no clock reads, the timestamp is the only input. */
export function classifySession(ts: number): SessionInfo {
  const dt = DateTime.fromMillis(ts, { zone: NY_ZONE });
  const weekday = dt.weekday; // 1 = Mon .. 7 = Sun
  const minuteOfDay = dt.hour * 60 + dt.minute;
  const kind: SessionKind =
    weekday >= 6 ? "weekend" : minuteOfDay >= RTH_START_MINUTE && minuteOfDay < RTH_END_MINUTE ? "rth" : "offhours";
  return {
    kind,
    referenceMarketOpen: kind === "rth",
    ny: { iso: dt.toISO() ?? dt.toUTC().toISO() ?? "", weekday, hour: dt.hour, minute: dt.minute },
    dst: dt.isInDST,
    nyOffsetMinutes: dt.offset,
    label: SESSION_LABELS[kind],
  };
}

/**
 * The UTC bounds of the RTH session for the NY calendar day containing ts.
 * Used to draw session bands on the basis chart without recomputing per point.
 */
export function rthBoundsUtc(ts: number): { startMs: number; endMs: number } {
  const day = DateTime.fromMillis(ts, { zone: NY_ZONE }).startOf("day");
  const start = day.plus({ minutes: RTH_START_MINUTE });
  const end = day.plus({ minutes: RTH_END_MINUTE });
  return { startMs: start.toUTC().toMillis(), endMs: end.toUTC().toMillis() };
}

/** Which kind a whole hour bucket belongs to, labelled for charts and tables. */
export function sessionOf(ts: number): SessionKind {
  return classifySession(ts).kind;
}