/**
 * Bitget v3 sends every scalar as a string, and uses "" and the literal "null"
 * as sentinels for "absent". These helpers are the ONLY place that knows this.
 */

const ABSENT = new Set(["", "null", "undefined", "NULL", "none"]);

/** Parse a wire scalar into a finite number, or null when the API means "absent". */
export function toNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (ABSENT.has(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a wire millisecond timestamp into a number, or null. */
export function toTs(value: unknown): number | null {
  const n = toNum(value);
  return n !== null && n > 0 ? n : null;
}

/** Strict variant for fields that must be present and numeric. */
export function requireNum(value: unknown, field: string): number {
  const n = toNum(value);
  if (n === null) throw new Error("Expected a numeric value for " + field + ", got " + JSON.stringify(value));
  return n;
}

export function isAbsent(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && ABSENT.has(value.trim()));
}
