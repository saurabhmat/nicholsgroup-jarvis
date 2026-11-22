// The Microsoft change-notification receiver (T-068, T-264, spec §14, §17 test 25), end to end against the fake Graph and in-memory twins: the validation echo (V-21), a notification
// that only queues a debounced sync for its own connection, and the spoofed (wrong clientState), replayed, wrong-lane and unknown-subscription cases, the lifecycle events, and the
// bounds. Synthetic data only (rule 10). The answer is 202 for every delivery that was read, so a prober learns nothing.
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { createGraphSubscriptionClient } from "../microsoft/subscription-client";
import { createMicrosoftSubscriptions } from "../microsoft/subscriptions";
import { createMicrosoftHarness, TENANT_A } from "../testing/microsoft-harness";
import { createSubscriptionStoreTwin } from "../testing/microsoft-subscription-store";
import { createMemoryWebhookStore } from "../testing/mock-webhook";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeSubscriptions } from "../testing/msw/microsoft/subscriptions";
import { CHANGE_SLOT_MS, createMicrosoftNotificationHandler, MAX_VALIDATION_TOKEN_CHARS, MICROSOFT_MAX_BODY_BYTES, MICROSOFT_MAX_ITEMS, MICROSOFT_MAX_SUBSCRIPTIONS, RENEW_EVENT_NAME } from "./microsoft";
import { WEBHOOK_EVENT_NAME } from "./handler";

const fake = createFakeMicrosoft();
const graph = createFakeSubscriptions(fake);
useMockServer(...fake.handlers, ...graph.handlers);
afterEach(() => RateLimiter.resetForTests());

const T0 = Date.parse("2026-11-23T12:00:00.000Z");
const URL_OK = "https://app.example.test/api/webhooks/microsoft";
const ENDPOINT = "http://localhost/api/webhooks/microsoft";
const STATE_PKG = "synthetic-pkg-client-state-0123456789-abcdefghij";
const STATE_APK = "synthetic-apk-client-state-0123456789-abcdefghij";
const CANARY = "notification-content-canary-77ab";

type Sent = { name: string; data: Record<string, unknown>; id: string };

function setup(opts: { lanes?: string[]; jobs?: boolean } = {}) {
  graph.reset();
  graph.setNow(T0);
  const h = createMicrosoftHarness({
    fake,
    lanes: {
      PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] },
      APK: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["apk.example.test"] },
    },
  });
  const twin = createSubscriptionStoreTwin((laneId, id) => {
    const r = h.rows.get(id);
    return r && r.lane_id === laneId ? { status: r.status } : undefined;
  });
  const mem = createMemoryWebhookStore({});
  const sent: Sent[] = [];
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
  let clock = T0;
  const failures = { enqueue: 0 };
  const handler = createMicrosoftNotificationHandler({
    subscriptions: twin.store,
    store: mem.store,
    lanes: () => (opts.lanes ?? ["PKG", "APK"]) as never,
    enqueue: async (e) => {
      if (failures.enqueue > 0) {
        failures.enqueue -= 1;
        throw new Error("inngest down");
      }
      sent.push(e as Sent);
    },
    jobsAvailable: () => opts.jobs ?? true,
    log: logger,
    now: () => new Date(clock),
  });
  const post = (body: string, init: { headers?: Record<string, string>; url?: string } = {}) =>
    handler(new Request(init.url ?? ENDPOINT, { method: "POST", body, headers: init.headers ?? { "content-type": "application/json; charset=utf-8" } }));
  const a = h.connect("PKG", "a@pubkgroup.example.test");
  const b = h.connect("APK", "b@apk.example.test");
  const expires = new Date(T0 + 6 * 86_400_000);
  twin.plant("PKG", a.conn.id, "mail", "sub-pkg-mail", expires, STATE_PKG);
  twin.plant("PKG", a.conn.id, "calendar", "sub-pkg-cal", expires, STATE_PKG);
  twin.plant("APK", b.conn.id, "mail", "sub-apk-mail", expires, STATE_APK);
  const body = (items: Parameters<typeof graph.notificationBody>[0]) => graph.notificationBody(items);
  return { h, twin, mem, sent, logs, post, handler, a, b, body, advance: (ms: number) => void (clock += ms), failures, setClock: (ms: number) => void (clock = ms) };
}

describe("the validation handshake (V-21)", () => {
  it("echoes the URL-decoded token as text/plain with nosniff and nothing else, and does no other work", async () => {
    const s = setup({ jobs: false });
    const token = "Validation: Token=abc+/= &x?y#z";
    const res = await s.post("", { url: `${ENDPOINT}?validationToken=${encodeURIComponent(token)}`, headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(token);
    expect(s.sent).toHaveLength(0);
    expect(s.mem.calls.claim).toHaveLength(0);
    expect(s.twin.calls.lookup).toBe(0);
    expect(s.logs.some((e) => JSON.stringify(e).includes("abc"))).toBe(false);
  });

  it("works whatever the body or content type, and with a body that would be a notification (still only the token)", async () => {
    const s = setup();
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]), { url: `${ENDPOINT}?validationToken=t0ken` });
    expect(await res.text()).toBe("t0ken");
    expect(s.sent).toHaveLength(0);
    expect(s.twin.calls.lookup).toBe(0);
  });

  it("refuses an empty, over-long or control-character token (400, JSON, nothing echoed)", async () => {
    const s = setup();
    for (const q of ["", "x".repeat(MAX_VALIDATION_TOKEN_CHARS + 1), "a%0d%0ab", "a%00b"]) {
      const res = await s.post("", { url: `${ENDPOINT}?validationToken=${q}` });
      expect(res.status, q.slice(0, 20)).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).toBe('{"error":"bad_request"}');
    }
    expect((await s.post("", { url: `${ENDPOINT}?validationToken=${"x".repeat(MAX_VALIDATION_TOKEN_CHARS)}` })).status).toBe(200);
  });

  it("only POST is answered: a GET with a token is 405", async () => {
    const s = setup();
    const res = await s.handler(new Request(`${ENDPOINT}?validationToken=abc`, { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("the fake Graph creates a subscription only because the receiver echoes: validation of BOTH urls goes through the real handler, and a wrong answer creates nothing", async () => {
    const s = setup();
    const own = s.h.connect("PKG", "c@pubkgroup.example.test");
    const client = createGraphSubscriptionClient({ guard: s.h.guard, tokens: s.h.tokens });
    const subscriptions = createMicrosoftSubscriptions({ client, store: s.twin.store, laneConfig: s.h.laneConfig, notificationUrl: () => URL_OK });
    graph.validator = async (url, token) => s.post("", { url: `${ENDPOINT}?validationToken=${encodeURIComponent(token)}`, headers: { "content-type": "text/plain" } }).then((r) => (url === URL_OK ? r : r));
    const out = await subscriptions.ensure("PKG", own.conn, { now: new Date(T0) });
    expect(out.created).toBe(2);
    expect(graph.validations).toHaveLength(4);
    expect(graph.validations.every((v) => v.ok)).toBe(true);
    // a receiver that answers JSON instead of text/plain would be refused by Graph
    graph.reset();
    graph.setNow(T0);
    graph.validator = async (_url, token) => new Response(JSON.stringify({ token }), { status: 200, headers: { "content-type": "application/json" } });
    const own2 = s.h.connect("PKG", "d@pubkgroup.example.test");
    await expect(subscriptions.ensure("PKG", own2.conn, { now: new Date(T0) })).rejects.toBeTruthy();
    expect(graph.subscriptions.size).toBe(0);
  });
});

describe("a valid change notification", () => {
  it("answers 202 with an empty body, queues ONE webhook/received event with ids only, from the stored row (lane, connection, stream), and calls Graph for nothing", async () => {
    const s = setup();
    const graphBefore = graph.requests.length + fake.state.graphRequests.length;
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(s.sent).toHaveLength(1);
    const [e] = s.sent;
    expect(e?.name).toBe(WEBHOOK_EVENT_NAME);
    expect(e?.data).toEqual({ laneId: "PKG", provider: "microsoft", connectionId: s.a.conn.id, eventId: expect.stringMatching(/^ms:change:[0-9a-f]{64}$/), eventType: "mail.changed", refs: [] });
    expect(e?.id).toMatch(/^wh:PKG:microsoft:[0-9a-f]{40}$/);
    expect([...s.mem.rows.values()].map((r) => [r.laneId, r.provider, r.eventType, r.status])).toEqual([["PKG", "microsoft", "mail.changed", "enqueued"]]);
    expect(graph.requests.length + fake.state.graphRequests.length).toBe(graphBefore); // no Graph call, no inline read
  });

  it("a calendar subscription queues a calendar event", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-pkg-cal", clientState: STATE_PKG }]));
    expect(s.sent.map((e) => [e.data.laneId, e.data.connectionId, e.data.eventType])).toEqual([["PKG", s.a.conn.id, "calendar.changed"]]);
  });

  it("notification content is untrusted: resource, resourceData and every other field select nothing and are not stored, queued or logged", async () => {
    const s = setup();
    const raw = JSON.stringify({
      value: [
        {
          subscriptionId: "sub-pkg-mail",
          clientState: STATE_PKG,
          changeType: "created",
          resource: `Users/${CANARY}/Messages/${CANARY}`,
          resourceData: { id: CANARY, "@odata.id": `Users/${CANARY}`, lane: "APK", laneId: "APK", connectionId: s.b.conn.id },
          tenantId: CANARY,
          laneId: "APK",
          connectionId: s.b.conn.id,
          subject: CANARY,
        },
      ],
    });
    const res = await s.post(raw);
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.data.laneId).toBe("PKG");
    expect(s.sent[0]?.data.connectionId).toBe(s.a.conn.id);
    expect(JSON.stringify([s.sent, [...s.mem.rows.values()], s.logs])).not.toContain(CANARY);
  });

  it("many items for one subscription in one delivery are one event", async () => {
    const s = setup();
    await s.post(s.body(Array.from({ length: 50 }, () => ({ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }))));
    expect(s.sent).toHaveLength(1);
  });

  it("two subscriptions of one delivery (mail and calendar) are two events", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }, { subscriptionId: "sub-pkg-cal", clientState: STATE_PKG }]));
    expect(s.sent.map((e) => e.data.eventType).sort()).toEqual(["calendar.changed", "mail.changed"]);
  });

  it("an item that is not an object, or has no usable subscription id, is dropped and the others are still handled", async () => {
    const s = setup();
    const res = await s.post(JSON.stringify({ value: ["x", 5, null, { subscriptionId: 7 }, { subscriptionId: "../etc" }, { subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }] }));
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(1);
  });
});

describe("dropped notifications answer exactly as accepted ones do", () => {
  const same = async (s: ReturnType<typeof setup>, accepted: string, dropped: string) => {
    const a = await s.post(accepted);
    const d = await s.post(dropped);
    expect([d.status, await d.text(), d.headers.get("content-type"), d.headers.get("cache-control")]).toEqual([a.status, await a.clone().text(), a.headers.get("content-type"), a.headers.get("cache-control")]);
    return d;
  };

  it("spoofed: a wrong clientState queues nothing, claims nothing and is logged with ids only (never the state)", async () => {
    const s = setup();
    await same(s, s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]), s.body([{ subscriptionId: "sub-pkg-mail", clientState: `${STATE_PKG}x` }]));
    expect(s.sent).toHaveLength(1); // only the accepted one
    expect(s.mem.calls.claim).toHaveLength(1);
    const line = s.logs.find((e) => JSON.stringify(e).includes("bad_client_state"));
    expect(line).toBeTruthy();
    expect(JSON.stringify(line)).toContain(s.a.conn.id);
    for (const e of s.logs) {
      expect(JSON.stringify(e)).not.toContain(STATE_PKG);
      expect(JSON.stringify(e)).not.toContain("sub-pkg-mail");
    }
  });

  it("a missing, empty, shortened, prefix or other lane's clientState is wrong", async () => {
    const s = setup();
    const ok = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]);
    for (const clientState of [undefined, "", STATE_PKG.slice(0, -1), STATE_PKG.slice(0, 5), STATE_APK, STATE_PKG.toUpperCase()]) {
      await same(s, ok, s.body([{ subscriptionId: "sub-pkg-mail", ...(clientState === undefined ? {} : { clientState }) }]));
      s.mem.rows.clear();
      s.sent.length = 0;
    }
    expect(s.sent).toHaveLength(0);
  });

  it("unknown subscription: dropped with 202, nothing queued, nothing claimed, the id is not logged", async () => {
    const s = setup();
    await same(s, s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]), s.body([{ subscriptionId: "sub-never-created", clientState: STATE_PKG }]));
    expect(s.sent).toHaveLength(1);
    expect(JSON.stringify(s.logs)).not.toContain("sub-never-created");
  });

  it("wrong lane: a subscription of APK carries APK's lane, never another; with PKG's clientState it is dropped; with its own it queues for APK only", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-apk-mail", clientState: STATE_PKG }]));
    expect(s.sent).toHaveLength(0);
    await s.post(s.body([{ subscriptionId: "sub-apk-mail", clientState: STATE_APK }]));
    expect(s.sent.map((e) => [e.data.laneId, e.data.connectionId])).toEqual([["APK", s.b.conn.id]]);
  });

  it("a lane this deployment does not serve is never asked: its subscription is unknown", async () => {
    const s = setup({ lanes: ["PKG"] });
    await s.post(s.body([{ subscriptionId: "sub-apk-mail", clientState: STATE_APK }]));
    expect(s.sent).toHaveLength(0);
    expect(s.twin.calls.lookup).toBe(1);
  });

  it("a subscription whose connection is disconnected, or whose row was removed, is unknown", async () => {
    const s = setup();
    const row = s.h.rows.get(s.a.conn.id);
    if (!row) throw new Error("no row");
    row.status = "disconnected";
    await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]));
    expect(s.sent).toHaveLength(0);
    row.status = "active";
    await s.twin.store.mark("PKG", s.a.conn.id, "sub-pkg-cal", "removed");
    await s.post(s.body([{ subscriptionId: "sub-pkg-cal", clientState: STATE_PKG }]));
    expect(s.sent).toHaveLength(0);
  });

  it("an unknown lifecycle event name with a valid clientState queues nothing", async () => {
    const s = setup();
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, lifecycleEvent: "somethingNew" }]));
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(0);
  });

  it("at most 25 distinct subscriptions are looked up per delivery", async () => {
    const s = setup();
    const items = Array.from({ length: MICROSOFT_MAX_SUBSCRIPTIONS + 10 }, (_, i) => ({ subscriptionId: `sub-x-${String(i)}`, clientState: STATE_PKG }));
    const res = await s.post(s.body(items));
    expect(res.status).toBe(202);
    expect(s.twin.calls.lookup).toBe(MICROSOFT_MAX_SUBSCRIPTIONS * 2); // two served lanes
  });
});

describe("replayed and later notifications (the dedupe key, documented)", () => {
  it("the same delivery twice inside the slot is one sync request; the second is a duplicate (202)", async () => {
    const s = setup();
    const body = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]);
    expect((await s.post(body)).status).toBe(202);
    expect((await s.post(body)).status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect(s.mem.calls.claim).toHaveLength(2);
  });

  it("a genuinely later change to the same mailbox (a later slot) queues another sync, even with identical bytes", async () => {
    const s = setup();
    const body = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]);
    await s.post(body);
    s.advance(CHANGE_SLOT_MS + 1);
    await s.post(body);
    expect(s.sent).toHaveLength(2);
    expect(new Set(s.sent.map((e) => (e.data as { eventId: string }).eventId)).size).toBe(2);
    expect(new Set(s.sent.map((e) => e.id)).size).toBe(2);
  });

  it("two different deliveries inside one slot: the second (a different body) is a conflict and is dropped; the first sync covers it", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, changeType: "created" }]));
    await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, changeType: "updated" }]));
    expect(s.sent).toHaveLength(1);
  });

  it("the key holds no content: it is derived from the lane, our stored subscription id and the slot", async () => {
    const s = setup();
    const a = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, resource: "Users/x/Messages/AAA" }]);
    const b = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, resource: "Users/x/Messages/BBB" }]);
    await s.post(a);
    await s.post(b);
    expect(s.sent).toHaveLength(1);
  });
});

describe("lifecycle notifications (T-264)", () => {
  it("reauthorizationRequired: the row is marked, the connection's renewal job is queued, 202", async () => {
    const s = setup();
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, lifecycleEvent: "reauthorizationRequired" }]));
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ name: RENEW_EVENT_NAME, data: { laneId: "PKG", connectionId: s.a.conn.id } });
    expect(Object.keys(s.sent[0]?.data ?? {}).sort()).toEqual(["connectionId", "laneId"]);
    expect(s.twin.rows.find((r) => r.subscriptionId === "sub-pkg-mail")?.status).toBe("reauthorization_required");
    expect([...s.mem.rows.values()].map((r) => [r.eventType, r.status])).toEqual([["mail.reauthorizationRequired", "enqueued"]]);
  });

  it("subscriptionRemoved: the row is marked removed, the renewal job is queued (it creates a new subscription), 202; the receiver then treats the old id as unknown", async () => {
    const s = setup();
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-cal", clientState: STATE_PKG, lifecycleEvent: "subscriptionRemoved" }]));
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ name: RENEW_EVENT_NAME, data: { laneId: "PKG", connectionId: s.a.conn.id } });
    expect(s.twin.rows.find((r) => r.subscriptionId === "sub-pkg-cal")?.status).toBe("removed");
    await s.post(s.body([{ subscriptionId: "sub-pkg-cal", clientState: STATE_PKG }]));
    expect(s.sent).toHaveLength(1);
  });

  it("missed: a delta sync of that stream is queued through the same debounced path, 202", async () => {
    const s = setup();
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-cal", clientState: STATE_PKG, lifecycleEvent: "missed" }]));
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ name: WEBHOOK_EVENT_NAME, data: { laneId: "PKG", connectionId: s.a.conn.id, eventType: "calendar.missed", refs: [] } });
  });

  it("a lifecycle event with a wrong clientState changes nothing and queues nothing", async () => {
    const s = setup();
    for (const lifecycleEvent of ["reauthorizationRequired", "subscriptionRemoved", "missed"]) {
      expect((await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: "forged-forged-forged-forged-forged-forged", lifecycleEvent }]))).status).toBe(202);
    }
    expect(s.sent).toHaveLength(0);
    expect(s.twin.rows.every((r) => r.status === "active")).toBe(true);
    expect(s.twin.calls.mark).toBe(0);
  });

  it("a replayed lifecycle event is one renewal request; the handler itself never calls Graph", async () => {
    const s = setup();
    const body = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, lifecycleEvent: "reauthorizationRequired" }]);
    await s.post(body);
    await s.post(body);
    expect(s.sent).toHaveLength(1);
    expect(graph.requests).toHaveLength(0);
  });
});

describe("the request is read strictly", () => {
  it("jobs unavailable (a Preview) answers 503 and claims nothing, but the validation handshake still works", async () => {
    const s = setup({ jobs: false });
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]));
    expect(res.status).toBe(503);
    expect(s.mem.calls.claim).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
  });

  it("not JSON, not an object, no value list, an empty list, more than 200 items: 400; the wrong content type: 415; too large: 413", async () => {
    const s = setup();
    for (const body of ["not json", "[]", "5", JSON.stringify({}), JSON.stringify({ value: "x" }), JSON.stringify({ value: [] }), JSON.stringify({ value: Array.from({ length: MICROSOFT_MAX_ITEMS + 1 }, () => ({})) })]) {
      expect((await s.post(body)).status, body.slice(0, 30)).toBe(400);
    }
    expect((await s.post("{}", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await s.post("{}", { headers: {} })).status).toBe(415);
    const huge = JSON.stringify({ value: [{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG, pad: "x".repeat(MICROSOFT_MAX_BODY_BYTES) }] });
    expect((await s.post(huge)).status).toBe(413);
    expect((await s.post(JSON.stringify({ value: [{ subscriptionId: "sub-pkg-mail" }] }), { headers: { "content-type": "application/json", "content-length": String(MICROSOFT_MAX_BODY_BYTES + 1) } })).status).toBe(413);
    expect(s.sent).toHaveLength(0);
  });

  it("exactly 200 items are read", async () => {
    const s = setup();
    const res = await s.post(JSON.stringify({ value: Array.from({ length: MICROSOFT_MAX_ITEMS }, () => ({ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG })) }));
    expect(res.status).toBe(202);
    expect(s.sent).toHaveLength(1);
  });

  it("a queue failure after the clientState check answers 503, marks the receipt failed, and Graph's retry is processed", async () => {
    const s = setup();
    s.failures.enqueue = 1;
    const body = s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]);
    expect((await s.post(body)).status).toBe(503);
    expect([...s.mem.rows.values()].map((r) => r.status)).toEqual(["failed"]);
    expect((await s.post(body)).status).toBe(202);
    expect(s.sent).toHaveLength(1);
    expect([...s.mem.rows.values()].map((r) => r.status)).toEqual(["enqueued"]);
  });

  it("a subscription store that is down answers 503 (retry), with no detail", async () => {
    const s = setup();
    s.twin.failNext(new Error("db down: secret detail"));
    const res = await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }]));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret detail");
    expect(JSON.stringify(s.logs)).not.toContain("secret detail");
  });

  it("no secret reaches a log line: not the clientState, not the validation token", async () => {
    const s = setup();
    await s.post(s.body([{ subscriptionId: "sub-pkg-mail", clientState: STATE_PKG }, { subscriptionId: "sub-pkg-cal", clientState: "nope-nope-nope-nope-nope-nope-nope" }]));
    await s.post("", { url: `${ENDPOINT}?validationToken=secret-token-123` });
    const all = JSON.stringify(s.logs);
    for (const secret of [STATE_PKG, STATE_APK, "secret-token-123", "nope-nope"]) expect(all).not.toContain(secret);
  });
});
