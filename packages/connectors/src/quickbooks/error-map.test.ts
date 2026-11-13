// QB-14 (T-195): the QuickBooks error map. Intuit responses in their documented format (hand-written fixtures with synthetic
// values, testing/msw/quickbooks/error-fixtures.ts) go through the real API client, token manager and HTTP client over MSW.
// Each fixture ends as retry (capped exponential backoff, Retry-After honoured), reconnect_required or failed-with-message,
// and none of Intuit's own text reaches the error.
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { delay, http, HttpResponse, useMockServer } from "../testing/msw/index";
import { API_SANDBOX, createFakeIntuit, FAKE_REALM } from "../testing/msw/quickbooks/handlers";
import { DETAIL_CANARY, intuitFixtures, type IntuitFixtureName } from "../testing/msw/quickbooks/error-fixtures";
import { createQboHarness } from "../testing/quickbooks-harness";
import { createQboApi, intuitErrorCode } from "./api";
import { classifyIntuitFailure, mapIntuitError, QBO_RETRY } from "./errors";

const server = useMockServer();
const LANE = "PKG";
const PATH = "/v3/company/{realm}/companyinfo/{realm}";
const URL_ = `${API_SANDBOX}/v3/company/:realm/companyinfo/:id`;
afterEach(() => RateLimiter.resetForTests());

async function setup(apiOptions: { sleeps?: number[]; maxRetries?: number; retryMaxMs?: number; timeoutMs?: number } = {}) {
  const intuit = createFakeIntuit();
  server.use(...intuit.handlers);
  const h = createQboHarness({ intuit });
  const conn = await h.connectViaCallback(LANE);
  intuit.state.apiRequests.length = 0;
  const sleeps = apiOptions.sleeps ?? [];
  // An API client of its own with the production backoff numbers, a recorded sleep and a jitter of 1 (the longest wait),
  // so the exact schedule can be asserted.
  const api = createQboApi({
    tokens: h.tokens,
    environment: () => "sandbox",
    onReconnectRequired: undefined,
    httpOptions: {
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 1,
      retryBaseMs: QBO_RETRY.baseMs,
      retryMaxMs: apiOptions.retryMaxMs ?? QBO_RETRY.maxMs,
      ...(apiOptions.maxRetries !== undefined ? { maxRetries: apiOptions.maxRetries } : {}),
      ...(apiOptions.timeoutMs !== undefined ? { timeoutMs: apiOptions.timeoutMs } : {}),
    },
  });
  return { intuit, h, conn, api, sleeps };
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
/** Serves the replies in order, then the last one forever; counts the requests. */
function reply(...replies: Reply[]) {
  const seen = { n: 0 };
  server.use(
    http.get(URL_, () => {
      const r = replies[Math.min(seen.n, replies.length - 1)] as Reply;
      seen.n += 1;
      return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status, headers: { intuit_tid: `synthetic-tid-${String(seen.n).padStart(4, "0")}`, ...r.headers } });
    }),
  );
  return seen;
}
const fx = (name: IntuitFixtureName, headers?: Record<string, string>): Reply => ({ ...intuitFixtures[name], ...(headers ? { headers } : {}) });
const OK: Reply = { status: 200, body: { CompanyInfo: { Id: "1" }, time: "2026-11-13T10:00:00.000Z" } };
const fail = async (p: Promise<unknown>): Promise<ConnectorError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ConnectorError);
  return e as ConnectorError;
};

describe("the code is read from both of Intuit's error shapes", () => {
  it("Fault.Error[0].code and the gateway's lower-case fault.error[0].code", () => {
    expect(intuitErrorCode(intuitFixtures.validation400.body)).toBe("2500");
    expect(intuitErrorCode(intuitFixtures.auth401.body)).toBe("3200");
    expect(intuitErrorCode({ Fault: { Error: [{ code: 6000 }] } })).toBe("6000");
    expect(intuitErrorCode({ nothing: true })).toBeUndefined();
    expect(intuitErrorCode(null)).toBeUndefined();
  });
});

describe("400 with a Fault: failed, with a fixed message, never retried", () => {
  it.each([
    ["validation400", "2500", /not valid/],
    ["business400", "6240", /not valid/],
    ["syntax400", "4000", /could not read the request/],
    ["unknown400", "9999", /refused the request/],
  ] as const)("%s", async (name, code, message) => {
    const { api, conn, sleeps } = await setup();
    const seen = reply(fx(name));
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info.kind).toBe("invalid_input");
    expect(err.info.disposition).toBe("fail");
    expect(err.info.http_status).toBe(400);
    expect(err.info.provider_error_code).toBe(code);
    expect(err.info.provider_tid).toBe("synthetic-tid-0001");
    expect(err.info.message).toMatch(message);
    expect(err.info.message).toMatch(/Nothing was changed/);
    expect(JSON.stringify(err.toJSON())).not.toContain("Synthetic Person");
    expect(JSON.stringify(err.toJSON())).not.toContain(DETAIL_CANARY);
    expect(seen.n).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("401, 403, 404", () => {
  it("401: refreshes the token once and retries once; a second 401 is a failure with a message and does NOT record reconnect_required (the token was just refreshed)", async () => {
    const { h, conn, intuit } = await setup();
    const seen = reply(fx("auth401"));
    const err = await fail(h.api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info.kind).toBe("forbidden");
    expect(err.info.disposition).toBe("fail");
    expect(err.info.http_status).toBe(401);
    expect(err.info.provider_error_code).toBe("3200");
    expect(err.info.message).toMatch(/did not accept/);
    expect(seen.n).toBe(2);
    expect(intuit.state.tokenRequests.filter((r) => r.grant === "refresh_token")).toHaveLength(1);
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.rows.get(conn.id)?.last_error).toBeNull();
    expect(h.notices).toEqual([]);
  });

  it("a token endpoint answer (401 invalid_client: our own client secret is wrong) is not an API answer: status unchanged, no event, the original error", async () => {
    const { h, conn, intuit } = await setup();
    intuit.state.failRefresh = { status: 401, error: "invalid_client", always: true };
    h.clock.t += 59 * 60_000;
    const seen = reply(OK);
    const err = await fail(h.api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "forbidden", http_status: 401, provider_error_code: "invalid_client" });
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.notices).toEqual([]);
    expect(seen.n).toBe(0);
  });

  it("401 that goes away after the refresh is not an error at all", async () => {
    const { h, conn } = await setup();
    const seen = reply(fx("auth401"), OK);
    const res = await h.api.get(LANE, conn, PATH, { realm: FAKE_REALM });
    expect(res.status).toBe(200);
    expect(seen.n).toBe(2);
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.notices).toEqual([]);
  });

  it("403 'application not authorized' (3100) is reconnect_required", async () => {
    const { h, conn } = await setup();
    const seen = reply(fx("appAuthorization403"));
    const err = await fail(h.api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "reconnect_required", http_status: 403, provider_error_code: "3100" });
    expect(seen.n).toBe(1);
    expect(h.rows.get(conn.id)?.status).toBe("reconnect_required");
    expect(h.notices).toHaveLength(1);
  });

  it("403 for a permission (120) is failed with a message: the connection stays active, no notification, no retry", async () => {
    const { h, conn } = await setup();
    const seen = reply(fx("permission403"));
    const err = await fail(h.api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "forbidden", disposition: "fail", http_status: 403, provider_error_code: "120" });
    expect(err.info.message).toMatch(/permissions/);
    expect(seen.n).toBe(1);
    expect(h.rows.get(conn.id)?.status).toBe("active");
    expect(h.notices).toEqual([]);
  });

  it("404: failed with a message, not retried", async () => {
    const { api, conn, sleeps } = await setup();
    const seen = reply(fx("notFound404"));
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "not_found", disposition: "fail", http_status: 404 });
    expect(err.info.message).toMatch(/could not find/);
    expect(seen.n).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("a token failure of an earlier attempt does not outrank the API answer (review L)", () => {
  it("secret() fails once (swallowed by the client), the next attempt gets a token and Intuit answers 403/3100: the API error wins and is recorded", async () => {
    const { h, conn } = await setup();
    let calls = 0;
    const flaky = { ...h.tokens, accessToken: async (l: string, c: never, o?: never) => {
      calls += 1;
      if (calls === 1) throw new ConnectorError({ kind: "transient", message: "Token store unavailable" });
      return h.tokens.accessToken(l, c, o);
    } } as unknown as typeof h.tokens;
    const api = createQboApi({
      tokens: flaky,
      environment: () => "sandbox",
      onReconnectRequired: undefined,
      httpFor: () => ({
        async request(req: { auth?: { secret: unknown } }) {
          const secret = req.auth?.secret as () => Promise<unknown>;
          await secret().catch(() => undefined); // attempt 1: the token read fails
          await secret(); // attempt 2: succeeds
          throw new ConnectorError({ kind: "forbidden", message: "x", http_status: 403, provider_error_code: "3100" });
        },
      }) as never,
    });
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "reconnect_required", http_status: 403, provider_error_code: "3100" });
  });
});

describe("429 with Retry-After", () => {
  it("waits the Retry-After (not the shorter backoff) and succeeds on the retry", async () => {
    const { api, conn, sleeps } = await setup();
    const seen = reply(fx("throttle429", { "Retry-After": "2" }), OK);
    const res = await api.get(LANE, conn, PATH, { realm: FAKE_REALM });
    expect(res.status).toBe(200);
    expect(seen.n).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("keeps retrying up to the cap and then leaves as a retryable rate_limited error carrying the wait", async () => {
    const { api, conn, sleeps } = await setup();
    const seen = reply(fx("throttle429", { "Retry-After": "3" }));
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "rate_limited", disposition: "retry", http_status: 429, retry_after_seconds: 3 });
    expect(seen.n).toBe(QBO_RETRY.maxRetries + 1);
    expect(sleeps).toEqual([3000, 3000, 3000]);
  });

  it("a Retry-After longer than the cap is not slept: the job is told to retry later (RetryAfter)", async () => {
    const { api, conn, sleeps } = await setup();
    const seen = reply(fx("throttle429", { "Retry-After": "120" }));
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "rate_limited", disposition: "retry", retry_after_seconds: 120 });
    expect(seen.n).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("without Retry-After it backs off exponentially", async () => {
    const { api, conn, sleeps } = await setup();
    reply(fx("throttle429"));
    await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(sleeps).toEqual([500, 1000, 2000]);
  });
});

describe("5xx and timeouts: retried with capped exponential backoff", () => {
  it("503 three times, then fine: waits 500, 1000, 2000 ms", async () => {
    const { api, conn, sleeps } = await setup();
    const seen = reply(fx("unavailable503"), fx("unavailable503"), fx("unavailable503"), OK);
    expect((await api.get(LANE, conn, PATH, { realm: FAKE_REALM })).status).toBe(200);
    expect(seen.n).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("500 for good: three retries, then a retryable transient error with a fixed message", async () => {
    const { api, conn } = await setup();
    const seen = reply(fx("server500"));
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "transient", disposition: "retry", http_status: 500, provider_error_code: null });
    expect(err.info.message).toMatch(/not responding/);
    expect(JSON.stringify(err.toJSON())).not.toContain(DETAIL_CANARY);
    expect(seen.n).toBe(QBO_RETRY.maxRetries + 1);
  });

  it("the backoff is capped", async () => {
    const { api, conn, sleeps } = await setup({ retryMaxMs: 1500 });
    reply(fx("server500"));
    await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(sleeps).toEqual([500, 1000, 1500]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(1500);
  });

  it("a timeout is retried and ends as a retryable timeout error", async () => {
    const { api, conn, sleeps } = await setup({ timeoutMs: 30, maxRetries: 1 });
    let n = 0;
    server.use(
      http.get(URL_, async () => {
        n += 1;
        await delay(400);
        return HttpResponse.json(OK.body as Record<string, unknown>);
      }),
    );
    const err = await fail(api.get(LANE, conn, PATH, { realm: FAKE_REALM }));
    expect(err.info).toMatchObject({ kind: "timeout", disposition: "retry" });
    expect(err.info.message).toMatch(/not responding/);
    expect(n).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe("the classification itself (pure)", () => {
  const c = (http_status: number | null, provider_error_code: string | null, kind: ConnectorError["info"]["kind"] = "provider_error", retry_after_seconds: number | null = null) =>
    classifyIntuitFailure({ kind, http_status, provider_error_code, retry_after_seconds });
  it("maps every documented status to one outcome", () => {
    expect(c(400, "2500").outcome).toBe("failed");
    expect(c(400, "4001").outcome).toBe("failed");
    expect(c(400, null).outcome).toBe("failed");
    expect(c(401, "3200").outcome).toBe("failed");
    expect(c(403, "3100").outcome).toBe("reconnect_required");
    expect(c(403, "120").outcome).toBe("failed");
    expect(c(403, null).outcome).toBe("failed");
    expect(c(404, null).outcome).toBe("failed");
    expect(c(429, "003001", "rate_limited", 7)).toMatchObject({ outcome: "retry", retryAfterSeconds: 7 });
    for (const s of [500, 502, 503, 504]) expect(c(s, null, "transient").outcome).toBe("retry");
    expect(c(null, null, "timeout").outcome).toBe("retry");
    expect(c(400, "invalid_grant", "reconnect_required").outcome).toBe("reconnect_required");
  });

  it("errors that never reached Intuit, and non-connector errors, are left alone", () => {
    const own = new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    expect(mapIntuitError(own)).toBe(own);
    const other = new Error("boom");
    expect(mapIntuitError(other)).toBe(other);
  });
});
