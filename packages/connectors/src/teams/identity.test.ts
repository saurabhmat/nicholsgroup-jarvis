// The Teams identity reader and writer (T-278, T-279): lane-checked, the server-only object id read through the job client, fixed errors that carry no database text, D0024 mapped to the
// one-account message. A fake supabase client stands in for the lane's job client (the SQL itself is proved in pgTAP 328).
import { describe, expect, it } from "vitest";
import { TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import { createTeamsIdentityReader, createTeamsIdentityWriter } from "./identity";

const ID = "00000000-0000-4000-8000-0000000f0279";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OBJECT = "22222222-2222-4222-8222-222222222222";

function readerClient(answer: { data: unknown; error: unknown }) {
  const seen: [string, unknown][] = [];
  const b: Record<string, unknown> = {};
  b.select = (c: string) => (seen.push(["select", c]), b);
  b.eq = (c: string, v: unknown) => (seen.push([c, v]), b);
  b.maybeSingle = async () => answer;
  return { client: async () => ({ schema: () => ({ from: () => b }) }) as never, seen };
}

describe("reader", () => {
  it("selects tenant, cloud and the object id for this lane, connection and the Teams provider only", async () => {
    const { client, seen } = readerClient({ data: { tenant_id: TENANT, cloud: "commercial", entra_object_id: OBJECT }, error: null });
    expect(await createTeamsIdentityReader(client).read("PKG", ID)).toEqual({ tenantId: TENANT, cloud: "commercial", entraObjectId: OBJECT });
    expect(seen).toEqual([["select", "tenant_id, cloud, entra_object_id"], ["lane_id", "PKG"], ["id", ID], ["provider", "microsoft_teams"]]);
  });

  it("an unset identity reads as nulls; no row (or another lane's or provider's) is not_found; a database error is a fixed transient; bad arguments never reach the database", async () => {
    expect(await createTeamsIdentityReader(readerClient({ data: { tenant_id: null, cloud: null, entra_object_id: null }, error: null }).client).read("PKG", ID)).toEqual({ tenantId: null, cloud: null, entraObjectId: null });
    await expect(createTeamsIdentityReader(readerClient({ data: null, error: null }).client).read("PKG", ID)).rejects.toMatchObject({ info: { kind: "not_found" } });
    const e = await createTeamsIdentityReader(readerClient({ data: null, error: { message: "relation x secret-db-text" } }).client).read("PKG", ID).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ info: { kind: "transient", message: "Connection store unavailable" } });
    expect(JSON.stringify(e)).not.toContain("secret-db-text");
    const reader = createTeamsIdentityReader(readerClient({ data: null, error: null }).client);
    await expect(reader.read("pkg", ID)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(reader.read("PKG", "nope")).rejects.toMatchObject({ info: { kind: "invalid_input" } });
  });
});

function writerClient(error: { code?: string } | null) {
  const calls: [string, Record<string, unknown>][] = [];
  const core = { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push([fn, args]), { error }) };
  return { client: async () => ({ schema: () => core }) as never, calls };
}
const identity = { tenantId: TENANT, cloud: "commercial", entraObjectId: OBJECT };

describe("writer", () => {
  it("calls connection_set_teams_identity with the lane, the connection, the tenant, the cloud and the object id", async () => {
    const { client, calls } = writerClient(null);
    await createTeamsIdentityWriter(client).setOnce("PKG", ID, identity);
    expect(calls).toEqual([["connection_set_teams_identity", { p_lane: "PKG", p_connection_id: ID, p_tenant_id: TENANT, p_cloud: "commercial", p_entra_object_id: OBJECT }]]);
  });

  it("maps the database codes to fixed errors without database text; D0024 is the one-account message", async () => {
    const cases: [string, string, string][] = [
      ["P0002", "not_found", "Connection not found"],
      ["23514", "invalid_input", "Not a Teams connection"],
      ["55000", "forbidden", "The tenant of this connection is already recorded"],
      ["D0024", "forbidden", TEAMS_ONE_ACCOUNT_MESSAGE],
      ["XX000", "transient", "Connection store unavailable"],
    ];
    for (const [code, kind, message] of cases) {
      await expect(createTeamsIdentityWriter(writerClient({ code }).client).setOnce("PKG", ID, identity), code).rejects.toMatchObject({ info: { kind, message } });
    }
  });

  it("bad arguments never reach the database", async () => {
    const { client, calls } = writerClient(null);
    const w = createTeamsIdentityWriter(client);
    for (const bad of [{ ...identity, tenantId: "x" }, { ...identity, entraObjectId: "x" }, { ...identity, entraObjectId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }]) await expect(w.setOnce("PKG", ID, bad)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(w.setOnce("pkg", ID, identity)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(w.setOnce("PKG", "nope", identity)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(calls).toEqual([]);
  });
});
