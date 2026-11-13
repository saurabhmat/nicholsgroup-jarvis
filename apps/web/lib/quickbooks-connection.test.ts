// T-233 / T-197: the QuickBooks row's data. Visible only to owner or admin_technical at AAL2 (the connect guard); an outage is
// "unavailable", never "not connected"; only id, the last four characters of the realm, state, times, the class-tracking flag and the
// pending-disconnect state reach the page. Mocks only (rule 10).
import { describe, expect, it } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { canDisconnect, loadQuickBooksSection, mapQuickBooksStatus, quickbooksSectionFor, realmTailOf, withDisconnectState, type QuickBooksConnectionView } from "./quickbooks-connection";

const CLIENT = { marker: "lane-client" } as never;
const SESSION = { userId: "u1" };
const conn = (over: Partial<QuickBooksConnectionView> = {}): QuickBooksConnectionView => ({
  id: "c1", realmTail: "0001", state: "connected", lastSyncAt: null, jobs: [], classTracking: null, disconnect: { pendingId: null, gate: null }, ...over,
});

type Result = { data: unknown; error: unknown };
/** A fake lane client that records every call per table and answers connections and sync_runs. */
function fake(connections: Result, runs: (connectionId: string, job: string) => Result = () => ({ data: [], error: null })) {
  const seen: [string, string, unknown][] = [];
  const client = {
    schema: (s: string) => ({
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        seen.push([s, table, filters]);
        const q = {
          select: (c: string) => ((filters.select = c), q),
          eq: (c: string, v: unknown) => ((filters[c] = v), q),
          order: (c: string) => (table === "connections" ? Promise.resolve(connections) : ((filters.order = c), q)),
          limit: () => Promise.resolve(runs(String(filters.connection_id), String(filters.job))),
        };
        return q;
      },
    }),
  } as never;
  return { seen, client };
}

describe("status mapping", () => {
  it("maps the four live statuses; disconnected and unknown are not shown as a connection", () => {
    expect(mapQuickBooksStatus("active")).toBe("connected");
    expect(mapQuickBooksStatus("pending")).toBe("connecting");
    expect(mapQuickBooksStatus("degraded")).toBe("degraded");
    expect(mapQuickBooksStatus("reconnect_required")).toBe("reconnect_required");
    expect(mapQuickBooksStatus("disconnected")).toBeUndefined();
    expect(mapQuickBooksStatus("weird")).toBeUndefined();
    expect(mapQuickBooksStatus(null)).toBeUndefined();
  });
  it("only connections past setup can be disconnected (the shared status list)", () => {
    expect(["connected", "degraded", "reconnect_required"].every((s) => canDisconnect(s as never))).toBe(true);
    expect(canDisconnect("connecting")).toBe(false);
  });
  it("the realm is cut to its last four characters", () => expect(realmTailOf("9130000000001")).toBe("0001"));
});

describe("loadQuickBooksSection", () => {
  it("reads only this lane's quickbooks connections with a fixed column list (no tokens), and sync runs of this lane per job", async () => {
    const { client, seen } = fake({ data: [{ id: "c1", external_account_id: "9130000000001", status: "active", last_sync_at: null, features: {} }], error: null });
    await loadQuickBooksSection(client, "PKG");
    expect(seen[0]).toEqual(["core", "connections", { select: "id, external_account_id, status, last_sync_at, features", lane_id: "PKG", provider: "quickbooks" }]);
    const runs = seen.filter((s) => s[1] === "sync_runs");
    expect(runs.map((r) => (r[2] as Record<string, unknown>).job).sort()).toEqual(["normalize", "reports", "sync"]);
    for (const [, , f] of runs) expect(f).toMatchObject({ select: "finished_at", lane_id: "PKG", connection_id: "c1", status: "succeeded" });
  });

  it("maps rows to tail, state, last success per job and the class-tracking flag; drops the rest", async () => {
    const { client } = fake(
      {
        data: [
          { id: "c1", external_account_id: "9130000000001", status: "active", last_sync_at: "2026-11-10T15:00:00+00:00", features: { class_tracking: true, multicurrency: false }, access_token: "synthetic-leak" },
          { id: "c2", external_account_id: "9130000000002", status: "disconnected", last_sync_at: null },
          { id: "c3", external_account_id: "9130000000003", status: "degraded", last_sync_at: "not a date", features: null },
          { id: "c4", external_account_id: "9130000000004", status: "reconnect_required", last_sync_at: null, features: { class_tracking: false } },
        ],
        error: null,
      },
      (id, job) => ({ data: id === "c1" && job !== "normalize" ? [{ finished_at: job === "sync" ? "2026-11-10T15:05:00Z" : "2026-11-10T06:00:00Z" }] : [], error: null }),
    );
    const view = await loadQuickBooksSection(client, "PKG");
    expect(view.connections.map((c) => [c.id, c.realmTail, c.state, c.lastSyncAt, c.classTracking])).toEqual([
      ["c1", "0001", "connected", "2026-11-10T15:00:00.000Z", true],
      ["c3", "0003", "degraded", null, null],
      ["c4", "0004", "reconnect_required", null, false],
    ]);
    expect(view.connections[0]?.jobs).toEqual([
      { job: "sync", at: "2026-11-10T15:05:00.000Z" },
      { job: "reports", at: "2026-11-10T06:00:00.000Z" },
      { job: "normalize", at: null },
    ]);
    expect(view.wasDisconnected).toBeUndefined();
    const text = JSON.stringify(view);
    expect(text).not.toContain("synthetic-leak");
    expect(text).not.toContain("9130000000001"); // never the whole realm id
  });

  it("no live connection but a disconnected one: wasDisconnected", async () => {
    const { client } = fake({ data: [{ id: "c2", external_account_id: "9130000000002", status: "disconnected", last_sync_at: null }], error: null });
    expect(await loadQuickBooksSection(client, "PKG")).toEqual({ connections: [], wasDisconnected: true });
    expect(await loadQuickBooksSection(fake({ data: [], error: null }).client, "PKG")).toEqual({ connections: [] });
  });

  it("throws on a read error (an outage is not 'not connected'), also on sync runs", async () => {
    await expect(loadQuickBooksSection(fake({ data: null, error: { message: "boom" } }).client, "PKG")).rejects.toThrow("connections unavailable");
    const bad = fake({ data: [{ id: "c1", external_account_id: "9130000000001", status: "active" }], error: null }, () => ({ data: null, error: { message: "x" } }));
    await expect(loadQuickBooksSection(bad.client, "PKG")).rejects.toThrow("sync runs unavailable");
  });
});

describe("withDisconnectState", () => {
  const view = { connections: [conn({ id: "00000000-0000-4000-8000-000000002901" }), conn({ id: "c2", state: "connecting" })] };
  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
  const act = (over: Record<string, unknown> = {}) => ({
    id: "00000000-0000-4000-8000-0000000000aa", lane_id: "PKG", action_type: "qbo.disconnect", connection_id: "00000000-0000-4000-8000-000000002901", provider: "quickbooks", target: { realm_id: "9130000000001" }, payload: {},
    payload_schema_version: 1, payload_sha256: "a".repeat(64), rationale: null, source_refs: [], proposer_kind: "user", proposer_user_id: "00000000-0000-4000-8000-0000000000a1", derived_from_retrieved: false,
    supersedes_id: null, superseded_by_id: null, status: "proposed", expires_at: FUTURE, approved_by: null, approved_at: null, approved_hash: null, executed_at: null,
    verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: "2026-11-11T12:00:00Z", updated_at: "2026-11-11T12:00:00Z", ...over,
  });
  const ctxWith = (rows: unknown[], fail = false) => ({
    client: { schema: () => ({ rpc: async () => (fail ? Promise.reject(new Error("x")) : { data: rows, error: null }) }) } as never,
    laneId: "PKG",
    userId: "u1",
  });
  const GATE_ON = { qbo: { realmId: "9130000000001" }, writeActionsAllowed: ["qbo_disconnect"], approvalsLive: true, stepUpMaxAgeS: 300, mailbox: null, composeGranted: false };
  const approvals = (facts: Record<string, unknown> = GATE_ON) => ({ jobRpc: async () => async () => ({ data: 0, error: null }), readFacts: async () => facts }) as never;

  it("a read failure of the approvals list leaves the view as it was (the button stays)", async () => {
    expect(await withDisconnectState(view, ctxWith([], true), approvals())).toEqual(view);
  });
  it("a connection still being set up gets no disconnect state", async () => {
    const out = await withDisconnectState({ connections: [conn({ id: "00000000-0000-4000-8000-000000002901", state: "connecting" })] }, ctxWith([act()]), approvals());
    expect(out.connections[0]?.disconnect).toEqual({ pendingId: null, gate: null });
  });
  it("a proposal waiting for this connection shows its id; another connection's, an expired one and a finished one do not", async () => {
    const out = await withDisconnectState(view, ctxWith([act()]), approvals());
    expect(out.connections[0]?.disconnect.pendingId).toBe("00000000-0000-4000-8000-0000000000aa");
    for (const other of [act({ connection_id: "other" }), act({ expires_at: "2020-01-01T00:00:00Z" }), act({ status: "verified" }), act({ status: "rejected" })]) {
      expect((await withDisconnectState(view, ctxWith([other]), approvals())).connections[0]?.disconnect.pendingId).toBeNull();
    }
  });
  it("reports the gate with its reason when the lane policy class is missing, and when approvals are not live", async () => {
    const off = await withDisconnectState(view, ctxWith([]), approvals({ ...GATE_ON, writeActionsAllowed: [] }));
    expect(off.connections[0]?.disconnect.gate?.enabled).toBe(false);
    expect(off.connections[0]?.disconnect.gate?.message).toMatch(/.+/);
    const notLive = await withDisconnectState(view, ctxWith([]), approvals({ ...GATE_ON, approvalsLive: false }));
    expect(notLive.connections[0]?.disconnect.gate?.enabled).toBe(false);
    expect(notLive.connections[1]?.disconnect).toEqual({ pendingId: null, gate: null });
  });
  it("enabled gate when the policy class and approvals_live are on", async () => {
    expect((await withDisconnectState(view, ctxWith([]), approvals())).connections[0]?.disconnect.gate).toEqual({ enabled: true, message: null });
  });
  it("no realm id or payload reaches the output", async () => {
    expect(JSON.stringify(await withDisconnectState(view, ctxWith([act()]), approvals()))).not.toContain("9130000000001");
  });
});

describe("quickbooksSectionFor", () => {
  const ok = { requireRole: async () => ({ client: CLIENT, session: SESSION }) as never };
  it("asks for exactly owner or admin_technical of the lane", async () => {
    const roles: (readonly string[])[] = [];
    const g = { requireRole: async (_l: string, r: readonly string[]) => (roles.push(r), { client: CLIENT, session: SESSION }) as never };
    expect(await quickbooksSectionFor(g, "PKG", async () => ({ connections: [] }))).toEqual({ connections: [] });
    expect([...(roles[0] ?? [])].sort()).toEqual(["admin_technical", "owner"]);
  });

  it("is null (nothing drawn) for another role, AAL1, no session or another lane; a role-check outage is not swallowed", async () => {
    for (const reason of ["forbidden", "mfa_required", "no_session"] as const) {
      const g = { requireRole: async () => Promise.reject(new AuthError(reason)) };
      expect(await quickbooksSectionFor(g, "PKG", async () => ({ connections: [conn()] })), reason).toBeNull();
    }
    const down = { requireRole: async () => Promise.reject(new Error("outage")) };
    await expect(quickbooksSectionFor(down, "PKG", async () => ({ connections: [] }))).rejects.toThrow("outage");
  });

  it("a read outage after the role check is `unavailable`", async () => {
    expect(await quickbooksSectionFor(ok, "PKG", async () => Promise.reject(new Error("db")))).toEqual({ connections: [], unavailable: true });
  });
});
