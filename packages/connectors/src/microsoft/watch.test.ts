// capabilities.watch and the providers' watch / renew / stop for Microsoft (T-068, T-264): `push` once the subscription logic is injected (the wiring does), `polling` without it (a
// lane with Google only never reaches this code). The 15-minute polling jobs are unchanged either way. Stubs only: the subscription behaviour itself is in subscriptions.test.ts.
import { describe, expect, it, vi } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { WatchInfo } from "../comms/schemas";
import { createMicrosoftCalendarProvider } from "./calendar";
import { createMicrosoftMailProvider } from "./mail";

const row = { id: "00000000-0000-4000-8000-000000006811", lane_id: "PKG", provider: "microsoft", external_account_id: "x@corp.example.test", status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null };
const conn = mintLaneBoundConnection(row as never) as never;
const guard = vi.fn(async (_lane: string, c: { id: string }) => ({ conn: { id: c.id }, tenantId: "t", cloud: "commercial" }));
const base = { api: { get: vi.fn() } as never, guard: guard as never, laneConfig: {} as never, now: () => Date.parse("2026-11-23T12:00:00Z") };
const push = (resource: "mail" | "calendar"): WatchInfo => ({ mode: "push", resource, channel_id: null, resource_id: "sub-1", expires_at: "2026-11-29T12:00:00.000Z", created_at: "2026-11-23T12:00:00.000Z" });

function subs() {
  return {
    ensure: vi.fn(async () => ({ created: 1, renewed: 0, recreated: 0, removed: 0, skipped: null, expiresAt: null })),
    stop: vi.fn(async () => 2),
    watchInfo: vi.fn(async (_l: string, _c: unknown, resource: "mail" | "calendar") => push(resource)),
  };
}

describe("mail", () => {
  it("without the subscription logic: polling, as before (no push claimed, nothing created)", async () => {
    const p = createMicrosoftMailProvider(base);
    expect(p.capabilities.watch).toBe("polling");
    expect(await p.watch("PKG", conn)).toMatchObject({ mode: "polling", resource: "mail" });
  });

  it("with it: capabilities.watch is push; watch and renew ensure the subscriptions and report the inbox one; stop stops them; the guard runs first each time", async () => {
    const s = subs();
    const p = createMicrosoftMailProvider({ ...base, subscriptions: s });
    expect(p.capabilities).toEqual({ watch: "push", prepareWrite: true });
    guard.mockClear();
    expect(await p.watch("PKG", conn)).toEqual(push("mail"));
    expect(await p.renew("PKG", conn, push("mail"))).toEqual(push("mail"));
    await p.stop("PKG", conn, push("mail"));
    expect(guard).toHaveBeenCalledTimes(3);
    expect(s.ensure).toHaveBeenCalledTimes(2);
    expect(s.ensure).toHaveBeenCalledWith("PKG", conn, { now: new Date("2026-11-23T12:00:00Z") });
    expect(s.watchInfo).toHaveBeenCalledWith("PKG", conn, "mail", new Date("2026-11-23T12:00:00Z"));
    expect(s.stop).toHaveBeenCalledExactlyOnceWith("PKG", conn);
  });

  it("a refused guard stops everything before the subscription logic is reached", async () => {
    const s = subs();
    const refusing = vi.fn(async () => { throw new Error("refused"); });
    const p = createMicrosoftMailProvider({ ...base, guard: refusing as never, subscriptions: s });
    await expect(p.watch("PKG", conn)).rejects.toThrow("refused");
    await expect(p.stop("PKG", conn, push("mail"))).rejects.toThrow("refused");
    expect(s.ensure).not.toHaveBeenCalled();
    expect(s.stop).not.toHaveBeenCalled();
  });
});

describe("calendar", () => {
  it("without the subscription logic: polling, one entry", async () => {
    const p = createMicrosoftCalendarProvider(base);
    expect(p.capabilities).toEqual({ watch: "polling", prepareWrite: false });
    expect(await p.watch("PKG", conn)).toMatchObject([{ mode: "polling", resource: "calendar" }]);
  });

  it("with it: push, one entry for the default calendar (D-59); renew and stop run the same logic", async () => {
    const s = subs();
    const p = createMicrosoftCalendarProvider({ ...base, subscriptions: s });
    expect(p.capabilities).toEqual({ watch: "push", prepareWrite: false });
    expect(await p.watch("PKG", conn)).toEqual([push("calendar")]);
    expect(await p.renew("PKG", conn, push("calendar"))).toEqual(push("calendar"));
    await p.stop("PKG", conn, push("calendar"));
    expect(s.watchInfo).toHaveBeenCalledWith("PKG", conn, "calendar", expect.any(Date));
    expect(s.stop).toHaveBeenCalledOnce();
  });
});
