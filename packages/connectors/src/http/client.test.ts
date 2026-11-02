import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import type { LogEntry } from "../log/index";
import { createConnectorLogger } from "../log/index";
import { delay, http, HttpResponse, stripe, useMockServer } from "../testing/msw/index";
import { forgetSecretsForTests, SecretValue } from "../vault/secret";
import { basicCredentials, createHttpClient, parseRetryAfter, type HttpClientOptions } from "./client";
import { RateLimiter } from "./rate-limit";

const BASE = "https://api.example.test";
const server = useMockServer();

/** A client with a recorded, instant sleep and a captured log. */
function client(extra: Partial<HttpClientOptions> = {}) {
  const waits: number[] = [];
  const logs: LogEntry[] = [];
  const c = createHttpClient({
    provider: "testprov",
    baseUrl: BASE,
    laneId: "PKG",
    requestIdHeader: "x-request-id",
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5,
    logger: createConnectorLogger({ sink: (e) => logs.push(e) }),
    ...extra,
  });
  return { c, waits, logs };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    return (e as ConnectorError).info;
  }
  throw new Error("expected a rejection");
};

afterEach(() => {
  forgetSecretsForTests();
  RateLimiter.resetForTests();
});

describe("requests", () => {
  it("fills path parameters (encoded), adds the query, sends the bearer token and parses JSON", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    server.use(
      http.get(`${BASE}/v3/company/:realm/query`, ({ request }) => {
        seen = { url: request.url, auth: request.headers.get("authorization") };
        return HttpResponse.json({ QueryResponse: { Invoice: [] } }, { headers: { "x-request-id": "tid-1" } });
      }),
    );
    const { c } = client();
    const res = await c.request<{ QueryResponse: unknown }>({
      method: "GET",
      path: "/v3/company/{realm}/query",
      params: { realm: "realm/1" },
      query: { query: "select * from Invoice", minorversion: 75, skip: undefined },
      auth: { scheme: "Bearer", secret: new SecretValue("synthetic-access-1") },
    });
    expect(res.data).toEqual({ QueryResponse: { Invoice: [] } });
    expect(res.providerTid).toBe("tid-1");
    expect(seen?.url).toBe(`${BASE}/v3/company/realm%2F1/query?query=select+*+from+Invoice&minorversion=75`);
    expect(seen?.auth).toBe("Bearer synthetic-access-1");
  });

  it("sends JSON and form bodies", async () => {
    const bodies: [string | null, string][] = [];
    server.use(
      http.post(`${BASE}/token`, async ({ request }) => {
        bodies.push([request.headers.get("content-type"), await request.text()]);
        return HttpResponse.json({ ok: true });
      }),
    );
    const { c } = client();
    await c.request({ method: "POST", path: "/token", body: { a: 1 } });
    await c.request({ method: "POST", path: "/token", body: new URLSearchParams({ grant_type: "refresh_token" }) });
    expect(bodies[0]).toEqual(["application/json", '{"a":1}']);
    expect(bodies[1]?.[0]).toMatch(/application\/x-www-form-urlencoded/);
    expect(bodies[1]?.[1]).toBe("grant_type=refresh_token");
  });

  it("picks up a fresh token on every attempt when auth is a function", async () => {
    const auths: (string | null)[] = [];
    let n = 0;
    server.use(
      http.get(`${BASE}/x`, ({ request }) => {
        auths.push(request.headers.get("authorization"));
        return ++n === 1 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({});
      }),
    );
    let version = 0;
    const { c } = client();
    await c.request({ method: "GET", path: "/x", auth: { scheme: "Bearer", secret: async () => new SecretValue(`synthetic-access-v${++version}`) } });
    expect(auths).toEqual(["Bearer synthetic-access-v1", "Bearer synthetic-access-v2"]);
  });

  it("rejects bad base URLs, path templates and missing parameters before any request", async () => {
    expect(() => createHttpClient({ provider: "p", laneId: "PKG", baseUrl: "http://api.example.test" })).toThrow(ConnectorError);
    expect(() => createHttpClient({ provider: "p", laneId: "PKG", baseUrl: "https://u:p@api.example.test" })).toThrow(ConnectorError);
    expect(() => createHttpClient({ provider: "p", laneId: "PKG", baseUrl: "https://api.example.test/?k=1" })).toThrow(ConnectorError);
    expect(() => createHttpClient({ provider: "p", laneId: "PKG", baseUrl: "http://127.0.0.1:9999" })).not.toThrow();
    const { c } = client();
    expect((await failure(c.request({ method: "GET", path: "/x?id=1" }))).kind).toBe("invalid_input");
    expect((await failure(c.request({ method: "GET", path: "https://evil.test/x" }))).kind).toBe("invalid_input");
    expect((await failure(c.request({ method: "GET", path: "/a/{id}" }))).kind).toBe("invalid_input");
    expect((await failure(c.request({ method: "GET", path: "/x", auth: { scheme: "Bearer", secret: "plain" as never } }))).kind).toBe(
      "invalid_input",
    );
  });

  it("refuses dot-segment and empty parameters, and dot or empty segments in templates (no endpoint switching)", async () => {
    const { c } = client({ baseUrl: `${BASE}/calendar/v3` });
    for (const id of ["..", ".", ""]) {
      expect((await failure(c.request({ method: "POST", path: "/customers/{id}/refunds", params: { id } }))).kind).toBe("invalid_input");
    }
    for (const path of ["/a/../b", "/a/./b", "/a//b", "/.."]) expect((await failure(c.request({ method: "GET", path }))).kind).toBe("invalid_input");
    // values with slashes or encoded dots stay inside their one segment
    const seen: string[] = [];
    server.use(http.get(`${BASE}/calendar/v3/c/:id`, ({ request }) => (seen.push(new URL(request.url).pathname), HttpResponse.json({}))));
    await c.request({ method: "GET", path: "/c/{id}", params: { id: "../../../gmail/v1/users/me" } });
    await c.request({ method: "GET", path: "/c/{id}", params: { id: "%2e%2e" } });
    expect(seen).toEqual(["/calendar/v3/c/..%2F..%2F..%2Fgmail%2Fv1%2Fusers%2Fme", "/calendar/v3/c/%252e%252e"]);
  });

  it("sends a raw string body with the caller's content-type, and Basic credentials", async () => {
    let seen: [string | null, string | null, string] | undefined;
    server.use(
      http.post(`${BASE}/query`, async ({ request }) => {
        seen = [request.headers.get("content-type"), request.headers.get("authorization"), await request.text()];
        return HttpResponse.json({});
      }),
    );
    await client().c.request({
      method: "POST",
      path: "/query",
      headers: { "content-type": "application/text" },
      body: "select * from Invoice",
      auth: { scheme: "Basic", secret: basicCredentials("client-id", new SecretValue("synthetic-client-secret")) },
    });
    expect(seen).toEqual(["application/text", `Basic ${Buffer.from("client-id:synthetic-client-secret").toString("base64")}`, "select * from Invoice"]);
  });

  it("never puts a malformed credential or a refresh failure's message in the error", async () => {
    const { c } = client();
    const bad = await failure(c.request({ method: "GET", path: "/x", auth: { scheme: "Bearer", secret: new SecretValue("synthetic-tok\r\nX-Evil: 1") } }));
    expect(bad.kind).toBe("invalid_input");
    expect(JSON.stringify(bad)).not.toContain("synthetic-tok");
    const refresh = await failure(
      c.request({ method: "GET", path: "/x", auth: { scheme: "Bearer", secret: async () => { throw new Error("refresh_token=synthetic-rt leaked"); } } }),
    );
    expect(refresh).toMatchObject({ kind: "provider_error", endpoint: "/x" });
    expect(JSON.stringify(refresh)).not.toContain("synthetic-rt");
    const reconnect = await failure(
      c.request({ method: "GET", path: "/x", auth: { scheme: "Bearer", secret: async () => { throw new ConnectorError({ kind: "reconnect_required", message: "invalid_grant" }); } } }),
    );
    expect(reconnect).toMatchObject({ kind: "reconnect_required", endpoint: "/x" });
  });

  it("validates options", () => {
    for (const bad of [{ laneId: "pkg" as never }, { maxRetries: Infinity }, { maxRetries: -1 }, { timeoutMs: 0 }, { retryBaseMs: Number.NaN }, { maxResponseBytes: -1 }]) {
      expect(() => client(bad)).toThrow(ConnectorError);
    }
  });

  it("keeps the base path", async () => {
    server.use(http.get(`${BASE}/v2/items`, () => HttpResponse.json({ ok: 1 })));
    const { c } = client({ baseUrl: `${BASE}/v2/` });
    expect((await c.request({ method: "GET", path: "/items" })).data).toEqual({ ok: 1 });
  });
});

describe("retries", () => {
  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const statuses = [429, 500, 502];
    server.use(http.get(`${BASE}/x`, () => (statuses.length ? new HttpResponse(null, { status: statuses.shift() }) : HttpResponse.json({ ok: 1 }))));
    const { c, waits } = client();
    const res = await c.request({ method: "GET", path: "/x" });
    expect(res.attempts).toBe(4);
    expect(waits).toEqual([250, 500, 1000]); // random 0.5 * 500 * 2^n
  });

  it("honours Retry-After in seconds and as an HTTP date", async () => {
    const responses = [
      new HttpResponse(null, { status: 429, headers: { "retry-after": "2" } }),
      new HttpResponse(null, { status: 503, headers: { "retry-after": new Date(Date.UTC(2026, 10, 2, 12, 0, 5)).toUTCString() } }),
    ];
    server.use(http.get(`${BASE}/x`, () => responses.shift() ?? HttpResponse.json({})));
    const { c, waits } = client({ now: () => Date.UTC(2026, 10, 2, 12, 0, 0) });
    await c.request({ method: "GET", path: "/x" });
    expect(waits).toEqual([2000, 5000]);
  });

  it("gives up as rate_limited when Retry-After is longer than the cap, with retry_after_seconds", async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse(null, { status: 429, headers: { "retry-after": "120", "x-request-id": "tid-9" } })));
    const { c, waits } = client();
    const info = await failure(c.request({ method: "GET", path: "/x" }));
    expect(info).toMatchObject({ kind: "rate_limited", disposition: "retry", http_status: 429, retry_after_seconds: 120, provider_tid: "tid-9", endpoint: "/x" });
    expect(waits).toEqual([]);
  });

  it("stops after maxRetries with a transient error", async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/x`, () => (calls++, new HttpResponse(null, { status: 503 }))));
    const { c } = client({ maxRetries: 2 });
    expect(await failure(c.request({ method: "GET", path: "/x" }))).toMatchObject({ kind: "transient", http_status: 503 });
    expect(calls).toBe(3);
  });

  it("does not retry POST unless asked", async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/x`, () => (calls++, new HttpResponse(null, { status: 503 }))));
    const { c } = client();
    await failure(c.request({ method: "POST", path: "/x", body: {} }));
    expect(calls).toBe(1);
    await failure(c.request({ method: "POST", path: "/x", body: {}, retry: true }));
    expect(calls).toBe(5);
  });

  it("retries network failures and reports them without the cause", async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/x`, () => (calls++, HttpResponse.error())));
    const { c } = client({ maxRetries: 1 });
    expect(await failure(c.request({ method: "GET", path: "/x" }))).toMatchObject({ kind: "transient", http_status: null, endpoint: "/x" });
    expect(calls).toBe(2);
  });

  it("times out slow responses", async () => {
    server.use(http.get(`${BASE}/x`, async () => new Promise(() => undefined)));
    const { c } = client({ timeoutMs: 50, maxRetries: 0 });
    expect((await failure(c.request({ method: "GET", path: "/x" }))).kind).toBe("timeout");
  });

  it("rejects with the abort reason when the caller cancels, before or during a backoff wait", async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/x`, () => (calls++, new HttpResponse(null, { status: 503 }))));
    const pre = new AbortController();
    pre.abort();
    await expect(client().c.request({ method: "GET", path: "/x", signal: pre.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    const mid = new AbortController();
    const { c } = client({ sleep: () => new Promise(() => undefined) }); // the backoff never ends on its own
    const p = c.request({ method: "GET", path: "/x", signal: mid.signal });
    await new Promise((r) => setTimeout(r, 20));
    mid.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("retries a body that stalls or breaks after the headers, as timeout / transient with the endpoint", async () => {
    // Fetch is injected: MSW's interceptor does not cope with a stalled stream being cancelled under it.
    let calls = 0;
    const json = { "content-type": "application/json" };
    const partial = new TextEncoder().encode('{"partial":');
    const stall = async () => (calls++, new Response(new ReadableStream({ start: (ctl) => ctl.enqueue(partial) }), { headers: json }));
    const reset = async () =>
      (calls++, new Response(new ReadableStream({ start: (ctl) => (ctl.enqueue(partial), ctl.error(new TypeError("socket reset"))) }), { headers: json }));
    const stalled = client({ timeoutMs: 50, maxRetries: 1, fetch: stall as typeof fetch }).c;
    expect(await failure(stalled.request({ method: "GET", path: "/stall" }))).toMatchObject({ kind: "timeout", disposition: "retry", endpoint: "/stall" });
    expect(calls).toBe(2);
    const broken = client({ maxRetries: 1, fetch: reset as typeof fetch }).c;
    expect(await failure(broken.request({ method: "GET", path: "/reset" }))).toMatchObject({ kind: "transient", disposition: "retry", endpoint: "/reset" });
    expect(calls).toBe(4);
  });

  it("retries a 429 on POST (not processed), unless retry is false", async () => {
    let calls = 0;
    server.use(http.post(`${BASE}/x`, () => (++calls === 1 ? new HttpResponse(null, { status: 429 }) : HttpResponse.json({}))));
    expect((await client().c.request({ method: "POST", path: "/x", body: {} })).attempts).toBe(2);
    calls = 0;
    await failure(client().c.request({ method: "POST", path: "/x", body: {}, retry: false }));
    expect(calls).toBe(1);
  });

  it("retries at once on a past Retry-After date, and gives up on a 503 whose Retry-After is over the cap", async () => {
    const responses = [new HttpResponse(null, { status: 503, headers: { "retry-after": new Date(Date.UTC(2026, 0, 1)).toUTCString() } })];
    server.use(http.get(`${BASE}/x`, () => responses.shift() ?? HttpResponse.json({})));
    const { c, waits } = client({ now: () => Date.UTC(2026, 10, 2) });
    await c.request({ method: "GET", path: "/x" });
    expect(waits).toEqual([0]);
    server.use(http.get(`${BASE}/y`, () => new HttpResponse(null, { status: 503, headers: { "retry-after": "3600" } })));
    expect(await failure(client().c.request({ method: "GET", path: "/y" }))).toMatchObject({ kind: "transient", retry_after_seconds: 3600 });
  });
});

describe("errors", () => {
  it.each([
    [400, "invalid_input"],
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "not_found"],
    [418, "provider_error"],
  ])("maps %s to %s, with the provider code and request id but never the body", async (status, kind) => {
    server.use(
      http.get(`${BASE}/v3/company/:realm/x`, () =>
        HttpResponse.json(
          { Fault: { Error: [{ code: "3200", Message: "AuthenticationFailed for customer Synthetic Leak Co", Detail: "token synthetic-access-2" }] } },
          { status, headers: { "x-request-id": "tid-2" } },
        ),
      ),
    );
    const { c } = client({ errorCode: (b) => (b as { Fault: { Error: { code: string }[] } }).Fault.Error[0]?.code });
    const info = await failure(
      c.request({ method: "GET", path: "/v3/company/{realm}/x", params: { realm: "999" }, auth: { scheme: "Bearer", secret: new SecretValue("synthetic-access-2") } }),
    );
    expect(info).toMatchObject({ kind, http_status: status, provider_error_code: "3200", provider_tid: "tid-2", endpoint: "/v3/company/{realm}/x" });
    const json = JSON.stringify(info);
    expect(json).not.toContain("Synthetic Leak");
    expect(json).not.toContain("synthetic-access-2");
    expect(json).not.toContain("999");
  });

  it("an error-code extractor that throws does not break error handling", async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.text("not json", { status: 400 })));
    const { c } = client({ errorCode: () => { throw new Error("boom"); } });
    expect(await failure(c.request({ method: "GET", path: "/x" }))).toMatchObject({ kind: "invalid_input", provider_error_code: null });
  });

  it("refuses redirects without following or retrying them (a token must never follow one)", async () => {
    let calls = 0;
    server.use(http.get(`${BASE}/x`, () => (calls++, new HttpResponse(null, { status: 302, headers: { location: "https://elsewhere.test/x" } }))));
    expect(await failure(client().c.request({ method: "GET", path: "/x" }))).toMatchObject({ kind: "provider_error", disposition: "fail", http_status: 302 });
    expect(calls).toBe(1);
  });

  it("keeps the status kind when an error body is not JSON or too big (401 stays the refresh signal)", async () => {
    server.use(
      http.get(`${BASE}/a`, () => new HttpResponse("{nope", { status: 401, headers: { "content-type": "application/json" } })),
      http.get(`${BASE}/b`, () => HttpResponse.json({ pad: "x".repeat(4096) }, { status: 401 })),
    );
    const { c } = client({ maxResponseBytes: 1024 });
    expect(await failure(c.request({ method: "GET", path: "/a" }))).toMatchObject({ kind: "forbidden", http_status: 401 });
    expect(await failure(c.request({ method: "GET", path: "/b" }))).toMatchObject({ kind: "forbidden", http_status: 401 });
  });

  it("ignores an error code that is not a string", async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.json({ code: 3200 }, { status: 400 })));
    const { c } = client({ errorCode: (b) => (b as { code: string }).code });
    expect(await failure(c.request({ method: "GET", path: "/x" }))).toMatchObject({ kind: "invalid_input", provider_error_code: null });
  });

  it("caps response size (with and without content-length) and rejects invalid or non-JSON bodies", async () => {
    let pulled = 0;
    server.use(
      http.get(`${BASE}/big`, () => HttpResponse.text("x".repeat(2048))),
      http.get(`${BASE}/bad`, () => new HttpResponse("{nope", { headers: { "content-type": "application/json" } })),
      http.get(`${BASE}/html`, () => HttpResponse.html("<html>maintenance</html>")),
    );
    const { c } = client({ maxResponseBytes: 1024 });
    expect(await failure(c.request({ method: "GET", path: "/big" }))).toMatchObject({ kind: "provider_error", endpoint: "/big", http_status: 200 });
    // No content-length: an endless stream is cut off at the cap, not buffered. Fetch is injected because MSW reads
    // response streams eagerly on its side, which would hide how much the client pulled.
    const endless = client({
      maxResponseBytes: 1024,
      fetch: async () =>
        new Response(new ReadableStream({ pull: (ctl) => (pulled++, ctl.enqueue(new Uint8Array(512))) }), { headers: { "content-type": "application/json" } }),
    }).c;
    expect(await failure(endless.request({ method: "GET", path: "/chunked" }))).toMatchObject({ kind: "provider_error", endpoint: "/chunked" });
    expect(pulled).toBeLessThan(10);
    expect(await failure(c.request({ method: "GET", path: "/bad" }))).toMatchObject({ kind: "provider_error", endpoint: "/bad" });
    expect(await failure(c.request({ method: "GET", path: "/html" }))).toMatchObject({ kind: "provider_error", endpoint: "/html" });
    expect((await c.request({ method: "GET", path: "/html", responseType: "text" })).data).toBe("<html>maintenance</html>");
  });
});

describe("logging", () => {
  it("logs one line per attempt with the endpoint template, never the URL, query, token or body", async () => {
    const statuses = [503];
    server.use(
      http.get(`${BASE}/v3/company/:realm/query`, () =>
        statuses.length ? new HttpResponse(null, { status: statuses.shift() }) : HttpResponse.json({ name: "Synthetic Leak Co" }),
      ),
    );
    const { c, logs } = client();
    await c.request({
      method: "GET",
      path: "/v3/company/{realm}/query",
      params: { realm: "4620816365" },
      query: { query: "select * from Customer where DisplayName = 'Synthetic Leak Co'" },
      auth: { scheme: "Bearer", secret: new SecretValue("synthetic-access-3") },
    });
    expect(logs.map((l) => [l.event, l.fields.status, l.fields.attempt])).toEqual([
      ["connector.http", 503, 1],
      ["connector.http", 200, 2],
    ]);
    expect(logs[0]).toMatchObject({ lane_id: "PKG", provider: "testprov", level: "warn", fields: { outcome: "retry", kind: "transient", final: false, retry_in_ms: 250 } });
    expect(logs[1]).toMatchObject({ level: "info", fields: { outcome: "ok" } });
    const out = JSON.stringify(logs);
    for (const s of ["4620816365", "Synthetic Leak", "synthetic-access-3", "select"]) expect(out).not.toContain(s);
  });
});

describe("logging levels and context", () => {
  it("logs the final failure as an error with its kind and code, and keeps a lane bound on an injected logger", async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.json({ code: "6000" }, { status: 400 })));
    const logs: LogEntry[] = [];
    const logger = createConnectorLogger({ sink: (e) => logs.push(e) }).child({ laneId: "PKG", connectionId: "00000000-0000-4000-8000-0000000000c1" });
    const c = createHttpClient({ provider: "testprov", baseUrl: BASE, laneId: "PKG", connectionId: "00000000-0000-4000-8000-0000000000c2", logger, errorCode: (b) => (b as { code: string }).code });
    await failure(c.request({ method: "GET", path: "/x" }));
    expect(logs[0]).toMatchObject({ level: "error", lane_id: "PKG", connection_id: "00000000-0000-4000-8000-0000000000c2", fields: { outcome: "error", final: true, kind: "invalid_input", provider_error_code: "6000", status: 400 } });
    const child = logger.child({ laneId: undefined, provider: "p2" });
    child.info("x.y");
    expect(logs[1]).toMatchObject({ lane_id: "PKG", provider: "p2" });
  });
});

describe("rate limit", () => {
  it("spaces calls so at most N start per window, shared by clients with the same key", async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.json({})));
    let clock = 0;
    const waits: number[] = [];
    const opts = {
      rateLimit: { requests: 2, perMs: 1000 },
      rateLimitKey: "conn-1",
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
    };
    const a = client(opts).c;
    const b = client(opts).c;
    await a.request({ method: "GET", path: "/x" });
    await b.request({ method: "GET", path: "/x" });
    await a.request({ method: "GET", path: "/x" });
    expect(waits).toEqual([1000]);
  });

  it("validates the limit, and refuses a different limit for the same bucket", () => {
    expect(() => client({ rateLimit: { requests: 0, perMs: 1000 } })).toThrow(TypeError);
    client({ rateLimit: { requests: 5, perMs: 1000 }, rateLimitKey: "k" });
    expect(() => client({ rateLimit: { requests: 9, perMs: 1000 }, rateLimitKey: "k" })).toThrow(TypeError);
  });

  it("keeps lanes in separate buckets", async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.json({})));
    const waits: number[] = [];
    const opts = { rateLimit: { requests: 1, perMs: 1000 }, now: () => 0, sleep: async (ms: number) => void waits.push(ms) };
    await client({ ...opts, laneId: "PKG" }).c.request({ method: "GET", path: "/x" });
    await client({ ...opts, laneId: "NL" }).c.request({ method: "GET", path: "/x" });
    expect(waits).toEqual([]);
  });

  it("admits concurrent callers in order and skips one that cancelled while queued", async () => {
    let clock = 0;
    const limiter = RateLimiter.for("t:PKG:*", { requests: 1, perMs: 100 }, { now: () => clock, sleep: async (ms) => void (clock += ms) });
    const order: string[] = [];
    const ac = new AbortController();
    const a = limiter.take().then(() => order.push(`a@${clock}`));
    const b = limiter.take(ac.signal).then(() => order.push("b"), () => order.push("b-cancelled"));
    const d = limiter.take().then(() => order.push(`d@${clock}`));
    ac.abort();
    await Promise.all([a, b, d]);
    expect(order).toEqual(["b-cancelled", "a@0", "d@100"]); // the cancelled caller is released at once and uses no slot
  });
});

describe("mock server", () => {
  it("blocks an unmocked request to a real provider and records it, so a test that swallows the error still fails", async () => {
    const { c } = client({ baseUrl: stripe.API, maxRetries: 0 });
    expect(await failure(c.request({ method: "GET", path: "/v1/balance" }))).toMatchObject({ kind: "transient", endpoint: "/v1/balance" });
    expect(server.takeUnhandled()).toBe(1);
  });

  it("re-exports delay for slow-response mocks", () => {
    expect(typeof delay).toBe("function");
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and dates, ignores garbage", () => {
    expect(parseRetryAfter("3", 0)).toBe(3000);
    expect(parseRetryAfter(" 3 ", 0)).toBe(3000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(new Date(0).toUTCString(), 4_000)).toBe(0);
    expect(parseRetryAfter("1.5", 0)).toBeNull(); // Date.parse would read this as a date in 2001
    expect(parseRetryAfter("2026-11-02", 0)).toBeNull();
  });
});
