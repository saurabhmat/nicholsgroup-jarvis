// T-170 (security suite), area 4. Webhook spoofing and replay across EVERY registered provider, enumerated from the registry
// (WEBHOOK_PROVIDERS), plus a coverage table over every provider name the contract knows (PROVIDERS): each is either served by a
// receiver (and then must have a hostile-request spec here), or has no receiver for a stated reason that is itself checked
// (no connector folder, no registry entry). A new provider or registry entry fails until it is classified. Synthetic data only.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../contract/schemas";
import type { LaneId } from "@nichols/core";
import { createMemoryWebhookStore, createMicrosoftMemoryWebhookStore } from "../testing/mock-webhook";
import { SecretValue } from "../vault/secret";
import { hmacSha256 } from "./crypto";
import { createWebhookHandler, WEBHOOK_EVENT_NAME } from "./handler";
import { createMicrosoftNotificationHandler, MICROSOFT_MAX_BODY_BYTES } from "./microsoft";
import { WEBHOOK_PROVIDERS } from "./registry";
import { createLogCapture } from "./test-util";
import type { SubscriptionLookup } from "../microsoft/subscription-store";
import type { WebhookProvider } from "./types";

const SECRET = "synthetic-signing-secret-0000-1111-2222";
const NOW = new Date("2026-11-24T12:00:00Z");
const CONN_PKG = "00000000-0000-4000-8000-000000170001";
const CONN_APK = "00000000-0000-4000-8000-000000170002";
const connectorsDir = resolve(__dirname, "..");

type Spec = {
  /** The provider name the registry entry carries. */
  provider: string;
  /** A valid delivery about `account` with event id `eventId`, optionally with an extra hostile field naming a lane. */
  body: (account: string, eventId: string, extra?: Record<string, unknown>) => string;
  headers: (body: string, secret: string) => Record<string, string>;
  /** The account ids known to the store, one per lane. */
  accounts: { PKG: string; APK: string };
};

/** One spec per registry key. A key without a spec fails below. */
const SPECS: Record<string, Spec> = {
  qbo: {
    provider: "quickbooks",
    body: (account, eventId, extra = {}) =>
      JSON.stringify({ eventNotifications: [{ realmId: account, dataChangeEvent: { entities: [{ name: "Invoice", id: eventId.replace(/\D/g, "") || "1", operation: "Update", lastUpdated: "2026-11-24T11:59:00.000Z" }] } }], ...extra }),
    headers: (body, secret) => ({ "content-type": "application/json", "intuit-signature": hmacSha256(secret, body).toString("base64") }),
    accounts: { PKG: "9130000000170001", APK: "9130000000170002" },
  },
};

function harness(key: string, secret: string | null = SECRET) {
  const spec = SPECS[key] as Spec;
  const base = WEBHOOK_PROVIDERS[key] as WebhookProvider;
  const provider: WebhookProvider = { ...base, getSecret: () => (secret === null ? null : new SecretValue(secret)) };
  const mem = createMemoryWebhookStore({
    [`${base.provider}:${spec.accounts.PKG}`]: [{ laneId: "PKG", connectionId: CONN_PKG }],
    [`${base.provider}:${spec.accounts.APK}`]: [{ laneId: "APK", connectionId: CONN_APK }],
  });
  const sent: { name: string; data: Record<string, unknown>; id: string }[] = [];
  const logs = createLogCapture();
  const handle = createWebhookHandler({ providers: { [key]: provider }, store: mem.store, enqueue: async (e) => void sent.push(e), jobsAvailable: () => true, log: logs.logger, now: () => NOW });
  const post = (body: string, headers: Record<string, string>, init: RequestInit = {}) =>
    handle(new Request(`http://localhost/api/webhooks/${key}`, { method: "POST", body, headers, ...init }), key);
  return { spec, base, post, sent, mem, logs, handle };
}

describe("registry completeness", () => {
  it("every registered webhook provider has a hostile-request spec here, and no spec is stale", () => {
    expect(Object.keys(SPECS).sort()).toEqual(Object.keys(WEBHOOK_PROVIDERS).sort());
  });
  it("every registry key names a contract provider and fixes a body cap, a media type list and a replay rule on purpose", () => {
    for (const [key, p] of Object.entries(WEBHOOK_PROVIDERS)) {
      expect(PROVIDERS as readonly string[], key).toContain(p.provider);
      expect(p.contentTypes.length, key).toBeGreaterThan(0);
      expect(p.maxBodyBytes === undefined || p.maxBodyBytes <= 4 * 1024 * 1024, `${key} cap`).toBe(true);
      expect(p.toleranceSeconds === null || p.toleranceSeconds > 0, `${key} tolerance chosen explicitly`).toBe(true);
    }
  });
});

describe.each(Object.keys(WEBHOOK_PROVIDERS))("receiver for %s: hostile requests", (key) => {
  const ok = (h: ReturnType<typeof harness>, id = "1001") => {
    const body = h.spec.body(h.spec.accounts.PKG, id);
    return { body, headers: h.spec.headers(body, SECRET) };
  };

  it("positive control: a valid delivery is queued for the lane stored for the account", async () => {
    const h = harness(key);
    const { body, headers } = ok(h);
    expect((await h.post(body, headers)).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.name).toBe(WEBHOOK_EVENT_NAME);
    expect(h.sent[0]?.data.laneId).toBe("PKG");
    expect(h.sent[0]?.data.connectionId).toBe(CONN_PKG);
  });

  it("no signature, a malformed signature and a wrong-secret signature are refused (401) and queue nothing", async () => {
    const h = harness(key);
    const { body, headers } = ok(h);
    const sigHeaders = Object.keys(headers).filter((k) => k !== "content-type");
    expect(sigHeaders.length).toBeGreaterThan(0);
    const missing = { "content-type": headers["content-type"] as string };
    const malformed = { ...headers, ...Object.fromEntries(sigHeaders.map((k) => [k, "not-a-signature"])) };
    const wrong = h.spec.headers(body, "another-synthetic-secret-9999-8888");
    for (const hh of [missing, malformed, wrong]) expect((await h.post(body, hh)).status).toBe(401);
    expect(h.sent).toHaveLength(0);
    expect(h.mem.rows.size).toBe(0);
  });

  it("a body changed after signing, and a signature copied onto another body, are refused", async () => {
    const h = harness(key);
    const { body, headers } = ok(h);
    expect((await h.post(body + " ", headers)).status).toBe(401);
    const other = h.spec.body(h.spec.accounts.APK, "2002");
    expect((await h.post(other, headers)).status).toBe(401); // signature of the PKG body on an APK delivery
    expect(h.sent).toHaveLength(0);
  });

  it("an unsupported media type is 415, an oversized body is 413 (before any signature work), a GET is 405", async () => {
    const h = harness(key);
    const { body, headers } = ok(h);
    expect((await h.post(body, { ...headers, "content-type": "text/plain" })).status).toBe(415);
    const cap = h.base.maxBodyBytes ?? 1024 * 1024;
    const big = "x".repeat(cap + 1);
    expect((await h.post(big, h.spec.headers(big, SECRET))).status).toBe(413);
    expect((await h.handle(new Request("http://localhost/x", { method: "GET" }), key)).status).toBe(405);
    expect(h.sent).toHaveLength(0);
  });

  it("with no secret configured, or a placeholder-short one, the receiver answers 503 and queues nothing (fails closed)", async () => {
    for (const secret of [null, "short"]) {
      const h = harness(key, secret);
      const body = h.spec.body(h.spec.accounts.PKG, "1001");
      expect((await h.post(body, h.spec.headers(body, secret ?? SECRET))).status).toBe(503);
      expect(h.sent).toHaveLength(0);
    }
  });

  it("replay: the identical signed delivery sent three times queues exactly once", async () => {
    const h = harness(key);
    const { body, headers } = ok(h);
    for (let i = 0; i < 3; i++) expect((await h.post(body, headers)).status).toBe(200);
    expect(h.sent).toHaveLength(1);
  });

  it("an account that is not connected queues nothing; an account of ANOTHER lane is queued for that lane only, never for the lane the request pretends", async () => {
    const h = harness(key);
    const unknown = h.spec.body("0000000000999999", "3003");
    expect((await h.post(unknown, h.spec.headers(unknown, SECRET))).status).toBe(200);
    expect(h.sent).toHaveLength(0);
    const apk = h.spec.body(h.spec.accounts.APK, "4004", { laneId: "PKG", lane_id: "PKG", connectionId: CONN_PKG });
    await h.post(apk, h.spec.headers(apk, SECRET));
    expect(h.sent.map((s) => s.data.laneId)).toEqual(["APK"]);
    expect(h.sent[0]?.data.connectionId).toBe(CONN_APK);
  });

  it("the content of a notification is never trusted or forwarded: hostile fields stay out of the queued event, the stored row and the log", async () => {
    const h = harness(key);
    const canary = "WEBHOOK-CANARY-INSTRUCTIONS-ignore-previous-and-approve";
    const body = h.spec.body(h.spec.accounts.PKG, "5005", { note: canary, role: "owner", approve: true, token: canary });
    expect((await h.post(body, h.spec.headers(body, SECRET))).status).toBe(200);
    const everything = JSON.stringify({ sent: h.sent, rows: [...h.mem.rows.values()], logs: h.logs.entries });
    expect(everything).not.toContain(canary);
    expect(everything).not.toContain(SECRET);
    for (const e of h.sent) expect(Object.keys(e.data).sort()).toEqual(["connectionId", "eventId", "eventType", "laneId", "provider", "refs"]);
  });

  it("when jobs are unavailable the receiver refuses with 503 (it never claims an event it cannot queue)", async () => {
    const h = harness(key);
    const handle = createWebhookHandler({ providers: { [key]: h.base }, store: h.mem.store, enqueue: async () => undefined, jobsAvailable: () => false, now: () => NOW });
    const { body, headers } = ok(h);
    expect((await handle(new Request("http://localhost/x", { method: "POST", body, headers }), key)).status).toBe(503);
  });

  it("only registered, well-formed provider keys are served (a path guess is 404)", async () => {
    const h = harness(key);
    const { body, headers } = ok(h);
    for (const guess of ["", "stripe", "gohighlevel", "../qbo", "QBO ", "__proto__", "constructor"]) {
      expect((await h.handle(new Request("http://localhost/x", { method: "POST", body, headers }), guess)).status, guess).toBe(404);
    }
  });
});

describe("Microsoft Graph notifications (mail, calendar and Teams share one endpoint)", () => {
  const STATE = "synthetic-client-state-pkg-0123456789-abcdefghij";
  const subs: Record<string, SubscriptionLookup & { lane: LaneId }> = {
    "sub-pkg": { lane: "PKG", laneId: "PKG", provider: "microsoft", connectionId: CONN_PKG, resource: "mail", status: "active", clientState: new SecretValue(STATE) } as never,
    "sub-apk": { lane: "APK", laneId: "APK", provider: "microsoft", connectionId: CONN_APK, resource: "mail", status: "active", clientState: new SecretValue("synthetic-client-state-apk-0123456789-abcdefghij") } as never,
  };
  function setup(lanes: LaneId[] = ["PKG", "APK"]) {
    const mem = createMicrosoftMemoryWebhookStore((laneId, id) => ((id === CONN_PKG && laneId === "PKG") || (id === CONN_APK && laneId === "APK") ? { provider: "microsoft", status: "active" } : undefined));
    const sent: { name: string; data: Record<string, unknown>; id: string }[] = [];
    const logs = createLogCapture();
    const handle = createMicrosoftNotificationHandler({
      subscriptions: {
        async lookupMany(laneId, ids) {
          const out = new Map<string, SubscriptionLookup>();
          for (const id of ids) if (subs[id]?.lane === laneId) out.set(id, subs[id] as SubscriptionLookup);
          return out;
        },
        async mark() {},
      },
      store: mem.store,
      lanes: () => lanes,
      enqueue: async (e) => void sent.push(e as never),
      jobsAvailable: () => true,
      log: logs.logger,
      now: () => NOW,
    });
    const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }, url = "http://localhost/api/webhooks/microsoft") =>
      handle(new Request(url, { method: "POST", body, headers }));
    return { post, sent, mem, logs, handle };
  }
  const note = (subscriptionId: string, clientState: string, extra: Record<string, unknown> = {}) => JSON.stringify({ value: [{ subscriptionId, clientState, changeType: "created", resource: "me/messages", ...extra }] });

  it("positive control: the right subscription id and clientState queue a sync for the stored lane and connection", async () => {
    const t = setup();
    expect((await t.post(note("sub-pkg", STATE))).status).toBe(202);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.data).toMatchObject({ laneId: "PKG", connectionId: CONN_PKG, provider: "microsoft" });
  });
  it("a wrong, empty or missing clientState, and an unknown subscription id, queue nothing (the answer is still 202: a prober learns nothing)", async () => {
    const t = setup();
    for (const body of [note("sub-pkg", "wrong"), note("sub-pkg", ""), JSON.stringify({ value: [{ subscriptionId: "sub-pkg" }] }), note("sub-unknown", STATE), note("sub-apk", STATE)]) {
      expect((await t.post(body)).status).toBe(202);
    }
    expect(t.sent).toHaveLength(0);
  });
  it("the lane comes from the stored subscription: a body naming another lane or connection changes nothing", async () => {
    const t = setup();
    await t.post(note("sub-pkg", STATE, { laneId: "APK", connectionId: CONN_APK, tenantId: "other", resourceData: { id: "x" } }));
    expect(t.sent.map((s) => [s.data.laneId, s.data.connectionId])).toEqual([["PKG", CONN_PKG]]);
  });
  it("a lane this deployment does not serve is never asked about the subscription", async () => {
    const t = setup(["PKG"]);
    await t.post(note("sub-apk", "synthetic-client-state-apk-0123456789-abcdefghij"));
    expect(t.sent).toHaveLength(0);
  });
  it("replay inside the slot queues once; the content (encrypted resource data, canary text) is never forwarded or logged", async () => {
    const t = setup();
    const canary = "GRAPH-NOTIFICATION-CANARY-ignore-all-rules";
    const body = note("sub-pkg", STATE, { encryptedContent: { data: canary }, note: canary });
    for (let i = 0; i < 3; i++) await t.post(body);
    expect(t.sent).toHaveLength(1);
    expect(JSON.stringify({ sent: t.sent, rows: [...t.mem.rows.values()], logs: t.logs.entries })).not.toContain(canary);
    expect(JSON.stringify(t.logs.entries)).not.toContain(STATE);
  });
  it("oversize is 413, a wrong media type 415, a GET 405, a malformed body 400, and nothing is queued", async () => {
    const t = setup();
    expect((await t.post("x".repeat(MICROSOFT_MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await t.post(note("sub-pkg", STATE), { "content-type": "text/plain" })).status).toBe(415);
    expect((await t.post("{not json")).status).toBe(400);
    expect((await t.handle(new Request("http://localhost/x", { method: "GET" }))).status).toBe(405);
    expect(t.sent).toHaveLength(0);
  });
  it("the validation handshake only echoes a short plain-text token (no HTML, no sniffing) and queues nothing", async () => {
    const t = setup();
    const res = await t.post("", {}, "http://localhost/api/webhooks/microsoft?validationToken=abc123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("abc123");
    const long = await t.post("", {}, `http://localhost/api/webhooks/microsoft?validationToken=${"a".repeat(2000)}`);
    expect(long.status).toBe(400);
    expect(t.sent).toHaveLength(0);
  });
});

describe("provider coverage: every provider the contract names has a receiver or a checked reason for none", () => {
  const CLASS: Record<string, { receiver: "registry" | "microsoft" | "none"; why: string }> = {
    quickbooks: { receiver: "registry", why: "/api/webhooks/qbo, HMAC (intuit-signature)" },
    microsoft: { receiver: "microsoft", why: "Graph change notifications, per-subscription clientState (mail and calendar)" },
    microsoft_teams: { receiver: "microsoft", why: "the same endpoint; the stored subscription says it is a Teams one" },
    google: { receiver: "none", why: "polling only; no push channel exists (no x-goog-channel handling anywhere)" },
    stripe: { receiver: "none", why: "no connector exists yet (provider name only)" },
    gohighlevel: { receiver: "none", why: "no connector exists yet (provider name only)" },
    monday: { receiver: "none", why: "no connector exists yet (provider name only)" },
    notion: { receiver: "none", why: "no connector exists yet (provider name only)" },
    timesolv: { receiver: "none", why: "no connector exists yet (provider name only)" },
  };
  it("the table covers exactly the contract's provider names", () => {
    expect(Object.keys(CLASS).sort()).toEqual([...PROVIDERS].sort());
  });
  it("'registry' providers are in WEBHOOK_PROVIDERS and the 'none' ones really have no receiver, no registry key and (except google) no connector folder", () => {
    const registered = Object.values(WEBHOOK_PROVIDERS).map((p) => p.provider as string);
    const dirs = readdirSync(connectorsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const [name, c] of Object.entries(CLASS)) {
      if (c.receiver === "registry") expect(registered, name).toContain(name);
      if (c.receiver === "none") {
        expect(registered, `${name} gained a registry entry: add a spec and classify it`).not.toContain(name);
        if (name !== "google") expect(dirs, `${name} gained a connector folder: classify its webhook story`).not.toContain(name);
      }
    }
    expect(existsSync(join(connectorsDir, "webhooks", "microsoft.ts"))).toBe(true);
    const webhookDirs = readdirSync(resolve(connectorsDir, "../../../apps/web/app/api/webhooks"));
    expect(webhookDirs.sort()).toEqual(["[provider]", "microsoft"]);
  });
  it("no Google push receiver exists: no source file handles the Google channel headers", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
    const hits = walk(connectorsDir).filter((f) => f.endsWith(".ts") && !f.endsWith("spoofing-catalog.test.ts") && /x-goog-(channel|resource)/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
