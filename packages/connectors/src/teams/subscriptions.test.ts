// Teams notice subscriptions (T-289, spec 9.1, 17 tests 14 and 15): one all-chats subscription per Teams connection, `created` only, no resource data, a Vault clientState, the lifetime asked and
// Microsoft's answer recorded, the 26-hour rule, a refused resource (no per-chat fallback), renewal within 24 hours, every stop condition, never a second subscription. MSW fakes of Entra and
// Graph, synthetic data only (rule 10); no live Microsoft call.
import { afterEach, describe, expect, it } from "vitest";
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createSubscriptionStoreTwin } from "../testing/microsoft-subscription-store";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, TEAMS_ERROR_TEXT_CANARY } from "../testing/msw/teams/handlers";
import { createFakeTeamsSubscriptions } from "../testing/msw/teams/subscriptions";
import { createTeamsHarness, TEAMS_OTHER_USER } from "../testing/teams-harness";
import { createTeamsSubscriptionClient } from "./subscription-client";
import { createTeamsSubscriptions } from "./subscriptions";
import { TEAMS_SUBSCRIPTION_LIFETIME_MINUTES } from "./constants";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const PERSON = "person@teams.example.test";
const URL_OK = "https://app.example.test/api/webhooks/microsoft";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PKG = "PKG" as LaneId;

type Setup = ReturnType<typeof setup>;
function setup(opts: { features?: ("chat_read" | "chat_send" | "channels_read")[]; lane?: Parameters<typeof createTeamsHarness>[0]["lanes"][string] } = {}) {
  const fake = createFakeTeams();
  const subs = createFakeTeamsSubscriptions(fake);
  server.use(...fake.handlers, ...subs.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: opts.lane ?? { teams: { features: opts.features ?? ["chat_read"] }, mailProviders: ["google"] } } });
  const twin = createSubscriptionStoreTwin((lane, id) => {
    const r = h.rows.get(id);
    return r && r.lane_id === lane ? { status: r.status } : undefined;
  });
  const t0 = Date.now();
  subs.setNow(t0);
  const state = { url: URL_OK as string | null, urlError: null as unknown, ownerAllowed: true, ownerError: null as unknown, ownerAsked: [] as unknown[] };
  let n = 0;
  const client = createTeamsSubscriptionClient({ guard: h.guard, tokens: h.tokens, logger: h.logger, errors: h.errors, httpOptions: h.httpOptions });
  const ensureApi = createTeamsSubscriptions({
    client,
    store: twin.store,
    notices: {
      async ownerStillAllowed(_l, id, owner) {
        state.ownerAsked.push([id, owner]);
        if (state.ownerError) throw state.ownerError;
        return state.ownerAllowed;
      },
    },
    identity: h.identityReader,
    laneConfig: h.laneConfig,
    notificationUrl: () => {
      if (state.urlError) throw state.urlError;
      return state.url;
    },
    logger: h.logger,
    randomBytes: (size) => Buffer.alloc(size, ++n), // deterministic and different per subscription
  });
  /** The scan's clock `ms` after the start; Microsoft's clock follows it. */
  const at = (ms: number) => {
    subs.setNow(t0 + ms);
    return { now: new Date(t0 + ms) };
  };
  return { fake, subs, h, twin, state, ensureApi, t0, at, connect: (o: Parameters<ReturnType<typeof createTeamsHarness>["connect"]>[2] = {}) => h.connect("PKG", PERSON, o) };
}
const logLines = (s: Setup) => s.h.logs.map((l) => l.event);
const noMicrosoftCall = (s: Setup) => {
  expect(s.subs.requests).toHaveLength(0);
  expect(s.fake.state.graphRequests).toHaveLength(0);
  expect(s.h.stats.tokenReads).toBe(0);
};

describe("create (spec 17 test 14)", () => {
  it("creates ONE subscription for users/<entra object id>/chats/getAllMessages, changeType created, no includeResourceData, both URLs from the configured URL, 4,200 minutes asked", async () => {
    const s = setup();
    const { conn, account, row } = s.connect();
    const out = await s.ensureApi.ensure(PKG, conn, s.at(0));
    expect(out).toMatchObject({ created: 1, renewed: 0, recreated: 0, skipped: null });
    expect(s.subs.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1.0/subscriptions"]);
    const body = s.subs.requests[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["changeType", "clientState", "expirationDateTime", "lifecycleNotificationUrl", "notificationUrl", "resource"]);
    expect(body.changeType).toBe("created");
    expect(body.resource).toBe(`users/${account.objectId}/chats/getAllMessages`);
    expect(body.notificationUrl).toBe(URL_OK);
    expect(body.lifecycleNotificationUrl).toBe(URL_OK);
    expect(Date.parse(body.expirationDateTime as string) - s.t0).toBe(TEAMS_SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    expect(TEAMS_SUBSCRIPTION_LIFETIME_MINUTES).toBe(4_200);
    expect(JSON.stringify(body)).not.toContain("includeResourceData");
    expect(s.subs.sawIncludeResourceData).toBe(0);
    // recorded for THIS connection with Microsoft's answer, provider-tied resource, a Vault clientState of 43 characters
    expect(s.twin.liveRows()).toHaveLength(1);
    const rec = s.twin.rows[0];
    expect(rec).toMatchObject({ connectionId: row.id, laneId: "PKG", resource: "teams_chats", status: "active", resourcePath: `users/${account.objectId}/chats/getAllMessages` });
    expect(rec?.expiresAt.getTime()).toBe(s.t0 + TEAMS_SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    expect(rec?.clientState).toHaveLength(43);
    expect(out.expiresAt?.getTime()).toBe(rec?.expiresAt.getTime());
  });

  it("records what Microsoft GIVES, not what was asked: a 3-day answer (4,320 capped) is stored as given", async () => {
    const s = setup();
    const { conn } = s.connect();
    s.subs.grantMinutes = 2 * 24 * 60; // gives 2 days
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    expect(s.twin.rows[0]?.expiresAt.getTime()).toBe(s.t0 + 2 * DAY);
    expect(logLines(s)).toContain("teams.subscription.ensured");
    const line = s.h.logs.find((l) => l.event === "teams.subscription.ensured");
    expect(line?.fields).toMatchObject({ action: "created", granted_minutes: 2880, asked_minutes: 4200 });
  });

  it("the clientState is a random secret per subscription: 256 bits, different each time, never logged, never in an error, compared by the receiver from the store", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    s.subs.remove([...s.subs.subscriptions.keys()][0] as string);
    Object.assign(s.twin.rows[0] ?? {}, { expiresAt: new Date(s.t0 - 1000) }); // our record says expired: a new one is made
    await s.ensureApi.ensure(PKG, conn, s.at(HOUR));
    expect(s.twin.rows).toHaveLength(2);
    expect(s.twin.rows[0]?.clientState).toBeNull(); // the superseded one's secret is gone
    const sentStates = s.subs.requests.filter((r) => r.method === "POST").map((r) => (r.body as { clientState: string }).clientState);
    expect(new Set(sentStates).size).toBe(2);
    const dump = JSON.stringify(s.h.logs) + JSON.stringify(s.h.apiErrors);
    for (const c of sentStates) expect(dump).not.toContain(c);
  });

  it("logs hold ids, enums and minute counts only: no token, no Entra object id, no resource path, no URL, no clientState", async () => {
    const s = setup();
    const { conn, account, row } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    const dump = JSON.stringify(s.h.logs);
    for (const secret of [account.objectId, "getAllMessages", URL_OK, s.twin.rows[0]?.clientState ?? "x", ...account.accessTokens, account.refreshToken]) expect(dump).not.toContain(secret);
    expect(dump).toContain(row.id); // the connection id is what a log line is about
  });

  it("never a second subscription: a live, unexpired row means no request at all, however often it runs", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    const before = s.subs.requests.length;
    for (const hours of [1, 6, 12, 24, 36]) {
      const out = await s.ensureApi.ensure(PKG, conn, s.at(hours * HOUR));
      expect(out).toMatchObject({ created: 0, renewed: 0, skipped: null });
    }
    expect(s.subs.requests).toHaveLength(before);
    expect(s.twin.liveRows()).toHaveLength(1);
    expect([...s.subs.subscriptions.values()]).toHaveLength(1);
  });

  it("only one all-chats subscription per connection even when the record of a previous one is gone for Microsoft: a quota refusal (10 per user) is `unsupported`, not a second try", async () => {
    const s = setup();
    const { conn, account } = s.connect();
    for (let i = 0; i < 10; i++) s.subs.subscriptions.set(`other-${String(i)}`, { id: `other-${String(i)}`, account, resource: "x", changeType: "created", notificationUrl: URL_OK, lifecycleNotificationUrl: URL_OK, expirationDateTime: s.t0 + DAY, clientState: "s" });
    const out = await s.ensureApi.ensure(PKG, conn, s.at(0));
    expect(out.skipped).toBe("unsupported");
    expect(s.subs.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(s.twin.liveRows()).toHaveLength(0);
  });
});

describe("a refused resource (spec 9.1: `teams.subscription.unsupported`, no per-chat fallback)", () => {
  for (const status of [400, 403, 404, 501]) {
    it(`Microsoft answers ${String(status)}: logged once with the status and Microsoft's short code, nothing recorded, not thrown, one POST only and no per-chat resource is ever tried`, async () => {
      const s = setup();
      const { conn } = s.connect();
      s.subs.refuse = { status, code: "ExtensionError" };
      const out = await s.ensureApi.ensure(PKG, conn, s.at(0));
      expect(out).toMatchObject({ created: 0, skipped: "unsupported", expiresAt: null });
      expect(s.twin.rows).toHaveLength(0);
      expect(s.subs.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1.0/subscriptions"]);
      const line = s.h.logs.find((l) => l.event === "teams.subscription.unsupported");
      expect(line?.fields).toMatchObject({ status });
      if (status !== 501) expect(line?.fields).toMatchObject({ provider_error_code: "ExtensionError" }); // a 5xx answer carries no provider code through the shared client
      expect(s.h.logs.filter((l) => l.event === "teams.subscription.unsupported")).toHaveLength(1);
      // no per-chat resource: nothing but the all-chats one was ever named, and no chat was read to build one
      for (const r of s.subs.requests) expect((r.body as { resource?: string }).resource ?? "").toMatch(/^users\/[0-9a-f-]{36}\/chats\/getAllMessages$/);
      expect(s.fake.state.graphRequests.every((r) => r.path.endsWith("/subscriptions"))).toBe(true);
      expect(JSON.stringify(s.h.logs)).not.toContain(TEAMS_ERROR_TEXT_CANARY);
    });
  }

  it("the next scan asks again (twice a day): a later success is recorded", async () => {
    const s = setup();
    const { conn } = s.connect();
    s.subs.refuse = { status: 400, code: "BadRequest" };
    expect((await s.ensureApi.ensure(PKG, conn, s.at(0))).skipped).toBe("unsupported");
    s.subs.refuse = null;
    expect((await s.ensureApi.ensure(PKG, conn, s.at(12 * HOUR))).created).toBe(1);
    expect(s.twin.liveRows()).toHaveLength(1);
  });

  it("a failure that is NOT a refusal of the resource is thrown for the job to retry or report: 401 after a refresh, 429, 500, a timeout class", async () => {
    for (const status of [401, 429, 500, 503]) {
      const s = setup();
      const { conn } = s.connect();
      s.subs.failNext("create", status, 3);
      await expect(s.ensureApi.ensure(PKG, conn, s.at(0)), String(status)).rejects.toBeInstanceOf(ConnectorError);
      expect(s.twin.rows).toHaveLength(0);
      // never repeated by the HTTP client: one POST (a 401 gets exactly one more after a token refresh)
      expect(s.subs.requests.filter((r) => r.method === "POST").length, String(status)).toBe(status === 401 ? 2 : 1);
      expect(s.h.logs.some((l) => l.event === "teams.subscription.unsupported")).toBe(false);
    }
  });
});

describe("the lifetime rule (spec 17 test 15)", () => {
  it("Microsoft answers 60 minutes: the subscription is DELETED at Microsoft, not recorded, logged `teams.subscription.lifetime_too_short`, notices off, not thrown", async () => {
    const s = setup();
    const { conn } = s.connect();
    s.subs.grantMinutes = 60;
    const out = await s.ensureApi.ensure(PKG, conn, s.at(0));
    expect(out).toMatchObject({ created: 0, skipped: "lifetime_too_short", expiresAt: null });
    expect(s.subs.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
    expect(s.subs.subscriptions.size).toBe(0);
    expect(s.twin.rows).toHaveLength(0);
    const line = s.h.logs.find((l) => l.event === "teams.subscription.lifetime_too_short");
    expect(line?.fields).toMatchObject({ granted_minutes: 60, asked_minutes: 4200 });
  });

  it("the limit is 26 hours: 1,559 minutes is refused, 1,560 is kept", async () => {
    const short = setup();
    const a = short.connect();
    short.subs.grantMinutes = 26 * 60 - 1;
    expect((await short.ensureApi.ensure(PKG, a.conn, short.at(0))).skipped).toBe("lifetime_too_short");
    const ok = setup();
    const b = ok.connect();
    ok.subs.grantMinutes = 26 * 60;
    expect(await ok.ensureApi.ensure(PKG, b.conn, ok.at(0))).toMatchObject({ created: 1, skipped: null });
    expect(ok.twin.liveRows()).toHaveLength(1);
  });

  it("an answer under 26 hours to a RENEWAL stops it too: the row is removed and Microsoft is asked to delete it", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    s.subs.grantMinutes = 60;
    const out = await s.ensureApi.ensure(PKG, conn, s.at(2 * DAY + 12 * HOUR)); // within 24 hours of expiry (the answer was 4,200 minutes = 2 days 22 hours)
    expect(out).toMatchObject({ renewed: 0, skipped: "lifetime_too_short", removed: 1 });
    expect(s.twin.liveRows()).toHaveLength(0);
    expect(s.subs.requests.map((r) => r.method)).toEqual(["POST", "PATCH", "DELETE"]);
  });

  it("an expiry that is nonsense (in the past, or more than 8 days ahead) is an error and the subscription is stopped", async () => {
    const s = setup();
    const { conn } = s.connect();
    s.subs.grantMinutes = 9 * 24 * 60;
    await expect(s.ensureApi.ensure(PKG, conn, s.at(0))).rejects.toMatchObject({ info: { kind: "provider_error" } });
    expect(s.subs.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
    expect(s.twin.rows).toHaveLength(0);
  });
});

describe("renewal (by the existing job: conn.subscriptions_renew)", () => {
  it("renews within 24 hours of the expiry with ONE PATCH of expirationDateTime and records Microsoft's answer; not before", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0)); // expires at +2d 22h 0m (4,200 minutes)
    await s.ensureApi.ensure(PKG, conn, s.at(2 * DAY)); // 22 h left: due
    const patch = s.subs.requests.filter((r) => r.method === "PATCH");
    expect(patch).toHaveLength(1);
    expect(Object.keys(patch[0]?.body as object)).toEqual(["expirationDateTime"]);
    expect(s.twin.rows[0]?.expiresAt.getTime()).toBe(s.t0 + 2 * DAY + TEAMS_SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
    expect(s.h.logs.find((l) => l.event === "teams.subscription.ensured" && (l.fields as { action?: string }).action === "renewed")).toBeTruthy();
  });

  it("a row more than 24 hours from its expiry is left alone", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    const n = s.subs.requests.length;
    await s.ensureApi.ensure(PKG, conn, s.at(DAY)); // 46 h left
    expect(s.subs.requests).toHaveLength(n);
  });

  it("reauthorization_required (Microsoft's lifecycle event, marked by the receiver) is renewed at once whatever the expiry", async () => {
    const s = setup();
    const { conn, row } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    await s.twin.store.mark(PKG, row.id, [...s.subs.subscriptions.keys()][0] as string, "reauthorization_required");
    const out = await s.ensureApi.ensure(PKG, conn, s.at(HOUR));
    expect(out.renewed).toBe(1);
    expect(s.twin.rows[0]?.status).toBe("active");
  });

  it("an expired row (or a renewal answered 404: Microsoft ended it, `subscriptionRemoved`) is replaced by ONE new subscription; the old one's secret goes", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    s.subs.remove([...s.subs.subscriptions.keys()][0] as string);
    const out = await s.ensureApi.ensure(PKG, conn, s.at(2 * DAY)); // due, PATCH answers 404
    expect(out).toMatchObject({ created: 1, recreated: 1, renewed: 0 });
    expect(s.twin.liveRows()).toHaveLength(1);
    expect(s.twin.rows.filter((r) => r.status === "removed").every((r) => r.clientState === null)).toBe(true);
    expect(s.subs.requests.map((r) => r.method)).toEqual(["POST", "PATCH", "POST"]);
    // expired in our record: removed and created again without a PATCH
    Object.assign(s.twin.rows.find((r) => r.status === "active") ?? {}, { expiresAt: new Date(s.t0) });
    const again = await s.ensureApi.ensure(PKG, conn, s.at(5 * DAY));
    expect(again).toMatchObject({ created: 1, recreated: 1 });
    expect(s.twin.liveRows()).toHaveLength(1);
  });

  it("a renewal that fails (5xx) is thrown for the job and leaves the row as it was", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    s.subs.failNext("renew", 503);
    await expect(s.ensureApi.ensure(PKG, conn, s.at(2 * DAY))).rejects.toBeInstanceOf(ConnectorError);
    expect(s.twin.liveRows()).toHaveLength(1);
    expect(s.twin.rows[0]?.expiresAt.getTime()).toBe(s.t0 + TEAMS_SUBSCRIPTION_LIFETIME_MINUTES * 60_000);
  });
});

describe("notices are off (nothing is sent to Microsoft; the rows are marked removed and the secrets deleted)", () => {
  const withRow = async (s: Setup, connect: ReturnType<Setup["connect"]>) => {
    await s.ensureApi.ensure(PKG, connect.conn, s.at(0));
    s.subs.requests.length = 0;
    s.fake.state.graphRequests.length = 0;
    s.h.stats.tokenReads = 0;
  };

  it("the lane pauses Teams (`teams.enabled` false)", async () => {
    const s = setup();
    const c = s.connect();
    await withRow(s, c);
    s.h.setLane("PKG", { teams: { enabled: false, features: ["chat_read"] } });
    const out = await s.ensureApi.ensure(PKG, c.conn, s.at(HOUR));
    expect(out).toMatchObject({ skipped: "paused", removed: 1 });
    expect(s.twin.liveRows()).toHaveLength(0);
    expect(s.twin.rows[0]?.clientState).toBeNull();
    noMicrosoftCall(s);
  });

  it("the lane removes `chat_read` from its features", async () => {
    const s = setup({ features: ["chat_read", "chat_send"] });
    const c = s.connect({ features: ["chat_read", "chat_send"] });
    await withRow(s, c);
    s.h.setLane("PKG", { teams: { features: ["chat_send"] } });
    expect(await s.ensureApi.ensure(PKG, c.conn, s.at(HOUR))).toMatchObject({ skipped: "paused", removed: 1 });
    noMicrosoftCall(s);
  });

  it("the connection does not have chat_read (a reconnect under fewer features)", async () => {
    const s = setup();
    const c = s.connect({ features: [] });
    expect(await s.ensureApi.ensure(PKG, c.conn, s.at(0))).toMatchObject({ skipped: "paused", created: 0 });
    noMicrosoftCall(s);
    expect(s.twin.rows).toHaveLength(0);
  });

  it("the company's cloud is one this build does not serve", async () => {
    const s = setup({ lane: { teams: { cloud: "gcc_high", features: ["chat_read"] } } });
    const c = s.connect();
    expect((await s.ensureApi.ensure(PKG, c.conn, s.at(0))).skipped).toBe("paused");
    noMicrosoftCall(s);
  });

  it("the lane has no Teams block at all", async () => {
    const s = setup({ lane: { teams: null } });
    const c = s.connect();
    expect((await s.ensureApi.ensure(PKG, c.conn, s.at(0))).skipped).toBe("paused");
    noMicrosoftCall(s);
  });

  it("the connection is not usable (reconnect_required, disconnected, pending)", async () => {
    for (const status of ["reconnect_required", "disconnected", "pending"] as const) {
      const s = setup();
      const c = s.connect({ status });
      expect((await s.ensureApi.ensure(PKG, c.conn, s.at(0))).skipped, status).toBe("paused");
      noMicrosoftCall(s);
    }
  });

  it("the owner lost own_mail (removed from the lane, or the permission): asked of the database for THIS connection and its owner", async () => {
    const s = setup();
    const c = s.connect({ owner: TEAMS_OTHER_USER });
    await withRow(s, c);
    s.state.ownerAllowed = false;
    const out = await s.ensureApi.ensure(PKG, c.conn, s.at(HOUR));
    expect(out).toMatchObject({ skipped: "owner_not_allowed", removed: 1 });
    expect(s.state.ownerAsked.at(-1)).toEqual([c.row.id, TEAMS_OTHER_USER]);
    expect(s.twin.liveRows()).toHaveLength(0);
    noMicrosoftCall(s);
  });

  it("an owner check that cannot be answered changes nothing and is retried (thrown, transient)", async () => {
    const s = setup();
    const c = s.connect();
    await withRow(s, c);
    s.state.ownerError = new ConnectorError({ kind: "transient", message: "x" });
    await expect(s.ensureApi.ensure(PKG, c.conn, s.at(HOUR))).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(s.twin.liveRows()).toHaveLength(1);
    noMicrosoftCall(s);
  });

  it("GRAPH_NOTIFICATION_URL is not configured: nothing is created; live subscriptions are stopped (DELETE) and removed", async () => {
    const s = setup();
    const c = s.connect();
    s.state.url = null;
    expect(await s.ensureApi.ensure(PKG, c.conn, s.at(0))).toMatchObject({ skipped: "not_configured", created: 0 });
    noMicrosoftCall(s);
    s.state.url = URL_OK;
    await withRow(s, c);
    s.state.url = null;
    const out = await s.ensureApi.ensure(PKG, c.conn, s.at(HOUR));
    expect(out).toMatchObject({ skipped: "not_configured", removed: 1 });
    expect(s.subs.requests.map((r) => r.method)).toEqual(["DELETE"]);
    expect(s.twin.liveRows()).toHaveLength(0);
  });

  it("an unreadable configuration changes and fails nothing (the log carries only our own fixed text)", async () => {
    const s = setup();
    const c = s.connect();
    await withRow(s, c);
    s.state.urlError = new ConnectorError({ kind: "connection_unavailable", message: "GRAPH_NOTIFICATION_URL must be https" });
    expect(await s.ensureApi.ensure(PKG, c.conn, s.at(HOUR))).toMatchObject({ skipped: "config_unreadable", removed: 0 });
    expect(s.twin.liveRows()).toHaveLength(1);
    noMicrosoftCall(s);
  });

  it("a connection of another provider is refused, and a connection of another lane is not accepted", async () => {
    const s = setup();
    const c = s.connect();
    await expect(s.ensureApi.ensure("APK" as LaneId, c.conn, s.at(0))).rejects.toBeInstanceOf(ConnectorError);
    await expect(s.ensureApi.ensure(PKG, { ...c.conn } as never, s.at(0))).rejects.toBeInstanceOf(ConnectorError);
    noMicrosoftCall(s);
  });
});

describe("stop (disconnect, switch-off)", () => {
  it("DELETEs at Microsoft (best effort) and removes the rows whatever Microsoft answers", async () => {
    const s = setup();
    const { conn } = s.connect();
    await s.ensureApi.ensure(PKG, conn, s.at(0));
    s.subs.failNext("delete", 500);
    expect(await s.ensureApi.stop(PKG, conn)).toBe(1);
    expect(s.twin.liveRows()).toHaveLength(0);
    expect(s.h.logs.some((l) => l.event === "teams.subscription.stop_unconfirmed")).toBe(true);
  });
});

describe("a connection's rows never reach another's", () => {
  it("two people in one lane each get their own subscription for their own object id, and stopping one leaves the other", async () => {
    const s = setup();
    const a = s.connect();
    const b = s.h.connect("PKG", "second@teams.example.test", { owner: TEAMS_OTHER_USER });
    await s.ensureApi.ensure(PKG, a.conn, s.at(0));
    await s.ensureApi.ensure(PKG, b.conn, s.at(0));
    const resources = s.subs.requests.filter((r) => r.method === "POST").map((r) => (r.body as { resource: string }).resource);
    expect(resources).toEqual([`users/${a.account.objectId}/chats/getAllMessages`, `users/${b.account.objectId}/chats/getAllMessages`]);
    expect(s.twin.liveRows()).toHaveLength(2);
    await s.ensureApi.stop(PKG, a.conn);
    expect(s.twin.liveRows().map((r) => r.connectionId)).toEqual([b.row.id]);
  });
});
