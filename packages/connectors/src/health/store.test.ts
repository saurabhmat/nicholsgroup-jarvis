// Token-health store (T-040) against a recording fake of the job client: tables, filters, values. Cross-lane denial in
// the database is covered by the connections pgTAP tests (RLS + lane filter).
import { describe, expect, it } from "vitest";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { createTokenHealthStore } from "./store";

const conn = mintLaneBoundConnection({
  id: "00000000-0000-4000-8000-000000000401", lane_id: "PKG", provider: "quickbooks", external_account_id: "realm-1", status: "degraded", features: {},
  features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null,
} as Connection);

function fake(result: { data?: unknown; error?: unknown }) {
  const calls: { op: string; values?: unknown; filters: [string, string, unknown][] }[] = [];
  const lanes: string[] = [];
  const mk = (op: string, values?: unknown) => {
    const call = { op, values, filters: [] as [string, string, unknown][] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const f of ["eq", "in"]) b[f] = (c: string, v: unknown) => { call.filters.push([f, c, v]); return b; };
    b.select = () => b; b.order = () => b; b.limit = () => b;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(res);
    return b;
  };
  const client = { schema: (s: string) => ({ from: (t: string) => ({ select: () => mk(`select:${s}.${t}`), update: (v: unknown) => mk(`update:${s}.${t}`, v) }) }) };
  return { calls, lanes, clientFor: async (l: string) => { lanes.push(l); return client as never; } };
}

describe("token health store", () => {
  it("lists only the lane's usable native connections (a Composio one has no token to check, T-219), narrowed by provider", async () => {
    const f = fake({ data: [{ id: "a" }, { id: "b" }] });
    const store = createTokenHealthStore(f.clientFor);
    await expect(store.listUsableConnectionIds("PKG", ["google"])).resolves.toEqual(["a", "b"]);
    expect(f.lanes).toEqual(["PKG"]);
    expect(f.calls[0]?.filters).toEqual([["eq", "lane_id", "PKG"], ["eq", "transport", "native"], ["in", "status", ["active", "degraded"]], ["in", "provider", ["google"]]]);
  });

  it("an empty provider list means none, without a query", async () => {
    const f = fake({});
    await expect(createTokenHealthStore(f.clientFor).listUsableConnectionIds("PKG", [])).resolves.toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("applies the patch scoped to lane, id and the status it was loaded with; only health fields", async () => {
    const f = fake({ data: [{ id: conn.id }] });
    await expect(createTokenHealthStore(f.clientFor).applyHealth("PKG", conn, { status: "active", last_error: null })).resolves.toBe(true);
    const c = f.calls[0];
    expect(c?.values).toEqual({ status: "active", last_error: null });
    expect(c?.filters).toEqual(expect.arrayContaining([["eq", "lane_id", "PKG"], ["eq", "id", conn.id], ["eq", "status", "degraded"]]));
  });

  it("returns false when the row changed meanwhile, and refuses a wrong lane", async () => {
    const f = fake({ data: [] });
    const store = createTokenHealthStore(f.clientFor);
    await expect(store.applyHealth("PKG", conn, { last_error: null })).resolves.toBe(false);
    await expect(store.applyHealth("APK", conn, { last_error: null })).rejects.toThrow();
  });

  it("clears last_error only when it is still the health check's own error, in this lane", async () => {
    const f = fake({ data: [{ id: conn.id }] });
    const store = createTokenHealthStore(f.clientFor);
    await expect(store.clearHealthError("PKG", conn)).resolves.toBe(true);
    expect(f.calls[0]?.values).toEqual({ last_error: null });
    expect(f.calls[0]?.filters).toEqual([["eq", "lane_id", "PKG"], ["eq", "id", conn.id], ["eq", "last_error->>endpoint", "/health-check"]]);
    await expect(store.clearHealthError("APK", conn)).rejects.toThrow();
  });

  it("hides database errors behind a fixed message", async () => {
    const f = fake({ error: { message: "secret detail", code: "XX" } });
    const store = createTokenHealthStore(f.clientFor);
    await expect(store.listUsableConnectionIds("PKG")).rejects.toThrow("Connection store unavailable");
    await expect(store.applyHealth("PKG", conn, { last_error: null })).rejects.toThrow("Connection store unavailable");
  });
});
