// The subscription store (T-068, T-264) over core.push_subscription_*: lane-bound, RPC arguments exact, rows re-validated, database text never passed on, the clientState only as a
// SecretValue. The functions themselves are pinned by pgTAP 326.
import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "../vault/secret";
import { SUBSCRIPTION_RESOURCES } from "./constants";
import { createMicrosoftSubscriptionStore } from "./subscription-store";

const CONN = "00000000-0000-4000-8000-000000032611";
const STATE = "synthetic-client-state-canary-0123456789abcdefgh";

function fake(result: { data?: unknown; error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const client = { schema: (schema: string) => ({ rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ schema, fn, args }), typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }) }) };
  const clientFor = vi.fn(async () => client as never);
  return { calls, clientFor };
}
const kind = async (p: Promise<unknown>) => (await p.then(() => "ok", (e: { info?: { kind?: string } }) => e.info?.kind)) as string;

describe("arguments", () => {
  it("every call names the lane and goes through the lane's client; record sends the provider, the resource path template and the clientState as a bind parameter", async () => {
    const f = fake({ data: null });
    const store = createMicrosoftSubscriptionStore(f.clientFor);
    const at = new Date("2026-11-28T12:00:00.000Z");
    await store.record("PKG", { connectionId: CONN, resource: "mail", subscriptionId: "sub-1", expiresAt: at, clientState: new SecretValue(STATE) });
    expect(f.clientFor).toHaveBeenCalledWith("PKG");
    expect(f.calls).toEqual([
      {
        schema: "core",
        fn: "push_subscription_record",
        args: { p_lane: "PKG", p_connection_id: CONN, p_provider: "microsoft", p_resource: "mail", p_subscription_id: "sub-1", p_resource_path: SUBSCRIPTION_RESOURCES.mail, p_expires_at: at.toISOString(), p_client_state: STATE },
      },
    ]);
  });

  it("list, renewed, mark, removeConnection, lookup and purge call their SQL functions with the lane and, where they act on a row, the connection", async () => {
    const f = fake({ data: true });
    const store = createMicrosoftSubscriptionStore(f.clientFor);
    const at = new Date("2026-11-28T12:00:00.000Z");
    await store.list("PKG", CONN);
    expect(await store.renewed("PKG", CONN, "sub-1", at)).toBe(true);
    expect(await store.mark("PKG", CONN, "sub-1", "removed")).toBe(true);
    await store.removeConnection("PKG", CONN);
    await store.lookup("PKG", "sub-1");
    await store.purge("PKG");
    expect(f.calls.map((c) => [c.fn, c.args])).toEqual([
      ["push_subscription_list", { p_lane: "PKG", p_connection_id: CONN }],
      ["push_subscription_renewed", { p_lane: "PKG", p_connection_id: CONN, p_subscription_id: "sub-1", p_expires_at: at.toISOString() }],
      ["push_subscription_mark", { p_lane: "PKG", p_connection_id: CONN, p_subscription_id: "sub-1", p_status: "removed" }],
      ["push_subscriptions_remove_connection", { p_lane: "PKG", p_connection_id: CONN }],
      ["push_subscription_lookup", { p_lane: "PKG", p_provider: "microsoft", p_subscription_id: "sub-1" }],
      ["push_subscriptions_purge", { p_lane: "PKG" }],
    ]);
  });
});

describe("results", () => {
  it("list keeps only well-formed rows", async () => {
    const good = { resource: "calendar", subscription_id: "s1", status: "active", expires_at: "2026-11-28T12:00:00+00:00" };
    const store = createMicrosoftSubscriptionStore(fake({ data: [good, { ...good, resource: "drive" }, { ...good, status: "removed" }, { ...good, expires_at: "soon" }, { ...good, subscription_id: 7 }, null] }).clientFor);
    expect(await store.list("PKG", CONN)).toEqual([{ resource: "calendar", subscriptionId: "s1", status: "active", expiresAt: new Date("2026-11-28T12:00:00.000Z") }]);
  });

  it("lookup returns the lane, the connection, the stream and the clientState as a SecretValue; anything malformed or empty is null", async () => {
    const row = { connection_id: CONN, resource: "mail", status: "active", client_state: STATE };
    const found = await createMicrosoftSubscriptionStore(fake({ data: [row] }).clientFor).lookup("PKG", "s1");
    expect(found).toMatchObject({ laneId: "PKG", connectionId: CONN, resource: "mail", status: "active" });
    expect(found?.clientState).toBeInstanceOf(SecretValue);
    expect(JSON.stringify(found)).not.toContain(STATE);
    expect(String(found?.clientState)).not.toContain(STATE);
    for (const data of [[], null, [{ ...row, resource: "x" }], [{ ...row, client_state: "" }], [{ ...row, status: "removed" }], [{ ...row, connection_id: 5 }]]) {
      expect(await createMicrosoftSubscriptionStore(fake({ data }).clientFor).lookup("PKG", "s1")).toBeNull();
    }
  });

  it("renewed and mark are false for anything but true", async () => {
    expect(await createMicrosoftSubscriptionStore(fake({ data: false }).clientFor).renewed("PKG", CONN, "s", new Date())).toBe(false);
    expect(await createMicrosoftSubscriptionStore(fake({ data: "yes" }).clientFor).mark("PKG", CONN, "s", "removed")).toBe(false);
  });
});

describe("failures carry fixed text", () => {
  it("a database error, a lane that cannot be reached and a refusal: fixed kinds, no database text, no clientState", async () => {
    const dbText = `permission denied for ${STATE} secret db text`;
    const store = createMicrosoftSubscriptionStore(fake({ error: { code: "XX000", message: dbText } }).clientFor);
    const err = await store.lookup("PKG", "s1").catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain("secret db text");
    expect(await kind(store.lookup("PKG", "s1"))).toBe("transient");
    expect(await kind(createMicrosoftSubscriptionStore(fake({ error: { code: "42501", message: dbText } }).clientFor).record("PKG", { connectionId: CONN, resource: "mail", subscriptionId: "s", expiresAt: new Date(), clientState: new SecretValue(STATE) }))).toBe("connection_unavailable");
    expect(await kind(createMicrosoftSubscriptionStore(async () => { throw new Error(dbText); }).list("PKG", CONN))).toBe("transient");
    expect(await kind(createMicrosoftSubscriptionStore(fake(() => { throw new Error(dbText); }).clientFor).list("PKG", CONN))).toBe("transient");
  });
});
