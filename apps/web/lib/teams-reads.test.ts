// The portal's own read markers through the person's lane client (T-282, T-283): which functions are called and what is made of the answers.
import { describe, expect, it } from "vitest";
import { markRead, readMarkers } from "./teams-reads";

const client = (answer: { data?: unknown; error?: unknown }) => {
  const calls: { schema: string; fn: string; args: unknown }[] = [];
  return { calls, c: { schema: (schema: string) => ({ rpc: async (fn: string, args: unknown) => (calls.push({ schema, fn, args }), { data: answer.data ?? null, error: answer.error ?? null }) }) } as never };
};

describe("readMarkers", () => {
  it("lists the caller's markers of one connection (core wrapper, lane and connection named) as chat id -> ISO time", async () => {
    const { calls, c } = client({ data: [{ chat_id: "19:a@thread.v2", read_through: "2026-11-21T09:00:00+00:00" }, { chat_id: "19:b@thread.v2", read_through: "2026-11-20T09:00:00.123Z" }, { chat_id: 5, read_through: "x" }, null, { chat_id: "19:c@thread.v2", read_through: "garbage" }] });
    const m = await readMarkers(c, "PKG", "00000000-0000-4000-8000-0000000000c1");
    expect([...m]).toEqual([["19:a@thread.v2", "2026-11-21T09:00:00.000Z"], ["19:b@thread.v2", "2026-11-20T09:00:00.123Z"]]);
    expect(calls).toEqual([{ schema: "core", fn: "teams_chat_reads_list", args: { p_lane: "PKG", p_connection: "00000000-0000-4000-8000-0000000000c1" } }]);
  });
  it("a database error is an error (never 'everything is read')", async () => {
    await expect(readMarkers(client({ error: { code: "XX000" } }).c, "PKG", "c")).rejects.toThrow();
    await expect(readMarkers(client({ data: "nope" }).c, "PKG", "c")).rejects.toThrow();
  });
});

describe("markRead", () => {
  it("calls the writer wrapper with the lane, connection, chat and time; false when the database refuses", async () => {
    const ok = client({ data: "2026-11-21T09:00:00Z" });
    expect(await markRead(ok.c, "PKG", "c1", "19:a@thread.v2", "2026-11-21T09:00:00.000Z")).toBe(true);
    expect(ok.calls).toEqual([{ schema: "core", fn: "teams_chat_read_mark", args: { p_lane: "PKG", p_connection: "c1", p_chat: "19:a@thread.v2", p_read_through: "2026-11-21T09:00:00.000Z" } }]);
    expect(await markRead(client({ error: { code: "P0002" } }).c, "PKG", "c1", "19:a@thread.v2", "2026-11-21T09:00:00.000Z")).toBe(false);
  });
});
