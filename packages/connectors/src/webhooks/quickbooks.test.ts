// QuickBooks webhook provider (T-053, QB-11) through the shared receiver: signature, fail-closed secret, lane from server
// data, dedupe and replays, unknown realms, entity allowlist, malformed and oversize bodies. Synthetic data only.
import { describe, expect, it } from "vitest";
import { createMemoryWebhookStore } from "../testing/mock-webhook";
import { SecretValue } from "../vault/secret";
import { hmacSha256 } from "./crypto";
import { createWebhookHandler, WEBHOOK_EVENT_NAME } from "./handler";
import { QBO_WEBHOOK_KEY, QBO_WEBHOOK_MAX_BODY_BYTES, createQuickbooksWebhookProvider, parseQuickbooksBody, quickbooksWebhookProvider } from "./quickbooks";
import { WEBHOOK_PROVIDERS } from "./registry";
import { createLogCapture } from "./test-util";

const TOKEN = "synthetic-verifier-token-0000-1111";
const CONN_PKG = "00000000-0000-4000-8000-0000000053a1";
const CONN_APK = "00000000-0000-4000-8000-0000000053a2";
const REALM_PKG = "9130000000000001";
const REALM_APK = "9130000000000002";
const sign = (body: string, token = TOKEN) => hmacSha256(token, body).toString("base64");
const headers = (body: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "intuit-signature": sign(body), ...extra });

const change = (name: string, id: string, operation = "Update", lastUpdated = "2026-11-06T10:00:00.000Z") => ({ name, id, operation, lastUpdated });
const legacy = (...notes: { realmId: string; entities: unknown[] }[]) =>
  JSON.stringify({ eventNotifications: notes.map((n) => ({ realmId: n.realmId, dataChangeEvent: { entities: n.entities } })) });

function setup(opts: { token?: string | null; accounts?: Parameters<typeof createMemoryWebhookStore>[0] } = {}) {
  const mem = createMemoryWebhookStore(
    opts.accounts ?? {
      [`quickbooks:${REALM_PKG}`]: [{ laneId: "PKG", connectionId: CONN_PKG }],
      [`quickbooks:${REALM_APK}`]: [{ laneId: "APK", connectionId: CONN_APK }],
    },
  );
  const sent: { name: string; data: Record<string, unknown>; id: string }[] = [];
  const logs = createLogCapture();
  const token = opts.token === undefined ? TOKEN : opts.token;
  const provider = createQuickbooksWebhookProvider(() => (token === null ? null : new SecretValue(token)));
  const handle = createWebhookHandler({
    providers: { [QBO_WEBHOOK_KEY]: provider },
    store: mem.store,
    enqueue: async (e) => void sent.push(e),
    jobsAvailable: () => true,
    log: logs.logger,
    now: () => new Date("2026-11-06T10:00:05Z"),
  });
  const post = (body: string, h: Record<string, string> = headers(body), init: RequestInit = {}) =>
    handle(new Request("http://localhost/api/webhooks/qbo", { method: "POST", body, headers: h, ...init }), QBO_WEBHOOK_KEY);
  return { post, sent, mem, logs };
}

describe("registration", () => {
  it("is registered under /api/webhooks/qbo with no timestamp tolerance chosen explicitly", () => {
    expect(WEBHOOK_PROVIDERS[QBO_WEBHOOK_KEY]).toBe(quickbooksWebhookProvider);
    expect(quickbooksWebhookProvider.provider).toBe("quickbooks");
    expect(quickbooksWebhookProvider.toleranceSeconds).toBeNull();
    expect(quickbooksWebhookProvider.maxBodyBytes).toBe(QBO_WEBHOOK_MAX_BODY_BYTES);
  });

  it("the default secret source fails closed when INTUIT_WEBHOOK_VERIFIER_TOKEN is unset", () => {
    const before = process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN;
    delete process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN;
    try {
      expect(quickbooksWebhookProvider.getSecret()).toBeNull();
      process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN = TOKEN;
      expect(quickbooksWebhookProvider.getSecret()?.reveal()).toBe(TOKEN);
    } finally {
      if (before === undefined) delete process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN;
      else process.env.INTUIT_WEBHOOK_VERIFIER_TOKEN = before;
    }
  });
});

describe("signature (QB-11)", () => {
  it("accepts a valid intuit-signature over the raw body and enqueues ids only, with the lane from server data", async () => {
    const { post, sent, mem } = setup();
    const body = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145")] });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(WEBHOOK_EVENT_NAME);
    expect(sent[0]?.data).toMatchObject({ laneId: "PKG", provider: "quickbooks", connectionId: CONN_PKG, eventType: "Invoice.update", refs: [{ type: "Invoice", id: "145" }] });
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    expect([...mem.rows.values()].map((r) => r.status)).toEqual(["enqueued"]);
  });

  it("verifies over the exact bytes: a re-serialised body does not verify", async () => {
    const { post, sent } = setup();
    const body = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145")] });
    const spaced = JSON.stringify(JSON.parse(body), null, 1);
    expect((await post(spaced, headers(body))).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("refuses a spoofed signature (wrong token, tampered body, missing, malformed) with one 401 and processes nothing", async () => {
    const { post, sent, mem, logs } = setup();
    const body = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145")] });
    const bad = [
      headers(body, { "intuit-signature": sign(body, "some-other-token-0000-1111-2222") }),
      headers(body, { "intuit-signature": sign(`${body} `) }),
      headers(body, { "intuit-signature": "not-base64!!" }),
      headers(body, { "intuit-signature": "" }),
      { "content-type": "application/json" },
    ];
    for (const h of bad) {
      const res = await post(body, h);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(sent).toHaveLength(0);
    expect(mem.rows.size).toBe(0);
    expect(mem.calls.resolve).toHaveLength(0);
    expect(JSON.stringify(logs.entries)).not.toContain(TOKEN);
  });

  it("fails closed when the verifier token is not configured: 503, even with a signature made from an empty or guessed key", async () => {
    for (const token of [null, "", "short"]) {
      const { post, sent, mem } = setup({ token });
      const body = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145")] });
      for (const key of [TOKEN, "", "short"]) {
        const res = await post(body, headers(body, { "intuit-signature": sign(body, key) }));
        expect(res.status).toBe(503);
      }
      expect(sent).toHaveLength(0);
      expect(mem.rows.size).toBe(0);
    }
  });

  it("never logs the token, the signature or the body", async () => {
    const { post, logs } = setup();
    const body = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145")] }, { realmId: "unknown-realm", entities: [change("Bill", "7")] });
    await post(body);
    await post(body, headers(body, { "intuit-signature": "AAAA" }));
    const text = JSON.stringify(logs.entries);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(sign(body));
    expect(text).not.toContain("eventNotifications");
  });
});

describe("lane resolution", () => {
  it("resolves each realm to its own lane and connection, ignoring any lane the payload claims", async () => {
    const { post, sent } = setup();
    const body = JSON.stringify({
      laneId: "APK",
      eventNotifications: [
        { realmId: REALM_PKG, laneId: "APK", connectionId: CONN_APK, dataChangeEvent: { entities: [change("Customer", "1")] } },
        { realmId: REALM_APK, dataChangeEvent: { entities: [change("Vendor", "2")] } },
      ],
    });
    expect((await post(body)).status).toBe(200);
    expect(sent.map((s) => [s.data.laneId, s.data.connectionId, s.data.refs])).toEqual([
      ["PKG", CONN_PKG, [{ type: "Customer", id: "1" }]],
      ["APK", CONN_APK, [{ type: "Vendor", id: "2" }]],
    ]);
  });

  it("drops unknown realms (answers 200 like success, logs counts and event ids only) and still processes known ones", async () => {
    const { post, sent, logs } = setup();
    const body = legacy({ realmId: "7770000000000009", entities: [change("Invoice", "1")] }, { realmId: REALM_PKG, entities: [change("Invoice", "2")] });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data.refs).toEqual([{ type: "Invoice", id: "2" }]);
    const skipped = logs.entries.filter((e) => e.event === "webhook.skipped");
    expect(skipped).toHaveLength(1);
    expect(JSON.stringify(logs.entries)).not.toContain("7770000000000009");
  });

  it("treats a realm claimed by two lanes as unknown", async () => {
    const { post, sent } = setup({ accounts: { [`quickbooks:${REALM_PKG}`]: [{ laneId: "PKG", connectionId: CONN_PKG }, { laneId: "APK", connectionId: CONN_APK }] } });
    expect((await post(legacy({ realmId: REALM_PKG, entities: [change("Invoice", "1")] }))).status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("a replayed or duplicate delivery enqueues nothing more", async () => {
    const { post, sent, mem } = setup();
    const body = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145"), change("Invoice", "145")] });
    expect((await post(body)).status).toBe(200);
    expect(sent).toHaveLength(1); // the same change twice in one delivery is one event
    expect((await post(body)).status).toBe(200); // Intuit retry
    expect((await post(body)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(mem.rows.size).toBe(1);
  });

  it("the same change inside a different delivery is still deduped; a new lastUpdated or operation is a new event", async () => {
    const { post, sent } = setup();
    await post(legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145")] }));
    await post(legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145"), change("Bill", "9")] }));
    expect(sent.map((s) => s.data.eventType)).toEqual(["Invoice.update", "Bill.update"]);
    await post(legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145", "Update", "2026-11-06T11:00:00.000Z")] }));
    await post(legacy({ realmId: REALM_PKG, entities: [change("Invoice", "145", "Delete")] }));
    expect(sent).toHaveLength(4);
  });

  it("the event id is a stable function of realm, entity, id, operation and last-updated time", () => {
    const ids = (entities: unknown[], realm = REALM_PKG) => {
      const r = parseQuickbooksBody(new TextEncoder().encode(legacy({ realmId: realm, entities })));
      return r.ok ? r.events.map((e) => e.eventId) : [];
    };
    const base = ids([change("Invoice", "1")]);
    expect(ids([change("Invoice", "1")])).toEqual(base);
    for (const other of [ids([change("Invoice", "1")], REALM_APK), ids([change("Bill", "1")]), ids([change("Invoice", "2")]), ids([change("Invoice", "1", "Create")]), ids([change("Invoice", "1", "Update", "2026-11-06T10:00:01.000Z")])]) {
      expect(other).not.toEqual(base);
    }
  });
});

describe("untrusted payload (rule 9)", () => {
  it("keeps only the T-051 entity set: Employee, TimeActivity and unknown names are dropped", async () => {
    const { post, sent } = setup();
    const body = legacy({
      realmId: REALM_PKG,
      entities: [change("Employee", "1"), change("TimeActivity", "2"), change("__proto__", "3"), change("invoice", "4"), change("Account", "5"), change("Invoice; drop", "6")],
    });
    expect((await post(body)).status).toBe(200);
    expect(sent.map((s) => s.data.refs)).toEqual([[{ type: "Invoice", id: "4" }], [{ type: "Account", id: "5" }]]);
  });

  it("drops entries with bad ids, realm ids or non-object entries without failing the delivery", async () => {
    const { post, sent } = setup();
    const body = legacy(
      { realmId: REALM_PKG, entities: ["x", 5, null, { name: "Invoice" }, change("Invoice", "a b"), change("Invoice", "x".repeat(65)), change("Invoice", "ok-1")] },
      { realmId: "bad realm!", entities: [change("Invoice", "9")] },
    );
    expect((await post(body)).status).toBe(200);
    expect(sent.map((s) => s.data.refs)).toEqual([[{ type: "Invoice", id: "ok-1" }]]);
  });

  it("carries no payload content into the queue or the claim rows", async () => {
    const { post, sent, mem } = setup();
    const body = JSON.stringify({
      eventNotifications: [{ realmId: REALM_PKG, note: "CONTENT-CANARY", dataChangeEvent: { entities: [{ ...change("Invoice", "1"), memo: "CONTENT-CANARY" }] } }],
    });
    await post(body);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("CONTENT-CANARY");
    expect(JSON.stringify([...mem.rows.values()])).not.toContain("CONTENT-CANARY");
  });

  it("a very large delivery is grouped per realm, entity and operation so it fits the receiver's caps", async () => {
    const { post, sent } = setup();
    const many = Array.from({ length: 450 }, (_, i) => change(i % 2 ? "Invoice" : "Bill", String(1000 + i), "Update", `2026-11-06T10:${String(i % 60).padStart(2, "0")}:00Z`));
    expect((await post(legacy({ realmId: REALM_PKG, entities: many }))).status).toBe(200);
    expect(sent.map((s) => s.data.eventType).sort()).toEqual(["Bill.update", "Invoice.update"]);
    expect((sent[0]?.data.refs as unknown[]).length).toBe(100);
  });
});

describe("malformed and oversize bodies", () => {
  it("answers 400 for non-JSON, wrong shapes and invalid UTF-8 (after a valid signature), 413 over the cap, 415 for other media types", async () => {
    const { post, sent } = setup();
    for (const body of ["", "not json", "null", "42", "{}", '{"eventNotifications":"x"}', JSON.stringify({ eventNotifications: Array.from({ length: 51 }, () => ({ realmId: REALM_PKG })) })]) {
      expect((await post(body)).status, body).toBe(400);
    }
    // Invalid UTF-8 (signed over the raw bytes): refused, not decoded leniently.
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(parseQuickbooksBody(raw)).toEqual({ ok: false });
    const big = legacy({ realmId: REALM_PKG, entities: [change("Invoice", "1")] }).padEnd(QBO_WEBHOOK_MAX_BODY_BYTES + 10, " ");
    expect((await post(big)).status).toBe(413);
    const lengthLie = await post("{}", { ...headers("{}"), "content-length": String(QBO_WEBHOOK_MAX_BODY_BYTES + 1) });
    expect(lengthLie.status).toBe(413);
    expect((await post("{}", { ...headers("{}"), "content-type": "text/plain" })).status).toBe(415);
    expect(sent).toHaveLength(0);
  });

  it("answers 200 with nothing queued for a valid delivery with no relevant entities", async () => {
    const { post, sent, mem } = setup();
    const res = await post(legacy({ realmId: REALM_PKG, entities: [change("Employee", "1")] }));
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(mem.rows.size).toBe(0);
  });
});

describe("CloudEvents shape (unverified against the sandbox)", () => {
  const ce = (type: string, id: string, realm = REALM_PKG, time = "2026-11-06T10:00:00Z") => ({
    specversion: "1.0", id: `ce-${id}`, source: "intuit.test", type, intuitentityid: id, intuitaccountid: realm, time,
  });

  it("reads an array of CloudEvents, mapping qbo.<entity>.<op>.v1 to the allowlisted entity", async () => {
    const { post, sent } = setup();
    const body = JSON.stringify([ce("qbo.invoice.created.v1", "1"), ce("qbo.billpayment.updated.v1", "2"), ce("qbo.employee.created.v1", "3"), ce("something.else", "4"), "junk"]);
    expect((await post(body, headers(body, { "content-type": "application/cloudevents-batch+json" }))).status).toBe(200);
    expect(sent.map((s) => [s.data.eventType, s.data.refs])).toEqual([
      ["Invoice.create", [{ type: "Invoice", id: "1" }]],
      ["BillPayment.update", [{ type: "BillPayment", id: "2" }]],
    ]);
  });

  it("a CloudEvent without a usable time is keyed on its delivery: a later update to the same record is a new event, an identical retry is not", async () => {
    const { post, sent } = setup();
    const first = JSON.stringify([ce("qbo.invoice.updated.v1", "1", REALM_PKG, "")]);
    const second = JSON.stringify([ce("qbo.invoice.updated.v1", "1", REALM_PKG, "not a time"), ce("qbo.bill.updated.v1", "2")]);
    await post(first);
    await post(first);
    await post(second);
    expect(sent.map((s) => s.data.eventType)).toEqual(["Invoice.update", "Invoice.update", "Bill.update"]);
  });

  it("reads a single CloudEvent object", () => {
    const r = parseQuickbooksBody(new TextEncoder().encode(JSON.stringify(ce("qbo.customer.deleted.v1", "8"))));
    expect(r.ok && r.events.map((e) => e.eventType)).toEqual(["Customer.delete"]);
  });
});
