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
import { createHash, randomUUID } from "node:crypto";
import { HttpResponse, http, type RequestHandler } from "msw";

export const GRAPH = "https://graph.microsoft.com";
export const GRAPH_V1 = `${GRAPH}/v1.0`;
export const LOGIN = "https://login.microsoftonline.com";
export const OAUTH_TOKEN_TEMPLATE = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token";

export const FAKE_GRAPH_CLIENT_ID = "synthetic-graph-client-id-5521";
export const FAKE_GRAPH_CLIENT_SECRET = "synthetic-graph-client-secret-8830";
/** In every Entra error description and Graph error message the fake serves; the connector must never store or show it. */
export const MICROSOFT_ERROR_TEXT_CANARY = "microsoft-error-text-canary-7d41-not-real";

/** What the fake's token endpoint answers for one authorization code (T-066). Registered by the test with `fake.grant(code, ...)`. */
export type FakeGrant = {
  account: FakeMsAccount;
  /** The `code_challenge` of the authorize request: when set, the exchange must carry the matching `code_verifier` (PKCE, S256). */
  codeChallenge?: string;
  /** The `nonce` of the authorize request, echoed in the id_token. */
  nonce?: string;
  /** The `scope` of the answer: a string as is, `null` leaves the field out. Default: the three read scopes, fully qualified and lower-cased (the doc's example form). */
  scope?: string | null;
  /** Default true; false = no `refresh_token` in the answer. */
  refresh?: boolean;
  /**
   * The id_token: `undefined` = a well-formed one for the account's tenant; a string as is (garbage tests); `null` = none; an object =
   * the default claims with these overrides (an `undefined` value removes the claim).
   */
  idToken?: string | null | Record<string, unknown>;
};

/** An unsigned-looking test token (header.payload.signature): the connector checks no signature (V-6), so the signature part is a fixed filler. */
export function encodeFakeIdToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  return `${part({ typ: "JWT", alg: "RS256", kid: "synthetic-key" })}.${part(claims)}.c3ludGhldGljLXNpZ25hdHVyZS1ub3QtY2hlY2tlZA`;
}

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
  /** What `/me` answers for this account instead of the defaults (T-066): `mail: null` = no mailbox, `userType`/`userPrincipalName` for guests. `userType` is returned only when `$select` asks for it (Graph). */
  profile?: { mail?: string | null; userPrincipalName?: string; userType?: string };
  inflight: number;
  maxInflight: number;
};

export type TokenRequest = { tenant: string; fields: Record<string, string> };
export type GraphRequest = { method: string; path: string; authorization: string | null; address: string | null; search?: string };

export interface FakeMicrosoft {
  handlers: RequestHandler[];
  state: {
    tokenRequests: TokenRequest[];
    graphRequests: GraphRequest[];
    refreshes: number;
    /** Authorization codes redeemed successfully (T-066). */
    codeGrants: number;
    /** Every id_token the fake issued (so a canary test can look for it everywhere). */
    idTokens: string[];
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
  /** Registers an authorization code for the next `authorization_code` exchange (single use, as at Microsoft). */
  grant(code: string, grant: FakeGrant): void;
  /** Codes still unredeemed. */
  codes: Map<string, FakeGrant>;
  addAccount(tenant: string, address: string): FakeMsAccount;
  issueAccess(a: FakeMsAccount): string;
  issueRefresh(a: FakeMsAccount): string;
  accountFor(tenant: string, address: string): FakeMsAccount | undefined;
}

export function createFakeMicrosoft(): FakeMicrosoft {
  const accounts = new Map<string, FakeMsAccount>();
  const byAccess = new Map<string, FakeMsAccount>();
  const byRefresh = new Map<string, FakeMsAccount>();
  const codes = new Map<string, FakeGrant>();
  let counter = 0;
  const state: FakeMicrosoft["state"] = { tokenRequests: [], graphRequests: [], refreshes: 0, codeGrants: 0, idTokens: [], failRefresh: null, hold: null, refreshHold: null, unauthorizedOnce: 0, meBody: null, meFail: null };

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
      if (fields.grant_type === "authorization_code") {
        const grant = codes.get(fields.code ?? "");
        if (!grant) return oauthError(400, "invalid_grant", [70000]);
        codes.delete(fields.code ?? ""); // a code works once
        const { account: who } = grant;
        // A tenant-specific authority only lets that tenant's users in.
        if (tenant !== "organizations" && tenant !== who.tenant) return oauthError(400, "invalid_request", [50020]);
        if (grant.codeChallenge !== undefined && createHash("sha256").update(fields.code_verifier ?? "", "ascii").digest("base64url") !== grant.codeChallenge) return oauthError(400, "invalid_grant", [70000]);
        if (!fields.redirect_uri) return oauthError(400, "invalid_request", [900144]);
        const claims: Record<string, unknown> = {
          iss: `https://login.microsoftonline.com/${who.tenant}/v2.0`,
          aud: FAKE_GRAPH_CLIENT_ID,
          tid: who.tenant,
          oid: `synthetic-oid-${who.address}`,
          sub: `synthetic-sub-${who.address}`,
          iat: Math.floor(Date.now() / 1000),
          nbf: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          // Decoys: the connector must never take the mailbox from these (V-6).
          preferred_username: `decoy-upn-${who.address}`,
          email: `decoy-email-${who.address}`,
          ...(grant.nonce !== undefined ? { nonce: grant.nonce } : {}),
        };
        let idToken: string | undefined;
        if (typeof grant.idToken === "string") idToken = grant.idToken;
        else if (grant.idToken !== null) {
          const merged = { ...claims, ...(grant.idToken ?? {}) };
          idToken = encodeFakeIdToken(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)));
        }
        state.codeGrants += 1;
        if (idToken !== undefined) state.idTokens.push(idToken);
        return HttpResponse.json(
          {
            token_type: "Bearer",
            ...(grant.scope === null ? {} : { scope: grant.scope ?? "https://graph.microsoft.com/mail.read https://graph.microsoft.com/user.read https://graph.microsoft.com/calendars.read" }),
            expires_in: 3599,
            ext_expires_in: 3599,
            access_token: issueAccess(who),
            ...(grant.refresh === false ? {} : { refresh_token: issueRefresh(who) }),
            ...(idToken === undefined ? {} : { id_token: idToken }),
          },
          { headers: { "request-id": randomUUID() } },
        );
      }
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
      state.graphRequests.push({ method: request.method, path: new URL(request.url).pathname, authorization, address: account?.address ?? null, search: new URL(request.url).search });
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
        const p = account.profile ?? {};
        const select = new URL(request.url).searchParams.get("$select") ?? "";
        const wants = (f: string) => select === "" || select.split(",").includes(f);
        return HttpResponse.json(
          {
            id: `synthetic-user-${account.address}`,
            ...(wants("mail") ? { mail: p.mail === undefined ? account.address : p.mail } : {}),
            ...(wants("userPrincipalName") ? { userPrincipalName: p.userPrincipalName ?? account.address } : {}),
            // `userType` is returned only when asked for with `$select` (V-4/V-6 check).
            ...(select.split(",").includes("userType") ? { userType: p.userType ?? "Member" } : {}),
            displayName: "Synthetic Executive",
          },
          { headers: requestId },
        );
      } finally {
        account.inflight -= 1;
      }
    }),
  ];

  return { handlers, state, accounts, codes, grant: (code, g) => void codes.set(code, g), addAccount, issueAccess, issueRefresh, accountFor: (tenant: string, address: string) => accounts.get(`${tenant}\u0000${address}`) };
}

/** Default handlers for this provider (none: a test builds its own fake with `createFakeMicrosoft`). */
export const handlers: RequestHandler[] = [];
