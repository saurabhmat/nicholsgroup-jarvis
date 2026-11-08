// T-219: the Settings → Connections Composio section. Role gating (owner / admin_technical at AAL2 only), lane-bound
// reads, the shape of the output (no connected account id, no tokens, no content), "configured" flags, outages.
import { describe, expect, it } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { composioSectionFor, loadComposioSection, type Availability } from "../lib/composio-connection";
import { describeComposioCheck, parseComposioCheck } from "../lib/composio-check-view";

type Rows = Record<string, { data: unknown; error: unknown }>;
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
          neq: (c: string, v: unknown) => (call.filters.push(`${c}!=${String(v)}`), chain),
          order: () => Promise.resolve(res),
          maybeSingle: () => Promise.resolve(res),
        };
        return chain;
      },
    }),
  } as never;
}

const ALL: Availability = { gmail: true, googlecalendar: true };
const connected: Rows = {
  connections: {
    data: [
      // newest first; extra columns a careless query might return must not be passed on
      { id: "c-pending", toolkit: "gmail", account_identity: null, status: "pending", last_sync_at: null, created_at: "2026-11-08T12:00:00Z", external_account_id: "ca_leak" },
      { id: "c-gmail", toolkit: "gmail", account_identity: "Boss@Example.test", status: "active", last_sync_at: "2026-11-08T11:00:00+00:00", created_at: "2026-11-08T10:00:00Z", external_account_id: "ca_leak2", access_token: "synthetic-leak" },
      { id: "c-cal", toolkit: "googlecalendar", account_identity: "boss@example.test", status: "reconnect_required", last_sync_at: null, created_at: "2026-11-08T09:00:00Z" },
    ],
    error: null,
  },
  lane_config_current: { data: { mailboxes: ["boss@example.test"] }, error: null },
};

describe("loadComposioSection", () => {
  it("reads only the lane's composio connections (lane, transport, not disconnected) and maps them per toolkit", async () => {
    const seen: Seen[] = [];
    const view = await loadComposioSection(fakeClient(connected, seen), "PKG", ALL);
    expect(seen[0]?.filters).toEqual(["lane_id=PKG", "transport=composio", "status!=disconnected"]);
    expect(seen[0]?.select).not.toMatch(/external_account_id|token/);
    expect(view.toolkits.map((t) => [t.toolkit, t.connection?.id, t.connection?.state])).toEqual([
      ["gmail", "c-gmail", "connected"], // the pending row does not hide the usable one
      ["googlecalendar", "c-cal", "reconnect_required"],
    ]);
    expect(view.toolkits[0]?.connection).toMatchObject({ address: "Boss@Example.test", mailboxAllowed: true, lastSyncAt: "2026-11-08T11:00:00.000Z" });
  });

  it("output carries nothing beyond the view fields (no connected account id, no token)", async () => {
    const view = await loadComposioSection(fakeClient(connected), "PKG", ALL);
    const text = JSON.stringify(view);
    expect(text).not.toContain("ca_leak");
    expect(text).not.toContain("synthetic-leak");
    expect(Object.keys(view.toolkits[0]?.connection ?? {}).sort()).toEqual(["address", "id", "lastSyncAt", "mailboxAllowed", "state"]);
  });

  it("a pending row older than the connect state's lifetime is hidden; a fresh one shows as connecting", async () => {
    const pending = (created_at: string): Rows => ({ connections: { data: [{ id: "c-p", toolkit: "gmail", account_identity: null, status: "pending", last_sync_at: null, created_at }], error: null }, lane_config_current: { data: null, error: null } });
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect((await loadComposioSection(fakeClient(pending("2026-11-08T11:58:00Z")), "PKG", ALL, now)).toolkits[0]?.connection?.state).toBe("connecting");
    expect((await loadComposioSection(fakeClient(pending("2026-11-08T11:00:00Z")), "PKG", ALL, now)).toolkits[0]?.connection).toBeNull();
  });

  it("flags an address that is not in lane_config.mailboxes", async () => {
    const rows: Rows = { ...connected, lane_config_current: { data: { mailboxes: ["someone@example.test"] }, error: null } };
    const view = await loadComposioSection(fakeClient(rows), "PKG", ALL);
    expect(view.toolkits[0]?.connection?.mailboxAllowed).toBe(false);
  });

  it("no rows: both toolkits not connected; configured flags come from the server", async () => {
    const view = await loadComposioSection(fakeClient({ connections: { data: [], error: null }, lane_config_current: { data: null, error: null } }), "PKG", { gmail: true, googlecalendar: false });
    expect(view.toolkits.map((t) => [t.toolkit, t.configured, t.connection])).toEqual([["gmail", true, null], ["googlecalendar", false, null]]);
  });

  it("a database error throws (the page must not say 'not connected' for an outage)", async () => {
    await expect(loadComposioSection(fakeClient({ connections: { data: null, error: { code: "XX" } } }), "PKG", ALL)).rejects.toThrow();
  });
});

describe("composioSectionFor (gate)", () => {
  const ok = { requireRole: async () => ({ client: fakeClient(connected) }) } as never;
  it("owner / admin_technical at aal2 get the view", async () => {
    expect((await composioSectionFor(ok, "PKG", () => ALL))?.toolkits).toHaveLength(2);
  });
  it("AuthError (viewer, AAL1, other lane) gets null: no buttons, no data, and the loader is never called", async () => {
    let loaded = false;
    const denied = { requireRole: async () => { throw new AuthError("forbidden"); } } as never;
    expect(await composioSectionFor(denied, "APK", () => ALL, async () => ((loaded = true), { toolkits: [] }))).toBeNull();
    expect(loaded).toBe(false);
  });
  it("an outage after the role check is `unavailable`, with the configured flags kept; an outage in the role check rethrows", async () => {
    const view = await composioSectionFor(ok, "PKG", () => ALL, async () => { throw new Error("db down"); });
    expect(view).toMatchObject({ unavailable: true });
    expect(view?.toolkits.every((t) => t.connection === null && t.configured)).toBe(true);
    await expect(composioSectionFor({ requireRole: async () => { throw new Error("db down"); } } as never, "PKG", () => ALL)).rejects.toThrow("db down");
  });
});

describe("check view", () => {
  it("parses exactly { status, checked_at } and nothing else", () => {
    expect(parseComposioCheck({ status: "ok", checked_at: "2026-11-08T12:00:00.000Z" })).toEqual({ status: "ok", checked_at: "2026-11-08T12:00:00.000Z" });
    for (const bad of [null, [], {}, { status: "ok" }, { status: "ok", checked_at: "x" }, { status: "weird", checked_at: "2026-11-08T12:00:00Z" }, { status: "ok", checked_at: "2026-11-08T12:00:00Z", address: "a@b.test" }]) {
      expect(parseComposioCheck(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("describes every status without echoing anything from the account", () => {
    for (const s of ["ok", "reconnect_required", "not_connected", "mailbox_not_allowed", "error"] as const) {
      const v = describeComposioCheck(s);
      expect(v.title.length).toBeGreaterThan(0);
      expect(v.description).not.toMatch(/@/);
    }
  });
});
