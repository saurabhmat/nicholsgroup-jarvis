// T-199: the Settings → Connections Google section. Status mapping, role gating (owner / admin_technical only; others and
// other lanes get nothing) and the shape of the output (no tokens, cursors, subjects, senders or event titles). Mocks only.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { googleSectionFor, loadGoogleSection, mapGoogleStatus } from "../lib/google-connection";

type Rows = Record<string, { data: unknown; error: unknown }>;
const CID = "00000000-0000-4000-8000-000000000199";

type Seen = { table: string; select: string; filters: string[] };

function fakeClient(rows: Rows, seen: Seen[] = []) {
  return {
    schema: () => ({
      from: (table: string) => {
        const res = rows[table] ?? { data: [], error: null };
        const call: Seen = { table, select: "", filters: [] };
        seen.push(call);
        const chain: Record<string, unknown> = {
          select: (s: string) => ((call.select = s), chain),
          eq: (c: string, v: unknown) => (call.filters.push(`${c}=${String(v)}`), chain),
          in: (c: string, v: unknown[]) => (call.filters.push(`${c} in ${v.join(",")}`), chain),
          order: () => Promise.resolve(res),
          maybeSingle: () => Promise.resolve(res),
          then: (f: (v: unknown) => unknown) => Promise.resolve(res).then(f),
        };
        return chain;
      },
    }),
  } as never;
}

const connected: Rows = {
  connections: {
    // Extra columns a careless query might return must not be passed on.
    data: [{ id: CID, external_account_id: "Ops@Example.test", status: "active", access_token: "synthetic-token-leak" }],
    error: null,
  },
  sync_cursors: {
    data: [
      { connection_id: CID, stream: "mail", updated_at: "2026-11-05T14:00:00+00:00", cursor_value: "g1.cursor-leak" },
      { connection_id: CID, stream: "calendar", updated_at: "2026-11-05T14:05:00+00:00" },
    ],
    error: null,
  },
  lane_config_current: { data: { mailboxes: ["ops@example.test"] }, error: null },
};

describe("mapGoogleStatus", () => {
  it.each([
    ["active", "connected"],
    ["pending", "connecting"],
    ["degraded", "degraded"],
    ["reconnect_required", "reconnect_required"],
    ["disconnected", undefined],
    ["weird", undefined],
    [null, undefined],
  ])("%s -> %s", (s, want) => expect(mapGoogleStatus(s)).toBe(want));
});

describe("loadGoogleSection", () => {
  it("returns only mailbox, state, allowed flag and the two sync times", async () => {
    const seen: Seen[] = [];
    const view = await loadGoogleSection(fakeClient(connected, seen), "PKG");
    expect(view).toEqual({
      connections: [{ id: CID, mailbox: "Ops@Example.test", state: "connected", mailboxAllowed: true, lastMailSyncAt: "2026-11-05T14:00:00.000Z", lastCalendarSyncAt: "2026-11-05T14:05:00.000Z" }],
    });
    expect(JSON.stringify(view)).not.toMatch(/token-leak|cursor-leak/);
    expect(seen.find((s) => s.table === "sync_cursors")?.select).not.toMatch(/cursor_value/);
    // Only the mailbox list is read from lane_config, not the whole config.
    expect(seen.find((s) => s.table === "lane_config_current")?.select).toBe("mailboxes:config->mailboxes");
  });

  it("every read is filtered to the lane (and to Google, and to the mail and calendar streams)", async () => {
    const seen: Seen[] = [];
    await loadGoogleSection(fakeClient(connected, seen), "PKG");
    expect(seen.find((s) => s.table === "connections")?.filters).toEqual(["lane_id=PKG", "provider=google"]);
    expect(seen.find((s) => s.table === "sync_cursors")?.filters).toEqual(["lane_id=PKG", `connection_id in ${CID}`, "stream in mail,calendar"]);
    expect(seen.find((s) => s.table === "lane_config_current")?.filters).toEqual(["lane_id=PKG"]);
  });

  it("several connections: sync times are matched per connection and per stream", async () => {
    const B = "00000000-0000-4000-8000-0000000001b0";
    const rows: Rows = {
      connections: { data: [{ id: CID, external_account_id: "ops@example.test", status: "active" }, { id: B, external_account_id: "desk@example.test", status: "degraded" }], error: null },
      sync_cursors: { data: [{ connection_id: B, stream: "calendar", updated_at: "2026-07-01T12:00:00Z" }, { connection_id: CID, stream: "mail", updated_at: "2026-11-05T14:00:00Z" }], error: null },
      lane_config_current: { data: { mailboxes: ["OPS@example.test"] }, error: null },
    };
    const view = await loadGoogleSection(fakeClient(rows), "PKG");
    expect(view.connections).toEqual([
      { id: CID, mailbox: "ops@example.test", state: "connected", mailboxAllowed: true, lastMailSyncAt: "2026-11-05T14:00:00.000Z", lastCalendarSyncAt: null },
      { id: B, mailbox: "desk@example.test", state: "degraded", mailboxAllowed: false, lastMailSyncAt: null, lastCalendarSyncAt: "2026-07-01T12:00:00.000Z" },
    ]);
  });

  it("shows 'not synced yet' as null times and flags a mailbox outside lane_config.mailboxes", async () => {
    const view = await loadGoogleSection(fakeClient({ ...connected, sync_cursors: { data: [], error: null }, lane_config_current: { data: { mailboxes: null }, error: null } }), "PKG");
    expect(view.connections[0]).toMatchObject({ lastMailSyncAt: null, lastCalendarSyncAt: null, mailboxAllowed: false });
  });

  it("maps reconnect_required and hides disconnected rows", async () => {
    const rows: Rows = { ...connected, connections: { data: [{ id: CID, external_account_id: "ops@example.test", status: "reconnect_required" }, { id: "x", external_account_id: "old@example.test", status: "disconnected" }], error: null } };
    const view = await loadGoogleSection(fakeClient(rows), "PKG");
    expect(view.connections.map((c) => c.state)).toEqual(["reconnect_required"]);
  });

  it("no connection: empty list, and no further reads", async () => {
    const seen: Seen[] = [];
    expect(await loadGoogleSection(fakeClient({ connections: { data: [], error: null } }, seen), "PKG")).toEqual({ connections: [] });
    expect(seen.map((s) => s.table)).toEqual(["connections"]);
  });

  it("a database error throws instead of looking like 'not connected'", async () => {
    await expect(loadGoogleSection(fakeClient({ connections: { data: null, error: { code: "x" } } }), "PKG")).rejects.toThrow();
  });
});

describe("googleSectionFor (role gating)", () => {
  const guard = (err?: unknown) => {
    const requireRole = vi.fn(async (lane: string, roles: readonly string[]) => {
      void lane;
      void roles;
      if (err) throw err;
      return { session: {}, laneId: "PKG", client: {} } as never;
    });
    return { requireRole };
  };

  it("asks for exactly owner or admin_technical of the lane", async () => {
    const g = guard();
    const load = vi.fn(async () => ({ connections: [] }));
    expect(await googleSectionFor(g, "PKG", load)).toEqual({ connections: [] });
    expect(g.requireRole.mock.calls[0]?.[0]).toBe("PKG");
    expect([...(g.requireRole.mock.calls[0]?.[1] ?? [])].sort()).toEqual(["admin_technical", "owner"]);
  });

  it.each(["forbidden", "no_session", "mfa_required"] as const)("%s: no section and no data read", async (reason) => {
    const load = vi.fn();
    expect(await googleSectionFor(guard(new AuthError(reason)), "PKG", load as never)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("an outage in the role check is rethrown, never shown as an empty section", async () => {
    await expect(googleSectionFor(guard(new Error("down")), "PKG", vi.fn())).rejects.toThrow("down");
  });

  it("an outage while reading gives an 'unavailable' view (not 'not connected', and the rest of Settings still renders)", async () => {
    const load = vi.fn(async () => {
      throw new Error("connections unavailable");
    });
    expect(await googleSectionFor(guard(), "PKG", load)).toEqual({ connections: [], unavailable: true });
  });
});
