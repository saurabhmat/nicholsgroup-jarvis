// quickbooks mocks (MSW) for T-050. A stateful fake Intuit: OpenID discovery, the OAuth token endpoint (authorization
// code and refresh grants, with refresh-token rotation), revocation and the CompanyInfo API. Synthetic data only; no
// request reaches the real Intuit (unmatched requests are blocked by `useMockServer`).
// The fake's rotation rule: every refresh issues a new access and refresh token; every refresh token it has issued
// stays usable until it is replaced twice over (Intuit keeps the previous refresh token valid for a grace period).
import { delay, http, HttpResponse, type RequestHandler } from "msw";
import { type FakeData, type FakeObject, type FakeReports, syntheticPreferences, syntheticReports } from "./fixtures";

export const API_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
export const API_PRODUCTION = "https://quickbooks.api.intuit.com";
export const OAUTH_ORIGIN = "https://oauth.platform.intuit.com";
export const OAUTH_TOKEN = `${OAUTH_ORIGIN}/oauth2/v1/tokens/bearer`;
export const DISCOVERY_ORIGIN = "https://developer.api.intuit.com";
export const REVOKE_URL = `${DISCOVERY_ORIGIN}/v2/oauth2/tokens/revoke`;
export const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";

/** Synthetic client credentials the fake accepts. */
export const FAKE_CLIENT_ID = "synthetic-intuit-client-id";
export const FAKE_CLIENT_SECRET = "synthetic-intuit-client-secret-01";
/** Synthetic realm (a QuickBooks company id is digits). */
export const FAKE_REALM = "9341450000000001";
export const FAKE_CODE = "synthetic-code-0001";

export function discoveryDocument(environment: "sandbox" | "production" = "sandbox") {
  return {
    issuer: "https://oauth.platform.intuit.com/op/v1",
    authorization_endpoint: AUTHORIZE_URL,
    token_endpoint: OAUTH_TOKEN,
    revocation_endpoint: REVOKE_URL,
    userinfo_endpoint: `https://${environment === "sandbox" ? "sandbox-" : ""}accounts.platform.intuit.com/v1/openid_connect/userinfo`,
    jwks_uri: "https://oauth.platform.intuit.com/op/v1/jwks",
    response_types_supported: ["code"],
  };
}

export type FakeIntuitOptions = {
  environment?: "sandbox" | "production";
  /** Realm the CompanyInfo API answers for. */
  realm?: string;
  /** More realms the CompanyInfo API answers for (a token is valid for every company the fake knows). */
  extraRealms?: string[];
  /** Milliseconds each token-endpoint call takes (lets tests overlap refreshes). */
  tokenDelayMs?: number;
  /** Seconds in `expires_in`. Default 3600. */
  expiresIn?: number;
  /** Seconds in `x_refresh_token_expires_in`. Default 8726400 (101 days). */
  refreshExpiresIn?: number;
  /**
   * No grace period: only the newest refresh token is valid, so a second refresh with a token that was just replaced is
   * `invalid_grant` (the strictest reading of "the refresh token rotates").
   */
  strictRotation?: boolean;
  /** Entities the query and CDC endpoints serve (T-051). Default: none. */
  data?: FakeData;
  /** The Preferences object the API serves. Default: everything off. */
  preferences?: FakeObject;
};

export type FakeIntuit = {
  handlers: RequestHandler[];
  state: {
    discoveryRequests: number;
    /** Token-endpoint requests, in order. */
    tokenRequests: { grant: string; auth: string | null; form: URLSearchParams }[];
    apiRequests: { realm: string; authorization: string | null; minorversion: string | null; method: string }[];
    revokeRequests: { auth: string | null; body: unknown }[];
    /** Every access/refresh token issued, in order. */
    issued: { access: string; refresh: string }[];
    /** Make the next refresh answer this (consumed once), or `always` for every refresh. */
    failRefresh: { status: number; error: string; always?: boolean } | null;
    /** Next N CompanyInfo calls answer 401 regardless of the token. */
    reject401: number;
    /** Next N CompanyInfo calls answer this status. */
    failApi: { status: number; times: number } | null;
    /** Access tokens the API accepts. */
    validAccess: Set<string>;
    /** Refresh tokens the token endpoint accepts. */
    validRefresh: Set<string>;
    /** T-051: served entities (mutable), CDC deletions and what was asked. */
    data: FakeData;
    preferences: FakeObject;
    deleted: { entity: string; Id: string; at: string }[];
    /** Objects per entity a CDC answer holds before it is cut off (Intuit: 1000). */
    cdcCap: number;
    queries: string[];
    cdcRequests: { entities: string; changedSince: string }[];
    preferencesRequests: number;
    /** T-052: report answers by Intuit's report name, and what was asked (query strings as sent). */
    reports: FakeReports;
    reportRequests: { name: string; query: Record<string, string> }[];
    /** Any request to the API that is not a GET on a known read path (must stay empty). */
    unexpected: { method: string; path: string }[];
    /** Next N query/CDC/Preferences calls answer this status (429 gets Retry-After: 0). */
    failRead: { status: number; times: number } | null;
  };
  /** Mark an access token expired at the provider (the API answers 401 for it). */
  expireAccess(token: string): void;
};

const FAKE_BASIC = () => `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString("base64")}`;

export function createFakeIntuit(options: FakeIntuitOptions = {}): FakeIntuit {
  const environment = options.environment ?? "sandbox";
  const realm = options.realm ?? FAKE_REALM;
  let n = 0;
  let tid = 0;
  const nextTid = () => `synthetic-tid-${String(++tid).padStart(4, "0")}`;
  const state: FakeIntuit["state"] = {
    discoveryRequests: 0,
    tokenRequests: [],
    apiRequests: [],
    revokeRequests: [],
    issued: [],
    failRefresh: null,
    reject401: 0,
    failApi: null,
    validAccess: new Set(),
    validRefresh: new Set(),
    data: options.data ?? {},
    preferences: options.preferences ?? syntheticPreferences(),
    deleted: [],
    cdcCap: 1000,
    queries: [],
    cdcRequests: [],
    preferencesRequests: 0,
    reports: syntheticReports(),
    reportRequests: [],
    unexpected: [],
    failRead: null,
  };
  const issue = () => {
    n += 1;
    const pair = { access: `synthetic-access-token-${String(n).padStart(4, "0")}`, refresh: `synthetic-refresh-token-${String(n).padStart(4, "0")}` };
    state.issued.push(pair);
    state.validAccess.add(pair.access);
    state.validRefresh.add(pair.refresh);
    // grace: keep only the two newest refresh tokens usable
    const keep = state.issued.slice(options.strictRotation ? -1 : -2).map((p) => p.refresh);
    for (const r of [...state.validRefresh]) if (!keep.includes(r)) state.validRefresh.delete(r);
    return {
      access_token: pair.access,
      refresh_token: pair.refresh,
      token_type: "bearer",
      expires_in: options.expiresIn ?? 3600,
      x_refresh_token_expires_in: options.refreshExpiresIn ?? 8_726_400,
    };
  };
  const api = environment === "sandbox" ? API_SANDBOX : API_PRODUCTION;
  const tidHeader = () => ({ intuit_tid: nextTid() });

  /** Auth + injected failures shared by the T-051 read endpoints; null = proceed. */
  const readGate = (request: Request, params: Record<string, string | readonly string[] | undefined>): Response | null => {
    const authorization = request.headers.get("authorization");
    state.apiRequests.push({ realm: String(params.realm), authorization, minorversion: new URL(request.url).searchParams.get("minorversion"), method: request.method });
    if (state.failRead && state.failRead.times > 0) {
      state.failRead.times -= 1;
      const headers: Record<string, string> = { ...tidHeader() };
      if (state.failRead.status === 429) headers["Retry-After"] = "0";
      return HttpResponse.json({ Fault: { Error: [{ Message: "synthetic failure", code: "9999" }], type: "SystemFault" } }, { status: state.failRead.status, headers });
    }
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!state.validAccess.has(token)) {
      return HttpResponse.json({ Fault: { Error: [{ Message: "AuthenticationFailed", code: "003200", Detail: "Token invalid" }], type: "AUTHENTICATION" } }, { status: 401, headers: tidHeader() });
    }
    if (!(params.realm === realm || options.extraRealms?.includes(String(params.realm)))) {
      return HttpResponse.json({ Fault: { Error: [{ Message: "Not found", code: "610" }], type: "ValidationFault" } }, { status: 404, headers: tidHeader() });
    }
    return null;
  };
  const updatedAt = (o: FakeObject) => Date.parse(String((o.MetaData as { LastUpdatedTime?: string } | undefined)?.LastUpdatedTime ?? ""));

  const handlers: RequestHandler[] = [
    http.get(`${api}/v3/company/:realm/preferences`, ({ request, params }) => {
      const denied = readGate(request, params);
      if (denied) return denied;
      state.preferencesRequests += 1;
      return HttpResponse.json({ Preferences: state.preferences, time: new Date().toISOString() }, { headers: tidHeader() });
    }),
    http.get(`${api}/v3/company/:realm/query`, ({ request, params }) => {
      const denied = readGate(request, params);
      if (denied) return denied;
      const q = new URL(request.url).searchParams.get("query") ?? "";
      state.queries.push(q);
      const m = /^select \* from (\w+)( where Active in \(true, false\))? ORDERBY Id STARTPOSITION (\d+) MAXRESULTS (\d+)$/.exec(q);
      if (!m) return HttpResponse.json({ Fault: { Error: [{ Message: "QueryParserError", code: "4000" }], type: "ValidationFault" } }, { status: 400, headers: tidHeader() });
      const [, entity = "", , start = "1", max = "1000"] = m;
      const all = state.data[entity] ?? [];
      const page = all.slice(Number(start) - 1, Number(start) - 1 + Number(max));
      return HttpResponse.json({ QueryResponse: page.length ? { [entity]: page, startPosition: Number(start), maxResults: page.length } : {}, time: new Date().toISOString() }, { headers: tidHeader() });
    }),
    http.get(`${api}/v3/company/:realm/cdc`, ({ request, params }) => {
      const denied = readGate(request, params);
      if (denied) return denied;
      const url = new URL(request.url);
      const entities = url.searchParams.get("entities") ?? "";
      const changedSince = url.searchParams.get("changedSince") ?? "";
      state.cdcRequests.push({ entities, changedSince });
      const since = Date.parse(changedSince);
      if (Number.isNaN(since)) return HttpResponse.json({ Fault: { Error: [{ Message: "bad changedSince", code: "2030" }], type: "ValidationFault" } }, { status: 400, headers: tidHeader() });
      const parts = entities.split(",").filter(Boolean).map((entity) => {
        const changed = (state.data[entity] ?? []).filter((o) => updatedAt(o) > since).slice(0, state.cdcCap);
        const gone = state.deleted.filter((d) => d.entity === entity && Date.parse(d.at) > since).map((d) => ({ Id: d.Id, domain: "QBO", status: "Deleted", MetaData: { LastUpdatedTime: d.at } }));
        const all = [...changed, ...gone];
        return all.length ? { [entity]: all, startPosition: 1, maxResults: all.length } : {};
      });
      return HttpResponse.json({ CDCResponse: [{ QueryResponse: parts }], time: new Date().toISOString() }, { headers: tidHeader() });
    }),
    http.get(`${api}/v3/company/:realm/reports/:name`, ({ request, params }) => {
      const denied = readGate(request, params);
      if (denied) return denied;
      const name = String(params.name);
      state.reportRequests.push({ name, query: Object.fromEntries(new URL(request.url).searchParams) });
      const report = state.reports[name];
      if (!report) return HttpResponse.json({ Fault: { Error: [{ Message: "Invalid report name", code: "4000" }], type: "ValidationFault" } }, { status: 400, headers: tidHeader() });
      return HttpResponse.json(report, { headers: tidHeader() });
    }),
    // Anything else under the company path that is not the CompanyInfo read must never be called by the sync.
    http.all(`${api}/v3/company/:realm/*`, ({ request }) => {
      const p = new URL(request.url).pathname.replace(/\/v3\/company\/[^/]+/, "");
      if (request.method === "GET" && p.startsWith("/companyinfo/")) return undefined; // handled below
      state.unexpected.push({ method: request.method, path: p });
      return HttpResponse.json({ Fault: { Error: [{ Message: "not available", code: "500" }], type: "SystemFault" } }, { status: 500, headers: tidHeader() });
    }),
    http.get(`${DISCOVERY_ORIGIN}/.well-known/openid_sandbox_configuration`, () => {
      state.discoveryRequests += 1;
      return HttpResponse.json(discoveryDocument("sandbox"), { headers: tidHeader() });
    }),
    http.get(`${DISCOVERY_ORIGIN}/.well-known/openid_configuration`, () => {
      state.discoveryRequests += 1;
      return HttpResponse.json(discoveryDocument("production"), { headers: tidHeader() });
    }),
    http.post(OAUTH_TOKEN, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const grant = form.get("grant_type") ?? "";
      state.tokenRequests.push({ grant, auth: request.headers.get("authorization"), form });
      if (options.tokenDelayMs) await delay(options.tokenDelayMs);
      if (request.headers.get("authorization") !== FAKE_BASIC()) {
        return HttpResponse.json({ error: "invalid_client" }, { status: 401, headers: tidHeader() });
      }
      if (grant === "authorization_code") {
        if (form.get("code") !== FAKE_CODE) return HttpResponse.json({ error: "invalid_grant" }, { status: 400, headers: tidHeader() });
        return HttpResponse.json(issue(), { headers: tidHeader() });
      }
      if (grant === "refresh_token") {
        const fail = state.failRefresh;
        if (fail) {
          if (!fail.always) state.failRefresh = null;
          return HttpResponse.json({ error: fail.error }, { status: fail.status, headers: tidHeader() });
        }
        if (!state.validRefresh.has(form.get("refresh_token") ?? "")) {
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400, headers: tidHeader() });
        }
        return HttpResponse.json(issue(), { headers: tidHeader() });
      }
      return HttpResponse.json({ error: "unsupported_grant_type" }, { status: 400, headers: tidHeader() });
    }),
    http.post(REVOKE_URL, async ({ request }) => {
      state.revokeRequests.push({ auth: request.headers.get("authorization"), body: await request.json().catch(() => null) });
      return new HttpResponse(null, { status: 200, headers: tidHeader() });
    }),
    http.get(`${api}/v3/company/:realm/companyinfo/:id`, ({ request, params }) => {
      const authorization = request.headers.get("authorization");
      const url = new URL(request.url);
      state.apiRequests.push({ realm: String(params.realm), authorization, minorversion: url.searchParams.get("minorversion"), method: request.method });
      if (state.reject401 > 0) {
        state.reject401 -= 1;
        return HttpResponse.json({ Fault: { Error: [{ Message: "AuthenticationFailed", code: "003200", Detail: "Token expired" }], type: "AUTHENTICATION" } }, { status: 401, headers: tidHeader() });
      }
      if (state.failApi && state.failApi.times > 0) {
        state.failApi.times -= 1;
        return HttpResponse.json({ Fault: { Error: [{ Message: "synthetic failure", code: "9999" }], type: "SystemFault" } }, { status: state.failApi.status, headers: tidHeader() });
      }
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!state.validAccess.has(token)) {
        return HttpResponse.json({ Fault: { Error: [{ Message: "AuthenticationFailed", code: "003200", Detail: "Token invalid" }], type: "AUTHENTICATION" } }, { status: 401, headers: tidHeader() });
      }
      if (!(params.realm === realm || options.extraRealms?.includes(String(params.realm))) || params.id !== params.realm) {
        return HttpResponse.json({ Fault: { Error: [{ Message: "Not found", code: "610" }], type: "ValidationFault" } }, { status: 404, headers: tidHeader() });
      }
      return HttpResponse.json(
        {
          CompanyInfo: {
            Id: String(params.realm),
            CompanyName: "Synthetic Test Company",
            LegalName: "Synthetic Test Company LLC",
            Country: "US",
            FiscalYearStartMonth: "January",
            CompanyStartDate: "2020-01-01",
            // Personal data the connector must never keep:
            Email: { Address: "synthetic.person@example.test" },
            CompanyAddr: { Line1: "1 Synthetic Way", City: "Testville" },
          },
          time: new Date().toISOString(),
        },
        { headers: tidHeader() },
      );
    }),
  ];

  return { handlers, state, expireAccess: (token) => void state.validAccess.delete(token) };
}

/** Default handlers for this provider: none (tests build a `createFakeIntuit` so they own its state). */
export const handlers: RequestHandler[] = [];
