// T-219: the Composio connection store over a fake Supabase client: every query names the lane, the account id comes
// from the row, database messages never leak, D0023 becomes the in-use refusal.
import { describe, expect, it } from "vitest";
import { ACCOUNT_IN_USE_MESSAGE } from "../contract/errors";
import { createComposioConnectionStore } from "./store";

const USER = "11111111-1111-4111-8111-111111111111";
const ID = "00000000-0000-4000-8000-000000000001";

type Call = { op: string; table?: string; filters: unknown[][]; values?: unknown; fn?: string; args?: unknown };
function fake(result: { data?: unknown; error?: { code?: string; message?: string } | null } = {}) {
  const calls: Call[] = [];
  const mk = (call: Call) => {
    const b: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "order", "limit", "select"]) b[m] = (...a: unknown[]) => ((call.filters.push([m, ...a])), b);
    b.maybeSingle = async () => ({ data: result.data ?? null, error: result.error ?? null });
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(res);
    return b;
  };
  const client = {
    schema: () => ({
      from: (table: string) => ({
        select: () => {
          const c: Call = { op: "select", table, filters: [] };
          calls.push(c);
          return mk(c);
        },
        upsert: (values: unknown) => {
          calls.push({ op: "upsert", table, filters: [], values });
          return Promise.resolve({ error: null });
        },
        update: (values: unknown) => {
          const c: Call = { op: "update", table, filters: [], values };
          calls.push(c);
          return mk(c);
        },
      }),
      rpc: async (fn: string, args: unknown) => {
        calls.push({ op: "rpc", fn, args, filters: [] });
        return { data: null, error: result.error ?? null };
      },
    }),
  };
  return { calls, clientFor: async () => client as never };
}
const row = { id: ID, lane_id: "PKG", toolkit: "gmail", external_account_id: "ca_1", account_identity: "boss@example.test", status: "active", created_by: USER, last_sync_at: null };

describe("composio connection store", () => {
  it("ensurePending inserts a composio/google pending row for the lane and reads it back by lane + account", async () => {
    const f = fake({ data: { ...row, status: "pending", account_identity: null } });
    const out = await createComposioConnectionStore(f.clientFor).ensurePending("PKG", "gmail", "ca_1", USER);
    expect(out).toMatchObject({ id: ID, laneId: "PKG", toolkit: "gmail", accountId: "ca_1", status: "pending", identity: null });
    expect(f.calls[0]).toMatchObject({ op: "upsert", values: { lane_id: "PKG", provider: "google", transport: "composio", toolkit: "gmail", external_account_id: "ca_1", status: "pending", created_by: USER } });
    expect(f.calls[1]?.filters).toContainEqual(["eq", "lane_id", "PKG"]);
    expect(f.calls[1]?.filters).toContainEqual(["eq", "transport", "composio"]);
  });
  it("refuses bad input before touching the database", async () => {
    const f = fake();
    const s = createComposioConnectionStore(f.clientFor);
    await expect(s.ensurePending("PKG", "notion" as never, "ca_1", USER)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(s.ensurePending("PKG", "gmail", "ca 1", USER)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(s.ensurePending("pkg", "gmail", "ca_1", USER)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(s.activate("PKG", "not-a-uuid", "a@b.test", USER)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(f.calls).toEqual([]);
  });
  it("activate calls the security-definer function with the lane; D0023 is the in-use refusal; other errors are generic", async () => {
    const ok = fake();
    await createComposioConnectionStore(ok.clientFor).activate("PKG", ID, "boss@example.test", USER);
    expect(ok.calls[0]).toMatchObject({ op: "rpc", fn: "connection_activate_composio", args: { p_lane_id: "PKG", p_connection_id: ID, p_identity: "boss@example.test", p_actor_id: USER } });
    const inUse = fake({ error: { code: "D0023", message: "boss@example.test is connected" } });
    await expect(createComposioConnectionStore(inUse.clientFor).activate("PKG", ID, "boss@example.test", USER)).rejects.toMatchObject({ info: { kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE } });
    const bad = fake({ error: { code: "XX000", message: "secret database text" } });
    const err = await createComposioConnectionStore(bad.clientFor).activate("PKG", ID, "x@y.test", USER).catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain("secret database text");
  });
  it("find is lane-bound, composio-only, per toolkit, newest not-disconnected", async () => {
    const f = fake({ data: row });
    const out = await createComposioConnectionStore(f.clientFor).find("PKG", "gmail");
    expect(out).toMatchObject({ identity: "boss@example.test", createdBy: USER });
    const filters = f.calls[0]?.filters ?? [];
    expect(filters).toContainEqual(["eq", "lane_id", "PKG"]);
    expect(filters).toContainEqual(["eq", "transport", "composio"]);
    expect(filters).toContainEqual(["eq", "toolkit", "gmail"]);
    expect(filters).toContainEqual(["neq", "status", "disconnected"]);
  });
  it("a malformed stored row is refused rather than trusted", async () => {
    for (const bad of [{ ...row, external_account_id: "ca 1" }, { ...row, toolkit: "notion" }, { ...row, status: "weird" }, { ...row, id: "x" }]) {
      const f = fake({ data: bad });
      await expect(createComposioConnectionStore(f.clientFor).find("PKG", "gmail")).rejects.toMatchObject({ info: { kind: "provider_error" } });
    }
  });
  it("setHealth updates only composio rows of the lane with a status guard, and never touches pending or disconnected rows", async () => {
    const f = fake({ data: [{ id: ID }] });
    const s = createComposioConnectionStore(f.clientFor);
    const conn = { id: ID, laneId: "PKG", toolkit: "gmail", accountId: "ca_1", identity: "boss@example.test", status: "active", createdBy: USER, lastSyncAt: null } as const;
    expect(await s.setHealth("PKG", { ...conn }, "reconnect_required")).toBe(true);
    expect(f.calls[0]?.values).toEqual({ status: "reconnect_required" });
    expect(f.calls[0]?.filters).toEqual(expect.arrayContaining([["eq", "lane_id", "PKG"], ["eq", "transport", "composio"], ["eq", "status", "active"]]));
    const before = f.calls.length;
    expect(await s.setHealth("PKG", { ...conn, status: "pending" }, "active")).toBe(false);
    expect(await s.setHealth("PKG", { ...conn, status: "disconnected" }, "active")).toBe(false);
    expect(f.calls.length).toBe(before);
    await expect(s.setHealth("APK", { ...conn }, "active")).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });
});
