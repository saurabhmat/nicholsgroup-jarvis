// `core.connection_set_microsoft_identity` through the connector (T-066): arguments, error mapping with fixed text, refusals before any call.
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { createMicrosoftIdentityWriter } from "./identity";

const LANE = "PKG";
const ID = "00000000-0000-4000-8000-0000000066a1";
const TENANT = "11111111-1111-4111-8111-111111111111";

function fake(result: { error?: { code?: string; message?: string } | null } | (() => never)) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    schema: (schema: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn: `${schema}.${fn}`, args });
        if (typeof result === "function") return result();
        return { data: null, error: result.error ?? null };
      },
    }),
  };
  return { calls, clientFor: vi.fn(async () => client as never) };
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return (e as ConnectorError).info;
  }
  throw new Error("expected a rejection");
};

describe("createMicrosoftIdentityWriter", () => {
  it("calls core.connection_set_microsoft_identity with the lane, connection, tenant and cloud, through the lane's client", async () => {
    const f = fake({});
    await createMicrosoftIdentityWriter(f.clientFor).setOnce(LANE, ID, TENANT, "commercial");
    expect(f.clientFor).toHaveBeenCalledWith(LANE);
    expect(f.calls).toEqual([{ fn: "core.connection_set_microsoft_identity", args: { p_lane: LANE, p_connection_id: ID, p_tenant_id: TENANT, p_cloud: "commercial" } }]);
  });

  it("maps the database codes to fixed messages (never the database text)", async () => {
    const cases: [string, string][] = [["P0002", "not_found"], ["55000", "forbidden"], ["23514", "invalid_input"], ["22023", "invalid_input"], ["22004", "invalid_input"], ["XX000", "transient"]];
    for (const [code, kind] of cases) {
      const info = await failure(createMicrosoftIdentityWriter(fake({ error: { code, message: "secret-db-text 11111111" } }).clientFor).setOnce(LANE, ID, TENANT, "commercial"));
      expect(info.kind, code).toBe(kind);
      expect(info.message, code).not.toContain("secret-db-text");
    }
  });

  it("refuses a bad lane, connection id or tenant (including `common`) before any call; an unavailable lane or a thrown call is a fixed error", async () => {
    const f = fake({});
    const w = createMicrosoftIdentityWriter(f.clientFor);
    for (const args of [["pkg", ID, TENANT], [LANE, "not-a-uuid", TENANT], [LANE, ID, "common"], [LANE, ID, TENANT.toUpperCase().replace(/1/g, "A")]] as const) {
      expect((await failure(w.setOnce(args[0], args[1], args[2], "commercial"))).kind, args.join(",")).toBe("invalid_input");
    }
    expect(f.calls).toEqual([]);
    const noLane = createMicrosoftIdentityWriter(vi.fn(async () => { throw new Error("no lane"); }));
    expect((await failure(noLane.setOnce(LANE, ID, TENANT, "commercial"))).kind).toBe("connection_unavailable");
    const thrown = fake(() => { throw new Error("socket text 11111111"); });
    const info = await failure(createMicrosoftIdentityWriter(thrown.clientFor).setOnce(LANE, ID, TENANT, "commercial"));
    expect(info.kind).toBe("transient");
    expect(info.message).not.toContain("socket text");
  });
});
