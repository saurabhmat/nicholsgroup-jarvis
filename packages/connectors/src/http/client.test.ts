import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import type { LogEntry } from "../log/index";
import { createConnectorLogger } from "../log/index";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { forgetSecretsForTests, SecretValue } from "../vault/secret";
import { createHttpClient, parseRetryAfter, type HttpClientOptions } from "./client";
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
    expect(() => createHttpClient({ provider: "p", baseUrl: "http://api.example.test" })).toThrow(ConnectorError);
    expect(() => createHttpClient({ provider: "p", baseUrl: "https://u:p@api.example.test" })).toThrow(ConnectorError);
    expect(() => createHttpClient({ provider: "p", baseUrl: "https://api.example.test/?k=1" })).toThrow(ConnectorError);
    expect(() => createHttpClient({ provider: "p", baseUrl: "http://127.0.0.1:9999" })).not.toThrow();
    const { c } = client();
    expect((await failure(c.request({ method: "GET", path: "/x?id=1" }))).kind).toBe("invalid_input");
    expect((await failure(c.request({ method: "GET", path: "https://evil.test/x" }))).kind).toBe("invalid_input");
    expect((await failure(c.request({ method: "GET", path: "/a/{id}" }))).kind).toBe("invalid_input");
    expect((await failure(c.request({ method: "GET", path: "/x", auth: { scheme: "Bearer", secret: "plain" as never } }))).kind).toBe(
      "invalid_input",
    );
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

  it("stops when the caller cancels", async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse(null, { status: 503 })));
    const ac = new AbortController();
    ac.abort();
    const { c } = client();
    expect((await failure(c.request({ method: "GET", path: "/x", signal: ac.signal }))).kind).toBe("timeout");
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

  it("refuses redirects (a token must never follow one)", async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse(null, { status: 302, headers: { location: "https://elsewhere.test/x" } })));
    const { c } = client({ maxRetries: 0 });
    expect((await failure(c.request({ method: "GET", path: "/x" }))).kind).toBe("transient");
  });

  it("caps response size and rejects invalid JSON", async () => {
    server.use(
      http.get(`${BASE}/big`, () => HttpResponse.text("x".repeat(2048))),
      http.get(`${BASE}/bad`, () => new HttpResponse("{nope", { headers: { "content-type": "application/json" } })),
    );
    const { c } = client({ maxResponseBytes: 1024 });
    expect(await failure(c.request({ method: "GET", path: "/big" }))).toMatchObject({ kind: "provider_error", endpoint: "/big" });
    expect(await failure(c.request({ method: "GET", path: "/bad" }))).toMatchObject({ kind: "provider_error", endpoint: "/bad" });
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
    expect(logs[0]).toMatchObject({ lane_id: "PKG", provider: "testprov" });
    const out = JSON.stringify(logs);
    for (const s of ["4620816365", "Synthetic Leak", "synthetic-access-3", "select"]) expect(out).not.toContain(s);
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

  it("validates the limit", () => {
    expect(() => client({ rateLimit: { requests: 0, perMs: 1000 } })).toThrow(TypeError);
  });
});

describe("mock server", () => {
  it("fails any request no handler covers, so tests never reach a real provider", async () => {
    const { c } = client({ maxRetries: 0 });
    expect(await failure(c.request({ method: "GET", path: "/not-mocked" }))).toMatchObject({ kind: "transient", endpoint: "/not-mocked" });
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
  });
});
