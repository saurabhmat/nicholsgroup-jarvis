// Verifier building blocks (T-036): constant-time compare, tolerance, the generic HMAC verifier, body reading, store RPCs.
import { describe, expect, it } from "vitest";
import { SecretValue } from "../vault/secret";
import { hmacSha256, safeEqual, sha256Hex, withinTolerance } from "./crypto";
import { hmacSha256Verifier } from "./hmac";
import { mediaType, readRawBody } from "./body";
import { createWebhookStore, WebhookStoreError } from "./store";

const secret = new SecretValue("unit-test-secret-0123456789");
const body = new TextEncoder().encode('{"a":1}');
const now = new Date("2026-11-04T15:00:00Z");

describe("safeEqual", () => {
  it("compares strings and bytes, of any length, without throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(safeEqual("a", "")).toBe(false);
  });
});

describe("withinTolerance", () => {
  it("accepts both directions up to the limit and refuses beyond or invalid dates", () => {
    expect(withinTolerance(new Date(now.getTime() - 300_000), now, 300)).toBe(true);
    expect(withinTolerance(new Date(now.getTime() + 300_000), now, 300)).toBe(true);
    expect(withinTolerance(new Date(now.getTime() - 300_001), now, 300)).toBe(false);
    expect(withinTolerance(new Date(now.getTime() + 300_001), now, 300)).toBe(false);
    expect(withinTolerance(new Date("nope"), now, 300)).toBe(false);
  });
});

describe("hmacSha256Verifier", () => {
  const sig = (data: string | Uint8Array, enc: "hex" | "base64") => hmacSha256("unit-test-secret-0123456789", data).toString(enc);

  it("verifies a base64 signature over the body (Intuit-style, no timestamp)", () => {
    const v = hmacSha256Verifier({ signatureHeader: "intuit-signature", encoding: "base64" });
    const ok = v.verify({ body, headers: new Headers({ "Intuit-Signature": sig(body, "base64") }), secret, now });
    expect(ok).toEqual({ ok: true, signedAt: null });
    expect(v.verify({ body, headers: new Headers({ "intuit-signature": sig(body, "base64").toUpperCase() }), secret, now })).toMatchObject({ ok: false });
    expect(v.verify({ body, headers: new Headers(), secret, now })).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("verifies a hex signature over `<timestamp>.<body>` with a prefix", () => {
    const v = hmacSha256Verifier({ signatureHeader: "x-sig", encoding: "hex", prefix: "sha256=", timestampHeader: "x-ts" });
    const ts = "1793804400";
    const data = Buffer.concat([Buffer.from(`${ts}.`), body]);
    const headers = (over: Record<string, string> = {}) => new Headers({ "x-sig": `sha256=${sig(data, "hex")}`, "x-ts": ts, ...over });
    expect(v.verify({ body, headers: headers(), secret, now })).toEqual({ ok: true, signedAt: new Date(1793804400_000) });
    expect(v.verify({ body, headers: headers({ "x-sig": `sha256=${sig(data, "hex").toUpperCase()}` }), secret, now }).ok).toBe(true);
    expect(v.verify({ body, headers: headers({ "x-ts": "1793804401" }), secret, now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(v.verify({ body, headers: headers({ "x-sig": sig(data, "hex") }), secret, now })).toEqual({ ok: false, reason: "malformed_signature" });
    expect(v.verify({ body, headers: headers({ "x-ts": "soon" }), secret, now })).toEqual({ ok: false, reason: "malformed_signature" });
    const noTs = headers();
    noTs.delete("x-ts");
    expect(v.verify({ body, headers: noTs, secret, now })).toEqual({ ok: false, reason: "missing_timestamp" });
    expect(v.verify({ body: new TextEncoder().encode("{}"), headers: headers(), secret, now })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("a different secret never verifies", () => {
    const v = hmacSha256Verifier({ signatureHeader: "x-sig", encoding: "hex" });
    const headers = new Headers({ "x-sig": sig(body, "hex") });
    expect(v.verify({ body, headers, secret: new SecretValue("some-other-secret-9876543210"), now }).ok).toBe(false);
  });
});

describe("body helpers", () => {
  it("mediaType drops parameters and case", () => {
    expect(mediaType("Application/JSON; charset=utf-8")).toBe("application/json");
    expect(mediaType(null)).toBe("");
  });

  it("readRawBody returns the exact bytes, enforces the cap, and refuses a bad Content-Length", async () => {
    const req = (b: string, h: Record<string, string> = {}) => new Request("http://x/", { method: "POST", body: b, headers: h });
    const ok = await readRawBody(req("héllo"), 100);
    expect(ok.ok && new TextDecoder().decode(ok.bytes)).toBe("héllo");
    expect(await readRawBody(req("x".repeat(101)), 100)).toEqual({ ok: false, reason: "too_large" });
    expect(await readRawBody(req("x", { "content-length": "99999" }), 100)).toEqual({ ok: false, reason: "too_large" });
    expect(await readRawBody(req("x", { "content-length": "abc" }), 100)).toEqual({ ok: false, reason: "too_large" });
    expect(await readRawBody(new Request("http://x/", { method: "POST" }), 100)).toMatchObject({ ok: true });
    expect(sha256Hex("a")).toHaveLength(64);
  });
});

describe("createWebhookStore", () => {
  function fakeClient(responses: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { code: string } }>) {
    const calls: { lane: string; fn: string; args: Record<string, unknown> }[] = [];
    const clientFor = async (lane: string) => ({
      schema: (s: string) => (
        expect(s).toBe("core"),
        { rpc: async (fn: string, args: Record<string, unknown>) => (calls.push({ lane, fn, args }), { data: null, error: null, ...(responses[fn]?.(args) ?? {}) }) }
      ),
    });
    return { calls, clientFor: clientFor as never };
  }

  it("resolve asks every served lane with the lane in each call and reports found, unknown and ambiguous", async () => {
    const c1 = fakeClient({ webhook_resolve_connection: (a) => ({ data: a.p_lane === "PKG" ? "11111111-1111-4111-8111-111111111111" : null }) });
    const store = createWebhookStore(c1.clientFor, () => ["PKG", "APK", "PKG"]);
    expect(await store.resolve("quickbooks", "Realm-1")).toEqual({ kind: "found", laneId: "PKG", connectionId: "11111111-1111-4111-8111-111111111111" });
    expect(c1.calls.map((c) => [c.lane, c.args.p_lane, c.args.p_provider, c.args.p_account])).toEqual([["PKG", "PKG", "quickbooks", "Realm-1"], ["APK", "APK", "quickbooks", "Realm-1"]]);
    const none = createWebhookStore(fakeClient({ webhook_resolve_connection: () => ({ data: null }) }).clientFor, () => ["PKG"]);
    expect(await none.resolve("quickbooks", "x")).toEqual({ kind: "unknown" });
    const both = createWebhookStore(fakeClient({ webhook_resolve_connection: () => ({ data: "11111111-1111-4111-8111-111111111111" }) }).clientFor, () => ["PKG", "APK"]);
    expect(await both.resolve("quickbooks", "x")).toEqual({ kind: "ambiguous" });
  });

  it("claim and mark pass the lane and ids; unexpected answers and errors become a fixed WebhookStoreError", async () => {
    const c = fakeClient({ webhook_event_claim: () => ({ data: "process" }), webhook_event_mark: () => ({ data: true }), webhook_events_purge: () => ({ data: 3 }) });
    const store = createWebhookStore(c.clientFor, () => ["PKG"]);
    expect(await store.claim("PKG", "c1", "stripe", { id: "e", type: "t", payloadHash: "h" })).toBe("process");
    expect(await store.mark("PKG", "stripe", "e", "enqueued")).toBe(true);
    expect(await store.purge("PKG", 45)).toBe(3);
    expect(c.calls.map((x) => x.lane)).toEqual(["PKG", "PKG", "PKG"]);
    expect(c.calls[2]?.args).toEqual({ p_lane: "PKG", p_keep: "45 days" });
    const weird = createWebhookStore(fakeClient({ webhook_event_claim: () => ({ data: "maybe" }) }).clientFor, () => ["PKG"]);
    await expect(weird.claim("PKG", "c1", "stripe", { id: "e", type: "t", payloadHash: "h" })).rejects.toBeInstanceOf(WebhookStoreError);
    const failing = createWebhookStore(fakeClient({ webhook_event_claim: () => ({ error: { code: "42501" } }) }).clientFor, () => ["PKG"]);
    await expect(failing.claim("PKG", "c1", "stripe", { id: "e", type: "t", payloadHash: "h" })).rejects.toThrow("webhook store unavailable");
    const noLane = createWebhookStore((async () => { throw new Error("lane off: secret detail"); }) as never, () => ["PKG"]);
    await expect(noLane.mark("PKG", "stripe", "e", "failed")).rejects.toThrow("webhook store unavailable");
  });
});
