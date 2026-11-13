// T-196: the connector error log. Scrubbing, the single sink (store failure never reaches the caller, the transports get the same
// scrubbed fields), the CSV/JSON export encoders, and a canary test through the whole path: real API client + token manager + HTTP
// client over MSW, an Intuit that answers with canary text everywhere, an in-memory store. No external call.
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorErrorInfo } from "../contract/schemas";
import { RateLimiter } from "../http/rate-limit";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { classifyIntuitFailure } from "../quickbooks/errors";
import { createQboApi } from "../quickbooks/api";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { API_SANDBOX, createFakeIntuit, FAKE_REALM } from "../testing/msw/quickbooks/handlers";
import { createQboHarness } from "../testing/quickbooks-harness";
import {
  createApiErrorSink, csvCell, ERROR_COLUMNS, flattenRun, GENERIC_MESSAGE, parseExportRange, pick, safeFixedMessage, scrubApiError, templateEndpoint, toCsv,
  type ApiErrorTransport, type ScrubbedApiError,
} from "./index";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const info = (over: Partial<ConnectorErrorInfo> = {}): ConnectorErrorInfo => ({
  kind: "invalid_input", disposition: "fail", message: "m", http_status: 400, provider_error_code: "2500", provider_tid: "synthetic-tid-0001", retry_after_seconds: null, endpoint: "/v3/company/{realm}/query", ...over,
});

describe("templateEndpoint", () => {
  it.each([
    ["/v3/company/{realm}/query", "/v3/company/{realm}/query"],
    ["/v3/company/9341450000000001/query?query=select * from Customer where DisplayName = 'Jane Doe'&minorversion=75", "/v3/company/{realm}/query"],
    ["/v3/company/{realm}/reports/ProfitAndLoss?start_date=2026-01-01#frag", "/v3/company/{realm}/reports/ProfitAndLoss"],
    ["/v3/company/{realm}/invoice/1234567", "/v3/company/{realm}/invoice/{id}"],
    ["/v3/company/{realm}/customer/jane@example.test", "/v3/company/{realm}/customer/{id}"],
    ["/v3/company/{realm}/customer/Jane Doe", "/v3/company/{realm}/customer/{id}"],
  ])("%s", (input, expected) => expect(templateEndpoint(input)).toBe(expected));
  it("not a path -> null", () => {
    expect(templateEndpoint("https://quickbooks.api.intuit.com/v3")).toBeNull();
    expect(templateEndpoint(null)).toBeNull();
    expect(templateEndpoint("")).toBeNull();
  });
});

describe("scrubApiError", () => {
  it("uses the fixed message, never the one in the error", () => {
    const s = scrubApiError("quickbooks", info({ message: "Jane Doe owes 1234567" }), "QuickBooks refused the request. Nothing was changed.");
    expect(s.provider_message).toBe("QuickBooks refused the request. Nothing was changed.");
    expect(JSON.stringify(s)).not.toContain("Jane");
  });
  it("a fixed message that looks personal or like a credential becomes generic", () => {
    expect(safeFixedMessage("mail jane@example.test")).toBe(GENERIC_MESSAGE);
    expect(safeFixedMessage("Authorization Bearer abc")).toBe(GENERIC_MESSAGE);
    expect(safeFixedMessage("invoice 12345 failed")).toBe(GENERIC_MESSAGE);
    expect(safeFixedMessage("")).toBe(GENERIC_MESSAGE);
  });
  it("drops a code or request id that is not code-shaped", () => {
    const s = scrubApiError("quickbooks", info({ provider_error_code: "Jane Doe", provider_tid: "a b@c.test" }), "x");
    expect(s.provider_error_code).toBeNull();
    expect(s.provider_tid).toBeNull();
  });
  it("keeps the safe fields", () => {
    expect(scrubApiError("quickbooks", info({ kind: "rate_limited", disposition: "retry", http_status: 429, retry_after_seconds: 30, provider_error_code: "003001" }), "x")).toMatchObject({
      provider: "quickbooks", http_status: 429, retry_after_seconds: 30, provider_error_code: "003001", kind: "rate_limited", disposition: "retry", endpoint: "/v3/company/{realm}/query",
    });
  });
});

describe("the sink", () => {
  const conn = mintLaneBoundConnection<"quickbooks">({
    id: "00000000-0000-4000-8000-000000009601", lane_id: "PKG", provider: "quickbooks", external_account_id: FAKE_REALM, status: "active", features: {}, last_sync_at: null, last_error: null, features_checked_at: "2026-11-13T00:00:00.000Z", token_expires_at: "2026-11-13T01:00:00.000Z",
  } as never);
  const make = (over: { fail?: boolean; transports?: ApiErrorTransport[] } = {}) => {
    const rows: ScrubbedApiError[] = [];
    const logs: LogEntry[] = [];
    const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
    const sink = createApiErrorSink({
      store: { insert: async (_l, _c, row) => { if (over.fail) throw new Error("db password=hunter2 jane@example.test"); rows.push(row); } },
      messageFor: (i) => classifyIntuitFailure(i).message,
      logger,
      ...(over.transports ? { transports: over.transports } : {}),
    });
    return { sink, rows, logs };
  };

  it("one row and one redacted log line per error, with the same scrubbed fields", async () => {
    const seen: ScrubbedApiError[] = [];
    const { sink, rows, logs } = make({ transports: [{ name: "test", send: ({ scrubbed }) => void seen.push(scrubbed) }] });
    await sink.record("PKG", conn, info());
    expect(rows).toHaveLength(1);
    expect(seen).toEqual(rows);
    const line = logs.find((l) => l.event === "connector.api_error");
    expect(line?.fields).toMatchObject({ provider_message: rows[0]?.provider_message, http_status: 400, kind: "invalid_input" });
  });
  it("a failed insert is logged by code only and never thrown", async () => {
    const { sink, logs } = make({ fail: true });
    await expect(sink.record("PKG", conn, info())).resolves.toBeUndefined();
    const text = JSON.stringify(logs);
    expect(text).toContain("store_failed");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("jane@");
  });
  it("a throwing transport does not stop the others or the caller", async () => {
    const seen: string[] = [];
    const { sink } = make({ transports: [{ name: "bad", send: () => { throw new Error("boom"); } }, { name: "good", send: () => void seen.push("ok") }] });
    await expect(sink.record("PKG", conn, info())).resolves.toBeUndefined();
    expect(seen).toEqual(["ok"]);
  });
  it("a failure that never reached the provider is not an API error", async () => {
    const { sink, rows } = make();
    await sink.record("PKG", conn, info({ http_status: null, kind: "invalid_input", endpoint: null }));
    expect(rows).toEqual([]);
  });
  it("a network failure and a timeout are recorded (no status)", async () => {
    const { sink, rows } = make();
    await sink.record("PKG", conn, info({ http_status: null, kind: "timeout", disposition: "retry", provider_error_code: null }));
    await sink.record("PKG", conn, info({ http_status: null, kind: "transient", disposition: "retry", provider_error_code: null }));
    expect(rows.map((r) => r.http_status)).toEqual([null, null]);
  });
  it("another lane's connection is refused (nothing stored, nothing thrown)", async () => {
    const { sink, rows } = make();
    await sink.record("APK", conn, info());
    expect(rows).toEqual([]);
  });
});

describe("export encoders", () => {
  it("CSV cells starting with = + - @ tab or CR are neutralised; others are quoted when needed", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(400)).toBe("400");
  });
  it("toCsv: header, rows, CRLF", () => {
    expect(toCsv(["a", "b"], [{ a: "=x", b: 1 }, { a: null, b: "y" }])).toBe("a,b\r\n'=x,1\r\n,y\r\n");
  });
  it("pick keeps exactly the exported columns", () => {
    expect(Object.keys(pick([{ id: "secret-id", lane_id: "PKG", at: "t", extra: 1 }], ERROR_COLUMNS)[0] ?? {})).toEqual([...ERROR_COLUMNS]);
  });
  it("flattenRun keeps the error's safe fields and not its message", () => {
    const r = flattenRun({ job: "sync", error: { kind: "forbidden", http_status: 403, provider_error_code: "120", provider_tid: "t", endpoint: "/v3/x", message: "free text" } });
    expect(r).toMatchObject({ error_kind: "forbidden", error_http_status: 403, error_code: "120", error_tid: "t", error_endpoint: "/v3/x" });
    expect(JSON.stringify(r)).not.toContain("free text");
  });
  it("range: dates are whole UTC days (to inclusive), max 90 days, order and shape checked", () => {
    expect(parseExportRange("2026-11-01", "2026-11-02")).toEqual({ ok: true, range: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" } });
    expect(parseExportRange("2026-08-15", "2026-11-12")).toMatchObject({ ok: true }); // 90 days
    expect(parseExportRange("2026-08-14", "2026-11-12")).toEqual({ ok: false, reason: "range_too_long" });
    expect(parseExportRange("2026-11-05", "2026-11-01")).toEqual({ ok: false, reason: "invalid_range" });
    expect(parseExportRange("2026-02-30", "2026-03-02")).toEqual({ ok: false, reason: "invalid_range" });
    expect(parseExportRange("yesterday", "2026-03-02")).toEqual({ ok: false, reason: "invalid_range" });
    expect(parseExportRange(null, "2026-03-02")).toEqual({ ok: false, reason: "invalid_range" });
    expect(parseExportRange("2026-11-01T00:00:00Z", "2026-11-02T12:00:00Z")).toMatchObject({ ok: true });
  });
});

// ------------------------------------------------------------------ canaries through the whole path
const EMAIL = "canary.person@example.test";
const NAME = "Canary Persona Quux";
const DIGITS = "98765432101234";
const URL_ = `${API_SANDBOX}/v3/company/:realm/query`;

describe("canaries never reach a row, a transport event or the log", () => {
  it.each([400, 401, 403, 404, 429, 500, 503] as const)("Intuit answers %i with canary text everywhere", async (status) => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const conn = await h.connectViaCallback("PKG");
    const tokenCanaries = [...h.secrets.values()].flatMap((s) => {
      const t = JSON.parse(s) as { access_token: string; refresh_token: string };
      return [t.access_token, t.refresh_token];
    });
    expect(tokenCanaries.length).toBe(2);

    server.use(
      http.get(URL_, () =>
        HttpResponse.json(
          {
            Fault: { Error: [{ Message: `${NAME} ${EMAIL}`, Detail: `Bearer ${tokenCanaries[0]} ${NAME} ${EMAIL} ${DIGITS}`, code: status === 400 ? "2500" : status === 403 ? "120" : "3200", element: EMAIL }], type: "ValidationFault" },
            fault: { error: [{ message: EMAIL, detail: NAME, code: "3200" }] },
          },
          { status, headers: { intuit_tid: "synthetic-tid-0001", "retry-after": "1" } },
        ),
      ),
    );

    const rows: ScrubbedApiError[] = [];
    const events: unknown[] = [];
    const logs: LogEntry[] = [];
    const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
    const sink = createApiErrorSink({
      store: { insert: async (_l, _c, row) => void rows.push(row) },
      messageFor: (i) => classifyIntuitFailure(i).message,
      logger,
      transports: [{ name: "capture", send: (e) => void events.push(e) }],
    });
    const api = createQboApi({ tokens: h.tokens, environment: () => "sandbox", errors: sink, httpOptions: { sleep: async () => undefined, maxRetries: 0, random: () => 0 } });

    const e = await api.get("PKG", conn, "/v3/company/{realm}/query", { realm: FAKE_REALM }, { query: `select * from Customer where DisplayName = '${NAME}'` }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ConnectorError);
    expect(rows).toHaveLength(1);

    const stored = JSON.stringify(rows) + JSON.stringify(events) + JSON.stringify(logs.filter((l) => l.event.startsWith("connector.api_error")));
    for (const canary of [...tokenCanaries, EMAIL, NAME, "Canary", "Quux", FAKE_REALM, "select", "Customer", "DisplayName"]) expect(stored).not.toContain(canary);
    // no run of 5 or more digits anywhere in the stored row fields except the request id's, which is Intuit's own opaque id
    const row = rows[0] as ScrubbedApiError;
    expect(JSON.stringify({ ...row, provider_tid: null })).not.toMatch(/[0-9]{5,}/);
    expect(row.endpoint).toBe("/v3/company/{realm}/query");
    expect(row.http_status).toBe(status);
    expect(row.provider_message).toBe(classifyIntuitFailure(row as never).message);
    expect(row.provider_tid).toBe("synthetic-tid-0001");
  });

  it("a store that fails never breaks the API call's own error", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const conn = await h.connectViaCallback("PKG");
    server.use(http.get(URL_, () => HttpResponse.json({ Fault: { Error: [{ code: "2500" }] } }, { status: 400 })));
    const logs: LogEntry[] = [];
    const sink = createApiErrorSink({
      store: { insert: async () => { throw new Error(`password=hunter2 ${EMAIL}`); } },
      messageFor: (i) => classifyIntuitFailure(i).message,
      logger: createConnectorLogger({ sink: (x) => logs.push(x) }),
    });
    const api = createQboApi({ tokens: h.tokens, environment: () => "sandbox", errors: sink, httpOptions: { maxRetries: 0 } });
    const e = await api.get("PKG", conn, "/v3/company/{realm}/query", { realm: FAKE_REALM }).then(() => null, (x: unknown) => x);
    expect((e as ConnectorError).info.kind).toBe("invalid_input");
    expect(JSON.stringify(logs)).not.toContain("hunter2");
    expect(JSON.stringify(logs)).not.toContain(EMAIL);
  });

  it("a token-endpoint failure is not an API error and is not recorded", async () => {
    const intuit = createFakeIntuit();
    server.use(...intuit.handlers);
    const h = createQboHarness({ intuit });
    const conn = await h.connectViaCallback("PKG");
    intuit.state.failRefresh = { status: 401, error: "invalid_client", always: true };
    h.clock.t += 59 * 60_000;
    const rows: ScrubbedApiError[] = [];
    const sink = createApiErrorSink({ store: { insert: async (_l, _c, r) => void rows.push(r) }, messageFor: (i) => classifyIntuitFailure(i).message, logger: createConnectorLogger({ sink: () => undefined }) });
    const api = createQboApi({ tokens: h.tokens, environment: () => "sandbox", errors: sink, httpOptions: { maxRetries: 0 } });
    await api.get("PKG", conn, "/v3/company/{realm}/query", { realm: FAKE_REALM }).then(() => null, (x: unknown) => x);
    expect(rows).toEqual([]);
  });
});
