// T-233: the QuickBooks row's data. Visible only to owner or admin_technical at AAL2 (the connect guard); an outage is
// "unavailable", never "not connected"; only id, realm, state and last sync reach the page. Mocks only (rule 10).
import { describe, expect, it } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { loadQuickBooksSection, mapQuickBooksStatus, quickbooksSectionFor } from "./quickbooks-connection";

const CLIENT = { marker: "lane-client" } as never;

function clientWith(result: { data: unknown; error: unknown }) {
  const seen: [string, unknown][] = [];
  const q = {
    select: (c: string) => (seen.push(["select", c]), q),
    eq: (c: string, v: unknown) => (seen.push([c, v]), q),
    order: () => Promise.resolve(result),
  };
  return { seen, client: { schema: (s: string) => (seen.push(["schema", s]), { from: (t: string) => (seen.push(["from", t]), q) }) } as never };
}

describe("status mapping", () => {
  it("maps the four live statuses; disconnected and unknown are not shown", () => {
    expect(mapQuickBooksStatus("active")).toBe("connected");
    expect(mapQuickBooksStatus("pending")).toBe("connecting");
    expect(mapQuickBooksStatus("degraded")).toBe("degraded");
    expect(mapQuickBooksStatus("reconnect_required")).toBe("reconnect_required");
    expect(mapQuickBooksStatus("disconnected")).toBeUndefined();
    expect(mapQuickBooksStatus("weird")).toBeUndefined();
    expect(mapQuickBooksStatus(null)).toBeUndefined();
  });
});

describe("loadQuickBooksSection", () => {
  it("reads only this lane's quickbooks connections, with a fixed column list (no tokens)", async () => {
    const { client, seen } = clientWith({ data: [], error: null });
    await loadQuickBooksSection(client, "PKG");
    expect(seen).toEqual([["schema", "core"], ["from", "connections"], ["select", "id, external_account_id, status, last_sync_at"], ["lane_id", "PKG"], ["provider", "quickbooks"]]);
  });

  it("maps rows to id, realm, state and last sync and drops the rest", async () => {
    const { client } = clientWith({
      data: [
        { id: "c1", external_account_id: "9130000000001", status: "active", last_sync_at: "2026-11-10T15:00:00+00:00", access_token: "synthetic-leak" },
        { id: "c2", external_account_id: "9130000000002", status: "disconnected", last_sync_at: null },
        { id: "c3", external_account_id: "9130000000003", status: "degraded", last_sync_at: "not a date" },
      ],
      error: null,
    });
    const view = await loadQuickBooksSection(client, "PKG");
    expect(view).toEqual({
      connections: [
        { id: "c1", realmId: "9130000000001", state: "connected", lastSyncAt: "2026-11-10T15:00:00.000Z" },
        { id: "c3", realmId: "9130000000003", state: "degraded", lastSyncAt: null },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("synthetic-leak");
  });

  it("throws on a read error (an outage is not 'not connected')", async () => {
    await expect(loadQuickBooksSection(clientWith({ data: null, error: { message: "boom" } }).client, "PKG")).rejects.toThrow("connections unavailable");
  });
});

describe("quickbooksSectionFor", () => {
  it("asks for exactly owner or admin_technical of the lane", async () => {
    const roles: (readonly string[])[] = [];
    const g = { requireRole: async (_l: string, r: readonly string[]) => (roles.push(r), { client: CLIENT }) as never };
    expect(await quickbooksSectionFor(g, "PKG", async () => ({ connections: [] }))).toEqual({ connections: [] });
    expect([...(roles[0] ?? [])].sort()).toEqual(["admin_technical", "owner"]);
  });

  it("is null (nothing drawn) for another role, AAL1, no session or another lane; a role-check outage is not swallowed", async () => {
    for (const reason of ["forbidden", "mfa_required", "no_session"] as const) {
      const g = { requireRole: async () => Promise.reject(new AuthError(reason)) };
      expect(await quickbooksSectionFor(g, "PKG", async () => ({ connections: [{ id: "x", realmId: "1", state: "connected", lastSyncAt: null }] })), reason).toBeNull();
    }
    const down = { requireRole: async () => Promise.reject(new Error("outage")) };
    await expect(quickbooksSectionFor(down, "PKG", async () => ({ connections: [] }))).rejects.toThrow("outage");
  });

  it("a read outage after the role check is `unavailable`", async () => {
    const g = { requireRole: async () => ({ client: CLIENT }) as never };
    expect(await quickbooksSectionFor(g, "PKG", async () => Promise.reject(new Error("db")))).toEqual({ connections: [], unavailable: true });
  });
});
