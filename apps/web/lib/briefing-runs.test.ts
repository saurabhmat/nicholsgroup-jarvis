// T-235 part 1: the pure helpers of the run claims: staleness (3 h), Regenerate availability (30 min), parsing the RPC row.
import { describe, expect, it } from "vitest";
import { briefingRunStateFrom, hasSyncedMail, hasUsableSource, isStale, needsRenewal, regenerateAvailableAt, STALE_AFTER_MS } from "./briefing-runs";

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
    expect(briefingRunStateFrom([{ running: false, last_regenerate_at: null, runs_today: 3, latest_prepared_at: "2026-11-12T10:00:00Z", last_attempt_at: "junk" }])).toEqual({ running: false, lastRegenerateAt: null, runsToday: 3, latestPreparedAt: "2026-11-12T10:00:00Z", lastAttemptAt: null, sourcesNewer: false });
    expect(briefingRunStateFrom([])).toBeNull();
    expect(briefingRunStateFrom(null)).toBeNull();
    expect(briefingRunStateFrom([{ running: "yes" }])).toBeNull();
  });
  it("T-270: renewal is asked for when the summary is old OR was made before the newest connection first synced", () => {
    const fresh = new Date(NOW - 60_000).toISOString();
    expect(needsRenewal(fresh, NOW, false)).toBe(false);
    expect(needsRenewal(fresh, NOW, true)).toBe(true);
    expect(needsRenewal(null, NOW, false)).toBe(true);
    expect(needsRenewal(new Date(NOW - STALE_AFTER_MS - 1000).toISOString(), NOW, false)).toBe(true);
  });
  it("T-270: a usable source is an own mail connection in use; the 'nothing set up' marker, a pending, an expired or a calendar-only row is not", () => {
    expect(hasUsableSource([{ stream: "mail", connectionId: "c1", status: "active" }])).toBe(true);
    expect(hasUsableSource([{ stream: "mail", connectionId: "c1", status: "degraded" }])).toBe(true);
    expect(hasUsableSource([{ stream: "mail", connectionId: null, status: "not_configured" }, { stream: "calendar", connectionId: null, status: "not_configured" }])).toBe(false);
    expect(hasUsableSource([{ stream: "mail", connectionId: "c1", status: "pending" }])).toBe(false);
    expect(hasUsableSource([{ stream: "mail", connectionId: "c1", status: "reconnect_required" }])).toBe(false);
    expect(hasUsableSource([{ stream: "calendar", connectionId: "c1", status: "active" }])).toBe(false);
    expect(hasUsableSource([])).toBe(false);
  });
});

describe("T-270: loadRunState merges the sources-newer read", () => {
  const row = [{ running: false, last_regenerate_at: null, runs_today: 0, latest_prepared_at: "2026-11-12T14:00:00Z", last_attempt_at: null }];
  const db = (newer: { data: unknown; error?: unknown } | "throws") => ({
    schema: () => ({
      rpc: (fn: string) => (fn === "briefing_run_state" ? Promise.resolve({ data: row, error: null }) : newer === "throws" ? Promise.reject(new Error("x")) : Promise.resolve({ error: null, ...newer })),
    }),
  });
  it("true from the database -> sourcesNewer; false, an error or a throw -> false (the 3-hour rule alone then applies)", async () => {
    const { loadRunState } = await import("./briefing");
    expect((await loadRunState(db({ data: true }) as never, "PKG"))?.sourcesNewer).toBe(true);
    expect((await loadRunState(db({ data: false }) as never, "PKG"))?.sourcesNewer).toBe(false);
    expect((await loadRunState(db({ data: null, error: { code: "42883" } }) as never, "PKG"))?.sourcesNewer).toBe(false);
    expect((await loadRunState(db("throws") as never, "PKG"))?.sourcesNewer).toBe(false);
  });
});

describe("T-270 review M1: hasSyncedMail", () => {
  const r = (over: Partial<{ stream: string; connectionId: string | null; status: string; lastSyncAt: string | null }>) => ({ stream: "mail", connectionId: "c1", status: "active", lastSyncAt: "2026-11-22T15:22:00Z", ...over });
  it("needs a usable mail row with its own sync time", () => {
    expect(hasSyncedMail([r({})])).toBe(true);
    expect(hasSyncedMail([r({ lastSyncAt: null }), r({ stream: "calendar" })])).toBe(false);
    expect(hasSyncedMail([r({ status: "pending" })])).toBe(false);
    expect(hasSyncedMail([])).toBe(false);
  });
});
