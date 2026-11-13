// T-238 parts D and F: the sync status line and the stale-data line. Pure, synthetic rows.
import { describe, expect, it } from "vitest";
import type { CoverageItem } from "./coverage";
import { easternTime, STALE_DATA_MS, staleDataLine, syncErrorText, syncStatus } from "./sync-status";

const NOW = new Date("2026-11-13T15:00:00Z"); // 10:00 AM ET
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursAgo = (h: number) => minsAgo(h * 60);
let n = 0;
const item = (stream: "mail" | "calendar", over: Partial<CoverageItem> = {}): CoverageItem => ({
  stream, account: `a${String(++n)}@pubk.test`, connectionId: `c${String(n)}`, provider: "google", status: "active", configured: true, lastSyncAt: minsAgo(4), errorKind: null, state: "ok", reason: null, ...over,
});

describe("syncStatus", () => {
  it("says how long ago each stream synced, using the OLDEST last-good sync among its sources", () => {
    const out = syncStatus([item("mail", { lastSyncAt: minsAgo(4) }), item("mail", { lastSyncAt: minsAgo(12) }), item("calendar", { lastSyncAt: minsAgo(30) })], NOW);
    expect(out.map((s) => s.text)).toEqual(["Mail synced 12 min ago", "Calendar synced 30 min ago"]);
    expect(out.map((s) => s.state)).toEqual(["ok", "ok"]);
  });
  it("carries the Eastern clock time in the detail (accessible name and title)", () => {
    const [mail] = syncStatus([item("mail", { lastSyncAt: "2026-11-13T14:42:00Z" })], NOW);
    expect(mail?.detail).toBe("Mail last synced 9:42 AM ET.");
    expect(easternTime("2026-11-12T14:42:00Z", NOW)).toBe("Thu, Nov 12, 9:42 AM ET");
  });
  it("a stream that failed shows its real error as fixed text, with the last good sync in the detail", () => {
    const [mail] = syncStatus([item("mail", { errorKind: "reconnect_required", state: "error", status: "reconnect_required", lastSyncAt: "2026-11-13T14:00:00Z" })], NOW);
    expect(mail?.text).toBe("Mail sync failed: Google access expired. Reconnect in Settings.");
    expect(mail?.state).toBe("failed");
    expect(mail?.detail).toContain("Last good sync 9:00 AM ET.");
  });
  it("an active connection that carries an error from its last sync is a failure too", () => {
    const [cal] = syncStatus([item("calendar", { errorKind: "transient" })], NOW);
    expect(cal?.text).toBe("Calendar sync failed: Google had a temporary problem; retrying.");
  });
  it("with several mailboxes it says how many failed and reports the one that needs a person first", () => {
    const [mail] = syncStatus([item("mail"), item("mail", { errorKind: "transient" }), item("mail", { errorKind: "reconnect_required", state: "error", status: "reconnect_required" })], NOW);
    expect(mail?.text).toBe("Mail sync failed for 2 of 3 mailboxes: Google access expired. Reconnect in Settings.");
    expect(mail).toMatchObject({ total: 3, failed: 2 });
  });
  it("one stream can fail while the other is fine", () => {
    const out = syncStatus([item("mail", { errorKind: "forbidden" }), item("calendar", { lastSyncAt: minsAgo(3) })], NOW);
    expect(out.map((s) => s.state)).toEqual(["failed", "ok"]);
    expect(out[1]?.text).toBe("Calendar synced 3 min ago");
  });
  it("never shows provider text: an unknown or hostile code gets the generic fixed text", () => {
    for (const code of ["weird_code", "__proto__", "toString", "Bearer abc"]) {
      const [mail] = syncStatus([item("mail", { errorKind: code })], NOW);
      expect(mail?.text).toBe("Mail sync failed: The last sync did not finish. Try Sync now; if it continues, check Settings.");
    }
    expect(syncErrorText("reconnect_required", null)).toBe("The provider access expired. Reconnect in Settings.");
    expect(syncErrorText("reconnect_required", "microsoft")).toBe("Microsoft access expired. Reconnect in Settings.");
    expect(syncErrorText("reconnect_required", "constructor")).toBe("The provider access expired. Reconnect in Settings.");
  });
  it("a source that never synced says so; a source that was never connected is left out", () => {
    expect(syncStatus([item("mail", { lastSyncAt: null, state: "stale" })], NOW)[0]).toMatchObject({ text: "Mail not synced yet", state: "never" });
    expect(syncStatus([item("mail", { state: "not_connected", connectionId: null }), item("calendar", { state: "not_connected", connectionId: null })], NOW)).toEqual([]);
    expect(syncStatus([], NOW)).toEqual([]);
  });
  it("one never-synced source among synced ones is still 'not synced yet' (never optimistic)", () => {
    expect(syncStatus([item("mail"), item("mail", { lastSyncAt: null, state: "stale" })], NOW)[0]?.text).toBe("Mail not synced yet");
  });
  it("a stale (old but not failed) stream is marked stale with its age", () => {
    expect(syncStatus([item("mail", { lastSyncAt: hoursAgo(5), state: "stale" })], NOW)[0]).toMatchObject({ text: "Mail synced 5h ago", state: "stale" });
  });
});

describe("staleDataLine", () => {
  const fresh = [item("mail", { lastSyncAt: minsAgo(5) }), item("calendar", { lastSyncAt: minsAgo(5) })];
  it("is null when everything is fresh, with no sources, and for the 24 h boundary itself", () => {
    expect(staleDataLine(fresh, NOW)).toBeNull();
    expect(staleDataLine([], NOW)).toBeNull();
    expect(staleDataLine([item("mail", { lastSyncAt: new Date(NOW.getTime() - STALE_DATA_MS).toISOString() })], NOW)).toBeNull();
    expect(staleDataLine([item("mail", { lastSyncAt: new Date(NOW.getTime() - STALE_DATA_MS - 1000).toISOString() })], NOW)).toMatch(/last synced 24 hours ago/);
  });
  it("mail only", () => {
    expect(staleDataLine([item("mail", { lastSyncAt: hoursAgo(26) }), item("calendar")], NOW)).toBe("Mail was last synced 26 hours ago, so this summary may miss newer email.");
  });
  it("calendar only", () => {
    expect(staleDataLine([item("mail"), item("calendar", { lastSyncAt: hoursAgo(30) })], NOW)).toBe("Calendar was last synced 30 hours ago, so this summary may miss schedule changes.");
  });
  it("both: ONE combined line", () => {
    expect(staleDataLine([item("mail", { lastSyncAt: hoursAgo(26) }), item("calendar", { lastSyncAt: hoursAgo(30) })], NOW)).toBe(
      "Mail was last synced 26 hours ago and calendar 30 hours ago, so this summary may miss newer email and schedule changes.",
    );
  });
  it("uses the oldest source of a kind, and days from 48 hours", () => {
    expect(staleDataLine([item("mail", { lastSyncAt: minsAgo(5) }), item("mail", { lastSyncAt: hoursAgo(72) })], NOW)).toBe("Mail was last synced 3 days ago, so this summary may miss newer email.");
  });
  it("never synced", () => {
    expect(staleDataLine([item("mail", { lastSyncAt: null, state: "stale" }), item("calendar")], NOW)).toBe("Mail has not synced yet, so this summary may miss newer email.");
    expect(staleDataLine([item("mail", { lastSyncAt: null }), item("calendar", { lastSyncAt: hoursAgo(30) })], NOW)).toBe(
      "Mail has not synced yet and calendar was last synced 30 hours ago, so this summary may miss newer email and schedule changes.",
    );
  });
  it("sources that were never connected do not count", () => {
    expect(staleDataLine([item("mail", { state: "not_connected", connectionId: null, lastSyncAt: null })], NOW)).toBeNull();
  });
  it("a summary older than 24 hours is said in the SAME single line, never a second one", () => {
    expect(staleDataLine(fresh, NOW, hoursAgo(26))).toBe("This summary was prepared 26 hours ago, so it may be out of date.");
    const both = staleDataLine([item("mail", { lastSyncAt: hoursAgo(26) })], NOW, hoursAgo(27));
    expect(both).toBe("Mail was last synced 26 hours ago, so this summary may miss newer email. This summary was prepared 27 hours ago.");
    expect(both?.includes("\n")).toBe(false);
  });
  it("a summary of exactly 24 hours, a fresh one, none, or an unreadable time adds nothing", () => {
    expect(staleDataLine(fresh, NOW, new Date(NOW.getTime() - STALE_DATA_MS).toISOString())).toBeNull();
    expect(staleDataLine(fresh, NOW, hoursAgo(2))).toBeNull();
    expect(staleDataLine(fresh, NOW, null)).toBeNull();
    expect(staleDataLine(fresh, NOW, "not a date")).toBeNull();
  });
});
