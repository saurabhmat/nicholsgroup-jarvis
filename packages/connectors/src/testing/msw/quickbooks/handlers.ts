// quickbooks mocks (MSW) for T-050. A stateful fake Intuit: OpenID discovery, the OAuth token endpoint (authorization
// code and refresh grants, with refresh-token rotation), revocation and the CompanyInfo API. Synthetic data only; no
// request reaches the real Intuit (unmatched requests are blocked by `useMockServer`).
// The fake's rotation rule: every refresh issues a new access and refresh token; every refresh token it has issued
// stays usable until it is replaced twice over (Intuit keeps the previous refresh token valid for a grace period).
import { delay, http, HttpResponse, type RequestHandler } from "msw";

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
  /** Milliseconds each token-endpoint call takes (lets tests overlap refreshes). */
  tokenDelayMs?: number;
  /** Seconds in `expires_in`. Default 3600. */
  expiresIn?: number;
  /** Seconds in `x_refresh_token_expires_in`. Default 8726400 (101 days). */
  refreshExpiresIn?: number;
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
  };
  const issue = () => {
    n += 1;
    const pair = { access: `synthetic-access-token-${String(n).padStart(4, "0")}`, refresh: `synthetic-refresh-token-${String(n).padStart(4, "0")}` };
    state.issued.push(pair);
    state.validAccess.add(pair.access);
    state.validRefresh.add(pair.refresh);
    // grace: keep only the two newest refresh tokens usable
    const keep = state.issued.slice(-2).map((p) => p.refresh);
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

  const handlers: RequestHandler[] = [
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
      if (params.realm !== realm || params.id !== realm) {
        return HttpResponse.json({ Fault: { Error: [{ Message: "Not found", code: "610" }], type: "ValidationFault" } }, { status: 404, headers: tidHeader() });
      }
      return HttpResponse.json(
        {
          CompanyInfo: {
            Id: realm,
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
