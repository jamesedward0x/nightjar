/**
 * Session classification, with the DST transition as the headline case.
 * DECISION.md 2.6 F8: RTH is 13:30-20:00 UTC under EDT and 14:30-21:00 UTC under EST.
 * A hardcoded UTC offset would pass every summer test and silently misclassify every
 * winter hour, so both are asserted here against the same wall-clock session.
 */

import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  NY_ZONE,
  RTH_END_MINUTE,
  RTH_START_MINUTE,
  classifySession,
  rthBoundsUtc,
  sessionOf,
} from "@/lib/compute/sessions";

const utc = (iso: string): number => DateTime.fromISO(iso, { zone: "utc" }).toMillis();

describe("classifySession - EDT (summer)", () => {
  it("treats 09:30-16:00 New York as regular trading hours", () => {
    expect(sessionOf(utc("2026-07-15T13:30:00Z"))).toBe("rth"); // 09:30 EDT
    expect(sessionOf(utc("2026-07-15T19:59:00Z"))).toBe("rth"); // 15:59 EDT
  });

  it("is exclusive at the 16:00 close and inclusive at the 09:30 open", () => {
    expect(sessionOf(utc("2026-07-15T13:29:00Z"))).toBe("offhours"); // 09:29
    expect(sessionOf(utc("2026-07-15T20:00:00Z"))).toBe("offhours"); // 16:00
  });

  it("reports New York as being on daylight saving time", () => {
    expect(classifySession(utc("2026-07-15T15:00:00Z")).dst).toBe(true);
    expect(classifySession(utc("2026-07-15T15:00:00Z")).nyOffsetMinutes).toBe(-240);
  });
});

describe("classifySession - EST (winter)", () => {
  it("shifts the same wall-clock session one hour later in UTC", () => {
    expect(sessionOf(utc("2026-01-15T14:30:00Z"))).toBe("rth"); // 09:30 EST
    expect(sessionOf(utc("2026-01-15T20:59:00Z"))).toBe("rth"); // 15:59 EST
    // The summer boundaries are NOT rth in winter - this is the regression F8 warns about.
    expect(sessionOf(utc("2026-01-15T13:30:00Z"))).toBe("offhours"); // 08:30 EST
    expect(sessionOf(utc("2026-01-15T21:00:00Z"))).toBe("offhours"); // 16:00 EST
  });

  it("reports standard time", () => {
    expect(classifySession(utc("2026-01-15T15:00:00Z")).dst).toBe(false);
    expect(classifySession(utc("2026-01-15T15:00:00Z")).nyOffsetMinutes).toBe(-300);
  });
});

describe("classifySession - weekend boundary is New York, not UTC", () => {
  it("classifies a New York Saturday as weekend", () => {
    // 2026-08-29 is the Saturday of the largest dislocation episode in the sample.
    expect(sessionOf(utc("2026-08-29T13:00:00Z"))).toBe("weekend");
  });

  it("classifies UTC Monday 00:00 as weekend because New York is still in Sunday", () => {
    expect(sessionOf(utc("2026-08-03T00:00:00Z"))).toBe("weekend"); // Sun 20:00 EDT
    expect(sessionOf(utc("2026-08-03T04:00:00Z"))).toBe("offhours"); // Mon 00:00 EDT
  });

  it("never marks a weekend hour as reference-market-open", () => {
    expect(classifySession(utc("2026-08-29T13:00:00Z")).referenceMarketOpen).toBe(false);
    expect(classifySession(utc("2026-07-15T15:00:00Z")).referenceMarketOpen).toBe(true);
  });
});

describe("rthBoundsUtc", () => {
  it("moves with the DST transition", () => {
    const summer = rthBoundsUtc(utc("2026-07-15T15:00:00Z"));
    const winter = rthBoundsUtc(utc("2026-01-15T15:00:00Z"));
    expect(DateTime.fromMillis(summer.startMs).toUTC().toISO()).toContain("T13:30");
    expect(DateTime.fromMillis(winter.startMs).toUTC().toISO()).toContain("T14:30");
    expect(winter.startMs - summer.startMs).not.toBe(0);
  });

  it("spans exactly the configured session length", () => {
    const bounds = rthBoundsUtc(utc("2026-07-15T15:00:00Z"));
    expect(bounds.endMs - bounds.startMs).toBe((RTH_END_MINUTE - RTH_START_MINUTE) * 60_000);
  });
});

it("exposes the zone it classifies in", () => {
  expect(NY_ZONE).toBe("America/New_York");
});