// Fake Microsoft Teams (MSW) for the connector tests (T-279): the Entra token endpoint of the TEAMS app (its own synthetic client id and secret, so a test can prove the mail app's
// credentials are never used) and the Graph reads and the one write the Teams connector may make, with synthetic accounts only (rule 10: example.test addresses, invented tenant ids,
// object ids and tokens). Each account is found by its bearer token or refresh token and carries its own tenant. No chat text exists in the fake: the answers hold only ids, so a canary
// test can plant its own.
//
// Faithful where it matters: a refresh returns a NEW refresh token and does not revoke the old one (as for mail); OAuth errors use the OAuth shape, Graph errors the Graph shape and
// ECHO the bearer token (so a leak into an error, a log or a record would show); a token response lists scopes as the test configures them (Microsoft lists every scope already
// consented for the app in the tenant, not only the requested ones). Every request is recorded (method, path, query, Authorization, token form fields).
import { createHash, randomUUID } from "node:crypto";
import { HttpResponse, http, type RequestHandler } from "msw";

export const GRAPH_V1 = "https://graph.microsoft.com/v1.0";
export const LOGIN = "https://login.microsoftonline.com";
export const FAKE_TEAMS_CLIENT_ID = "synthetic-teams-client-id-7741";
export const FAKE_TEAMS_CLIENT_SECRET = "synthetic-teams-client-secret-3392";
/** In every error text the fake serves; the connector must never store or show it. */
export const TEAMS_ERROR_TEXT_CANARY = "teams-error-text-canary-5b19-not-real";

export type FakeTeamsAccount = {
  tenant: string;
  upn: string;
  /** The Entra object id (`/me` id). */
  objectId: string;
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  refreshToken: string;
  revoked: boolean;
  /** What `/me` answers instead of the defaults: a guest (`userType`), another sign-in name. `userType` is returned only when `$select` asks for it (Graph). */
  profile?: { userPrincipalName?: string | null; userType?: string | null; id?: string };
};

export type FakeTeamsGrant = {
  account: FakeTeamsAccount;
  codeChallenge?: string;
  redirectUri?: string;
  nonce?: string;
  /** The `scope` of the answer: a string as is, `null` leaves the field out. */
  scope?: string | null;
  refresh?: boolean;
  /** `undefined` = a well-formed id_token for the account's tenant; a string as is; `null` = none; an object = the default claims with these overrides (an `undefined` value removes the claim). */
  idToken?: string | null | Record<string, unknown>;
};

export function encodeFakeIdToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
  return `${part({ typ: "JWT", alg: "RS256", kid: "synthetic-key" })}.${part(claims)}.c3ludGhldGljLXNpZ25hdHVyZS1ub3QtY2hlY2tlZA`;
}

export type TeamsGraphRequest = { method: string; path: string; search: string; authorization: string | null; body: unknown };
export type TeamsTokenRequest = { tenant: string; fields: Record<string, string> };

export interface FakeTeams {
  handlers: RequestHandler[];
  state: {
    tokenRequests: TeamsTokenRequest[];
    graphRequests: TeamsGraphRequest[];
    refreshes: number;
    codeGrants: number;
    idTokens: string[];
    failRefresh: { status: number; error: string; codes?: number[]; times?: number } | null;
    /** Make the Graph answer 401 for the next N requests, whatever the token. */
    unauthorizedOnce: number;
    /** Answer the next `times` Graph requests with this status. */
    graphFail: { status: number; code: string; times: number; retryAfter?: number } | null;
    /** The next POST to a message route answers this status instead of 201 (a timeout is a test's own fetch). */
    postStatus: number | null;
  };
  accounts: Map<string, FakeTeamsAccount>;
  codes: Map<string, FakeTeamsGrant>;
  grant(code: string, grant: FakeTeamsGrant): void;
  addAccount(tenant: string, upn: string): FakeTeamsAccount;
  issueAccess(a: FakeTeamsAccount): string;
  issueRefresh(a: FakeTeamsAccount): string;
  accountFor(tenant: string, upn: string): FakeTeamsAccount | undefined;
}

export function createFakeTeams(): FakeTeams {
  const accounts = new Map<string, FakeTeamsAccount>();
  const byAccess = new Map<string, FakeTeamsAccount>();
  const byRefresh = new Map<string, FakeTeamsAccount>();
  const codes = new Map<string, FakeTeamsGrant>();
  let counter = 0;
  const state: FakeTeams["state"] = { tokenRequests: [], graphRequests: [], refreshes: 0, codeGrants: 0, idTokens: [], failRefresh: null, unauthorizedOnce: 0, graphFail: null, postStatus: null };

  const issueAccess = (a: FakeTeamsAccount): string => {
    const t = `synthetic-teams-access-${String(++counter)}-${randomUUID()}`;
    a.accessTokens.add(t);
    byAccess.set(t, a);
    return t;
  };
  const issueRefresh = (a: FakeTeamsAccount): string => {
    const t = `synthetic-teams-refresh-${String(++counter)}-${randomUUID()}`;
    a.refreshTokens.add(t);
    a.refreshToken = t;
    byRefresh.set(t, a);
    return t;
  };
  function addAccount(tenant: string, upn: string): FakeTeamsAccount {
    const a: FakeTeamsAccount = { tenant, upn, objectId: randomUUID(), accessTokens: new Set(), refreshTokens: new Set(), refreshToken: "", revoked: false };
    issueRefresh(a);
    accounts.set(`${tenant}\u0000${upn}`, a);
    return a;
  }

  const oauthError = (status: number, error: string, codes: number[] = []) =>
    HttpResponse.json({ error, error_description: `AADSTS${String(codes[0] ?? 0)}: ${TEAMS_ERROR_TEXT_CANARY}`, error_codes: codes, trace_id: randomUUID() }, { status, headers: { "request-id": randomUUID() } });

  /** Records the request and answers the shared failures (401 once, a configured failure); returns the account or a response. */
  async function graph(request: Request): Promise<{ account: FakeTeamsAccount } | { response: Response }> {
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const account = byAccess.get(bearer);
    const url = new URL(request.url);
    let body: unknown = null;
    if (request.method !== "GET") body = await request.clone().json().catch(() => null);
    state.graphRequests.push({ method: request.method, path: url.pathname, search: url.search, authorization, body });
    const requestId = { "request-id": randomUUID() };
    if (state.unauthorizedOnce > 0) {
      state.unauthorizedOnce -= 1;
      return { response: HttpResponse.json({ error: { code: "InvalidAuthenticationToken", message: `${bearer} ${TEAMS_ERROR_TEXT_CANARY}` } }, { status: 401, headers: requestId }) };
    }
    if (!account || !account.accessTokens.has(bearer)) {
      return { response: HttpResponse.json({ error: { code: "InvalidAuthenticationToken", message: `Access token ${bearer} is invalid. ${TEAMS_ERROR_TEXT_CANARY}` } }, { status: 401, headers: requestId }) };
    }
    const fail = state.graphFail;
    if (fail && fail.times > 0) {
      fail.times -= 1;
      return { response: HttpResponse.json({ error: { code: fail.code, message: TEAMS_ERROR_TEXT_CANARY } }, { status: fail.status, headers: { ...requestId, ...(fail.retryAfter === undefined ? {} : { "retry-after": String(fail.retryAfter) }) } }) };
    }
    return { account };
  }

  const handlers: RequestHandler[] = [
    http.post(`${LOGIN}/:tenant/oauth2/v2.0/token`, async ({ request, params }) => {
      const fields = Object.fromEntries(new URLSearchParams(await request.text()));
      const tenant = String(params.tenant);
      state.tokenRequests.push({ tenant, fields });
      const f = state.failRefresh;
      if (f && (f.times === undefined || f.times > 0)) {
        if (f.times !== undefined) f.times -= 1;
        return oauthError(f.status, f.error, f.codes);
      }
      if (fields.client_id !== FAKE_TEAMS_CLIENT_ID || fields.client_secret !== FAKE_TEAMS_CLIENT_SECRET) return oauthError(401, "invalid_client", [7000215]);
      if (fields.grant_type === "authorization_code") {
        const grant = codes.get(fields.code ?? "");
        if (!grant) return oauthError(400, "invalid_grant", [70000]);
        codes.delete(fields.code ?? "");
        const who = grant.account;
        if (tenant !== "organizations" && tenant !== who.tenant) return oauthError(400, "invalid_request", [50020]);
        if (grant.codeChallenge !== undefined && createHash("sha256").update(fields.code_verifier ?? "", "ascii").digest("base64url") !== grant.codeChallenge) return oauthError(400, "invalid_grant", [70000]);
        if (!fields.redirect_uri || (grant.redirectUri !== undefined && fields.redirect_uri !== grant.redirectUri)) return oauthError(400, "invalid_grant", [50011]);
        const claims: Record<string, unknown> = {
          iss: `${LOGIN}/${who.tenant}/v2.0`,
          aud: FAKE_TEAMS_CLIENT_ID,
          tid: who.tenant,
          oid: who.objectId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          // Decoys: the connector must never take the account from these.
          preferred_username: `decoy-upn-${who.upn}`,
          email: `decoy-email-${who.upn}`,
          ...(grant.nonce !== undefined ? { nonce: grant.nonce } : {}),
        };
        let idToken: string | undefined;
        if (typeof grant.idToken === "string") idToken = grant.idToken;
        else if (grant.idToken !== null) idToken = encodeFakeIdToken(Object.fromEntries(Object.entries({ ...claims, ...(grant.idToken ?? {}) }).filter(([, v]) => v !== undefined)));
        state.codeGrants += 1;
        if (idToken !== undefined) state.idTokens.push(idToken);
        return HttpResponse.json(
          {
            token_type: "Bearer",
            ...(grant.scope === null ? {} : { scope: grant.scope ?? "openid offline_access User.Read Chat.Read" }),
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
        { token_type: "Bearer", scope: "User.Read Chat.Read", expires_in: 3599, ext_expires_in: 3599, access_token: issueAccess(account), refresh_token: issueRefresh(account) },
        { headers: { "request-id": randomUUID() } },
      );
    }),

    http.get(`${GRAPH_V1}/me`, async ({ request }) => {
      const r = await graph(request);
      if ("response" in r) return r.response;
      const p = r.account.profile ?? {};
      const select = new URL(request.url).searchParams.get("$select") ?? "";
      const wants = (f: string) => select === "" || select.split(",").includes(f);
      return HttpResponse.json(
        {
          ...(wants("id") ? { id: p.id ?? r.account.objectId } : {}),
          ...(wants("userPrincipalName") ? { userPrincipalName: p.userPrincipalName === undefined ? r.account.upn : p.userPrincipalName } : {}),
          ...(select.split(",").includes("userType") ? { userType: p.userType === undefined ? "Member" : p.userType } : {}),
          displayName: "Synthetic Person",
        },
        { headers: { "request-id": randomUUID() } },
      );
    }),
    // Reads that carry ids only (no chat text): enough to prove which routes are reachable and what a request looks like.
    http.get(`${GRAPH_V1}/me/chats`, async ({ request }) => {
      const r = await graph(request);
      return "response" in r ? r.response : HttpResponse.json({ value: [] });
    }),
    http.get(`${GRAPH_V1}/chats/:chatId/messages`, async ({ request }) => {
      const r = await graph(request);
      return "response" in r ? r.response : HttpResponse.json({ value: [] });
    }),
    http.get(`${GRAPH_V1}/users/:userId`, async ({ request }) => {
      const r = await graph(request);
      return "response" in r ? r.response : HttpResponse.json({ userPrincipalName: "synthetic.person@teams.example.test" });
    }),
    http.get(`${GRAPH_V1}/me/joinedTeams`, async ({ request }) => {
      const r = await graph(request);
      return "response" in r ? r.response : HttpResponse.json({ value: [] });
    }),
    // The one write the Teams connector may make (the approvals executor, T-286): a message in a chat.
    http.post(`${GRAPH_V1}/chats/:chatId/messages`, async ({ request }) => {
      const r = await graph(request);
      if ("response" in r) return r.response;
      const status = state.postStatus ?? 201;
      state.postStatus = null;
      if (status !== 201) return HttpResponse.json({ error: { code: "Forbidden", message: TEAMS_ERROR_TEXT_CANARY } }, { status, headers: { "request-id": randomUUID() } });
      return HttpResponse.json({ id: `synthetic-message-${randomUUID()}` }, { status: 201, headers: { "request-id": randomUUID() } });
    }),
  ];

  return { handlers, state, accounts, codes, grant: (code, g) => void codes.set(code, g), addAccount, issueAccess, issueRefresh, accountFor: (tenant, upn) => accounts.get(`${tenant}\u0000${upn}`) };
}

/** Default handlers for this provider (none: a test builds its own fake with `createFakeTeams`). */
export const handlers: RequestHandler[] = [];
