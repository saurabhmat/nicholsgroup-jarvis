// The connection identity reader (T-256): lane + id selection, fixed errors, only two columns.
import { describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { createMicrosoftIdentityReader } from "./identity";

const ID = "9f1b2c3d-1111-4222-8333-444455556666";
function clientReturning(result: { data: unknown; error: unknown } | "throw") {
  const calls: { table?: string; columns?: string; eq: [string, unknown][] } = { eq: [] };
  const q = {
    select(c: string) { calls.columns = c; return q; },
    eq(k: string, v: unknown) { calls.eq.push([k, v]); return q; },
    maybeSingle: async () => { if (result === "throw") throw new Error("db password is hunter2"); return result; },
  };
  const client = { schema: () => ({ from: (t: string) => { calls.table = t; return q; } }) };
  return { calls, clientFor: async () => client as never };
}
const kind = async (p: Promise<unknown>) => { try { await p; } catch (e) { return isConnectorError(e) ? e.info : null; } return null; };

describe("createMicrosoftIdentityReader", () => {
  it("reads tenant_id and cloud of the row of this lane and id only", async () => {
    const { calls, clientFor } = clientReturning({ data: { tenant_id: "11111111-1111-4111-8111-111111111111", cloud: "commercial" }, error: null });
    expect(await createMicrosoftIdentityReader(clientFor).read("PKG", ID)).toEqual({ tenantId: "11111111-1111-4111-8111-111111111111", cloud: "commercial" });
    expect(calls).toMatchObject({ table: "connections", columns: "tenant_id, cloud", eq: [["lane_id", "PKG"], ["id", ID]] });
  });
  it("null columns stay null; a missing row is not_found; a database failure is transient with fixed text", async () => {
    expect(await createMicrosoftIdentityReader(clientReturning({ data: { tenant_id: null, cloud: null }, error: null }).clientFor).read("PKG", ID)).toEqual({ tenantId: null, cloud: null });
    expect((await kind(createMicrosoftIdentityReader(clientReturning({ data: null, error: null }).clientFor).read("PKG", ID)))?.kind).toBe("not_found");
    const t = await kind(createMicrosoftIdentityReader(clientReturning("throw").clientFor).read("PKG", ID));
    expect(t?.kind).toBe("transient");
    expect(JSON.stringify(t)).not.toContain("hunter2");
  });
  it("refuses a malformed lane or id before any query, and an unavailable lane", async () => {
    const { calls, clientFor } = clientReturning({ data: null, error: null });
    expect((await kind(createMicrosoftIdentityReader(clientFor).read("pkg" as never, ID)))?.kind).toBe("invalid_input");
    expect((await kind(createMicrosoftIdentityReader(clientFor).read("PKG", "not-a-uuid")))?.kind).toBe("invalid_input");
    expect(calls.table).toBeUndefined();
    const failing = async () => { throw new Error("no such lane"); };
    expect((await kind(createMicrosoftIdentityReader(failing as never).read("PKG", ID)))?.kind).toBe("connection_unavailable");
  });
});
