// T-235 part 1: the pure helpers of the run claims: staleness (3 h), Regenerate availability (30 min), parsing the RPC row.
import { describe, expect, it } from "vitest";
import { briefingRunStateFrom, isStale, regenerateAvailableAt, STALE_AFTER_MS } from "./briefing-runs";

const NOW = Date.parse("2026-11-12T15:00:00Z");

describe("briefing runs", () => {
  it("stale after 3 hours, or with no briefing", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(new Date(NOW - STALE_AFTER_MS + 1000).toISOString(), NOW)).toBe(false);
    expect(isStale(new Date(NOW - STALE_AFTER_MS - 1000).toISOString(), NOW)).toBe(true);
    expect(isStale("not a date", NOW)).toBe(true);
  });
  it("Regenerate is available 30 minutes after the last one", () => {
    expect(regenerateAvailableAt(null, NOW)).toBeNull();
    expect(regenerateAvailableAt(new Date(NOW - 31 * 60_000).toISOString(), NOW)).toBeNull();
    expect(regenerateAvailableAt(new Date(NOW - 10 * 60_000).toISOString(), NOW)).toBe(NOW + 20 * 60_000);
  });
  it("parses the one-row RPC result; anything else is null", () => {
    expect(briefingRunStateFrom([{ running: false, last_regenerate_at: null, runs_today: 3, latest_prepared_at: "2026-11-12T10:00:00Z", last_attempt_at: "junk" }])).toEqual({ running: false, lastRegenerateAt: null, runsToday: 3, latestPreparedAt: "2026-11-12T10:00:00Z", lastAttemptAt: null });
    expect(briefingRunStateFrom([])).toBeNull();
    expect(briefingRunStateFrom(null)).toBeNull();
    expect(briefingRunStateFrom([{ running: "yes" }])).toBeNull();
  });
});
