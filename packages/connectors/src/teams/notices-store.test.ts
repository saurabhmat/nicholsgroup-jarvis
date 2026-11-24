// The service side of the Teams notices (T-289): arguments exact and lane-bound, P0002 is "dropped" (not an error), everything else is a fixed transient error with no database text, the owner
// check asks the database for THIS owner in THIS lane. Synthetic ids only.
import { describe, expect, it, vi } from "vitest";
import { createTeamsNoticesStore } from "./notices-store";

const CONN = "00000000-0000-4000-8000-000000028901";
const OWNER = "00000000-0000-4000-8000-000000028902";

function fake(result: { data?: unknown; error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
  const client = { schema: (schema: string) => ({ rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ schema, fn, args }), typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }) }) };
  return { calls, clientFor: vi.fn(async () => client as never) };
}
const kind = async (p: Promise<unknown>) => (await p.then(() => "ok", (e: { info?: { kind?: string } }) => e.info?.kind)) as string;

describe("recordNotice", () => {
  it("calls core.teams_activity_notice with the lane and the connection through the lane's client, and is true for a recorded notice", async () => {
    const f = fake({ data: "2026-11-23T12:00:00+00:00" });
    expect(await createTeamsNoticesStore(f.clientFor).recordNotice("PKG", CONN)).toBe(true);
    expect(f.clientFor).toHaveBeenCalledWith("PKG");
    expect(f.calls).toEqual([{ schema: "core", fn: "teams_activity_notice", args: { p_lane: "PKG", p_connection: CONN } }]);
  });

  it("P0002 (no usable Teams connection of this lane with this id: disconnected meanwhile, another lane's) is `false`, not an error", async () => {
    expect(await createTeamsNoticesStore(fake({ error: { code: "P0002", message: "teams activity: not found" } }).clientFor).recordNotice("PKG", CONN)).toBe(false);
  });

  it("any other failure is a fixed transient error with no database text; a missing client too", async () => {
    const e = await createTeamsNoticesStore(fake({ error: { code: "XX000", message: "secret db text" } }).clientFor).recordNotice("PKG", CONN).catch((x: unknown) => x);
    expect(e).toMatchObject({ info: { kind: "transient" } });
    expect(JSON.stringify(e)).not.toContain("secret db text");
    expect(await kind(createTeamsNoticesStore(vi.fn(async () => { throw new Error("no lane"); })).recordNotice("PKG", CONN))).toBe("transient");
  });
});

describe("purgeConnection", () => {
  it("calls core.teams_activity_purge_connection and returns the count; an odd answer is an error, not a zero", async () => {
    const f = fake({ data: 1 });
    expect(await createTeamsNoticesStore(f.clientFor).purgeConnection("PKG", CONN)).toBe(1);
    expect(f.calls).toEqual([{ schema: "core", fn: "teams_activity_purge_connection", args: { p_lane: "PKG", p_connection: CONN } }]);
    for (const data of [null, "1", 1.5, -1]) expect(await kind(createTeamsNoticesStore(fake({ data }).clientFor).purgeConnection("PKG", CONN))).toBe("transient");
    expect(await kind(createTeamsNoticesStore(fake({ error: { code: "42501" } }).clientFor).purgeConnection("PKG", CONN))).toBe("transient");
  });
});

describe("ownerStillAllowed", () => {
  it("asks core.teams_connection_ids for THIS owner in THIS lane and is true only when the connection is among them", async () => {
    const f = fake({ data: [CONN] });
    expect(await createTeamsNoticesStore(f.clientFor).ownerStillAllowed("PKG", CONN, OWNER)).toBe(true);
    expect(f.calls).toEqual([{ schema: "core", fn: "teams_connection_ids", args: { p_uid: OWNER, p_lane: "PKG" } }]);
    expect(await createTeamsNoticesStore(fake({ data: [] }).clientFor).ownerStillAllowed("PKG", CONN, OWNER)).toBe(false);
    expect(await createTeamsNoticesStore(fake({ data: ["00000000-0000-4000-8000-000000028999"] }).clientFor).ownerStillAllowed("PKG", CONN, OWNER)).toBe(false);
  });

  it("no owner, or one that is not an id, is not allowed and asks nothing; a database failure is transient (the renewal then changes nothing)", async () => {
    const f = fake({ data: [CONN] });
    expect(await createTeamsNoticesStore(f.clientFor).ownerStillAllowed("PKG", CONN, null)).toBe(false);
    expect(await createTeamsNoticesStore(f.clientFor).ownerStillAllowed("PKG", CONN, "x")).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(await kind(createTeamsNoticesStore(fake({ error: { code: "XX000" } }).clientFor).ownerStillAllowed("PKG", CONN, OWNER))).toBe("transient");
    expect(await kind(createTeamsNoticesStore(fake({ data: "nope" }).clientFor).ownerStillAllowed("PKG", CONN, OWNER))).toBe("transient");
  });
});
