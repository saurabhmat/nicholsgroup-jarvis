// The service-side deletion of the Teams read markers (T-282): which function is called, with which lane and connection, and fixed errors.
import { describe, expect, it, vi } from "vitest";
import { createTeamsChatReadsStore } from "./chat-reads-store";

const mk = (result: { data?: unknown; error?: unknown } | (() => never)) => {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const client = { schema: (schema: string) => ({ rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ schema, fn, args }); return typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }; } }) };
  return { calls, clientFor: vi.fn(async () => client as never) };
};

describe("the Teams read-marker store", () => {
  it("deletes one connection's markers through the lane's job client", async () => {
    const { calls, clientFor } = mk({ data: 3 });
    expect(await createTeamsChatReadsStore(clientFor).purgeConnection("PKG", "00000000-0000-4000-8000-000000000c01")).toBe(3);
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ schema: "core", fn: "teams_chat_reads_purge_connection", args: { p_lane: "PKG", p_connection: "00000000-0000-4000-8000-000000000c01" } }]);
  });
  it("an error or an unexpected value is a fixed transient error (never the database's text)", async () => {
    for (const r of [{ error: { code: "42501", message: "secret detail" } }, { data: "3" }, { data: -1 }, { data: 1.5 }, () => { throw new Error("secret detail"); }] as const) {
      const e = await createTeamsChatReadsStore(mk(r as never).clientFor).purgeConnection("PKG", "c").then(() => null, (x: unknown) => x as { info: { kind: string; message: string } });
      expect(e?.info.kind).toBe("transient");
      expect(JSON.stringify(e)).not.toContain("secret detail");
    }
  });
});
