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

describe("retentionDays (T-063)", () => {
  it("reads the lane policy's retention_days for the lane", async () => {
    const { calls, clientFor } = client({ data: { retention_days: 90 } });
    expect(await createLaneConfigReader(clientFor).retentionDays("PKG")).toBe(90);
    expect(calls).toEqual([{ table: "core.lane_policies", select: "retention_days", filters: [["lane_id", "PKG"]] }]);
  });
  it("fails closed: a missing or invalid policy and a database error are errors, never a default", async () => {
    for (const data of [null, { retention_days: null }, { retention_days: 0 }, { retention_days: "90" }, { retention_days: 99999 }]) {
      const { clientFor } = client({ data });
      expect(await kindOf(createLaneConfigReader(clientFor).retentionDays("PKG"))).toBe("connection_unavailable");
    }
    expect(await kindOf(createLaneConfigReader(client({ error: { code: "x" } }).clientFor).retentionDays("PKG"))).toBe("transient");
  });
});

describe("mailboxes (T-063)", () => {
  it("returns the lane's mailboxes lower-cased, empty when none, and fails closed on malformed ones", async () => {
    expect(await createLaneConfigReader(client({ data: { config: { mailboxes: ["Exec@Example.test"] } } }).clientFor).mailboxes("PKG")).toEqual(["exec@example.test"]);
    expect(await createLaneConfigReader(client({ data: { config: {} } }).clientFor).mailboxes("PKG")).toEqual([]);
    expect(await kindOf(createLaneConfigReader(client({ data: { config: { mailboxes: ["not an address"] } } }).clientFor).mailboxes("PKG"))).toBe("provider_error");
  });
});

describe("calendarSettings (T-064)", () => {
  const read = (data: unknown) => createLaneConfigReader(client({ data }).clientFor).calendarSettings("PKG");
  it("defaults when the lane has no calendar section: primary and selected owned calendars, 365 days ahead", async () => {
    const safe = { calendarIds: null, includeReadOnly: false, forwardDays: 365 };
    expect(await read(null)).toEqual(safe);
    expect(await read({ config: {} })).toEqual(safe);
    expect(await read({ config: { calendar: null } })).toEqual(safe);
    expect(await read({ config: { calendar: {} } })).toEqual(safe);
  });
  it("reads an explicit list, include_read_only and forward_days", async () => {
    expect(await read({ config: { calendar: { calendar_ids: ["en.usa#holiday@group.v.calendar.google.com"], include_read_only: true, forward_days: 90 } } })).toEqual({
      calendarIds: ["en.usa#holiday@group.v.calendar.google.com"],
      includeReadOnly: true,
      forwardDays: 90,
    });
  });
  it("fails closed on anything malformed, never to a default", async () => {
    for (const calendar of ["x", [], { calendar_ids: [] }, { calendar_ids: "primary" }, { calendar_ids: [1] }, { calendar_ids: ["has space"] }, { calendar_ids: ["a\nb"] }, { calendar_ids: Array.from({ length: 11 }, (_v, i) => `c${String(i)}`) }, { include_read_only: "yes" }, { forward_days: 0 }, { forward_days: 6 }, { forward_days: 731 }, { forward_days: 30.5 }, { forward_days: "30" }]) {
      expect(await kindOf(read({ config: { calendar } })), JSON.stringify(calendar)).toBe("provider_error");
    }
    expect(await kindOf(createLaneConfigReader(client({ error: { code: "x" } }).clientFor).calendarSettings("PKG"))).toBe("transient");
  });
});

describe("retentionSettings (T-042)", () => {
  // The policy read and the config read are two queries on the same client: answer by table.
  const both = (policy: unknown, config: unknown) => {
    const c = {
      schema: () => ({
        from: (table: string) => {
          const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === "lane_policies" ? policy : config, error: null }) };
          return q;
        },
      }),
    };
    return vi.fn(async () => c as never);
  };

  it("comms follows the lane policy; the rest default when lane_config has no retention section", async () => {
    const r = await createLaneConfigReader(both({ retention_days: 90 }, { config: {} })).retentionSettings("PKG");
    expect(r).toEqual({ commsDays: 90, calendarDays: 180, conversationsDays: 180, webhookDays: 30 });
    expect(await createLaneConfigReader(both({ retention_days: 30 }, null)).retentionSettings("NL")).toEqual({ commsDays: 30, calendarDays: 180, conversationsDays: 180, webhookDays: 30 });
  });

  it("reads lane_config.retention values", async () => {
    const r = await createLaneConfigReader(both({ retention_days: 90 }, { config: { retention: { calendar_days: 60, conversations_days: 365, webhook_days: 14 } } })).retentionSettings("PKG");
    expect(r).toEqual({ commsDays: 90, calendarDays: 60, conversationsDays: 365, webhookDays: 14 });
  });

  it("fails closed on out-of-range or malformed values and on a missing policy", async () => {
    for (const retention of [{ calendar_days: 181 }, { calendar_days: 29 }, { webhook_days: 6 }, { conversations_days: "x" }, { webhook_days: 1.5 }, "x", []]) {
      expect(await kindOf(createLaneConfigReader(both({ retention_days: 90 }, { config: { retention } })).retentionSettings("PKG")), JSON.stringify(retention)).toBe("provider_error");
    }
    expect(await kindOf(createLaneConfigReader(both(null, { config: {} })).retentionSettings("PKG"))).toBe("connection_unavailable");
    // the config part alone does not need the policy
    expect(await createLaneConfigReader(both(null, { config: {} })).retentionConfig("PKG")).toEqual({ calendarDays: 180, conversationsDays: 180, webhookDays: 30 });
  });
});
