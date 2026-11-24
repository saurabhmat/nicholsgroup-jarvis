// The notice state of a person's own Teams connection (T-290): database only, three facts, a limiter that is a per-person sliding window. Synthetic data only.
import { describe, expect, it } from "vitest";
import { ACTIVITY_OFF, createWindowLimiter, markSeen, readActivity } from "./teams-activity";

const CONN = "00000000-0000-4000-8000-0000000000c1";
const client = (result: { data?: unknown; error?: unknown }, calls: { fn: string; args: unknown }[] = []) =>
  ({ schema: (s: string) => ({ rpc: async (fn: string, args: unknown) => (calls.push({ fn: `${s}.${fn}`, args }), { data: result.data ?? null, error: result.error ?? null }) }) }) as never;

describe("readActivity", () => {
  it("calls core.teams_activity_get for the lane and connection and nothing else", async () => {
    const calls: { fn: string; args: unknown }[] = [];
    await readActivity(client({ data: [] }, calls), "PKG", CONN);
    expect(calls).toEqual([{ fn: "core.teams_activity_get", args: { p_lane: "PKG", p_connection: CONN } }]);
  });

  it("no row (not the owner, not usable) is `off`; an error is thrown, never read as `no activity`", async () => {
    expect(await readActivity(client({ data: [] }), "PKG", CONN)).toEqual(ACTIVITY_OFF);
    await expect(readActivity(client({ error: { code: "XX000" } }), "PKG", CONN)).rejects.toThrow();
    await expect(readActivity(client({ data: "nope" }), "PKG", CONN)).rejects.toThrow();
  });

  it("the dot needs notices on and a notice after the last time the list was opened; times are normalised; junk is null", async () => {
    const get = (r: Record<string, unknown>) => readActivity(client({ data: [r] }), "PKG", CONN);
    expect(await get({ live: true, live_until: "2026-11-25T10:00:00+00:00", last_notice_at: "2026-11-23T10:00:00+00:00", last_seen_at: "2026-11-23T09:00:00+00:00" })).toEqual({ live: true, liveUntil: "2026-11-25T10:00:00.000Z", dot: true, lastNoticeAt: "2026-11-23T10:00:00.000Z" });
    expect((await get({ live: true, last_notice_at: "2026-11-23T10:00:00Z", last_seen_at: "2026-11-23T10:00:00Z" })).dot).toBe(false);
    expect((await get({ live: false, last_notice_at: "2026-11-23T10:00:00Z", last_seen_at: null })).dot).toBe(false);
    expect(await get({ live: true, live_until: "soon", last_notice_at: "x", last_seen_at: 5 })).toEqual({ live: true, liveUntil: null, dot: false, lastNoticeAt: null });
    expect((await get({ live: false, live_until: "2026-11-25T10:00:00Z" })).liveUntil).toBeNull();
  });
});

describe("markSeen", () => {
  it("calls core.teams_activity_seen and is true unless the database refuses", async () => {
    const calls: { fn: string; args: unknown }[] = [];
    expect(await markSeen(client({ data: "2026-11-23T10:00:00Z" }, calls), "PKG", CONN)).toBe(true);
    expect(calls).toEqual([{ fn: "core.teams_activity_seen", args: { p_lane: "PKG", p_connection: CONN } }]);
    expect(await markSeen(client({ error: { code: "P0002" } }), "PKG", CONN)).toBe(false);
  });
});

describe("createWindowLimiter", () => {
  it("allows `max` in the window, then answers the whole seconds to wait; the window slides; keys are independent", () => {
    let t = 0;
    const l = createWindowLimiter(2, 10_000, () => t);
    expect([l.take("a"), l.take("a")]).toEqual([0, 0]);
    t = 3_000;
    expect(l.take("a")).toBe(7);
    expect(l.take("b")).toBe(0);
    t = 10_001;
    expect(l.take("a")).toBe(0); // both first hits left the window
    t = 10_002;
    expect(l.take("a")).toBe(0); // the second of the new window
    expect(l.take("a")).toBeGreaterThan(0);
  });
});
