// The service-side closing of a Teams connection's open send actions (T-286): which function is called, with which lane and connection, and fixed errors.
import { describe, expect, it, vi } from "vitest";
import { createTeamsActionsStore } from "./actions-purge-store";

const mk = (result: { data?: unknown; error?: unknown } | (() => never)) => {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const client = { schema: (schema: string) => ({ rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ schema, fn, args }); return typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }; } }) };
  return { calls, clientFor: vi.fn(async () => client as never) };
};

describe("the Teams send-action store", () => {
  it("closes one connection's open actions through the lane's job client", async () => {
    const { calls, clientFor } = mk({ data: 2 });
    expect(await createTeamsActionsStore(clientFor).purgeConnection("PKG", "00000000-0000-4000-8000-000000000c01")).toBe(2);
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ schema: "core", fn: "teams_actions_purge_connection", args: { p_lane: "PKG", p_connection: "00000000-0000-4000-8000-000000000c01" } }]);
  });
  it("an error or an unexpected value is a fixed transient error (never the database's text)", async () => {
    for (const r of [{ error: { code: "42501", message: "secret detail" } }, { data: "3" }, { data: -1 }, { data: 1.5 }, () => { throw new Error("secret detail"); }] as const) {
      const e = await createTeamsActionsStore(mk(r as never).clientFor).purgeConnection("PKG", "c").then(() => null, (x: unknown) => x as { info: { kind: string; message: string } });
      expect(e?.info.kind).toBe("transient");
      expect(JSON.stringify(e)).not.toContain("secret detail");
    }
  });
  it("asks which message ids another action recorded (ids only) and refuses a malformed answer with fixed text", async () => {
    const { calls, clientFor } = mk({ data: ["m1"] });
    expect(await createTeamsActionsStore(clientFor).claimedExternalIds("PKG", "00000000-0000-4000-8000-000000000c01", "00000000-0000-4000-8000-000000000a01", ["m1", "m2"])).toEqual(["m1"]);
    expect(calls).toEqual([{ schema: "core", fn: "act_claimed_external_ids", args: { p_lane: "PKG", p_connection: "00000000-0000-4000-8000-000000000c01", p_except: "00000000-0000-4000-8000-000000000a01", p_ids: ["m1", "m2"] } }]);
    for (const r of [{ error: { message: "secret detail" } }, { data: "m1" }, { data: [1] }, () => { throw new Error("secret detail"); }] as const) {
      const e = await createTeamsActionsStore(mk(r as never).clientFor).claimedExternalIds("PKG", "c", "a", ["m1"]).then(() => null, (x: unknown) => x as { info: { kind: string } });
      expect(e?.info.kind).toBe("transient");
      expect(JSON.stringify(e)).not.toContain("secret detail");
    }
  });
});
