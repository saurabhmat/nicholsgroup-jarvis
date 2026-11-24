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
    await store.lookupMany("PKG", ["sub-1", "sub-2"]);
    await store.purge("PKG");
    expect(f.calls.map((c) => [c.fn, c.args])).toEqual([
      ["push_subscription_list", { p_lane: "PKG", p_connection_id: CONN }],
      ["push_subscription_renewed", { p_lane: "PKG", p_connection_id: CONN, p_subscription_id: "sub-1", p_expires_at: at.toISOString() }],
      ["push_subscription_mark", { p_lane: "PKG", p_connection_id: CONN, p_subscription_id: "sub-1", p_status: "removed" }],
      ["push_subscriptions_remove_connection", { p_lane: "PKG", p_connection_id: CONN }],
      // T-289: a notification does not say which kind of connection it is for: asked for the mail and calendar subscriptions (microsoft) and the Teams ones (microsoft_teams), together
      ["push_subscription_lookup", { p_lane: "PKG", p_provider: "microsoft", p_subscription_ids: ["sub-1", "sub-2"] }],
      ["push_subscription_lookup", { p_lane: "PKG", p_provider: "microsoft_teams", p_subscription_ids: ["sub-1", "sub-2"] }],
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

  it("lookupMany returns, by provider id, the lane, connection, stream and clientState (a SecretValue); anything malformed or empty is absent; an empty batch makes no call", async () => {
    const row = { subscription_id: "s1", connection_id: CONN, resource: "mail", status: "active", client_state: STATE };
    // the database answers per provider: only the mail provider holds this row
    const onlyMail = (data: unknown) => ({ clientFor: vi.fn(async () => ({ schema: () => ({ rpc: async (_f: string, a: Record<string, unknown>) => ({ data: a.p_provider === "microsoft" ? data : [], error: null }) }) }) as never) });
    const f = onlyMail([row]);
    const found = (await createMicrosoftSubscriptionStore(f.clientFor).lookupMany("PKG", ["s1"])).get("s1");
    expect(found).toMatchObject({ laneId: "PKG", connectionId: CONN, resource: "mail", status: "active" });
    expect(found?.clientState).toBeInstanceOf(SecretValue);
    expect(JSON.stringify(found)).not.toContain(STATE);
    expect(String(found?.clientState)).not.toContain(STATE);
    for (const data of [[], null, [{ ...row, resource: "x" }], [{ ...row, client_state: "" }], [{ ...row, status: "removed" }], [{ ...row, connection_id: 5 }], [{ ...row, subscription_id: 5 }]]) {
      expect((await createMicrosoftSubscriptionStore(onlyMail(data).clientFor).lookupMany("PKG", ["s1"])).size).toBe(0);
    }
    const none = fake({ data: [row] });
    expect((await createMicrosoftSubscriptionStore(none.clientFor).lookupMany("PKG", [])).size).toBe(0);
    expect(none.calls).toHaveLength(0);
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
    const err = await store.lookupMany("PKG", ["s1"]).catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain("secret db text");
    expect(await kind(store.lookupMany("PKG", ["s1"]))).toBe("transient");
    expect(await kind(createMicrosoftSubscriptionStore(fake({ error: { code: "42501", message: dbText } }).clientFor).record("PKG", { connectionId: CONN, resource: "mail", subscriptionId: "s", expiresAt: new Date(), clientState: new SecretValue(STATE) }))).toBe("connection_unavailable");
    expect(await kind(createMicrosoftSubscriptionStore(async () => { throw new Error(dbText); }).list("PKG", CONN))).toBe("transient");
    expect(await kind(createMicrosoftSubscriptionStore(fake(() => { throw new Error(dbText); }).clientFor).list("PKG", CONN))).toBe("transient");
  });
});

describe("Teams subscriptions (T-289)", () => {
  const OID_PATH = "users/00000000-0000-4000-8000-0000000000a1/chats/getAllMessages";

  it("record sends the Teams provider, the teams_chats resource and the person's all-chats path; a mail record is unchanged", async () => {
    const f = fake({ data: null });
    const store = createMicrosoftSubscriptionStore(f.clientFor);
    const at = new Date("2026-11-28T12:00:00.000Z");
    await store.record("PKG", { connectionId: CONN, resource: "teams_chats", resourcePath: OID_PATH, subscriptionId: "sub-t", expiresAt: at, clientState: new SecretValue(STATE) });
    await store.record("PKG", { connectionId: CONN, resource: "calendar", subscriptionId: "sub-c", expiresAt: at, clientState: new SecretValue(STATE) });
    expect(f.calls.map((c) => [c.args.p_provider, c.args.p_resource, c.args.p_resource_path])).toEqual([
      ["microsoft_teams", "teams_chats", OID_PATH],
      ["microsoft", "calendar", SUBSCRIPTION_RESOURCES.calendar],
    ]);
  });

  it("list reads a teams_chats row", async () => {
    const row = { resource: "teams_chats", subscription_id: "t1", status: "reauthorization_required", expires_at: "2026-11-28T12:00:00+00:00" };
    expect(await createMicrosoftSubscriptionStore(fake({ data: [row] }).clientFor).list("PKG", CONN)).toEqual([{ resource: "teams_chats", subscriptionId: "t1", status: "reauthorization_required", expiresAt: new Date("2026-11-28T12:00:00.000Z") }]);
  });

  it("lookupMany merges the two provider answers: a mail row and a Teams row are both found, each with its own resource; an id in neither is absent; both calls name the lane", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const answers: Record<string, unknown[]> = {
      microsoft: [{ subscription_id: "m1", connection_id: CONN, resource: "mail", status: "active", client_state: STATE }],
      microsoft_teams: [{ subscription_id: "t1", connection_id: CONN, resource: "teams_chats", status: "active", client_state: STATE }],
    };
    const client = { schema: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ fn, args }), { data: answers[String(args.p_provider)] ?? [], error: null }) }) };
    const found = await createMicrosoftSubscriptionStore(vi.fn(async () => client as never)).lookupMany("PKG", ["m1", "t1", "zz"]);
    expect([...found.keys()].sort()).toEqual(["m1", "t1"]);
    expect(found.get("t1")).toMatchObject({ laneId: "PKG", connectionId: CONN, resource: "teams_chats" });
    expect(found.get("m1")?.resource).toBe("mail");
    expect(calls.every((c) => c.args.p_lane === "PKG")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("the provider that answered is carried on the result (the receiver's claim must name it); an id that answers under BOTH providers is ambiguous and dropped, with one content-free log line", async () => {
    const warn = vi.fn();
    const both = { subscription_id: "dup", connection_id: CONN, resource: "mail", status: "active", client_state: STATE };
    const answers: Record<string, unknown[]> = {
      microsoft: [both, { ...both, subscription_id: "m1" }],
      microsoft_teams: [{ ...both, subscription_id: "dup", resource: "teams_chats" }, { ...both, subscription_id: "t1", resource: "teams_chats" }],
    };
    const client = { schema: () => ({ rpc: async (_fn: string, args: Record<string, unknown>) => ({ data: answers[String(args.p_provider)] ?? [], error: null }) }) };
    const found = await createMicrosoftSubscriptionStore(vi.fn(async () => client as never), { warn } as never).lookupMany("PKG", ["dup", "m1", "t1"]);
    expect([...found.keys()].sort()).toEqual(["m1", "t1"]);
    expect(found.get("m1")?.provider).toBe("microsoft");
    expect(found.get("t1")?.provider).toBe("microsoft_teams");
    expect(warn).toHaveBeenCalledWith("microsoft.subscription.ambiguous_lookup", { laneId: "PKG", count: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("dup");
  });

  it("a failure of either provider's lookup is a failure of the lookup (the receiver answers 503 and Graph retries), with a fixed message", async () => {
    let n = 0;
    const client = { schema: () => ({ rpc: async () => (++n === 2 ? { data: null, error: { code: "XX000", message: "secret db text" } } : { data: [], error: null }) }) };
    const e = await createMicrosoftSubscriptionStore(vi.fn(async () => client as never)).lookupMany("PKG", ["a"]).catch((x: unknown) => x);
    expect(e).toMatchObject({ info: { kind: "transient" } });
    expect(JSON.stringify(e)).not.toContain("secret db text");
  });
});
