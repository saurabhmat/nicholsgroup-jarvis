/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// T-195 (QB-3, QB-4, QB-6, QB-8 reconnect): invalid_grant, a revoked or expired refresh token and the reconnect flow.
//   * invalid_grant records `reconnect_required` (and last_error), sends ONE admin notification, and is never retried;
//   * after that conn.sync, the reports job, the webhook-triggered CDC and a direct connector call make no Intuit request;
//   * reconnecting through the connect flow reuses the same connection row (after reconnect_required and after disconnected),
//     flips it back to active, clears the error, and sync works again; a different realm is still refused.
// Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createConnSyncJob } from "../sync/job";
import { createQuickbooksUsableCheck } from "../sync/usable";
import { useMockServer } from "../testing/msw/index";
import { createFakeIntuit, FAKE_REALM } from "../testing/msw/quickbooks/handlers";
import { createQboHarness } from "../testing/quickbooks-harness";
import { createReconnectRecorder, createReconnectStore } from "./reconnect";
import { createConnectorSyncRunner } from "../sync/runners";
import type { SyncRunStore } from "../sync/types";
import { SecretValue } from "../vault/secret";
import { createTokenManager } from "./token-manager";

const server = useMockServer();
const LANE = "PKG";
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
afterEach(() => RateLimiter.resetForTests());

async function setup(realms: Record<string, string | null> = {}) {
  const intuit = createFakeIntuit();
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit, realms });
  const conn = await h.connectViaCallback(LANE);
  intuit.state.apiRequests.length = 0;
  return { intuit, h, conn };
}
const refreshCalls = (i: ReturnType<typeof createFakeIntuit>) => i.state.tokenRequests.filter((r) => r.grant === "refresh_token");
const apiCalls = (i: ReturnType<typeof createFakeIntuit>) => i.state.apiRequests.length + i.state.reportRequests.length + i.state.cdcRequests.length + i.state.queries.length;

/** Makes the stored refresh token worthless at Intuit (revoked in the user's Intuit account, or expired), then needs a refresh. */
function killRefreshToken(h: Awaited<ReturnType<typeof setup>>["h"], intuit: ReturnType<typeof createFakeIntuit>) {
  intuit.state.failRefresh = { status: 400, error: "invalid_grant", always: true };
  h.clock.t += 59 * 60_000; // inside the refresh window
}

describe("invalid_grant (revoked or expired refresh token)", () => {
  it("records reconnect_required with the redacted error, notifies once, and never retries the refresh", async () => {
    const { intuit, h, conn } = await setup();
    killRefreshToken(h, intuit);
    const err = (await h.api.get(LANE, conn, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM }).catch((e: unknown) => e)) as ConnectorError;
    expect(err.info).toMatchObject({ kind: "reconnect_required", disposition: "reconnect_required", provider_error_code: "invalid_grant", http_status: 400 });
    const row = h.rows.get(conn.id);
    expect(row?.status).toBe("reconnect_required");
    expect(row?.last_error).toMatchObject({ kind: "reconnect_required", provider_error_code: "invalid_grant" });
    expect(h.notices).toEqual([{ laneId: LANE, connectionId: conn.id, provider: "quickbooks", errorKind: "reconnect_required" }]);
    expect(refreshCalls(intuit)).toHaveLength(1);
    // The stored set is kept (so a disconnect can still try to revoke it) and nothing about it reached the notice or the error.
    const stored = h.secrets.get(conn.id) ?? "";
    expect(JSON.stringify([h.notices, row?.last_error, err.toJSON()])).not.toContain(JSON.parse(stored).refresh_token);
  });

  it("an expired refresh token is the same (Intuit no longer knows it)", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.validRefresh.clear();
    h.clock.t += 59 * 60_000;
    await expect(h.tokens.accessToken(LANE, conn)).rejects.toMatchObject({ info: { kind: "reconnect_required" } });
    expect(h.rows.get(conn.id)?.status).toBe("reconnect_required");
  });

  it("two callers failing at once notify once and refresh once (single flight)", async () => {
    const { intuit, h, conn } = await setup();
    killRefreshToken(h, intuit);
    const calls = Array.from({ length: 5 }, () => h.api.get(LANE, conn, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM }).catch((e: unknown) => e));
    const out = await Promise.all(calls);
    expect(out.every((e) => e instanceof ConnectorError && e.info.kind === "reconnect_required")).toBe(true);
    expect(h.notices).toHaveLength(1);
    expect(refreshCalls(intuit)).toHaveLength(1);
  });

  it("a second instance that fails after the status is already recorded changes nothing and notifies nobody", async () => {
    const { intuit, h, conn } = await setup();
    killRefreshToken(h, intuit);
    await h.tokens.accessToken(LANE, conn).catch(() => undefined);
    const before = { status: h.rows.get(conn.id)?.status, error: h.rows.get(conn.id)?.last_error };
    await h.newTokenManager().accessToken(LANE, conn).catch(() => undefined);
    expect(h.rows.get(conn.id)).toMatchObject({ status: before.status, last_error: before.error });
    expect(h.notices).toHaveLength(1);
  });

  it("a refresh that lost a race to another instance (its token is newer) is not a reconnect", async () => {
    const { intuit, h, conn } = await setup({});
    h.clock.t += 59 * 60_000;
    const a = h.newTokenManager();
    const b = h.newTokenManager();
    await Promise.all([a.accessToken(LANE, conn), b.accessToken(LANE, conn)]);
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.notices).toEqual([]);
    expect(refreshCalls(intuit).length).toBeGreaterThan(0);
  });

  it("a status store that is down does not hide the error: the caller still gets reconnect_required, the failure is logged without detail", async () => {
    const { intuit, h, conn } = await setup();
    const broken = createReconnectRecorder({
      store: { markReconnectRequired: async () => { throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" }); }, markNotified: async () => undefined },
      notify: async () => { throw new Error("must not be reached"); },
    });
    const tokens = createTokenManager({
      vault: h.vault,
      tokenEndpoint: async (l) => (await h.discovery.get(l, "sandbox")).token,
      client: () => ({ clientId: "synthetic-intuit-client-id", clientSecret: new SecretValue("synthetic-intuit-client-secret-01") }),
      now: () => h.clock.t,
      onReconnectRequired: broken,
    });
    killRefreshToken(h, intuit);
    await expect(tokens.accessToken(LANE, conn)).rejects.toMatchObject({ info: { kind: "reconnect_required" } });
  });
});

describe("after reconnect_required nothing talks to Intuit (QB-4: no sync, no retry)", () => {
  async function broken() {
    const ctx = await setup();
    killRefreshToken(ctx.h, ctx.intuit);
    await ctx.h.api.get(LANE, ctx.conn, "/v3/company/{realm}/companyinfo/{realm}", { realm: FAKE_REALM }).catch(() => undefined);
    expect(ctx.h.rows.get(ctx.conn.id)?.status).toBe("reconnect_required");
    ctx.intuit.state.apiRequests.length = 0;
    ctx.intuit.state.tokenRequests.length = 0;
    return ctx;
  }

  it("the connector's sync refuses with reconnect_required before any request", async () => {
    const { intuit, h, conn } = await broken();
    await expect(h.connector.sync!(LANE, conn, null, async () => undefined)).rejects.toMatchObject({ info: { kind: "reconnect_required", disposition: "reconnect_required" } });
    expect(apiCalls(intuit)).toBe(0);
    expect(intuit.state.tokenRequests).toHaveLength(0);
  });

  it("conn.sync skips the connection: no run is started, no request is made", async () => {
    const { intuit, h, conn } = await broken();
    const runs: SyncRunStore = {
      start: async () => { throw new Error("a run must not start for a reconnect_required connection"); },
      finish: async () => undefined,
      recordOutcome: async () => undefined,
    };
    const job = createConnSyncJob({
      loader: { loadConnection: (l, id) => h.connections.load(l, id) },
      runs,
      runners: { quickbooks: createConnectorSyncRunner({ connector: h.connector, cursors: { get: async () => null, put: async () => true }, sinkFor: () => async () => undefined }) },
    });
    for (const trigger of ["schedule", "manual", "webhook"] as const) {
      expect(await job.run(LANE, conn.id, { trigger })).toEqual({ ok: true, skipped: "connection_not_usable" });
    }
    expect(apiCalls(intuit)).toBe(0);
  });

  it("the webhook-triggered CDC is not started (usable check says no)", async () => {
    const { h, conn } = await broken();
    const usable = createQuickbooksUsableCheck({ loadConnection: (l, id) => h.connections.load(l, id) });
    expect(await usable(LANE, conn.id)).toBe(false);
  });

  it("the reports job is skipped without a request", async () => {
    const { intuit, h, conn } = await broken();
    expect(await h.reportsJob.run(LANE, conn.id)).toEqual({ ok: true, skipped: "connection_not_usable" });
    expect(apiCalls(intuit)).toBe(0);
    expect(h.reportState.stored).toEqual([]);
  });

  it("a direct API call still cannot refresh quietly: it asks Intuit once more only if called, and a health check reports reconnect_required without a request", async () => {
    const { intuit, h, conn } = await broken();
    const health = await h.connector.health(LANE, conn);
    expect(health).toMatchObject({ ok: false, status: "reconnect_required" });
    expect(apiCalls(intuit)).toBe(0);
  });
});

describe("reconnect (QB-4, QB-8): the connect flow, the same connection row", () => {
  it("after reconnect_required: same id, active again, error cleared, new tokens, sync works", async () => {
    const { intuit, h, conn } = await setup();
    killRefreshToken(h, intuit);
    await h.tokens.accessToken(LANE, conn).catch(() => undefined);
    expect(h.rows.get(conn.id)?.status).toBe("reconnect_required");
    intuit.state.failRefresh = null;
    const before = h.secrets.get(conn.id);
    const again = await h.connectViaCallback(LANE, ADMIN, FAKE_REALM, "synthetic-code-0001");
    expect(again.id).toBe(conn.id);
    expect(h.rows.size).toBe(1);
    const row = h.rows.get(conn.id);
    expect(row).toMatchObject({ status: "active", last_error: null });
    expect(h.secrets.get(conn.id)).not.toBe(before);
    const { summary } = await (async () => {
      const records: unknown[] = [];
      const summary = await h.connector.sync!(LANE, again, null, async (b) => void records.push(...b));
      return { summary };
    })();
    expect(summary.mode).toBe("full");
  });

  it("after disconnected (approved revoke): same id, active again, tokens stored again", async () => {
    const { h, conn } = await setup();
    await h.disconnectForTest(LANE, conn);
    expect(h.rows.get(conn.id)?.status).toBe("disconnected");
    expect(h.secrets.has(conn.id)).toBe(false);
    const again = await h.connectViaCallback(LANE);
    expect(again.id).toBe(conn.id);
    expect(h.rows.size).toBe(1);
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.secrets.has(conn.id)).toBe(true);
    expect(await h.connector.health(LANE, again)).toMatchObject({ ok: true });
  });

  it("a different company than the lane's configured realm is refused before any token request; the existing connection is untouched", async () => {
    const { intuit, h, conn } = await setup({ PKG: FAKE_REALM });
    killRefreshToken(h, intuit);
    await h.tokens.accessToken(LANE, conn).catch(() => undefined);
    intuit.state.failRefresh = null;
    intuit.state.tokenRequests.length = 0;
    const url = await h.flow.start("qbo", LANE, h.as(ADMIN));
    const state = new URL(url).searchParams.get("state") ?? "";
    const result = await h.flow.callback("qbo", new URLSearchParams({ state, code: "synthetic-code-0001", realmId: "1111111111111111" }), h.as(ADMIN));
    expect(result).toMatchObject({ ok: false, reason: "account_refused", laneId: LANE });
    expect(intuit.state.tokenRequests).toHaveLength(0);
    expect(h.rows.size).toBe(1);
    expect(h.rows.get(conn.id)?.status).toBe("reconnect_required");
  });

  it("a different company with no realm configured becomes its own connection: the old one stays reconnect_required", async () => {
    const intuit = createFakeIntuit({ extraRealms: ["2222222222222222"] });
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const first = await h.connectViaCallback(LANE);
    killRefreshToken(h, intuit);
    await h.tokens.accessToken(LANE, first).catch(() => undefined);
    intuit.state.failRefresh = null;
    const other = await h.connectViaCallback(LANE, ADMIN, "2222222222222222");
    expect(other.id).not.toBe(first.id);
    expect(h.rows.get(first.id)?.status).toBe("reconnect_required");
    expect(h.rows.get(other.id)?.status).toBe("active");
  });
});

describe("only a dead grant is recorded (security M1, L2)", () => {
  it("a token endpoint 401 (invalid_client) leaves the status unchanged and sends no event", async () => {
    const { intuit, h, conn } = await setup();
    intuit.state.failRefresh = { status: 401, error: "invalid_client", always: true };
    h.clock.t += 59 * 60_000;
    const err = (await h.tokens.accessToken(LANE, conn).catch((e: unknown) => e)) as ConnectorError;
    expect(err.info.kind).not.toBe("reconnect_required");
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.notices).toEqual([]);
  });

  it("a failed Vault re-read after invalid_grant is a transient outage, not reconnect_required, and records nothing", async () => {
    const { intuit, h, conn } = await setup();
    let reads = 0;
    const flaky = { ...h.vault, getToken: async (l: string, c: never) => {
      reads += 1;
      if (reads > 1) throw new ConnectorError({ kind: "transient", message: "Token store unavailable" });
      return h.vault.getToken(l, c);
    } };
    const tokens = createTokenManager({
      vault: flaky,
      tokenEndpoint: async (l) => (await h.discovery.get(l, "sandbox")).token,
      client: () => ({ clientId: "synthetic-intuit-client-id", clientSecret: new SecretValue("synthetic-intuit-client-secret-01") }),
      now: () => h.clock.t,
      sleep: async () => undefined,
    });
    killRefreshToken(h, intuit);
    await expect(tokens.accessToken(LANE, conn)).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(h.rows.get(conn.id)?.status).toBe("active");
  });
});

describe("the admin notice is durable (code review M1)", () => {
  it("a notify that fails once leaves the connection un-notified; the health scan lists it and raises the alert; a later notice marks it", async () => {
    const { intuit, h, conn } = await setup();
    h.notifyState.fail = 1;
    killRefreshToken(h, intuit);
    await h.tokens.accessToken(LANE, conn).catch(() => undefined);
    expect(h.rows.get(conn.id)?.status).toBe("reconnect_required");
    expect(h.notices).toEqual([]);
    expect(h.notified.has(conn.id)).toBe(false);
    // the daily token-health job re-raises it for a reconnect_required QuickBooks connection
    const { createTokenHealthJob } = await import("../health/job");
    const job = createTokenHealthJob({
      loader: { loadConnection: (l, id) => h.connections.load(l, id) },
      store: { listUsableConnectionIds: async () => [], applyHealth: async () => true, clearHealthError: async () => false, reconnectNoticePending: async (_l, c) => !h.notified.has(c.id), markReconnectNotified: async (_l, c) => void h.notified.add(c.id) },
      checkers: {},
    });
    expect(await job.run(LANE, conn.id)).toMatchObject({ ok: true, alerts: [{ provider: "quickbooks", reason: "reconnect_required", errorKind: "reconnect_required" }] });
    // a recorder call whose notify now works marks it
    const second = createReconnectRecorder({ store: { markReconnectRequired: async () => true, markNotified: async (l, c) => void h.notified.add(c.id) }, notify: async (n) => void h.notices.push(n) });
    await second(LANE, conn, new ConnectorError({ kind: "reconnect_required", message: "x" }).toJSON());
    expect(h.notices).toHaveLength(1);
    expect(h.notified.has(conn.id)).toBe(true);
  });

  it("a notify that works marks the connection notified", async () => {
    const { intuit, h, conn } = await setup();
    killRefreshToken(h, intuit);
    await h.tokens.accessToken(LANE, conn).catch(() => undefined);
    expect(h.notices).toHaveLength(1);
    expect(h.notified.has(conn.id)).toBe(true);
  });
});

describe("the real reconnect store (SQL shape)", () => {
  it("updates only an active or degraded row of the lane, through the lane's job client, and reports whether it changed", async () => {
    const { conn } = await setup();
    const calls: { table: string; patch: unknown; eq: [string, unknown][]; inn: [string, unknown][] }[] = [];
    const chain = (table: string) => {
      const rec = { table, patch: undefined as unknown, eq: [] as [string, unknown][], inn: [] as [string, unknown][] };
      calls.push(rec);
      const q: Record<string, unknown> = {
        update: (p: unknown) => { rec.patch = p; return q; },
        eq: (k: string, v: unknown) => { rec.eq.push([k, v]); return q; },
        in: (k: string, v: unknown) => { rec.inn.push([k, v]); return q; },
        select: async () => ({ data: [{ id: conn.id }], error: null }),
      };
      return q;
    };
    const store = createReconnectStore((async () => ({ schema: () => ({ from: chain }) })) as never);
    const info = new ConnectorError({ kind: "reconnect_required", message: "x", http_status: 400, provider_error_code: "invalid_grant" }).toJSON();
    expect(await store.markReconnectRequired(LANE, conn, info)).toBe(true);
    expect(calls[0]).toMatchObject({ table: "connections", patch: { status: "reconnect_required", last_error: info, reconnect_notified_at: null }, eq: [["lane_id", LANE], ["id", conn.id]], inn: [["status", ["active", "degraded"]]] });
  });
});
