// conn.token_health and conn.subscriptions_renew jobs (T-040): expiry rule, failing health, isolation between
// connections and lanes, no secrets in rows, logs or alerts. Synthetic data; fake store and checkers.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type ConnectionLoader, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, HealthStatus } from "../contract/schemas";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { MOCK_SECRET_CANARY } from "../testing/index";
import { createSubscriptionRenewJob, createTokenHealthJob, expiryAlert } from "./job";
import { HEALTH_CHECK_ENDPOINT, type ConnectionHealthPatch, type TokenHealthStore } from "./types";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-0000000004${String(n).padStart(2, "0")}`;

function row(n: number, over: Partial<Connection> = {}): Connection {
  return {
    id: id(n), lane_id: "PKG", provider: "quickbooks", external_account_id: `realm-${n}`, status: "active", features: {},
    features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, ...over,
  } as Connection;
}

function setup(rows: Connection[]) {
  const patches: { laneId: string; id: string; patch: ConnectionHealthPatch }[] = [];
  const cleared: { laneId: string; id: string }[] = [];
  const entries: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => entries.push(e), now: () => NOW });
  const loader: ConnectionLoader<string> = {
    async loadConnection(laneId, connectionId) {
      const r = rows.find((x) => x.id === connectionId && x.lane_id === laneId);
      if (!r) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      return mintLaneBoundConnection(r) as LaneBoundConnection<string>;
    },
  };
  const store: TokenHealthStore = {
    async listUsableConnectionIds(laneId) {
      return rows.filter((r) => r.lane_id === laneId && ["active", "degraded"].includes(r.status)).map((r) => r.id);
    },
    async applyHealth(laneId, conn, patch) {
      patches.push({ laneId, id: conn.id, patch });
      return true;
    },
    async clearHealthError(laneId, conn) {
      cleared.push({ laneId, id: conn.id });
      return true;
    },
  };
  return { loader, store, patches, cleared, entries, logger };
}

const good = async (): Promise<HealthStatus> => ({ ok: true, status: "active", checked_at: NOW.toISOString(), provider_tid: null, error: null });
const bad = (kind: ConstructorParameters<typeof ConnectorError>[0]["kind"]) => async (): Promise<HealthStatus> => ({
  ok: false, status: "degraded", checked_at: NOW.toISOString(), provider_tid: null, error: new ConnectorError({ kind, message: "check failed" }).toJSON(),
});

describe("expiryAlert", () => {
  it("flags a credential expiring within 7 days and not one at 8 days", () => {
    expect(expiryAlert("quickbooks", at(7 * DAY), NOW)).toMatchObject({ reason: "token_expiring", daysLeft: 7 });
    expect(expiryAlert("quickbooks", at(2 * DAY), NOW)).toMatchObject({ reason: "token_expiring", daysLeft: 2 });
    expect(expiryAlert("quickbooks", at(7 * DAY + 1000), NOW)).toBeNull();
    expect(expiryAlert("quickbooks", at(8 * DAY), NOW)).toBeNull();
    expect(expiryAlert("quickbooks", null, NOW)).toBeNull();
  });
  it("flags an expired credential", () => {
    expect(expiryAlert("quickbooks", at(-DAY), NOW)).toMatchObject({ reason: "token_expired", daysLeft: -1 });
    expect(expiryAlert("quickbooks", at(0), NOW)).toMatchObject({ reason: "token_expired" });
  });
  it("ignores an unparseable stored value", () => {
    expect(expiryAlert("quickbooks", "not-a-date", NOW)).toBeNull();
  });
});

describe("conn.token_health job", () => {
  it("alerts for a credential expiring in 6 days, writes nothing for the expiry alone", async () => {
    const s = setup([row(1, { token_expires_at: at(6 * DAY) })]);
    const job = createTokenHealthJob({ ...s, checkers: { quickbooks: good }, now: () => NOW });
    const out = await job.run("PKG", id(1));
    expect(out).toEqual({ ok: true, skipped: null, alerts: [{ provider: "quickbooks", reason: "token_expiring", daysLeft: 6 }] });
    expect(s.patches).toEqual([]);
  });

  it("does not alert at 8 days", async () => {
    const s = setup([row(1, { token_expires_at: at(8 * DAY) })]);
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: good }, now: () => NOW }).run("PKG", id(1));
    expect(out).toEqual({ ok: true, skipped: null, alerts: [] });
  });

  it("a failing health check alerts, flags last_error and moves active to degraded", async () => {
    const s = setup([row(1)]);
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("forbidden") }, now: () => NOW }).run("PKG", id(1));
    expect(out).toMatchObject({ ok: true, alerts: [{ provider: "quickbooks", reason: "health_check_failed", errorKind: "forbidden" }] });
    expect(s.patches).toHaveLength(1);
    expect(s.patches[0]).toMatchObject({ laneId: "PKG", id: id(1), patch: { status: "degraded", last_error: { kind: "forbidden", endpoint: HEALTH_CHECK_ENDPOINT } } });
  });

  it("a good check clears the health check's own error, and keeps an error written by a sync or renewal", async () => {
    const own = setup([row(1, { status: "degraded", last_error: { ...new ConnectorError({ kind: "forbidden", message: "x" }).toJSON(), endpoint: HEALTH_CHECK_ENDPOINT } })]);
    await createTokenHealthJob({ ...own, checkers: { quickbooks: good }, now: () => NOW }).run("PKG", id(1));
    expect(own.patches.map((p) => p.patch)).toEqual([{ status: "active" }]);
    expect(own.cleared).toEqual([{ laneId: "PKG", id: id(1) }]);

    const other = setup([row(1, { last_error: new ConnectorError({ kind: "provider_error", message: "sync failed", endpoint: "/v3/query" }).toJSON() })]);
    await createTokenHealthJob({ ...other, checkers: { quickbooks: good }, now: () => NOW }).run("PKG", id(1));
    expect(other.cleared).toEqual([]);
    expect(other.patches).toEqual([]);
  });

  it("reconnect_required from the check is flagged, not applied as a status change (the status is recorded where the failure happens, T-195)", async () => {
    const s = setup([row(1)]);
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("reconnect_required") }, now: () => NOW }).run("PKG", id(1));
    expect(out).toMatchObject({ ok: true, alerts: [{ reason: "reconnect_required", errorKind: "reconnect_required" }] });
    expect(s.patches[0]?.patch.status).toBeUndefined();
    expect(s.patches[0]?.patch.last_error).toMatchObject({ kind: "reconnect_required" });
  });

  it("a degraded connection stays degraded when the check fails again, and heals when it passes", async () => {
    const s = setup([row(1, { status: "degraded", last_error: new ConnectorError({ kind: "provider_error", message: "x" }).toJSON() })]);
    await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("provider_error") }, now: () => NOW }).run("PKG", id(1));
    expect(s.patches[0]?.patch.status).toBeUndefined();
    await createTokenHealthJob({ ...s, checkers: { quickbooks: good }, now: () => NOW }).run("PKG", id(1));
    expect(s.patches[1]?.patch).toEqual({ status: "active" });
    expect(s.cleared).toEqual([]); // the loaded row still carries the sync's error, which only a sync clears
  });

  it("a superseded write (row changed meanwhile) is logged, not an error", async () => {
    const s = setup([row(1)]);
    s.store.applyHealth = async () => false;
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("forbidden") }, now: () => NOW, logger: s.logger }).run("PKG", id(1));
    expect(out).toMatchObject({ ok: true });
    expect(s.entries.map((e) => e.event)).toContain("conn.token_health.superseded");
  });

  it("clamps daysLeft so the attention event stays valid for very old expiries", () => {
    expect(expiryAlert("quickbooks", at(-20000 * DAY), NOW)?.daysLeft).toBe(-3650);
  });

  it("a transient check failure is inconclusive: no alert, no write", async () => {
    const s = setup([row(1)]);
    for (const kind of ["transient", "timeout", "rate_limited"] as const) {
      const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad(kind) }, now: () => NOW }).run("PKG", id(1));
      expect(out).toEqual({ ok: true, skipped: null, alerts: [] });
    }
    expect(s.patches).toEqual([]);
  });

  it("a checker that throws is treated as a failed check (reduced to a kind)", async () => {
    const s = setup([row(1)]);
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: async () => { throw new Error("boom"); } }, now: () => NOW }).run("PKG", id(1));
    expect(out).toMatchObject({ ok: true, alerts: [{ reason: "health_check_failed" }] });
  });

  it("expiry and health failure both alert", async () => {
    const s = setup([row(1, { token_expires_at: at(DAY) })]);
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("forbidden") }, now: () => NOW }).run("PKG", id(1));
    expect(out.ok && out.alerts.map((a) => a.reason)).toEqual(["token_expiring", "health_check_failed"]);
  });

  it("a provider without a checker gets the expiry rule only", async () => {
    const s = setup([row(1, { provider: "google", token_expires_at: at(DAY) })]);
    const out = await createTokenHealthJob({ ...s, checkers: {}, now: () => NOW }).run("PKG", id(1));
    expect(out).toMatchObject({ ok: true, alerts: [{ provider: "google", reason: "token_expiring" }] });
    expect(s.patches).toEqual([]);
  });

  it("skips connections that are not usable (reconnect_required, pending, disconnected)", async () => {
    for (const status of ["reconnect_required", "pending", "disconnected"] as const) {
      const s = setup([row(1, { status, token_expires_at: status === "disconnected" ? null : at(DAY) })]);
      const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("forbidden") }, now: () => NOW }).run("PKG", id(1));
      expect(out).toEqual({ ok: true, skipped: "connection_not_usable", alerts: [] });
      expect(s.patches).toEqual([]);
    }
  });

  it("one connection failing does not block another", async () => {
    const s = setup([row(1), row(2, { external_account_id: "realm-2" })]);
    const checker = async (_l: string, c: { id: string }): Promise<HealthStatus> => {
      if (c.id === id(1)) throw new ConnectorError({ kind: "provider_error", message: "down" });
      return good();
    };
    const job = createTokenHealthJob({ ...s, checkers: { quickbooks: checker }, now: () => NOW });
    const [a, b] = await Promise.all([job.run("PKG", id(1)), job.run("PKG", id(2))]);
    expect(a).toMatchObject({ ok: true, alerts: [{ reason: "health_check_failed" }] });
    expect(b).toEqual({ ok: true, skipped: null, alerts: [] });
    expect(s.patches.map((p) => p.id)).toEqual([id(1)]);
  });

  it("a store failure is a retryable failure for that connection only", async () => {
    const s = setup([row(1)]);
    s.store.applyHealth = async () => { throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" }); };
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: bad("forbidden") }, now: () => NOW }).run("PKG", id(1));
    expect(out).toEqual({ ok: false, retryable: true, errorKind: "transient" });
  });

  it("cross-lane: another lane's connection id is not found, nothing is checked or written", async () => {
    const s = setup([row(1, { lane_id: "APK" })]);
    let called = 0;
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: async () => { called++; return good(); } }, now: () => NOW }).run("PKG", id(1));
    expect(out).toEqual({ ok: false, retryable: false, errorKind: "not_found" });
    expect(called).toBe(0);
    expect(s.patches).toEqual([]);
  });

  it("canary: no secret reaches the row patch, alerts or logs", async () => {
    const s = setup([row(1, { token_expires_at: at(DAY) })]);
    const thrower = async () => { throw new Error(`Authorization: Bearer ${MOCK_SECRET_CANARY} failed`); };
    const out = await createTokenHealthJob({ ...s, checkers: { quickbooks: thrower }, now: () => NOW, logger: s.logger }).run("PKG", id(1));
    const all = JSON.stringify({ out, patches: s.patches, entries: s.entries });
    expect(all).not.toContain(MOCK_SECRET_CANARY);
    expect(s.entries.length).toBeGreaterThan(0);
  });
});

describe("conn.subscriptions_renew job", () => {
  const renewed = async () => ({ renewed: true, expires_at: at(3 * DAY) });

  it("is an interface: with no renewer registered nothing is listed or called", async () => {
    const s = setup([row(1)]);
    const job = createSubscriptionRenewJob({ ...s, renewers: {}, now: () => NOW });
    expect(job.providers()).toEqual([]);
    expect(await job.run("PKG", id(1))).toEqual({ ok: true, skipped: "no_renewer", alerts: [] });
    expect(s.patches).toEqual([]);
  });

  it("calls the provider's renewer with the lane and connection", async () => {
    const s = setup([row(1, { provider: "google" })]);
    const calls: unknown[] = [];
    const job = createSubscriptionRenewJob({ ...s, renewers: { google: async (l, c, i) => { calls.push([l, c.id, i.now.toISOString()]); return renewed(); } }, now: () => NOW });
    expect(job.providers()).toEqual(["google"]);
    expect(await job.run("PKG", id(1))).toEqual({ ok: true, skipped: null, alerts: [] });
    expect(calls).toEqual([["PKG", id(1), NOW.toISOString()]]);
  });

  it("a permanent renewal failure flags last_error and alerts; status is unchanged", async () => {
    const s = setup([row(1, { provider: "google" })]);
    const job = createSubscriptionRenewJob({ ...s, renewers: { google: async () => { throw new ConnectorError({ kind: "forbidden", message: "no" }); } }, now: () => NOW });
    const out = await job.run("PKG", id(1));
    expect(out).toEqual({ ok: true, skipped: null, alerts: [{ provider: "google", reason: "subscription_renewal_failed", errorKind: "forbidden" }] });
    expect(s.patches).toHaveLength(1);
    expect(s.patches[0]?.patch.status).toBeUndefined();
    expect(s.patches[0]?.patch.last_error).toMatchObject({ kind: "forbidden" });
  });

  it("a transient renewal failure is retryable and writes nothing", async () => {
    const s = setup([row(1, { provider: "google" })]);
    const job = createSubscriptionRenewJob({ ...s, renewers: { google: async () => { throw new ConnectorError({ kind: "timeout", message: "t" }); } }, now: () => NOW });
    expect(await job.run("PKG", id(1))).toEqual({ ok: false, retryable: true, errorKind: "timeout" });
    expect(s.patches).toEqual([]);
  });

  it("skips unusable connections, and an unknown/other-lane connection fails alone", async () => {
    const s = setup([row(1, { provider: "google", status: "reconnect_required" }), row(2, { provider: "google", lane_id: "APK" })]);
    const job = createSubscriptionRenewJob({ ...s, renewers: { google: renewed }, now: () => NOW });
    expect(await job.run("PKG", id(1))).toEqual({ ok: true, skipped: "connection_not_usable", alerts: [] });
    expect(await job.run("PKG", id(2))).toEqual({ ok: false, retryable: false, errorKind: "not_found" });
  });

  it("canary: a secret in a provider error does not reach rows or logs", async () => {
    const s = setup([row(1, { provider: "google" })]);
    const job = createSubscriptionRenewJob({ ...s, renewers: { google: async () => { throw new Error(`token ${MOCK_SECRET_CANARY}`); } }, now: () => NOW, logger: s.logger });
    const out = await job.run("PKG", id(1));
    expect(JSON.stringify({ out, p: s.patches, e: s.entries })).not.toContain(MOCK_SECRET_CANARY);
  });
});
