// Fake Microsoft (MSW) for the connector tests (T-256): the Entra token endpoint (commercial cloud, one path per tenant) and the
// Graph `/me` read API, with synthetic accounts only (rule 10: example.test addresses, invented tenant ids and tokens). Each account
// is found by its bearer token or refresh token and carries its own tenant.
//
// Faithful where it matters to the token manager and the client (docs/plan-review.md, "T-256 verify items"):
//  - a refresh returns a NEW refresh token and does NOT revoke the old one (V-8): every refresh token ever issued stays valid until
//    `revoked` is set (which makes the answer 400 `invalid_grant`, as for a revoked or expired grant);
//  - OAuth errors use the OAuth shape `{ error, error_description, error_codes }`; Graph errors `{ error: { code, message } }`;
//  - a throttled account answers 429 (or 503) with `Retry-After`; throttling is per account, so another tenant is untouched;
//  - Graph error messages ECHO the bearer token, so a leak into an error, a log or a record would show.
// Every request is recorded (path, method, the Authorization header, the token request's form fields), and the number of requests
// in flight per account is tracked (`maxInflight`) with an optional hold that keeps responses open.
import { randomUUID } from "node:crypto";
import { HttpResponse, http, type RequestHandler } from "msw";

export const GRAPH = "https://graph.microsoft.com";
export const GRAPH_V1 = `${GRAPH}/v1.0`;
export const LOGIN = "https://login.microsoftonline.com";
export const OAUTH_TOKEN_TEMPLATE = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token";

export const FAKE_GRAPH_CLIENT_ID = "synthetic-graph-client-id-5521";
export const FAKE_GRAPH_CLIENT_SECRET = "synthetic-graph-client-secret-8830";
/** In every Entra error description and Graph error message the fake serves; the connector must never store or show it. */
export const MICROSOFT_ERROR_TEXT_CANARY = "microsoft-error-text-canary-7d41-not-real";

export type FakeMsAccount = {
  tenant: string;
  address: string;
  accessTokens: Set<string>;
  /** Every refresh token ever issued that is not revoked: the old one stays valid after a rotation (V-8). */
  refreshTokens: Set<string>;
  /** The newest refresh token. */
  refreshToken: string;
  revoked: boolean;
  /** When set, `/me` answers this status with Retry-After (`null` = no header) `remaining` more times (Infinity = always). */
  throttle: { status: 429 | 503; retryAfter: number | null; remaining: number } | null;
  inflight: number;
  maxInflight: number;
};

export type TokenRequest = { tenant: string; fields: Record<string, string> };
export type GraphRequest = { method: string; path: string; authorization: string | null; address: string | null };

export interface FakeMicrosoft {
  handlers: RequestHandler[];
  state: {
    tokenRequests: TokenRequest[];
    graphRequests: GraphRequest[];
    refreshes: number;
    /** Make the next token requests fail (status + OAuth `error`), `times` times (default: until cleared). */
    failRefresh: { status: number; error: string; codes?: number[]; times?: number } | null;
    /** Hold every `/me` response until this resolves (to observe concurrency). */
    hold: Promise<void> | null;
    /** Hold every token response until this resolves, so two instances overlap. */
    refreshHold: Promise<void> | null;
    /** Make the Graph answer 401 for the next N `/me` requests, whatever the token. */
    unauthorizedOnce: number;
    /** Answer `/me` with this body instead of the profile. */
    meBody: unknown;
    /** Answer the next `times` `/me` requests with this status and Graph error code (no Retry-After unless given). */
    meFail: { status: number; code: string; times: number; retryAfter?: number } | null;
  };
  accounts: Map<string, FakeMsAccount>;
  addAccount(tenant: string, address: string): FakeMsAccount;
  issueAccess(a: FakeMsAccount): string;
  issueRefresh(a: FakeMsAccount): string;
  accountFor(tenant: string, address: string): FakeMsAccount | undefined;
}

export function createFakeMicrosoft(): FakeMicrosoft {
  const accounts = new Map<string, FakeMsAccount>();
  const byAccess = new Map<string, FakeMsAccount>();
  const byRefresh = new Map<string, FakeMsAccount>();
  let counter = 0;
  const state: FakeMicrosoft["state"] = { tokenRequests: [], graphRequests: [], refreshes: 0, failRefresh: null, hold: null, refreshHold: null, unauthorizedOnce: 0, meBody: null, meFail: null };

  const issueAccess = (a: FakeMsAccount): string => {
    const t = `synthetic-ms-access-${String(++counter)}-${randomUUID()}`;
    a.accessTokens.add(t);
    byAccess.set(t, a);
    return t;
  };
  const issueRefresh = (a: FakeMsAccount): string => {
    const t = `synthetic-ms-refresh-${String(++counter)}-${randomUUID()}`;
    a.refreshTokens.add(t);
    a.refreshToken = t;
    byRefresh.set(t, a);
    return t;
  };
  function addAccount(tenant: string, address: string): FakeMsAccount {
    const a: FakeMsAccount = { tenant, address, accessTokens: new Set(), refreshTokens: new Set(), refreshToken: "", revoked: false, throttle: null, inflight: 0, maxInflight: 0 };
    issueRefresh(a);
    accounts.set(`${tenant}\u0000${address}`, a);
    return a;
  }

  const oauthError = (status: number, error: string, codes: number[] = []) =>
    HttpResponse.json({ error, error_description: `AADSTS${String(codes[0] ?? 0)}: ${MICROSOFT_ERROR_TEXT_CANARY}`, error_codes: codes, trace_id: randomUUID() }, { status, headers: { "request-id": randomUUID() } });

  const handlers: RequestHandler[] = [
    http.post(OAUTH_TOKEN_TEMPLATE.replace("{tenant}", ":tenant"), async ({ request, params }) => {
      const fields = Object.fromEntries(new URLSearchParams(await request.text()));
      const tenant = String(params.tenant);
      state.tokenRequests.push({ tenant, fields });
      if (state.refreshHold) await state.refreshHold;
      const f = state.failRefresh;
      if (f && (f.times === undefined || f.times > 0)) {
        if (f.times !== undefined) f.times -= 1;
        return oauthError(f.status, f.error, f.codes);
      }
      if (fields.client_id !== FAKE_GRAPH_CLIENT_ID || fields.client_secret !== FAKE_GRAPH_CLIENT_SECRET) return oauthError(401, "invalid_client", [7000215]);
      if (fields.grant_type !== "refresh_token") return oauthError(400, "unsupported_grant_type");
      const account = byRefresh.get(fields.refresh_token ?? "");
      if (!account || account.tenant !== tenant) return oauthError(400, "invalid_grant", [70000]);
      if (account.revoked) return oauthError(400, "invalid_grant", [70008]);
      state.refreshes += 1;
      return HttpResponse.json(
        { token_type: "Bearer", scope: "Mail.Read Calendars.Read User.Read", expires_in: 3599, ext_expires_in: 3599, access_token: issueAccess(account), refresh_token: issueRefresh(account) },
        { headers: { "request-id": randomUUID() } },
      );
    }),

    http.get(`${GRAPH_V1}/me`, async ({ request }) => {
      const authorization = request.headers.get("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const account = byAccess.get(bearer);
      state.graphRequests.push({ method: request.method, path: new URL(request.url).pathname, authorization, address: account?.address ?? null });
      const requestId = { "request-id": randomUUID() };
      if (state.unauthorizedOnce > 0) {
        state.unauthorizedOnce -= 1;
        return HttpResponse.json({ error: { code: "InvalidAuthenticationToken", message: `${bearer} ${MICROSOFT_ERROR_TEXT_CANARY}` } }, { status: 401, headers: requestId });
      }
      if (!account || !account.accessTokens.has(bearer)) {
        return HttpResponse.json({ error: { code: "InvalidAuthenticationToken", message: `Access token ${bearer} is invalid. ${MICROSOFT_ERROR_TEXT_CANARY}` } }, { status: 401, headers: requestId });
      }
      account.inflight += 1;
      account.maxInflight = Math.max(account.maxInflight, account.inflight);
      try {
        if (state.hold) await state.hold;
        const fail = state.meFail;
        if (fail && fail.times > 0) {
          fail.times -= 1;
          return HttpResponse.json({ error: { code: fail.code, message: MICROSOFT_ERROR_TEXT_CANARY } }, { status: fail.status, headers: { ...requestId, ...(fail.retryAfter === undefined ? {} : { "retry-after": String(fail.retryAfter) }) } });
        }
        const t = account.throttle;
        if (t && t.remaining > 0) {
          t.remaining -= 1;
          return HttpResponse.json({ error: { code: "TooManyRequests", message: MICROSOFT_ERROR_TEXT_CANARY } }, { status: t.status, headers: { ...requestId, ...(t.retryAfter === null ? {} : { "retry-after": String(t.retryAfter) }) } });
        }
        if (state.meBody !== null) return HttpResponse.json(state.meBody as never, { headers: requestId });
        return HttpResponse.json({ id: `synthetic-user-${account.address}`, mail: account.address, userPrincipalName: account.address, displayName: "Synthetic Executive" }, { headers: requestId });
      } finally {
        account.inflight -= 1;
      }
    }),
  ];

  return { handlers, state, accounts, addAccount, issueAccess, issueRefresh, accountFor: (tenant: string, address: string) => accounts.get(`${tenant}\u0000${address}`) };
}

/** Default handlers for this provider (none: a test builds its own fake with `createFakeMicrosoft`). */
export const handlers: RequestHandler[] = [];
