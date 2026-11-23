// The Microsoft receiver for a TEAMS subscription (T-289, spec 9.2, 17 tests 14 and 15): the receiver's logic is the mail one, unchanged: validation echo, per-subscription clientState in constant time,
// dedupe, lane and connection from the STORED row, `resource` and `resourceData` never read. A `teams_chats` row yields `teams_chats.changed`; no Graph call; no chat or message id reaches an event,
// a receipt or a log line. Hostile payloads: a wrong clientState, an unknown subscription, another tenant's claim, resource data present, an oversized body, a replay. MSW fakes, synthetic data (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createSubscriptionStoreTwin } from "../testing/microsoft-subscription-store";
import { createMemoryWebhookStore } from "../testing/mock-webhook";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams } from "../testing/msw/teams/handlers";
import { createFakeTeamsSubscriptions } from "../testing/msw/teams/subscriptions";
import { createTeamsHarness } from "../testing/teams-harness";
import { createTeamsSubscriptionClient } from "../teams/subscription-client";
import { createTeamsSubscriptions } from "../teams/subscriptions";
import { WEBHOOK_EVENT_NAME } from "./handler";
import { createMicrosoftNotificationHandler, MICROSOFT_MAX_BODY_BYTES, RENEW_EVENT_NAME } from "./microsoft";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const T0 = Date.parse("2026-11-23T12:00:00.000Z");
const URL_OK = "https://app.example.test/api/webhooks/microsoft";
const ENDPOINT = "http://localhost/api/webhooks/microsoft";
const STATE = "synthetic-teams-client-state-0123456789-abcdefghij";
const CHAT_CANARY = "19:canary-chat-id-77ab@thread.v2";
const MSG_CANARY = "1700000000777canary";
const TEXT_CANARY = "teams-message-text-canary-91cd";

type Sent = { name: string; data: Record<string, unknown>; id: string };

function setup(opts: { jobs?: boolean } = {}) {
  const fake = createFakeTeams();
  const graph = createFakeTeamsSubscriptions(fake);
  server.use(...fake.handlers, ...graph.handlers);
  graph.setNow(T0);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: ["chat_read"] }, mailProviders: ["google"] }, APK: { teams: { features: ["chat_read"] } } } });
  const twin = createSubscriptionStoreTwin((laneId, id) => {
    const r = h.rows.get(id);
    return r && r.lane_id === laneId ? { status: r.status } : undefined;
  });
  const mem = createMemoryWebhookStore({}, {}, (laneId, id) => {
    const r = h.rows.get(id);
    return r && r.lane_id === laneId ? r.provider : undefined;
  });
  const sent: Sent[] = [];
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
  let clock = T0;
  const handler = createMicrosoftNotificationHandler({
    subscriptions: twin.store,
    store: mem.store,
    lanes: () => ["PKG", "APK"] as never,
    enqueue: async (e) => void sent.push(e as Sent),
    jobsAvailable: () => opts.jobs ?? true,
    log: logger,
    now: () => new Date(clock),
  });
  const post = (body: string, init: { headers?: Record<string, string>; url?: string } = {}) =>
    handler(new Request(init.url ?? ENDPOINT, { method: "POST", body, headers: init.headers ?? { "content-type": "application/json; charset=utf-8" } }));
  const a = h.connect("PKG", "a@teams.example.test");
  const b = h.connect("APK", "b@teams.example.test");
  const expires = new Date(T0 + 2 * 86_400_000);
  twin.plant("PKG", a.conn.id, "teams_chats", "sub-teams-pkg", expires, STATE);
  twin.plant("APK", b.conn.id, "teams_chats", "sub-teams-apk", expires, "synthetic-apk-teams-state-0123456789-abcdefghi");
  const body = (items: Parameters<typeof graph.notificationBody>[0]) => graph.notificationBody(items);
  return { fake, graph, h, twin, mem, sent, logs, post, handler, a, b, body, advance: (ms: number) => void (clock += ms) };
}
const noGraph = (s: ReturnType<typeof setup>) => {
  expect(s.graph.requests).toHaveLength(0);
  expect(s.fake.state.graphRequests).toHaveLength(0);
  expect(s.fake.state.tokenRequests).toHaveLength(0);
};

describe("a valid Teams notification (spec 17 test 14)", () => {
  it("a teams_chats row yields exactly `teams_chats.changed`, ids only, from the stored row; `resource` is never read; no Graph call, no token read", async () => {
    const s = setup();
    const res = await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE, resource: `chats('${CHAT_CANARY}')/messages('${MSG_CANARY}')` }]));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.name).toBe(WEBHOOK_EVENT_NAME);
    expect(s.sent[0]?.data).toEqual({ laneId: "PKG", provider: "microsoft", connectionId: s.a.conn.id, eventId: expect.stringMatching(/^ms:change:[0-9a-f]{64}$/), eventType: "teams_chats.changed", refs: [] });
    expect([...s.mem.rows.values()].map((r) => [r.laneId, r.provider, r.eventType, r.status])).toEqual([["PKG", "microsoft_teams", "teams_chats.changed", "enqueued"]]);
    noGraph(s);
    expect(s.h.stats.tokenReads).toBe(0);
    // the chat and message named by the notification are in no event, receipt or log line
    expect(JSON.stringify([s.sent, [...s.mem.rows.values()], s.logs])).not.toMatch(/canary/);
  });

  it("two Teams connections of two lanes in one delivery are two events, each for its own connection (mail's own receiver tests are webhooks/microsoft.test.ts, unchanged)", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-teams-apk", clientState: "synthetic-apk-teams-state-0123456789-abcdefghi" }, { subscriptionId: "sub-teams-pkg", clientState: STATE }]));
    expect(s.sent.map((e) => [e.data.laneId, e.data.connectionId, e.data.eventType]).sort()).toEqual([["APK", s.b.conn.id, "teams_chats.changed"], ["PKG", s.a.conn.id, "teams_chats.changed"]]);
  });

  it("the whole payload is untrusted: resource, resourceData, ids and text claims select nothing and reach no event, receipt or log; another lane's id in it changes nothing", async () => {
    const s = setup();
    const raw = JSON.stringify({
      value: [
        {
          subscriptionId: "sub-teams-pkg",
          clientState: STATE,
          changeType: "created",
          resource: `chats('${CHAT_CANARY}')/messages('${MSG_CANARY}')`,
          resourceData: { "@odata.type": "#Microsoft.Graph.chatMessage", id: MSG_CANARY, "@odata.id": `chats('${CHAT_CANARY}')`, body: { content: TEXT_CANARY }, from: { user: { displayName: TEXT_CANARY } } },
          laneId: "APK",
          connectionId: s.b.conn.id,
          subject: TEXT_CANARY,
        },
      ],
    });
    expect((await s.post(raw)).status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.data).toMatchObject({ laneId: "PKG", connectionId: s.a.conn.id });
    expect(JSON.stringify([s.sent, [...s.mem.rows.values()], s.logs])).not.toMatch(/canary/);
    noGraph(s);
  });

  it("a payload that carries ENCRYPTED resource data (never asked for) is handled like any other: its content is not read, decoded, stored or logged; ONE content-free line says it arrived", async () => {
    const s = setup();
    const raw = JSON.stringify({
      value: [
        { subscriptionId: "sub-teams-pkg", clientState: STATE, changeType: "created", encryptedContent: { data: TEXT_CANARY, dataKey: TEXT_CANARY, dataSignature: TEXT_CANARY, encryptionCertificateId: TEXT_CANARY, encryptionCertificateThumbprint: TEXT_CANARY } },
        { subscriptionId: "sub-teams-pkg", clientState: STATE, changeType: "created", encryptedContent: { data: TEXT_CANARY } },
      ],
    });
    expect((await s.post(raw)).status).toBe(202);
    expect(s.sent).toHaveLength(1);
    const line = s.logs.filter((l) => l.event === "webhook.unexpected_resource_data");
    expect(line).toHaveLength(1);
    expect(line[0]?.fields).toMatchObject({ outcome: "resource_data_ignored", items: 2 });
    expect(JSON.stringify([s.sent, [...s.mem.rows.values()], s.logs])).not.toContain(TEXT_CANARY);
    noGraph(s);
  });

  it("a normal notification (ids only, `resourceData` with an id and a type) raises no unexpected-resource-data line", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE }]));
    expect(s.logs.some((l) => l.event === "webhook.unexpected_resource_data")).toBe(false);
  });
});

describe("hostile and unknown deliveries answer exactly as accepted ones do (202) and queue nothing", () => {
  it("a wrong, missing or other-lane clientState: dropped, nothing claimed or queued, logged with ids only (never a state)", async () => {
    const s = setup();
    for (const state of ["wrong-wrong-wrong-wrong-wrong-wrong-wrong", "", STATE.slice(0, -1), `${STATE}x`, "synthetic-apk-teams-state-0123456789-abcdefghi"]) {
      const res = await s.post(s.body([{ subscriptionId: "sub-teams-pkg", ...(state === "" ? {} : { clientState: state }) }]));
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    }
    expect(s.sent).toHaveLength(0);
    expect(s.mem.calls.claim).toHaveLength(0);
    expect(s.logs.some((l) => l.event === "webhook.skipped" && (l.fields as { outcome?: string }).outcome === "bad_client_state" && l.connection_id === s.a.conn.id)).toBe(true);
    const all = JSON.stringify(s.logs);
    for (const secret of [STATE, "wrong-wrong", "synthetic-apk-teams-state"]) expect(all).not.toContain(secret);
  });

  it("an unknown subscription id, and the Teams subscription of a DISCONNECTED connection or a removed row, are dropped", async () => {
    const s = setup();
    expect((await s.post(s.body([{ subscriptionId: "sub-unknown", clientState: STATE }]))).status).toBe(202);
    const mine = s.h.rows.get(s.a.conn.id);
    if (mine) mine.status = "disconnected";
    expect((await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE }]))).status).toBe(202);
    if (mine) mine.status = "active";
    await s.twin.store.mark("PKG", s.a.conn.id, "sub-teams-pkg", "removed");
    expect((await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE }]))).status).toBe(202);
    expect(s.sent).toHaveLength(0);
    expect(s.mem.calls.claim).toHaveLength(0);
  });

  it("another tenant: the `tenantId` of a notification is never read; the secret and the stored row decide. A claim of another tenant with a wrong state is dropped; with the right state it is the stored connection's notice and nothing else", async () => {
    const s = setup();
    const other = "99999999-9999-4999-8999-999999999999";
    await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: "wrong-wrong-wrong-wrong-wrong-wrong-wrong", tenantId: other }]));
    expect(s.sent).toHaveLength(0);
    await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE, tenantId: other }]));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.data).toMatchObject({ laneId: "PKG", connectionId: s.a.conn.id });
    expect(JSON.stringify(s.sent)).not.toContain(other);
  });

  it("another lane's Teams subscription carries ITS lane and connection; PKG's state does not open it", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-teams-apk", clientState: STATE }]));
    expect(s.sent).toHaveLength(0);
    await s.post(s.body([{ subscriptionId: "sub-teams-apk", clientState: "synthetic-apk-teams-state-0123456789-abcdefghi" }]));
    expect(s.sent.map((e) => [e.data.laneId, e.data.connectionId, e.data.eventType])).toEqual([["APK", s.b.conn.id, "teams_chats.changed"]]);
  });

  it("an oversized body (413), a body that is not JSON (400), the wrong content type (415) and more than 200 items (400) queue nothing", async () => {
    const s = setup();
    const huge = JSON.stringify({ value: [{ subscriptionId: "sub-teams-pkg", clientState: STATE, pad: "x".repeat(MICROSOFT_MAX_BODY_BYTES) }] });
    expect((await s.post(huge)).status).toBe(413);
    expect((await s.post("not json")).status).toBe(400);
    expect((await s.post("{}", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await s.post(JSON.stringify({ value: Array.from({ length: 201 }, () => ({ subscriptionId: "sub-teams-pkg", clientState: STATE })) }))).status).toBe(400);
    expect(s.sent).toHaveLength(0);
    expect(s.mem.calls.claim).toHaveLength(0);
  });

  it("a flood of unknown ids costs one lookup per served lane, however many items it holds", async () => {
    const s = setup();
    await s.post(JSON.stringify({ value: Array.from({ length: 200 }, (_, i) => ({ subscriptionId: `unknown-${String(i)}`, clientState: STATE })) }));
    expect(s.twin.calls.lookup).toBe(2); // PKG and APK
    expect(s.sent).toHaveLength(0);
  });
});

describe("the claim names the connection's provider (the real core.webhook_event_claim refuses any other)", () => {
  it("a Teams notice and a Teams lifecycle event are claimed and marked under `microsoft_teams`; the queued event keeps provider `microsoft`", async () => {
    const s = setup();
    expect((await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE }]))).status).toBe(202);
    expect((await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE, lifecycleEvent: "reauthorizationRequired" }]))).status).toBe(202);
    expect([...s.mem.rows.values()].map((r) => `${r.provider}:${r.eventType}:${r.status}`).sort()).toEqual(["microsoft_teams:teams_chats.changed:enqueued", "microsoft_teams:teams_chats.reauthorizationRequired:enqueued"]);
    expect(s.sent.filter((e) => e.name === WEBHOOK_EVENT_NAME).map((e) => e.data.provider)).toEqual(["microsoft"]);
  });

  it("the memory store mirrors the SQL: a claim naming the wrong provider for a connection fails", async () => {
    const s = setup();
    await expect(s.mem.store.claim("PKG", s.a.conn.id, "microsoft", { id: "x", type: "teams_chats.changed", payloadHash: "h" })).rejects.toThrow();
    await expect(s.mem.store.claim("PKG", s.a.conn.id, "microsoft_teams", { id: "x", type: "teams_chats.changed", payloadHash: "h" })).resolves.toBe("process");
  });

  it("one item whose claim fails does not stop the others of the delivery; the answer is still 503 so Graph retries", async () => {
    const s = setup();
    const realClaim = s.mem.store.claim.bind(s.mem.store);
    let n = 0;
    s.mem.store.claim = async (...a) => {
      if (++n === 1) throw new Error("db down");
      return realClaim(...a);
    };
    const res = await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE }, { subscriptionId: "sub-teams-apk", clientState: "synthetic-apk-teams-state-0123456789-abcdefghi" }]));
    expect(res.status).toBe(503);
    expect(s.sent).toHaveLength(1);
  });
});

describe("replays", () => {
  it("the same delivery twice inside the slot is one event; a later slot is another; two different verified deliveries inside one slot are two", async () => {
    const s = setup();
    const body = s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE }]);
    await s.post(body);
    expect((await s.post(body)).status).toBe(202);
    expect(s.sent).toHaveLength(1);
    s.advance(11_000);
    await s.post(body);
    expect(s.sent).toHaveLength(2);
    await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE, resource: `chats('x')/messages('y')` }]));
    expect(s.sent).toHaveLength(3);
  });
});

describe("lifecycle notifications of a Teams subscription (spec 9.1) and the renewal that answers them", () => {
  it("reauthorizationRequired: the row is marked and the connection's renewal job is queued; subscriptionRemoved: queued and marked removed; `missed` is not a Teams event but is handled as the receiver always does", async () => {
    const s = setup();
    expect((await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE, lifecycleEvent: "reauthorizationRequired" }]))).status).toBe(202);
    expect(s.sent.at(-1)).toMatchObject({ name: RENEW_EVENT_NAME, data: { laneId: "PKG", connectionId: s.a.conn.id } });
    expect(s.twin.rows.find((r) => r.subscriptionId === "sub-teams-pkg")?.status).toBe("reauthorization_required");
    expect((await s.post(s.body([{ subscriptionId: "sub-teams-pkg", clientState: STATE, lifecycleEvent: "subscriptionRemoved" }]))).status).toBe(202);
    expect(s.sent.at(-1)).toMatchObject({ name: RENEW_EVENT_NAME, data: { laneId: "PKG", connectionId: s.a.conn.id } });
    expect(s.twin.rows.find((r) => r.subscriptionId === "sub-teams-pkg")?.status).toBe("removed");
    expect([...s.mem.rows.values()].map((r) => r.eventType).sort()).toEqual(["teams_chats.reauthorizationRequired", "teams_chats.subscriptionRemoved"]);
    noGraph(s);
  });

  it("round trip with the real validation: the fake Graph creates the Teams subscription only because the real receiver echoes both URLs; then subscriptionRemoved and reauthorizationRequired are answered by `ensure` (recreate, renew)", async () => {
    const s = setup();
    const client = createTeamsSubscriptionClient({ guard: s.h.guard, tokens: s.h.tokens, logger: s.h.logger, httpOptions: s.h.httpOptions });
    const subs = createTeamsSubscriptions({ client, store: s.twin.store, notices: { ownerStillAllowed: async () => true }, identity: s.h.identityReader, laneConfig: s.h.laneConfig, notificationUrl: () => URL_OK, logger: s.h.logger });
    s.graph.validator = (_url, token) => s.post("", { url: `${ENDPOINT}?validationToken=${encodeURIComponent(token)}`, headers: { "content-type": "text/plain" } });
    const c = s.h.connect("PKG", "rt@teams.example.test", { owner: "00000000-0000-4000-8000-0000000b0279" });
    const out = await subs.ensure("PKG", c.conn, { now: new Date(T0) });
    expect(out.created).toBe(1);
    expect(s.graph.validations).toHaveLength(2);
    expect(s.graph.validations.every((v) => v.ok)).toBe(true);
    const row = s.twin.liveRows().find((r) => r.connectionId === c.conn.id);
    if (!row?.clientState) throw new Error("not created");
    // a real notification of that subscription reaches the connection, and ONLY it
    s.sent.length = 0;
    const before = s.graph.requests.length;
    expect((await s.post(s.body([{ subscriptionId: row.subscriptionId, clientState: row.clientState }]))).status).toBe(202);
    expect(s.sent.map((e) => [e.data.connectionId, e.data.eventType])).toEqual([[c.conn.id, "teams_chats.changed"]]);
    expect(s.graph.requests.length).toBe(before);
    // removed -> the renewal job creates a new one
    expect((await s.post(s.body([{ subscriptionId: row.subscriptionId, clientState: row.clientState, lifecycleEvent: "subscriptionRemoved" }]))).status).toBe(202);
    s.graph.setNow(T0 + 60_000);
    expect(await subs.ensure("PKG", c.conn, { now: new Date(T0 + 60_000) })).toMatchObject({ created: 1, renewed: 0 });
    const next = s.twin.liveRows().find((r) => r.connectionId === c.conn.id);
    expect(next?.subscriptionId).not.toBe(row.subscriptionId);
    // reauthorization -> renewed with a PATCH
    if (!next?.clientState) throw new Error("not recreated");
    expect((await s.post(s.body([{ subscriptionId: next.subscriptionId, clientState: next.clientState, lifecycleEvent: "reauthorizationRequired" }]))).status).toBe(202);
    s.graph.requests.length = 0;
    s.graph.setNow(T0 + 120_000);
    expect(await subs.ensure("PKG", c.conn, { now: new Date(T0 + 120_000) })).toMatchObject({ renewed: 1, created: 0 });
    expect(s.graph.requests.map((r) => r.method)).toEqual(["PATCH"]);
  });
});
