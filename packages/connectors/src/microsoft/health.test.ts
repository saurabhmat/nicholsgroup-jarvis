// The Microsoft health check (T-256): GET /me through the guarded client, reporting a HealthStatus without throwing and without
// keeping anything from the response.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { createTokenHealthJob } from "../health/job";
import type { ConnectionHealthPatch, TokenHealthStore } from "../health/types";
import { createMicrosoftHarness, TENANT_A, TENANT_B } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";
import { createMicrosoftHealthSkip } from "./health";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());
const EXEC = "exec@pubkgroup.example.test";

function setup() {
  const fake = createFakeMicrosoft();
  server.use(...fake.handlers);
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: ["google", "microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] } } });
  return { fake, h, ...h.connect("PKG", EXEC) };
}

describe("health", () => {
  it("is ok after one GET /me, and keeps nothing of the profile", async () => {
    const { h, fake, conn } = setup();
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: true, status: "active", error: null });
    expect(fake.state.graphRequests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1.0/me"]);
    expect(JSON.stringify(res)).not.toContain(EXEC);
    expect(JSON.stringify(res)).not.toContain("Synthetic Executive");
  });

  it("a dead grant is reconnect_required (and the token manager's hook ran once)", async () => {
    const { h, conn, account } = setup();
    account.revoked = true;
    h.expireStoredAccess(conn.id);
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: false, status: "reconnect_required", error: { kind: "reconnect_required" } });
    expect(h.reconnects).toHaveLength(1);
  });

  it("a Graph failure is degraded with a fixed message, never Microsoft's text", async () => {
    const { h, fake, conn } = setup();
    fake.state.meFail = { status: 403, code: "ErrorAccessDenied", times: 1 };
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: false, status: "degraded", error: { kind: "forbidden", http_status: 403 } });
    expect(JSON.stringify(res)).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
  });

  it("a throttled check is a retry-disposition failure (the daily job treats it as inconclusive)", async () => {
    const { h, conn, account } = setup();
    account.throttle = { status: 429, retryAfter: 1, remaining: Infinity };
    const res = await h.health("PKG", conn);
    expect(res.ok).toBe(false);
    expect(res.error?.disposition).toBe("retry");
  });

  it("is refused by the guard like any call: Microsoft removed from the lane means no token read and no request", async () => {
    const { h, fake, conn } = setup();
    h.setLane("PKG", { providers: ["google"] });
    const res = await h.health("PKG", conn);
    expect(res).toMatchObject({ ok: false, error: { kind: "connection_unavailable" } });
    expect(h.stats.tokenReads).toBe(0);
    expect(fake.state.graphRequests).toHaveLength(0);
  });
});

describe("the daily health job and a Microsoft connection that is paused", () => {
  /** The real job over the harness: a store that records every change, the real skip and the real health check. */
  function job(over: { status?: "active" | "degraded"; cloud?: "commercial" | "gcc_high" } = {}) {
    const f = setup();
    if (over.status) { const r = f.h.rows.get(f.row.id); if (r) r.status = over.status; }
    const patches: ConnectionHealthPatch[] = [];
    let cleared = 0;
    const store: TokenHealthStore = {
      listUsableConnectionIds: async () => [f.row.id],
      applyHealth: async (_l, _c, patch) => (patches.push(patch), true),
      clearHealthError: async () => (cleared++, true),
      reconnectNoticePending: async () => false,
      markReconnectNotified: async () => undefined,
    };
    const run = createTokenHealthJob({
      loader: {
        loadConnection: async (_l, id) => {
          const r = f.h.rows.get(id);
          if (!r) throw new Error("no such row");
          return f.h.bind(r) as LaneBoundConnection<string>;
        },
      },
      store,
      checkers: { microsoft: f.h.health },
      skips: { microsoft: createMicrosoftHealthSkip({ laneConfig: f.h.laneConfig }) },
    });
    return { ...f, patches, cleared: () => cleared, run: () => run.run("PKG", f.row.id) };
  }

  it("a provider switched off for the lane is skipped: no status change, no last_error, no alert, no token read, no request", async () => {
    const j = job();
    j.h.setLane("PKG", { providers: ["google"] }); // the microsoft block stays
    expect(await j.run()).toEqual({ ok: true, skipped: "connection_not_usable", alerts: [] });
    expect(j.patches).toEqual([]);
    expect(j.cleared()).toBe(0);
    expect(j.h.stats.tokenReads).toBe(0);
    expect(j.fake.state.graphRequests).toHaveLength(0);
    expect(j.fake.state.tokenRequests).toHaveLength(0);
  });

  it("a degraded paused row stays degraded (the skip does not heal it either), and a lane with no microsoft block is the same", async () => {
    const j = job({ status: "degraded" });
    j.h.setLane("PKG", { microsoft: null });
    expect(await j.run()).toMatchObject({ ok: true, skipped: "connection_not_usable", alerts: [] });
    expect(j.patches).toEqual([]);
    expect(j.h.stats.tokenReads).toBe(0);
  });

  it("a lane on gcc_high is skipped the same way", async () => {
    const j = job();
    j.h.setLane("PKG", { microsoft: { tenantIds: [TENANT_A], cloud: "gcc_high" } });
    expect(await j.run()).toMatchObject({ ok: true, skipped: "connection_not_usable", alerts: [] });
    expect(j.patches).toEqual([]);
    expect(j.h.stats.tokenReads).toBe(0);
    expect(j.fake.state.graphRequests).toHaveLength(0);
  });

  it("an unreadable lane config is a retryable failure that changes nothing", async () => {
    const j = job();
    delete j.h.lanes.PKG;
    expect(await j.run()).toMatchObject({ ok: false, retryable: true });
    expect(j.patches).toEqual([]);
    expect(j.h.stats.tokenReads).toBe(0);
  });

  it("a tenant removed from the lane is NOT skipped: it stays a real failure (forbidden), flagged and alerted", async () => {
    const j = job();
    j.h.setLane("PKG", { microsoft: { tenantIds: [TENANT_B] } });
    const out = await j.run();
    expect(out).toMatchObject({ ok: true, skipped: null, alerts: [{ provider: "microsoft", reason: "health_check_failed", errorKind: "forbidden" }] });
    expect(j.patches[0]).toMatchObject({ status: "degraded", last_error: { kind: "forbidden" } });
    expect(j.h.stats.tokenReads).toBe(0);
    expect(j.fake.state.graphRequests).toHaveLength(0);
  });

  it("a healthy enabled connection is checked as before", async () => {
    const j = job();
    expect(await j.run()).toEqual({ ok: true, skipped: null, alerts: [] });
    expect(j.fake.state.graphRequests).toHaveLength(1);
  });
});
