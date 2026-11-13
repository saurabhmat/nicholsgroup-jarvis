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
  it("the realm is cut to its last four characters; an id of 8 characters or fewer shows no tail", () => {
    expect(realmTailOf("9130000000001")).toBe("0001");
    expect(realmTailOf("123456789")).toBe("6789");
    expect(realmTailOf("12345678")).toBe("");
    expect(realmTailOf("1234")).toBe("");
  });
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

  it("a disconnected row next to a live one: only the live one is shown and wasDisconnected is not set", async () => {
    const { client } = fake({
      data: [
        { id: "c2", external_account_id: "9130000000002", status: "disconnected", last_sync_at: null, features: {} },
        { id: "c1", external_account_id: "9130000000001", status: "active", last_sync_at: null, features: {} },
      ],
      error: null,
    });
    const view = await loadQuickBooksSection(client, "PKG");
    expect(view.connections.map((c) => c.id)).toEqual(["c1"]);
    expect(view.wasDisconnected).toBeUndefined();
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
  const C1 = "00000000-0000-4000-8000-000000002901";
  const C2 = "00000000-0000-4000-8000-000000002902";
  const A1 = "00000000-0000-4000-8000-0000000000aa";
  const view = { connections: [conn({ id: C1 }), conn({ id: C2, state: "reconnect_required" }), conn({ id: "c3", state: "connecting" })] };
  const GATE_ON = { qbo: { realmId: "9130000000001" }, writeActionsAllowed: ["qbo_disconnect"], approvalsLive: true, stepUpMaxAgeS: 300, mailbox: null, composeGranted: false };
  /** A fake lane client: `schema("core").rpc` records every call and answers act_pending_qbo_disconnects. */
  function clientWith(answer: () => Promise<{ data: unknown; error: unknown }>) {
    const calls: [string, unknown][] = [];
    return { calls, client: { schema: (s: string) => ({ rpc: async (fn: string, args: unknown) => (calls.push([`${s}.${fn}`, args]), answer()) }) } as never };
  }
  const rows = (data: unknown) => clientWith(async () => ({ data, error: null }));
  const approvals = (facts: Record<string, unknown> = GATE_ON) => {
    const reads: [string, string][] = [];
    return { reads, deps: { readFacts: async (lane: string, id: string) => (reads.push([lane, id]), facts) } as never };
  };

  it("reads only through the read-only pending function (no listApprovals, no job client, no write), for this lane", async () => {
    const { client, calls } = rows([]);
    await withDisconnectState(view, { client, laneId: "PKG" }, approvals().deps);
    expect(calls).toEqual([["core.act_pending_qbo_disconnects", { p_lane: "PKG" }]]);
  });
  it("a read failure (error, thrown, odd shape) leaves the view as it was", async () => {
    for (const c of [clientWith(async () => ({ data: null, error: { message: "x" } })), clientWith(async () => Promise.reject(new Error("x"))), rows({ not: "an array" })]) {
      expect(await withDisconnectState(view, { client: c.client, laneId: "PKG" }, approvals().deps)).toEqual(view);
    }
  });
  it("nothing to disconnect: nothing is read at all", async () => {
    const { client, calls } = rows([]);
    const a = approvals();
    const only = { connections: [conn({ state: "connecting" })] };
    expect(await withDisconnectState(only, { client, laneId: "PKG" }, a.deps)).toEqual(only);
    expect(calls).toEqual([]);
    expect(a.reads).toEqual([]);
  });
  it("a connection still being set up gets no disconnect state", async () => {
    const out = await withDisconnectState(view, { client: rows([]).client, laneId: "PKG" }, approvals().deps);
    expect(out.connections[2]?.disconnect).toEqual({ pendingId: null, gate: null });
  });
  it("a pending proposal shows its id on its own connection only; unknown rows and other shapes are ignored", async () => {
    const out = await withDisconnectState(view, { client: rows([{ id: A1, connection_id: C2 }, { id: 5, connection_id: C1 }, null, { id: "x", connection_id: "other" }]).client, laneId: "PKG" }, approvals().deps);
    expect(out.connections[0]?.disconnect.pendingId).toBeNull();
    expect(out.connections[1]?.disconnect.pendingId).toBe(A1);
  });
  it("the lane's facts are read once, however many connections there are", async () => {
    const a = approvals();
    await withDisconnectState(view, { client: rows([]).client, laneId: "PKG" }, a.deps);
    expect(a.reads).toEqual([["PKG", C1]]);
  });
  it("reports the gate with its reason when the lane policy class is missing, and when approvals are not live; the same gate on every connection", async () => {
    const off = await withDisconnectState(view, { client: rows([]).client, laneId: "PKG" }, approvals({ ...GATE_ON, writeActionsAllowed: [] }).deps);
    expect(off.connections[0]?.disconnect.gate?.enabled).toBe(false);
    expect(off.connections[0]?.disconnect.gate?.message).toMatch(/.+/);
    expect(off.connections[1]?.disconnect.gate).toEqual(off.connections[0]?.disconnect.gate);
    const notLive = await withDisconnectState(view, { client: rows([]).client, laneId: "PKG" }, approvals({ ...GATE_ON, approvalsLive: false }).deps);
    expect(notLive.connections[0]?.disconnect.gate?.enabled).toBe(false);
  });
  it("enabled gate when the policy class and approvals_live are on; a facts failure leaves the gate unknown", async () => {
    expect((await withDisconnectState(view, { client: rows([]).client, laneId: "PKG" }, approvals().deps)).connections[0]?.disconnect.gate).toEqual({ enabled: true, message: null });
    const broken = { readFacts: async () => Promise.reject(new Error("x")) } as never;
    expect((await withDisconnectState(view, { client: rows([]).client, laneId: "PKG" }, broken)).connections[0]?.disconnect.gate).toBeNull();
  });
  it("no realm id or payload reaches the output", async () => {
    expect(JSON.stringify(await withDisconnectState(view, { client: rows([{ id: A1, connection_id: C1, target: { realm_id: "9130000000001" } }]).client, laneId: "PKG" }, approvals().deps))).not.toContain("9130000000001");
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
