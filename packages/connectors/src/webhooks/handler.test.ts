// The webhook receiver pipeline (T-036), end to end against the mock provider and an in-memory store.
import { describe, expect, it, vi } from "vitest";
import { createLogCapture } from "./test-util";
import { createWebhookHandler, MIN_SECRET_LENGTH, WEBHOOK_EVENT_NAME, type WebhookDeps } from "./handler";
import { MOCK_WEBHOOK_SECRET, createMemoryWebhookStore, createMockWebhookProvider, mockBody, signMock, type MockProviderOptions } from "../testing/mock-webhook";

const CONN_PKG = "00000000-0000-4000-8000-0000000003a1";
const CONN_APK = "00000000-0000-4000-8000-0000000003a2";
const NOW = new Date("2026-11-04T15:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

function setup(opts: { provider?: MockProviderOptions; jobs?: boolean; enqueueFails?: number; accounts?: Parameters<typeof createMemoryWebhookStore>[0]; faults?: Parameters<typeof createMemoryWebhookStore>[1] } = {}) {
  const mem = createMemoryWebhookStore(
    opts.accounts ?? { "monday:acct-1": [{ laneId: "PKG", connectionId: CONN_PKG }], "monday:acct-2": [{ laneId: "APK", connectionId: CONN_APK }] },
    opts.faults,
  );
  const sent: { name: string; data: Record<string, unknown>; id: string }[] = [];
  let failures = opts.enqueueFails ?? 0;
  const logs = createLogCapture();
  const deps: WebhookDeps = {
    providers: { mock: createMockWebhookProvider(opts.provider) },
    store: mem.store,
    enqueue: async (e) => {
      if (failures > 0) { failures -= 1; throw new Error("inngest down"); }
      sent.push(e);
    },
    jobsAvailable: () => opts.jobs ?? true,
    log: logs.logger,
    now: () => NOW,
  };
  const handle = createWebhookHandler(deps);
  const post = (body: string, headers?: Record<string, string>, key = "mock", init: RequestInit = {}) =>
    handle(new Request("http://localhost/api/webhooks/mock", { method: "POST", body, headers: headers ?? signMock(body, { timestamp: nowSec }), ...init }), key);
  return { post, handle, sent, mem, logs };
}

const ev = (id: string, account = "acct-1") => ({ id, account, refs: [{ type: "Item", id: `obj-${id}` }] });

describe("accepted delivery", () => {
  it("verifies, resolves the lane from server data, enqueues ids only and answers 200", async () => {
    const { post, sent, mem } = setup();
    const res = await post(mockBody(ev("e1")));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(WEBHOOK_EVENT_NAME);
    expect(sent[0]?.data).toEqual({ laneId: "PKG", provider: "monday", connectionId: CONN_PKG, eventId: "e1", eventType: "item.changed", refs: [{ type: "Item", id: "obj-e1" }] });
    expect(sent[0]?.id).toMatch(/^wh:PKG:monday:[0-9a-f]{40}$/);
    expect([...mem.rows.values()].map((r) => r.status)).toEqual(["enqueued"]);
  });

  it("never forwards the body: the queued event and the row hold no payload", async () => {
    const { post, sent, mem } = setup();
    await post(JSON.stringify({ events: [{ ...ev("e1"), type: "t", secretNote: "CONTENT-CANARY", body: "CONTENT-CANARY" }] }), undefined);
    const body = JSON.stringify({ events: [{ ...ev("e9"), type: "t", note: "CONTENT-CANARY" }] });
    await post(body);
    expect(JSON.stringify(sent)).not.toContain("CONTENT-CANARY");
    expect(JSON.stringify([...mem.rows.values()])).not.toContain("CONTENT-CANARY");
  });

  it("handles several events in one delivery, each in its own lane", async () => {
    const { post, sent } = setup();
    const res = await post(mockBody(ev("a", "acct-1"), ev("b", "ACCT-2")));
    expect(res.status).toBe(200);
    expect(sent.map((s) => [s.data.laneId, s.data.eventId])).toEqual([["PKG", "a"], ["APK", "b"]]);
  });

  it("resolves a repeated account once per delivery", async () => {
    const { post, mem } = setup();
    await post(mockBody(ev("a"), ev("b"), ev("c", "ACCT-1")));
    expect(mem.calls.resolve).toHaveLength(1);
  });
});

describe("unsigned, forged and replayed requests", () => {
  const body = mockBody(ev("e1"));
  const expectRefused = async (r: Response, sent: unknown[], status = 401) => {
    expect(r.status).toBe(status);
    expect(sent).toHaveLength(0);
  };

  it("rejects an unsigned request", async () => {
    const { post, sent, mem } = setup();
    await expectRefused(await post(body, { "content-type": "application/json" }), sent);
    expect(mem.calls.claim).toHaveLength(0);
  });

  it("rejects a wrong signature, a signature by another secret and a tampered body", async () => {
    const { post, sent } = setup();
    await expectRefused(await post(body, { ...signMock(body, { timestamp: nowSec }), "x-mock-signature": `sha256=${"0".repeat(64)}` }), sent);
    await expectRefused(await post(body, signMock(body, { timestamp: nowSec, secret: "another-secret-another-secret" })), sent);
    await expectRefused(await post(mockBody(ev("e2")), signMock(body, { timestamp: nowSec })), sent);
  });

  it("rejects malformed signature and timestamp headers", async () => {
    const { post, sent } = setup();
    await expectRefused(await post(body, { ...signMock(body, { timestamp: nowSec }), "x-mock-signature": "nonsense" }), sent);
    await expectRefused(await post(body, { ...signMock(body, { timestamp: nowSec }), "x-mock-timestamp": "yesterday" }), sent);
    const noTs = signMock(body, { timestamp: nowSec });
    delete noTs["x-mock-timestamp"];
    await expectRefused(await post(body, noTs), sent);
  });

  it("rejects a correctly signed request outside the timestamp tolerance (replay), old and future", async () => {
    const { post, sent } = setup();
    await expectRefused(await post(body, signMock(body, { timestamp: nowSec - 301 })), sent);
    await expectRefused(await post(body, signMock(body, { timestamp: nowSec + 301 })), sent);
    expect((await post(body, signMock(body, { timestamp: nowSec - 299 }))).status).toBe(200);
  });

  it("requires a timestamp when the provider has a tolerance, even if the verifier reports none", async () => {
    const provider = createMockWebhookProvider();
    const noTs = { ...provider, verifier: { verify: () => ({ ok: true as const, signedAt: null }) } };
    const mem = createMemoryWebhookStore({ "monday:acct-1": [{ laneId: "PKG", connectionId: CONN_PKG }] });
    const sent: unknown[] = [];
    const handle = createWebhookHandler({ providers: { mock: noTs }, store: mem.store, enqueue: async (e) => void sent.push(e), jobsAvailable: () => true, now: () => NOW });
    const res = await handle(new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json" } }), "mock");
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("a verifier that throws is a refusal", async () => {
    const provider = { ...createMockWebhookProvider(), verifier: { verify: () => { throw new Error("boom"); } } };
    const mem = createMemoryWebhookStore({});
    const handle = createWebhookHandler({ providers: { mock: provider }, store: mem.store, enqueue: async () => {}, jobsAvailable: () => true, now: () => NOW });
    expect((await handle(new Request("http://x/", { method: "POST", body, headers: signMock(body) }), "mock")).status).toBe(401);
  });

  it("answers every refusal with the same body (no hint which check failed)", async () => {
    const { post } = setup();
    const bodies = new Set<string>();
    for (const headers of [{ "content-type": "application/json" }, signMock(body, { timestamp: nowSec - 999 }), signMock(body, { timestamp: nowSec, secret: "x".repeat(20) })]) {
      const res = await post(body, headers);
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("a replay inside the window is deduped: 200, nothing queued twice", async () => {
    const { post, sent, mem } = setup();
    const headers = signMock(body, { timestamp: nowSec });
    expect((await post(body, headers)).status).toBe(200);
    const again = await post(body, headers);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "ok" });
    expect(sent).toHaveLength(1);
    expect([...mem.rows.values()]).toHaveLength(1);
  });

  it("the same event id with a different body is not queued again", async () => {
    const { post, sent, logs } = setup();
    await post(mockBody(ev("e1")));
    await post(JSON.stringify({ events: [{ ...ev("e1"), type: "item.changed", extra: 1 }] }));
    expect(sent).toHaveLength(1);
    expect(logs.entries.some((e) => e.fields.outcome === "conflict")).toBe(true);
  });
});

describe("fail closed", () => {
  const body = mockBody(ev("e1"));

  it("answers 503 and queues nothing when the signing secret is not configured", async () => {
    for (const secret of [null, "", "short", " ".repeat(40), () => { throw new Error("INTUIT_WEBHOOK_VERIFIER_TOKEN missing"); }] as MockProviderOptions["secret"][]) {
      const { post, sent, mem, logs } = setup({ provider: { secret } });
      const res = await post(body);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "webhook_not_configured" });
      expect(sent).toHaveLength(0);
      expect(mem.calls.resolve).toHaveLength(0);
      expect(JSON.stringify(logs.entries)).not.toContain("INTUIT_WEBHOOK");
    }
    expect(MIN_SECRET_LENGTH).toBe(16);
  });

  it("an unconfigured secret does not let an unsigned request through", async () => {
    const { post, sent } = setup({ provider: { secret: null } });
    expect((await post(body, { "content-type": "application/json" })).status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it("answers 503 and accepts nothing when jobs are not available (Preview, no Inngest keys)", async () => {
    const { post, sent, mem } = setup({ jobs: false });
    const res = await post(body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "jobs_not_configured" });
    expect(sent).toHaveLength(0);
    expect(mem.rows.size).toBe(0);
  });
});

describe("request shape", () => {
  const body = mockBody(ev("e1"));

  it("accepts POST only", async () => {
    const { handle } = setup();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await handle(new Request("http://x/", { method }), "mock");
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("404s an unknown provider, including prototype names and odd keys", async () => {
    const { handle } = setup();
    for (const key of ["nope", "constructor", "__proto__", "toString", "Mock", "mock/../x", "", "a".repeat(40)]) {
      expect((await handle(new Request("http://x/", { method: "POST", body, headers: signMock(body) }), key)).status).toBe(404);
    }
  });

  it("checks the content type (parameters and case ignored)", async () => {
    const { post, sent } = setup();
    expect((await post(body, signMock(body, { timestamp: nowSec, contentType: "text/plain" }))).status).toBe(415);
    expect((await post(body, signMock(body, { timestamp: nowSec, contentType: "" }))).status).toBe(415);
    expect(sent).toHaveLength(0);
    expect((await post(body, signMock(body, { timestamp: nowSec, contentType: "Application/JSON; charset=utf-8" }))).status).toBe(200);
  });

  it("caps the body by Content-Length and while streaming", async () => {
    const { post, sent } = setup({ provider: { maxBodyBytes: 200 } });
    const big = mockBody(ev("e1"), ev("e2"), ev("e3"), ev("e4"), ev("e5"));
    expect(big.length).toBeGreaterThan(200);
    expect((await post(big, { ...signMock(big, { timestamp: nowSec }), "content-length": String(big.length) })).status).toBe(413);
    // No Content-Length (chunked): the stream is cut at the cap.
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await post("", signMock(big, { timestamp: nowSec }), "mock", { body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    // A lying Content-Length smaller than the real body is still caught by the stream cap.
    expect((await post(big, { ...signMock(big, { timestamp: nowSec }), "content-length": "10" })).status).toBeGreaterThanOrEqual(400);
    expect(sent).toHaveLength(0);
  });

  it("refuses a signed body that cannot be parsed or is oversized in events", async () => {
    const { post, sent } = setup();
    const bad = "not json";
    expect((await post(bad, signMock(bad, { timestamp: nowSec }))).status).toBe(400);
    const empty = mockBody();
    expect((await post(empty, signMock(empty, { timestamp: nowSec }))).status).toBe(200);
    const many = mockBody(...Array.from({ length: 201 }, (_, i) => ev(`e${i}`)));
    expect((await post(many, signMock(many, { timestamp: nowSec }))).status).toBe(400);
    const weird = mockBody({ id: "bad\u0000id", account: "acct-1" });
    expect((await post(weird, signMock(weird, { timestamp: nowSec }))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("lane resolution (rule 9, D-23)", () => {
  it("an unknown account gets the same 200 as success, queues nothing and records nothing", async () => {
    const { post, sent, mem } = setup();
    const ok = await post(mockBody(ev("e1")));
    const unknown = await post(mockBody(ev("e2", "nobody")));
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe(await ok.text());
    expect(sent).toHaveLength(1);
    expect(mem.rows.size).toBe(1);
  });

  it("an account claimed by two lanes is treated as unknown", async () => {
    const { post, sent } = setup({ accounts: { "monday:acct-1": [{ laneId: "PKG", connectionId: CONN_PKG }, { laneId: "APK", connectionId: CONN_APK }] } });
    expect((await post(mockBody(ev("e1")))).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("a lane named in the payload is ignored: the lane is the connection's", async () => {
    const { post, sent } = setup();
    const body = JSON.stringify({ events: [{ ...ev("e1"), type: "t", laneId: "APK", lane_id: "APK", connectionId: CONN_APK }] });
    await post(body);
    expect(sent[0]?.data.laneId).toBe("PKG");
    expect(sent[0]?.data.connectionId).toBe(CONN_PKG);
  });

  it("the same provider event id in two lanes is two events (no cross-lane collision)", async () => {
    const { post, sent, mem } = setup();
    await post(mockBody(ev("same", "acct-1"), ev("same", "acct-2")));
    expect(sent.map((s) => s.data.laneId)).toEqual(["PKG", "APK"]);
    expect(mem.rows.size).toBe(2);
  });

  it("a store outage answers 503 so the provider retries (never a silent drop)", async () => {
    for (const faults of [{ resolve: true }, { claim: true }]) {
      const { post, sent } = setup({ faults });
      expect((await post(mockBody(ev("e1")))).status).toBe(503);
      expect(sent).toHaveLength(0);
    }
  });
});

describe("enqueue", () => {
  it("a failed hand-off answers 503, marks the row failed, and the provider's retry queues it", async () => {
    const { post, sent, mem } = setup({ enqueueFails: 1 });
    const body = mockBody(ev("e1"));
    expect((await post(body)).status).toBe(503);
    expect([...mem.rows.values()][0]?.status).toBe("failed");
    expect(sent).toHaveLength(0);
    expect((await post(body, signMock(body, { timestamp: nowSec + 5 }))).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect([...mem.rows.values()][0]).toMatchObject({ status: "enqueued", attempts: 2 });
  });

  it("an event already queued before a failure in the same delivery is not queued again on retry", async () => {
    const { post, sent } = setup();
    // first event ok, second fails
    let n = 0;
    const mem = createMemoryWebhookStore({ "monday:acct-1": [{ laneId: "PKG", connectionId: CONN_PKG }] });
    const handle = createWebhookHandler({
      providers: { mock: createMockWebhookProvider() }, store: mem.store, jobsAvailable: () => true, now: () => NOW,
      enqueue: async (e) => { n += 1; if (n === 2) throw new Error("x"); sent.push(e); },
    });
    const body = mockBody(ev("a"), ev("b"));
    const send = () => handle(new Request("http://x/", { method: "POST", body, headers: signMock(body, { timestamp: nowSec }) }), "mock");
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(200);
    expect(sent.map((s) => s.data.eventId)).toEqual(["a", "b"]);
    void post;
  });

  it("the queued event has exactly the fields of the registered webhook/received schema (ids only)", async () => {
    const { post, sent } = setup();
    await post(mockBody(ev("e1")));
    expect(Object.keys(sent[0]?.data ?? {}).sort()).toEqual(["connectionId", "eventId", "eventType", "laneId", "provider", "refs"]);
  });
});

describe("logging", () => {
  it("logs provider, lane, event id, outcome and request id, and never the signature, secret or body", async () => {
    const { post, logs } = setup();
    const body = JSON.stringify({ events: [{ ...ev("e1"), type: "t", note: "BODY-CANARY" }] });
    const headers: Record<string, string> = { ...signMock(body, { timestamp: nowSec }), "x-vercel-id": "iad1::abc-123" };
    await post(body, headers);
    await post(body, { ...headers, "x-mock-signature": "sha256=" + "f".repeat(64) });
    const text = JSON.stringify(logs.entries);
    expect(text).not.toContain("BODY-CANARY");
    expect(text).not.toContain(MOCK_WEBHOOK_SECRET);
    expect(text).not.toContain(headers["x-mock-signature"] ?? "?");
    expect(text).not.toContain("f".repeat(64));
    const enq = logs.entries.find((e) => e.event === "webhook.enqueued");
    expect(enq).toMatchObject({ provider: "monday", lane_id: "PKG", fields: { event_id: "e1", outcome: "enqueued", request_id: "iad1::abc-123" } });
    expect(logs.entries.find((e) => e.fields.outcome === "signature")).toBeTruthy();
  });

  it("ignores a hostile request id header", async () => {
    const { post, logs } = setup();
    const body = mockBody(ev("e1"));
    await post(body, { ...signMock(body, { timestamp: nowSec }), "x-request-id": "evil id <script>" });
    expect(JSON.stringify(logs.entries)).not.toContain("evil");
  });
});

vi.setConfig({ testTimeout: 10_000 });
