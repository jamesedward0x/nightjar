/**
 * Client-side formatting. Pure functions over numbers the server already computed.
 *
 * Nothing here derives a figure: a formatter that rounds a basis into a different
 * basis is how a research tool starts lying. lib/compute/stats.ts has no imports, so
 * `round` is safe to bring into the browser bundle; luxon and zod are not, and are not.
 */

import { round } from "@/lib/compute/stats";
import type { SessionKind } from "@/lib/compute/types";

export function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Signed percent, e.g. +0.0573% / -0.1200%. The sign is the whole point of the product. */
export function pct(value: number | null | undefined, digits = 3): string {
  if (!isNum(value)) return "n/a";
  return (value >= 0 ? "+" : "") + round(value, digits).toFixed(digits) + "%";
}

/** Unsigned percent for spread, mean absolute basis, slippage. */
export function plainPct(value: number | null | undefined, digits = 3): string {
  if (!isNum(value)) return "n/a";
  return round(value, digits).toFixed(digits) + "%";
}

export function usd(value: number | null | undefined, digits = 0): string {
  if (!isNum(value)) return "n/a";
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function num(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return "n/a";
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function times(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return "n/a";
  return round(value, digits).toFixed(digits) + "x";
}

export function int(value: number | null | undefined): string {
  if (!isNum(value)) return "n/a";
  return String(Math.round(value));
}

/** "2026-08-29 13:00Z" - short form for axes and table cells. */
export function utcShort(ts: number | null | undefined): string {
  if (!isNum(ts)) return "n/a";
  return new Date(ts).toISOString().replace("T", " ").slice(5, 16) + "Z";
}

/** "2026-08-29 13:00:00 UTC" - full form for the headline as-of. */
export function utcFull(ts: number | null | undefined): string {
  if (!isNum(ts)) return "unknown";
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function duration(ms: number | null | undefined): string {
  if (!isNum(ms)) return "n/a";
  if (ms < 1000) return Math.round(ms) + "ms";
  return round(ms / 1000, 1).toFixed(1) + "s";
}

export function ago(ms: number | null | undefined): string {
  if (!isNum(ms)) return "n/a";
  if (ms < 60_000) return Math.max(0, Math.round(ms / 1000)) + "s ago";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m ago";
  return round(ms / 3_600_000, 1).toFixed(1) + "h ago";
}

/** Thousands-of-characters, for the trace panel's payload sizes. */
export function chars(n: number | null | undefined): string {
  if (!isNum(n)) return "";
  return n >= 1000 ? round(n / 1000, 1).toFixed(1) + " KB" : n + " B";
}

export function signClass(value: number | null | undefined): "pos" | "neg" | "flat" {
  if (!isNum(value)) return "flat";
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "flat";
}

export const SESSION_LABELS: Record<SessionKind, string> = {
  rth: "Regular hours",
  offhours: "Off hours",
  weekend: "Weekend",
};

export const SESSION_SHORT: Record<SessionKind, string> = {
  rth: "RTH",
  offhours: "OFF",
  weekend: "WKD",
};

/** Truncate long model strings for compact rows; the full text lives in the memo. */
export function clip(text: string, max = 160): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "\u2026";
}