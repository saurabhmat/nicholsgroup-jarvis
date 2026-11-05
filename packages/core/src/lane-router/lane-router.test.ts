import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuditError } from "../audit/index";
import { createLaneRouter, LaneAccessError, type ClientFactory, type LaneClient } from "./index";

type Row = { data_plane: string } | null;
type Calls = { schema: string[]; from: string[]; eq: [string, unknown][]; rpc: [string, unknown][] };

/** A minimal stand-in for the supabase-js chain the router uses. */
function fakeClient(row: Row, opts: { error?: boolean; rpcError?: boolean } = {}) {
  const calls: Calls = { schema: [], from: [], eq: [], rpc: [] };
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      calls.eq.push([col, val]);
      return builder;
    },
    maybeSingle: async () => (opts.error ? { data: null, error: { message: "boom" } } : { data: row, error: null }),
  };
  const client = {
    schema: (name: string) => {
      calls.schema.push(name);
      return {
        from: (table: string) => {
          calls.from.push(table);
          return builder;
        },
        rpc: async (fn: string, args: unknown) => {
          calls.rpc.push([fn, args]);
          return { data: 1, error: opts.rpcError ? { message: 'Failing row contains ("secret")' } : null };
        },
      };
    },
  };
  return { client: client as unknown as LaneClient, calls };
}

function factory(user: ReturnType<typeof fakeClient>, service: ReturnType<typeof fakeClient>, lanes = ["PKG"]) {
  const tokens: string[] = [];
  const f: ClientFactory = {
    userClient: (token) => {
      tokens.push(token);
      return user.client;
    },
    serviceClient: () => service.client,
    enabledLanes: () => lanes,
  };
  return { f, tokens };
}

const SESSION = { userId: "00000000-0000-4000-8000-000000000001", accessToken: "user-access-token" };
const reason = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof LaneAccessError ? e.reason : String(e)));

describe("lane router module", () => {
  it("imports server-only first (T-003 review M2)", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src.split("\n")[0]).toBe('import "server-only";');
  });
});

describe("getLaneClient", () => {
  it("returns the user's own client for a lane its RLS can see, querying with the user's token", async () => {
    const user = fakeClient({ data_plane: "core" });
    const { f, tokens } = factory(user, fakeClient(null));
    const client = await createLaneRouter(f).getLaneClient("PKG", SESSION);
    expect(client).toBe(user.client);
    expect(tokens).toEqual(["user-access-token"]);
    expect(user.calls.schema).toEqual(["core"]);
    expect(user.calls.from).toEqual(["lanes"]);
    expect(user.calls.eq).toEqual([["code", "PKG"], ["enabled", true]]);
  });

  it("refuses non-members, disabled lanes and AAL1 sessions (RLS returns no row)", async () => {
    const { f } = factory(fakeClient(null), fakeClient({ data_plane: "core" }));
    expect(await reason(createLaneRouter(f).getLaneClient("PKG", SESSION))).toBe("not_allowed");
  });

  it("fails closed when the lane query errors", async () => {
    const { f } = factory(fakeClient(null, { error: true }), fakeClient(null));
    expect(await reason(createLaneRouter(f).getLaneClient("PKG", SESSION))).toBe("not_allowed");
  });

  it("refuses without a session", async () => {
    const { f, tokens } = factory(fakeClient({ data_plane: "core" }), fakeClient(null));
    const router = createLaneRouter(f);
    expect(await reason(router.getLaneClient("PKG", undefined as never))).toBe("not_allowed");
    expect(await reason(router.getLaneClient("PKG", { userId: "x", accessToken: "" }))).toBe("not_allowed");
    expect(tokens).toEqual([]);
  });

  it("rejects malformed lane ids and lanes this deployment does not serve, before any query", async () => {
    const user = fakeClient({ data_plane: "core" });
    const { f, tokens } = factory(user, fakeClient(null), ["PKG"]);
    const router = createLaneRouter(f);
    for (const bad of ["pkg", "", "PKG;--", "TOOLONGLANE", 1 as never]) expect(await reason(router.getLaneClient(bad, SESSION))).toBe("invalid_lane");
    expect(await reason(router.getLaneClient("APK", SESSION))).toBe("not_served");
    expect(tokens).toEqual([]);
  });

  it("fails closed for the NL data plane (slot defined, not configured)", async () => {
    const { f } = factory(fakeClient({ data_plane: "nl" }), fakeClient(null), ["NL"]);
    expect(await reason(createLaneRouter(f).getLaneClient("NL", SESSION))).toBe("data_plane_unavailable");
  });
});

/** A list-shaped stand-in: the router awaits the chain after order(). */
function listClient(rows: { code: string; name: string; data_plane: string }[], error = false) {
  const calls: { eq: [string, unknown][]; select: string[]; order: string[] } = { eq: [], select: [], order: [] };
  const builder = {
    select: (cols: string) => (calls.select.push(cols), builder),
    eq: (col: string, val: unknown) => (calls.eq.push([col, val]), builder),
    order: async (col: string) => (calls.order.push(col), error ? { data: null, error: { message: "boom" } } : { data: rows, error: null }),
  };
  const client = { schema: () => ({ from: () => builder }) } as unknown as LaneClient;
  return { client, calls };
}

describe("listLanes", () => {
  const rows = [
    { code: "APK", name: "Ask Pub K", data_plane: "core" },
    { code: "NL", name: "Nichols Law", data_plane: "nl" },
    { code: "PKG", name: "Pub K Group", data_plane: "core" },
  ];

  it("lists what the user's own client can see, limited to served core-plane lanes", async () => {
    const user = listClient(rows);
    const { f, tokens } = factory(user as never, fakeClient(null), ["PKG", "NL"]);
    const lanes = await createLaneRouter(f).listLanes(SESSION);
    expect(lanes).toEqual([{ laneId: "PKG", name: "Pub K Group" }]); // APK not served, NL data plane not configured
    expect(tokens).toEqual(["user-access-token"]);
    expect(user.calls.eq).toEqual([["enabled", true]]);
    expect(user.calls.order).toEqual(["code"]);
  });

  it("is empty when RLS shows nothing, and refuses without a session", async () => {
    const { f, tokens } = factory(listClient([]) as never, fakeClient(null));
    const router = createLaneRouter(f);
    expect(await router.listLanes(SESSION)).toEqual([]);
    expect(await reason(router.listLanes({ userId: "x", accessToken: "" }))).toBe("not_allowed");
    expect(tokens).toEqual(["user-access-token"]);
  });

  it("a failed query is an outage, not an empty list", async () => {
    const { f } = factory(listClient([], true) as never, fakeClient(null));
    await expect(createLaneRouter(f).listLanes(SESSION)).rejects.toThrow("lane list unavailable");
  });
});

describe("getLaneJobClient", () => {
  it("returns the service client for an enabled, served lane", async () => {
    const service = fakeClient({ data_plane: "core" });
    const { f, tokens } = factory(fakeClient(null), service);
    expect(await createLaneRouter(f).getLaneJobClient("PKG")).toBe(service.client);
    expect(service.calls.eq).toEqual([["code", "PKG"], ["enabled", true]]);
    expect(tokens).toEqual([]);
  });

  it("refuses disabled or unserved lanes", async () => {
    const { f } = factory(fakeClient(null), fakeClient(null), ["PKG"]);
    const router = createLaneRouter(f);
    expect(await reason(router.getLaneJobClient("PKG"))).toBe("not_allowed");
    expect(await reason(router.getLaneJobClient("APK"))).toBe("not_served");
  });
});

describe("getAudit", () => {
  it("writes through audit.log() with the service client", async () => {
    const service = fakeClient(null);
    const { f } = factory(fakeClient(null), service);
    await createLaneRouter(f).getAudit().log({ laneId: "PKG", actor: { kind: "service" }, action: "sync.run_finished" });
    expect(service.calls.schema).toEqual(["audit"]);
    expect(service.calls.rpc).toEqual([
      ["log", { p_lane_id: "PKG", p_actor_kind: "service", p_actor_id: null, p_action: "sync.run_finished", p_target: null, p_metadata: {} }],
    ]);
  });

  it("an rpc error becomes AuditError without the database message", async () => {
    const { f } = factory(fakeClient(null), fakeClient(null, { rpcError: true }));
    const err = await createLaneRouter(f)
      .getAudit()
      .log({ laneId: "PKG", actor: { kind: "system" }, action: "x.y" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(String(err)).not.toContain("secret");
  });
});
