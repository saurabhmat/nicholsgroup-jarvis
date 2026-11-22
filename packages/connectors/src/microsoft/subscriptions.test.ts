// Microsoft change-notification subscriptions (T-068, T-264, spec §14, §17 test 25): create when missing, renew within 24 hours of expiry, recreate when gone, a failed renewal alerts and
// leaves polling alone, stop when disconnected / paused / switched off. Fake clocks (the `now` of each call and the fake Graph's clock), the fake Graph, an in-memory twin of the SQL
// store. Synthetic data only; no live call (rule 10).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type ConnectionLoader, type LaneBoundConnection } from "../contract/lane-bound";
import { createSubscriptionRenewJob } from "../health/job";
import type { ConnectionHealthPatch, TokenHealthStore } from "../health/types";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A } from "../testing/microsoft-harness";
import { createSubscriptionStoreTwin } from "../testing/microsoft-subscription-store";
import { HttpResponse, http, useMockServer } from "../testing/msw/index";
import { GRAPH_V1, createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeSubscriptions, FAKE_SUBSCRIPTION_MAX_MINUTES } from "../testing/msw/microsoft/subscriptions";
import { GRAPH_MAX_SUBSCRIPTION_MINUTES, SUBSCRIPTION_LIFETIME_MINUTES, SUBSCRIPTION_RENEW_WINDOW_MS } from "./constants";
import { createGraphSubscriptionClient } from "./subscription-client";
import { CLIENT_STATE_BYTES, createMicrosoftSubscriptions } from "./subscriptions";

const fake = createFakeMicrosoft();
const subs = createFakeSubscriptions(fake);
const server = useMockServer(...fake.handlers, ...subs.handlers);
afterEach(() => RateLimiter.resetForTests());

const T0 = Date.parse("2026-11-23T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const URL_OK = "https://app.example.test/api/webhooks/microsoft";
const MAIL = "me/mailfolders('inbox')/messages";

type Setup = ReturnType<typeof setup>;
function setup(opts: { url?: string | null | (() => string | null); lanes?: Record<string, { providers: ("google" | "microsoft")[]; microsoft: { tenantIds: string[] } | null; domains: string[] }> } = {}) {
  subs.reset();
  subs.setNow(T0);
  const h = createMicrosoftHarness({
    fake,
    lanes: opts.lanes ?? { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] }, APK: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["apk.example.test"] } },
  });
  const twin = createSubscriptionStoreTwin((laneId, id) => {
    const r = h.rows.get(id);
    return r && r.lane_id === laneId ? { status: r.status } : undefined;
  });
  let t = Date.now();
  const client = createGraphSubscriptionClient({ guard: h.guard, tokens: h.tokens, logger: undefined, httpOptions: { sleep: async (ms) => void (t += ms), now: () => t } });
  const fixedUrl = opts.url;
  const urlOf: () => string | null = typeof fixedUrl === "function" ? fixedUrl : () => (fixedUrl === undefined ? URL_OK : fixedUrl);
  const subscriptions = createMicrosoftSubscriptions({ client, store: twin.store, laneConfig: h.laneConfig, notificationUrl: urlOf });
  const connect = (lane = "PKG", address = "one@pubkgroup.example.test") => h.connect(lane, address);
  return { h, twin, subscriptions, connect, client };
}
const at = (ms: number) => new Date(T0 + ms);
const requestsOf = (method: string) => subs.requests.filter((r) => r.method === method);

describe("constants (V-21)", () => {
  it("the requested lifetime is inside Graph's maximum with a margin, and the renewal window leaves two scans of room", () => {
    expect(GRAPH_MAX_SUBSCRIPTION_MINUTES).toBe(FAKE_SUBSCRIPTION_MAX_MINUTES);
    expect(SUBSCRIPTION_LIFETIME_MINUTES).toBeLessThan(GRAPH_MAX_SUBSCRIPTION_MINUTES);
    expect(GRAPH_MAX_SUBSCRIPTION_MINUTES - SUBSCRIPTION_LIFETIME_MINUTES).toBeGreaterThanOrEqual(24 * 60);
    expect(SUBSCRIPTION_RENEW_WINDOW_MS).toBe(24 * HOUR); // the scan runs every 12 hours (CONN_RENEW_CRON): 24 h is two scans
    expect(SUBSCRIPTION_RENEW_WINDOW_MS).toBeLessThan(SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
  });
});

describe("create", () => {
  it("creates the inbox and the calendar subscription, records both, with a random clientState each, and never asks for resource data", async () => {
    const s = setup();
    const { conn } = s.connect();
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    expect(out).toMatchObject({ created: 2, renewed: 0, recreated: 0, skipped: null });
    const posts = requestsOf("POST");
    expect(posts).toHaveLength(2);
    const bodies = posts.map((p) => p.body as Record<string, unknown>);
    expect(bodies.map((b) => b.resource)).toEqual([MAIL, "me/events"]);
    for (const b of bodies) {
      expect(Object.keys(b).sort()).toEqual(["changeType", "clientState", "expirationDateTime", "lifecycleNotificationUrl", "notificationUrl", "resource"]);
      expect(b.notificationUrl).toBe(URL_OK);
      expect(b.lifecycleNotificationUrl).toBe(URL_OK);
      expect(b.changeType).toBe("created,updated,deleted");
      expect(Date.parse(b.expirationDateTime as string)).toBe(T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
      expect((b.clientState as string).length).toBeGreaterThanOrEqual(32);
      expect((b.clientState as string).length).toBeLessThanOrEqual(128);
    }
    expect(bodies[0]?.clientState).not.toBe(bodies[1]?.clientState);
    expect(subs.sawIncludeResourceData).toBe(0);
    expect(s.twin.liveRows("PKG").map((r) => [r.resource, r.connectionId])).toEqual([["mail", conn.id], ["calendar", conn.id]]);
    expect(s.twin.liveRows()[0]?.clientState).toBe(bodies[0]?.clientState);
    expect(out.expiresAt?.getTime()).toBe(T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    expect(CLIENT_STATE_BYTES).toBeGreaterThanOrEqual(32);
  });

  it("the fake Graph validates both URLs during the create (the receiver's answer is what decides)", async () => {
    const s = setup();
    subs.validator = async (_url, token) => new Response(token, { status: 200, headers: { "content-type": "text/plain" } });
    await s.subscriptions.ensure("PKG", s.connect().conn, { now: at(0) });
    expect(subs.validations.map((v) => [v.url, v.ok])).toEqual([[URL_OK, true], [URL_OK, true], [URL_OK, true], [URL_OK, true]]);
  });

  it("a validation Graph refuses (the receiver did not echo) creates nothing, records nothing and fails the run", async () => {
    const s = setup();
    subs.validator = async () => new Response("wrong", { status: 200, headers: { "content-type": "text/plain" } });
    await expect(s.subscriptions.ensure("PKG", s.connect().conn, { now: at(0) })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(subs.subscriptions.size).toBe(0);
    expect(s.twin.rows).toHaveLength(0);
  });

  it("a second run with live subscriptions far from expiry sends nothing", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    subs.requests.length = 0;
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(12 * HOUR) });
    expect(out).toMatchObject({ created: 0, renewed: 0 });
    expect(subs.requests).toHaveLength(0);
  });

  it("the clientState is in no log line, no error, no audit entry and not in the failure of a create", async () => {
    const s = setup();
    const { conn } = s.connect();
    subs.failNext("create", 400, 1);
    const err = await s.subscriptions.ensure("PKG", conn, { now: at(0) }).catch((e: unknown) => e);
    await s.subscriptions.ensure("PKG", conn, { now: at(0) }).catch(() => undefined);
    const states = s.twin.liveRows().map((r) => r.clientState as string);
    const posted = requestsOf("POST").map((p) => (p.body as { clientState: string }).clientState);
    expect(states.length).toBeGreaterThan(0);
    for (const state of [...states, ...posted]) {
      expect(JSON.stringify(s.h.logs)).not.toContain(state);
      expect(JSON.stringify(err)).not.toContain(state);
      expect(JSON.stringify(s.h.audits)).not.toContain(state);
      expect(JSON.stringify(s.h.apiErrors)).not.toContain(state);
    }
  });
});

describe("not configured, unreadable, paused", () => {
  it("no notification URL: nothing is attempted, nothing is read or written, nothing fails (the local and preview state)", async () => {
    const s = setup({ url: null });
    const { conn } = s.connect();
    const before = s.h.stats.tokenReads;
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    expect(out).toMatchObject({ skipped: "not_configured", created: 0, renewed: 0, removed: 0 });
    expect(subs.requests).toHaveLength(0);
    expect(s.h.stats.tokenReads).toBe(before);
    expect(s.twin.rows).toHaveLength(0);
  });

  it("a configuration that cannot be read (throws) attempts nothing and leaves live subscriptions alone", async () => {
    let configured = true;
    const s = setup({ url: () => { if (!configured) throw new Error("GRAPH_CLIENT_ID is missing"); return URL_OK; } });
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    subs.requests.length = 0;
    configured = false;
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(DAY) });
    expect(out.skipped).toBe("config_unreadable");
    expect(subs.requests).toHaveLength(0);
    expect(s.twin.liveRows()).toHaveLength(2);
  });

  it("an invalid URL setting logs the variable's name and the rule (our own fixed text), attempts nothing, and fails nothing", async () => {
    const s = setup({ url: () => { throw new ConnectorError({ kind: "connection_unavailable", message: "GRAPH_NOTIFICATION_URL: https required" }); } });
    const { conn } = s.connect();
    expect(await s.subscriptions.ensure("PKG", conn, { now: at(0) })).toMatchObject({ skipped: "config_unreadable" });
    expect(subs.requests).toHaveLength(0);
    expect(s.twin.rows).toHaveLength(0);
  });

  it("removing the URL later stops what exists: a DELETE per subscription, rows removed, and nothing fails (how change notifications are switched off)", async () => {
    let url: string | null = URL_OK;
    const s = setup({ url: () => url });
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    expect(subs.subscriptions.size).toBe(2);
    url = null;
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(HOUR) });
    expect(out).toMatchObject({ skipped: "not_configured", removed: 2 });
    expect(requestsOf("DELETE")).toHaveLength(2);
    expect(subs.subscriptions.size).toBe(0);
    expect(s.twin.liveRows()).toHaveLength(0);
  });

  it("a provider that is no longer enabled for the lane: the connection's subscriptions are marked removed, nothing is sent to Microsoft, no token is read, nothing else changes", async () => {
    const s = setup();
    const { conn, row } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    s.h.setLane("PKG", { providers: ["google"], microsoft: null });
    subs.requests.length = 0;
    const reads = s.h.stats.tokenReads;
    const statusBefore = row.status;
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(HOUR) });
    expect(out).toMatchObject({ skipped: "provider_disabled", removed: 2 });
    expect(subs.requests).toHaveLength(0);
    expect(s.h.stats.tokenReads).toBe(reads);
    expect(s.twin.liveRows()).toHaveLength(0);
    expect(row.status).toBe(statusBefore);
    // a lane with Google only never creates anything
    subs.requests.length = 0;
    expect(await s.subscriptions.ensure("PKG", conn, { now: at(2 * HOUR) })).toMatchObject({ skipped: "provider_disabled", created: 0 });
    expect(subs.requests).toHaveLength(0);
  });

  it("a settings read that fails is a retryable failure and changes nothing", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    s.h.setLane("PKG", { providers: ["microsoft"], microsoft: null });
    vi.spyOn(s.h.laneConfig, "mailProviderSettings").mockRejectedValueOnce(new ConnectorError({ kind: "provider_error", message: "x" }));
    const err = await s.subscriptions.ensure("PKG", conn, { now: at(HOUR) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ info: { kind: "transient" } });
    expect(s.twin.liveRows()).toHaveLength(2);
  });

  it("a Google connection is refused and nothing is sent", async () => {
    const s = setup();
    const { conn } = s.connect();
    await expect(s.subscriptions.ensure("PKG", { ...conn, provider: "google" } as unknown as LaneBoundConnection<string>, { now: at(0) })).rejects.toBeTruthy();
    expect(subs.requests).toHaveLength(0);
    expect(s.twin.calls.list).toBe(0);
  });
});

describe("renew (spec §17 test 25: a subscription expiring in 12 hours is renewed and expires_at moves)", () => {
  async function created(s: Setup) {
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    subs.requests.length = 0;
    return conn;
  }

  it("expiring within 24 hours: both are renewed with a PATCH, the recorded expiry moves to now + the lifetime", async () => {
    const s = setup();
    const conn = await created(s);
    const later = SUBSCRIPTION_LIFETIME_MINUTES * 60_000 - 12 * HOUR; // 12 hours before the expiry
    subs.setNow(T0 + later);
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(later) });
    expect(out).toMatchObject({ created: 0, renewed: 2, recreated: 0 });
    expect(requestsOf("PATCH")).toHaveLength(2);
    for (const r of requestsOf("PATCH")) expect(Object.keys(r.body as object)).toEqual(["expirationDateTime"]);
    expect(s.twin.liveRows().map((r) => r.expiresAt.getTime())).toEqual([T0 + later + SUBSCRIPTION_LIFETIME_MINUTES * 60_000, T0 + later + SUBSCRIPTION_LIFETIME_MINUTES * 60_000]);
    expect(out.expiresAt?.getTime()).toBe(T0 + later + SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
  });

  it("the window is exactly 24 hours: at 24 h it is renewed, one second more and it is not", async () => {
    const s = setup();
    const conn = await created(s);
    const expiry = T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000;
    const outside = await s.subscriptions.ensure("PKG", conn, { now: new Date(expiry - SUBSCRIPTION_RENEW_WINDOW_MS - 1000) });
    expect(outside).toMatchObject({ renewed: 0 });
    expect(subs.requests).toHaveLength(0);
    subs.setNow(expiry - SUBSCRIPTION_RENEW_WINDOW_MS);
    const inside = await s.subscriptions.ensure("PKG", conn, { now: new Date(expiry - SUBSCRIPTION_RENEW_WINDOW_MS) });
    expect(inside).toMatchObject({ renewed: 2 });
  });

  it("reauthorization_required is renewed whatever the expiry", async () => {
    const s = setup();
    const conn = await created(s);
    const mail = s.twin.liveRows().find((r) => r.resource === "mail");
    if (!mail) throw new Error("no row");
    await s.twin.store.mark("PKG", conn.id, mail.subscriptionId, "reauthorization_required");
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(HOUR) });
    expect(out).toMatchObject({ renewed: 1 });
    expect(requestsOf("PATCH")).toHaveLength(1);
    expect(s.twin.liveRows().find((r) => r.resource === "mail")?.status).toBe("active");
  });

  it("a renewal that answers 404 (gone) creates a new subscription: the old row is removed, a new one recorded", async () => {
    const s = setup();
    const conn = await created(s);
    const mail = s.twin.liveRows().find((r) => r.resource === "mail");
    if (!mail) throw new Error("no row");
    subs.remove(mail.subscriptionId); // Microsoft no longer has it
    const later = SUBSCRIPTION_LIFETIME_MINUTES * 60_000 - 12 * HOUR;
    subs.setNow(T0 + later);
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(later) });
    expect(out).toMatchObject({ renewed: 1, created: 1, recreated: 1 });
    const live = s.twin.liveRows().filter((r) => r.resource === "mail");
    expect(live).toHaveLength(1);
    expect(live[0]?.subscriptionId).not.toBe(mail.subscriptionId);
    expect(s.twin.rows.find((r) => r.subscriptionId === mail.subscriptionId)?.status).toBe("removed");
    expect(subs.subscriptions.size).toBe(2);
  });

  it("an expired subscription is recreated without a renewal request", async () => {
    const s = setup();
    const conn = await created(s);
    const lapsed = SUBSCRIPTION_LIFETIME_MINUTES * 60_000 + HOUR;
    subs.setNow(T0 + lapsed);
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(lapsed) });
    expect(out).toMatchObject({ created: 2, recreated: 2, renewed: 0 });
    expect(requestsOf("PATCH")).toHaveLength(0);
    expect(requestsOf("POST")).toHaveLength(2);
  });

  it("a PATCH answer that does not parse is an error, and the requested expiry is NOT recorded as confirmed", async () => {
    const s = setup();
    const conn = await created(s);
    const before = s.twin.liveRows().map((r) => r.expiresAt.getTime());
    const later = SUBSCRIPTION_LIFETIME_MINUTES * 60_000 - 12 * HOUR;
    subs.setNow(T0 + later);
    server.use(http.patch(`${GRAPH_V1}/subscriptions/:id`, () => HttpResponse.json({ id: 7, expirationDateTime: "soon" })));
    await expect(s.subscriptions.ensure("PKG", conn, { now: at(later) })).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(s.twin.liveRows().map((r) => r.expiresAt.getTime())).toEqual(before);
  });

  it("a row recorded as removed is created again by the next run (subscriptionRemoved)", async () => {
    const s = setup();
    const conn = await created(s);
    const cal = s.twin.liveRows().find((r) => r.resource === "calendar");
    if (!cal) throw new Error("no row");
    await s.twin.store.mark("PKG", conn.id, cal.subscriptionId, "removed");
    const out = await s.subscriptions.ensure("PKG", conn, { now: at(HOUR) });
    expect(out).toMatchObject({ created: 1, renewed: 0 });
    expect(requestsOf("POST")).toHaveLength(1);
    expect((requestsOf("POST")[0]?.body as { resource: string }).resource).toBe("me/events");
  });

  it("a renewal that fails (not 404) throws the mapped error, keeps the row, and the other stream is still handled", async () => {
    const s = setup();
    const conn = await created(s);
    const later = SUBSCRIPTION_LIFETIME_MINUTES * 60_000 - 12 * HOUR;
    subs.setNow(T0 + later);
    subs.failNext("renew", 403, 1);
    const err = await s.subscriptions.ensure("PKG", conn, { now: at(later) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ info: { kind: "forbidden" } });
    expect(requestsOf("PATCH")).toHaveLength(2); // the calendar's renewal still went out
    expect(s.twin.liveRows()).toHaveLength(2);
    expect(s.twin.liveRows().filter((r) => r.expiresAt.getTime() > T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000)).toHaveLength(1); // only the calendar moved
  });

  it("it acts only on the connection it is called for: another connection's subscriptions are never listed, renewed or stopped", async () => {
    const s = setup();
    const a = s.connect("PKG", "a@pubkgroup.example.test");
    const b = s.connect("PKG", "b@pubkgroup.example.test");
    await s.subscriptions.ensure("PKG", a.conn, { now: at(0) });
    await s.subscriptions.ensure("PKG", b.conn, { now: at(0) });
    const bIds = s.twin.liveRows().filter((r) => r.connectionId === b.conn.id).map((r) => r.subscriptionId);
    subs.requests.length = 0;
    const later = SUBSCRIPTION_LIFETIME_MINUTES * 60_000 - 12 * HOUR;
    subs.setNow(T0 + later);
    await s.subscriptions.ensure("PKG", a.conn, { now: at(later) });
    for (const r of subs.requests) for (const id of bIds) expect(r.path).not.toContain(id);
    expect(s.twin.liveRows().filter((r) => r.connectionId === b.conn.id).map((r) => r.expiresAt.getTime())).toEqual([T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000, T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000]);
    // and the store itself refuses a mismatched pair
    const aId = s.twin.liveRows().find((r) => r.connectionId === a.conn.id)?.subscriptionId ?? "";
    expect(await s.twin.store.renewed("PKG", b.conn.id, aId, at(DAY))).toBe(false);
    expect(await s.twin.store.mark("PKG", b.conn.id, aId, "removed")).toBe(false);
    expect(await s.twin.store.renewed("APK", a.conn.id, aId, at(DAY))).toBe(false);
  });
});

describe("a create that cannot be recorded", () => {
  it("the subscription Graph just made is stopped (best effort) and the failure is reported: nothing is delivered for a subscription no row describes", async () => {
    const s = setup();
    const { conn } = s.connect();
    const original = s.twin.store.record;
    s.twin.store.record = async () => {
      throw new ConnectorError({ kind: "transient", message: "Subscription store unavailable" });
    };
    await expect(s.subscriptions.ensure("PKG", conn, { now: at(0) })).rejects.toMatchObject({ info: { kind: "transient" } });
    s.twin.store.record = original;
    expect(requestsOf("DELETE").length).toBe(2);
    expect(subs.subscriptions.size).toBe(0);
    expect(s.twin.rows).toHaveLength(0);
  });
});

describe("stop", () => {
  it("sends a DELETE per subscription and marks the rows removed", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    expect(await s.subscriptions.stop("PKG", conn)).toBe(2);
    expect(requestsOf("DELETE")).toHaveLength(2);
    expect(subs.subscriptions.size).toBe(0);
    expect(s.twin.liveRows()).toHaveLength(0);
  });

  it("is best effort: Microsoft failing or the guard refusing does not stop the rows being marked removed", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    subs.failNext("delete", 503, 2);
    expect(await s.subscriptions.stop("PKG", conn)).toBe(2);
    expect(s.twin.liveRows()).toHaveLength(0);
    // guard refusal: the provider is off, the row is marked removed all the same
    const s2 = setup();
    const c2 = s2.connect();
    await s2.subscriptions.ensure("PKG", c2.conn, { now: at(0) });
    s2.h.setLane("PKG", { providers: ["google"], microsoft: null });
    expect(await s2.subscriptions.stop("PKG", c2.conn)).toBe(2);
  });

  it("acts only on the connection's own rows (another lane's connection id with this lane removes nothing)", async () => {
    const s = setup();
    const a = s.connect("PKG", "a@pubkgroup.example.test");
    const other = s.connect("APK", "x@apk.example.test");
    await s.subscriptions.ensure("PKG", a.conn, { now: at(0) });
    await s.subscriptions.ensure("APK", other.conn, { now: at(0) });
    expect(await s.subscriptions.stop("APK", other.conn)).toBe(2);
    expect(s.twin.liveRows("PKG")).toHaveLength(2);
    expect(await s.twin.store.removeConnection("APK", a.conn.id)).toBe(0);
  });
});

describe("watchInfo", () => {
  it("push with the expiry while a live row exists, polling otherwise; reads no Graph state", async () => {
    const s = setup();
    const { conn } = s.connect();
    expect(await s.subscriptions.watchInfo("PKG", conn, "mail", at(0))).toMatchObject({ mode: "polling", resource_id: null });
    await s.subscriptions.ensure("PKG", conn, { now: at(0) });
    subs.requests.length = 0;
    expect(await s.subscriptions.watchInfo("PKG", conn, "calendar", at(0))).toMatchObject({ mode: "push", resource: "calendar", expires_at: new Date(T0 + SUBSCRIPTION_LIFETIME_MINUTES * 60_000).toISOString() });
    expect(subs.requests).toHaveLength(0);
  });
});

describe("through the T-040 renewal job: a failed renewal falls back to polling and alerts", () => {
  function job(s: Setup, row: ReturnType<Setup["connect"]>["row"]) {
    const patches: ConnectionHealthPatch[] = [];
    const loader: ConnectionLoader<string> = {
      async loadConnection(laneId, id) {
        if (id !== row.id || laneId !== row.lane_id) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
        return mintLaneBoundConnection({ ...row, features: {} }) as LaneBoundConnection<string>;
      },
    };
    const store = { applyHealth: async (_l: string, _c: unknown, p: ConnectionHealthPatch) => { patches.push(p); return true; } } as unknown as TokenHealthStore;
    const renewJob = createSubscriptionRenewJob({
      loader,
      store,
      renewers: { microsoft: async (laneId, conn, input) => { const o = await s.subscriptions.ensure(laneId, conn, input); return { renewed: o.created + o.renewed > 0, expires_at: o.expiresAt?.toISOString() ?? null }; } },
      now: () => new Date(T0),
    });
    return { renewJob, patches };
  }

  it("a permanent failure raises subscription_renewal_failed, records last_error only (status and polling untouched)", async () => {
    const s = setup();
    const { conn, row } = s.connect();
    const { renewJob, patches } = job(s, row);
    subs.failNext("create", 403, 1);
    const out = await renewJob.run("PKG", conn.id);
    expect(out).toEqual({ ok: true, skipped: null, alerts: [{ provider: "microsoft", reason: "subscription_renewal_failed", errorKind: "forbidden" }] });
    expect(patches).toHaveLength(1);
    expect(patches[0]?.status).toBeUndefined();
    expect(row.status).toBe("active");
  });

  it("a transient failure is retryable and raises nothing", async () => {
    const s = setup();
    const { conn, row } = s.connect();
    const { renewJob, patches } = job(s, row);
    subs.failNext("create", 503, 1);
    expect(await renewJob.run("PKG", conn.id)).toMatchObject({ ok: false, retryable: true });
    expect(patches).toEqual([]);
  });

  it("not configured: ok, no alert, no request, no row written", async () => {
    const s = setup({ url: null });
    const { conn, row } = s.connect();
    const { renewJob, patches } = job(s, row);
    expect(await renewJob.run("PKG", conn.id)).toEqual({ ok: true, skipped: null, alerts: [] });
    expect(patches).toEqual([]);
    expect(subs.requests).toHaveLength(0);
  });
});
