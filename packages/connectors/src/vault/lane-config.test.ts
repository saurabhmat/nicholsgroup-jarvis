// Lane config reader (T-050): the one field the connect flow needs, read for one lane with the job client.
import { describe, expect, it, vi } from "vitest";
import { createLaneConfigReader } from "./lane-config";

function client(result: { data?: unknown; error?: unknown } | (() => never)) {
  const calls: { table: string; select: string; filters: [string, unknown][] }[] = [];
  const c = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const call = { table: `${schema}.${table}`, select: "", filters: [] as [string, unknown][] };
        calls.push(call);
        const q = {
          select: (s: string) => ((call.select = s), q),
          eq: (k: string, v: unknown) => (call.filters.push([k, v]), q),
          maybeSingle: async () => (typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null }),
        };
        return q;
      },
    }),
  };
  return { calls, clientFor: vi.fn(async () => c as never) };
}
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { info?: { kind?: string } }).info?.kind;
  }
  return "no error";
};

describe("qboRealmId", () => {
  it("reads only qbo.realm_id of the lane's current config, filtered by lane", async () => {
    const { calls, clientFor } = client({ data: { config: { qbo: { realm_id: "9341450000000001", entity_mapping_mode: "file" }, kpis: ["mrr"] } } });
    expect(await createLaneConfigReader(clientFor).qboRealmId("PKG")).toBe("9341450000000001");
    expect(clientFor).toHaveBeenCalledWith("PKG");
    expect(calls).toEqual([{ table: "core.lane_config_current", select: "config", filters: [["lane_id", "PKG"]] }]);
  });

  it("returns null when the lane has no config or no qbo section", async () => {
    expect(await createLaneConfigReader(client({ data: null }).clientFor).qboRealmId("PKG")).toBeNull();
    expect(await createLaneConfigReader(client({ data: { config: { kpis: [] } } }).clientFor).qboRealmId("PKG")).toBeNull();
    expect(await createLaneConfigReader(client({ data: { config: { qbo: null } } }).clientFor).qboRealmId("PKG")).toBeNull();
  });

  it("fails closed on a malformed realm", async () => {
    for (const realm of ["abc", "", 123, "1".repeat(21), { x: 1 }]) {
      expect(await kindOf(createLaneConfigReader(client({ data: { config: { qbo: { realm_id: realm } } } }).clientFor).qboRealmId("PKG")), String(realm)).toBe("provider_error");
    }
    expect(await kindOf(createLaneConfigReader(client({ data: { config: { qbo: "x" } } }).clientFor).qboRealmId("PKG"))).toBe("provider_error");
  });

  it("maps outages and unavailable lanes without passing database text on", async () => {
    expect(await kindOf(createLaneConfigReader(client({ error: { message: "secret db text" } }).clientFor).qboRealmId("PKG"))).toBe("transient");
    expect(
      await kindOf(
        createLaneConfigReader(
          client(() => {
            throw new Error("boom");
          }).clientFor,
        ).qboRealmId("PKG"),
      ),
    ).toBe("transient");
    expect(await kindOf(createLaneConfigReader(vi.fn(async () => Promise.reject(new Error("no lane")))).qboRealmId("PKG"))).toBe("connection_unavailable");
    expect(await kindOf(createLaneConfigReader(client({}).clientFor).qboRealmId("pkg"))).toBe("invalid_input");
  });
});
