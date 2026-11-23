// The OAuth connect flow (T-035), generic over providers. A provider (T-050 QuickBooks, T-063 Google, ...) supplies an
// `OAuthProvider`: endpoints, client credentials, scopes, and `identify` (which account was connected, when the
// credential expires). The flow does the rest:
//
// start:    authorize (owner/admin_technical at aal2, by the caller) → new state + PKCE verifier stored for this user
//           and lane (only the state's hash) → audited → the provider's authorization URL.
// callback: lane from the state → authorize again → consume the state (same user, same lane, once, within 10 min) →
//           exchange the code with the verifier (through the HTTP client) → identify the account → create or reuse the
//           connection row → store the token set in the Vault (it never leaves as plain text) → audited.
//
// Results are coarse reason codes for the UI; provider text, codes and tokens never reach the browser or the audit log.
import type { LaneId } from "@nichols/core";
import { withAudit, type Audit } from "@nichols/core/audit";
import type { LaneClient } from "@nichols/core/lane-router";
import { z } from "zod";
import { ACCOUNT_IN_USE_MESSAGE, ACCOUNT_OWNED_BY_OTHER_MESSAGE, ConnectorError, isConnectorError, TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { Provider } from "../contract/schemas";
import { createHttpClient, basicCredentials, type HttpClient } from "../http/client";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { SecretValue } from "../vault/secret";
import { codeChallenge, connectionOfState, hashState, laneOfState, newCodeVerifier, newState, nonceOf } from "./pkce";
import type { StateStore } from "./state";

/** Who may connect or reconnect an account (T-050: owner or admin_technical of the lane). QuickBooks and every provider but the mail ones. */
export const CONNECT_ROLES = ["owner", "admin_technical"] as const;

/**
 * T-247: a person's own Google account is connected by the person: any member who holds the `own_mail` view (owner, admin_technical,
 * viewer). The database decides again (core.oauth_state_create / consume: own_mail for google), so this list is only the first,
 * friendly check. Nobody connects a mailbox for someone else: the connection's owner is the signed-in user.
 */
export const MAIL_CONNECT_ROLES = ["owner", "admin_technical", "viewer"] as const;

/** The roles that may start or finish a connect of this provider. */
export function connectRolesFor(provider: string): readonly ("owner" | "admin_technical" | "viewer")[] {
  // T-278: a person's own Teams account (provider `microsoft_teams`) is connected by the person, like their own mailbox (the database checks own_mail again).
  return provider === "google" || provider === "microsoft" || provider === "microsoft_teams" ? MAIL_CONNECT_ROLES : CONNECT_ROLES;
}

/**
 * Providers whose connections belong to one person (core.connections.owner_user_id): a person's mailbox or calendar (T-247) and, since T-278, their own Teams
 * account. NOT a statement that the row is a mailbox: no mail or calendar reader reads this set (a `microsoft_teams` row is never a mailbox).
 */
const MAIL_PROVIDERS: ReadonlySet<string> = new Set(["google", "microsoft", "microsoft_teams"]);

/** The provider's token response; extra fields (x_refresh_token_expires_in, id_token, ...) are kept for `identify`. */
export const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8192),
    token_type: z.string().max(64).optional(),
    expires_in: z.number().int().positive().optional(),
    refresh_token: z.string().min(1).max(8192).optional(),
    scope: z.string().max(4096).optional(),
  })
  .loose();
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export interface OAuthProvider {
  /** The connection provider. */
  provider: Provider;
  /** Route segment, e.g. "qbo" for /api/connect/qbo/callback (must match the redirect URI registered with the provider). */
  slug: string;
  scopes: readonly string[];
  /** Scopes for one lane when they depend on the lane's policy (Google adds gmail.compose behind the write flag, T-232). Default: `scopes`. */
  scopesFor?(laneId: LaneId): Promise<readonly string[]>;
  /** What the provider calls the account, for messages: "QuickBooks company", "Stripe account". Default "account". */
  accountLabel?: string;
  /** Authorization and token endpoints (from discovery where the provider has it). */
  endpoints(laneId: LaneId): Promise<{ authorization: string; token: string }>;
  /** Client credentials and the registered redirect URI, read from the connector env at call time. */
  client(): { clientId: string; clientSecret: SecretValue; redirectUri: string; tokenAuth: "basic" | "post" };
  /** Response header carrying the provider's transaction id (Intuit `intuit_tid`); logged for every call. */
  requestIdHeader?: string;
  /** Extra authorization parameters (e.g. Google `access_type=offline`, `prompt=consent`). */
  authorizationParams?: Readonly<Record<string, string>>;
  /** Whether a reconnect sends the stored address as `login_hint`. Default: true for Google only (T-066: Microsoft sets it). */
  loginHint?: boolean;
  /** Names of `authorizationParams` that are left out when a `login_hint` is sent (Microsoft: `prompt=select_account` cannot be combined with `login_hint`). */
  omitOnLoginHint?: readonly string[];
  /**
   * OpenID `nonce` (T-066): the authorize request carries a nonce derived from the PKCE verifier (so it exists only on the server and
   * in the stored state), and `identify` receives the expected value to check the id_token against. No new storage.
   */
  nonce?: boolean;
  /** The provider checks the granted scopes itself in `identify` (Microsoft returns short or fully qualified names); the generic "nothing we did not ask for" check is skipped. */
  scopeCheckedByProvider?: boolean;
  /** HTTP client for the provider's token endpoint with its own host allow-list (Microsoft). Default: the plain client. */
  tokenHttp?(laneId: LaneId, baseUrl: string): HttpClient;
  /**
   * The result for a callback that came back with `error=` (the user cancelled, or the provider refused): `null` = `denied`. Pure and
   * fixed-result: nothing from the query is copied into the result (T-066: Microsoft's consent errors become `admin_consent_required`).
   */
  callbackErrorReason?(query: URLSearchParams): ConnectFailure | null;
  /** The token set as it is stored in the Vault. Default: everything the token endpoint returned (Microsoft drops the id_token: it is not needed after the connect). */
  storedTokens?(tokens: TokenResponse): TokenResponse;
  /**
   * Optional check of the callback before the code is exchanged (e.g. QuickBooks: the realm must be the lane's). Throw a
   * ConnectorError to refuse; no token is requested then. `identify` still runs after the exchange.
   */
  precheck?(input: { laneId: LaneId; callback: URLSearchParams }): Promise<void>;
  /**
   * T-255: optional check at the START of a connect (after the caller is authorized, before any state is stored or any redirect is
   * built): e.g. the provider must be enabled for the lane. Throw `forbidden` to refuse (the route answers 403).
   */
  startCheck?(input: { laneId: LaneId }): Promise<void>;
  /**
   * The connected account and the expiry of the credential whose loss forces a reconnect. Throw a ConnectorError to
   * refuse the account (e.g. a QuickBooks realm that is not the lane's). May call the provider with `http`.
   */
  /**
   * Extra structured fields for the `connector.oauth_callback_failed` log line of a refusal this provider threw (T-270). Must return only
   * values the provider has already bounded (never a token, code or address). Never in the user message, the redirect or the audit row.
   */
  logFields?(cause: unknown): Record<string, unknown> | undefined;
  identify(input: { laneId: LaneId; tokens: TokenResponse; callback: URLSearchParams; http: HttpClient; nonce?: string }): Promise<{
    externalAccountId: string;
    expiresAt: Date | null;
    /** Boolean connection features to record on the connection row (e.g. Google `gmail_compose`); merged into the stored ones. */
    features?: Record<string, boolean>;
    /**
     * Runs after the account, its owner and (for a reconnect) its row are settled and BEFORE the token is stored (Microsoft records the
     * tenant once, T-254). Throw a ConnectorError or ConnectRefusal to refuse: nothing is stored then.
     */
    beforeStore?(input: { connection: LaneBoundConnection; reconnect: boolean }): Promise<void>;
  }>;
}

export type Authorized = { userId: string; client: LaneClient };

export type OAuthFlowDeps = {
  providers: readonly OAuthProvider[];
  states: StateStore;
  connections: {
    ensureConnection(laneId: LaneId, provider: Provider, externalAccountId: string, createdBy?: string): Promise<LaneBoundConnection>;
    /**
     * One connection of the lane by id, for a reconnect (T-238): null when it is not this lane's, not this provider's or not a native
     * connection. Required for `start`/`callback` with a connection id; without it such a connect is refused.
     */
    findById?(laneId: LaneId, provider: Provider, connectionId: string): Promise<{ id: string; externalAccountId: string; status: string; ownerUserId?: string | null } | null>;
    /** Merges boolean features into the connection row (T-232); required only for providers whose `identify` returns features. */
    setFeatures?(laneId: LaneId, connection: LaneBoundConnection, features: Record<string, boolean>): Promise<void>;
  };
  storeToken(laneId: LaneId, conn: LaneBoundConnection<string>, secret: SecretValue, expiresAt: Date | null, actorUserId?: string): Promise<void>;
  audit: Audit;
  /** HTTP client for a provider's token endpoint (injected in tests). */
  httpFor?: (provider: OAuthProvider, laneId: LaneId, baseUrl: string) => HttpClient;
  random?: (n: number) => Buffer;
  logger?: ConnectorLogger;
};

export type ConnectFailure =
  | "unknown_provider"
  | "invalid_state"
  | "denied"
  | "exchange_failed"
  | "account_refused"
  | "wrong_account"
  | "wrong_tenant"
  | "admin_consent_required"
  | "unavailable";

/** A provider's refusal with its own coarse result (T-066: `wrong_tenant`, `wrong_account`). The message is fixed; nothing from a response is put in it. */
export class ConnectRefusal extends Error {
  override readonly name = "ConnectRefusal";
  constructor(readonly reason: "wrong_tenant" | "wrong_account" | "account_refused") {
    super("connect refused");
  }
}

export type CallbackResult =
  | { ok: true; provider: Provider; laneId: LaneId; connectionId: string }
  | { ok: false; reason: ConnectFailure; provider?: Provider; laneId?: LaneId; message?: string };

/** Thrown by `authorize` callbacks; the route maps it to 401/403. Anything else is an outage. The provider is passed so the roles can differ (a person's own Google account: any own_mail member, T-247). */
export type AuthorizeFn = (laneId: LaneId, provider?: Provider) => Promise<Authorized>;

const OUTAGE_KINDS: ReadonlySet<string> = new Set(["transient", "rate_limited", "connection_unavailable"]);
/** Scopes any OpenID provider adds on its own; everything else the token carries must have been requested. */
const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"];
const SLUG = /^[a-z][a-z0-9-]{1,31}$/;
/**
 * Shown when the code was exchanged but the account was refused or storing failed. The tokens are dropped from memory and
 * never stored. Revoking the grant at the provider is an external write and may run only through approvals (D-24), so
 * the flow does not do it: the user is told to remove the app's access at the provider.
 */
export const GRANT_NOT_STORED_MESSAGE =
  "Nothing was connected and no access was stored. If the provider still lists this app as authorised, remove its access in your provider account.";

/** The HTTP client for a provider's token endpoint: OAuth error codes (`error`) and the provider's request id are captured. */
export function defaultOAuthHttp(p: OAuthProvider, laneId: LaneId, baseUrl: string, logger?: ConnectorLogger): HttpClient {
  if (p.tokenHttp) return p.tokenHttp(laneId, baseUrl);
  return createHttpClient({
    provider: p.provider,
    laneId,
    baseUrl,
    ...(logger ? { logger } : {}),
    ...(p.requestIdHeader ? { requestIdHeader: p.requestIdHeader } : {}),
    errorCode: (b) => (b as { error?: unknown } | null)?.error as string | undefined,
  });
}

export function createOAuthFlow(deps: OAuthFlowDeps) {
  const bySlug = new Map<string, OAuthProvider>();
  for (const p of deps.providers) {
    if (!SLUG.test(p.slug) || bySlug.has(p.slug)) throw new TypeError(`invalid or duplicate OAuth provider slug ${p.slug}`);
    bySlug.set(p.slug, p);
  }
  const httpFor = deps.httpFor ?? defaultOAuthHttp;

  return {
    /** Whether a provider slug is registered (routes return 404 otherwise). */
    has(slug: string): boolean {
      return bySlug.has(slug);
    },

    /** The provider authorization URL to redirect the user to. Throws AuthError (from `authorize`) or ConnectorError. */
    async start(slug: string, laneId: LaneId, authorize: AuthorizeFn, opts: { connectionId?: string } = {}): Promise<string> {
      const p = bySlug.get(slug);
      if (!p) throw new ConnectorError({ kind: "not_found", message: "Unknown provider" });
      const { userId, client } = await authorize(laneId, p.provider);
      if (p.startCheck) await p.startCheck({ laneId });
      // A reconnect (T-238): the connection must be this lane's own, for this provider; its account is the only one the callback accepts.
      let bound: { id: string; externalAccountId: string } | null = null;
      if (opts.connectionId !== undefined) {
        const found = deps.connections.findById ? await deps.connections.findById(laneId, p.provider, opts.connectionId).catch(() => "error" as const) : null;
        if (found === "error") throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
        if (!found) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
        // T-247: only the owner reconnects their own mailbox (the connect is as the signed-in user; the account check follows at the callback).
        if (MAIL_PROVIDERS.has(p.provider) && found.ownerUserId !== userId) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
        bound = found;
      }
      const { clientId, redirectUri } = p.client();
      const { authorization } = await p.endpoints(laneId);
      const url = new URL(authorization);
      if (url.protocol !== "https:") throw new ConnectorError({ kind: "provider_error", message: "Authorization endpoint must be https" });
      const state = newState(laneId, deps.random, bound?.id);
      const verifier = newCodeVerifier(deps.random);
      await deps.states.create(client, laneId, p.provider, hashState(state), verifier, redirectUri);
      await deps.audit.log({
        laneId,
        actor: { kind: "user", userId },
        action: bound ? "connection.reconnect_started" : "connection.connect_started",
        target: bound ? `connection:${bound.id}` : `provider:${p.provider}`,
      });
      // The stored address of a reconnect is only a hint to the provider's account chooser; the callback still checks the account.
      const hint = bound && (p.loginHint ?? p.provider === "google") && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(bound.externalAccountId) ? bound.externalAccountId : null;
      const base = Object.fromEntries(Object.entries(p.authorizationParams ?? {}).filter(([k]) => hint === null || !(p.omitOnLoginHint ?? []).includes(k)));
      const params = {
        ...base,
        ...(hint !== null ? { login_hint: hint } : {}),
        ...(p.nonce ? { nonce: nonceOf(verifier) } : {}),
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: (p.scopesFor ? await p.scopesFor(laneId) : p.scopes).join(" "),
        state,
        code_challenge: codeChallenge(verifier),
        code_challenge_method: "S256",
      };
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return url.toString();
    },

    /**
     * Finishes a connect from the provider's redirect. Authorization errors from `authorize` are rethrown (the route
     * answers 401/403); every other failure is a coarse result.
     */
    async callback(slug: string, query: URLSearchParams, authorize: AuthorizeFn): Promise<CallbackResult> {
      const p = bySlug.get(slug);
      if (!p) return { ok: false, reason: "unknown_provider" };
      const laneId = laneOfState(query.get("state"));
      if (!laneId) return { ok: false, reason: "invalid_state", provider: p.provider };
      const { userId, client } = await authorize(laneId, p.provider);

      let stored: Awaited<ReturnType<StateStore["consume"]>>;
      try {
        stored = await deps.states.consume(client, laneId, hashState(query.get("state") as string));
      } catch {
        return { ok: false, reason: "unavailable", provider: p.provider, laneId };
      }
      // A state started by the Composio connect (toolkit set) never completes a native callback.
      if (!stored || stored.provider !== p.provider || stored.toolkit) return { ok: false, reason: "invalid_state", provider: p.provider, laneId };

      const entry = { laneId, actor: { kind: "user" as const, userId }, action: "connection.connect", target: `provider:${p.provider}` };
      // The user cancelled or the provider refused at its consent screen: nothing to exchange.
      if (query.get("error") !== null || !query.get("code")) {
        const reason: ConnectFailure = (query.get("error") !== null ? p.callbackErrorReason?.(query) : null) ?? "denied";
        await deps.audit.log({ ...entry, action: "connection.connect.failed", metadata: { reason } }).catch(() => undefined);
        return { ok: false, reason, provider: p.provider, laneId };
      }
      const code = query.get("code") as string;
      let exchanged = false; // a grant exists at the provider (see GRANT_NOT_STORED_MESSAGE)

      try {
        const conn = await withAudit(deps.audit, entry, async () => {
          if (p.precheck) {
            try {
              await p.precheck({ laneId, callback: query });
            } catch (e) {
              if (isConnectorError(e) && OUTAGE_KINDS.has(e.info.kind)) throw e;
              throw new RefusedAccount(e);
            }
          }
          const tokens = await exchange(p, laneId, code, stored.codeVerifier, stored.redirectUri);
          // From here a grant exists at the provider. If anything stops us before it is stored, the tokens are simply
          // dropped (never stored, never logged) and the owner is told to remove the app's access (D-24: no revoke here).
          exchanged = true;
          const http = httpFor(p, laneId, new URL((await p.endpoints(laneId)).token).origin);
          let identity: Awaited<ReturnType<OAuthProvider["identify"]>>;
          try {
            identity = await p.identify({ laneId, tokens, callback: query, http, ...(p.nonce ? { nonce: nonceOf(stored.codeVerifier) } : {}) });
          } catch (e) {
            // An outage while checking the account is not a refusal of the account.
            if (isConnectorError(e) && OUTAGE_KINDS.has(e.info.kind)) throw e;
            throw new RefusedAccount(e);
          }
          // A reconnect (T-238) accepts only the account of the connection it was started for: a different Google account is refused
          // here, before any row or token is written. The connection is read again (it may have changed since the start).
          let account = identity.externalAccountId;
          const boundId = connectionOfState(query.get("state"));
          if (boundId !== null) {
            const found = deps.connections.findById ? await deps.connections.findById(laneId, p.provider, boundId) : null;
            if (!found) throw new RefusedAccount(new ConnectorError({ kind: "not_found", message: "Connection not found" }));
            if (found.externalAccountId.toLowerCase() !== identity.externalAccountId.toLowerCase()) throw new WrongAccount();
            account = found.externalAccountId; // the stored spelling: the same row, never a second one
          }
          // D-23: the account may already be connected to another lane; the database refuses it (unique index).
          const refuseInUse = async <T>(call: () => Promise<T>): Promise<T> => {
            try {
              return await call();
            } catch (e) {
              if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.message === ACCOUNT_IN_USE_MESSAGE) throw new RefusedAccount(e);
              throw e;
            }
          };
          const connection = await refuseInUse(() => deps.connections.ensureConnection(laneId, p.provider, account, userId));
          // T-247: a mailbox has one owner. A row that belongs to someone else is never reused (this user proved control of the Google
          // account, but the row is another user's: the tokens are not stored, and the user is told).
          if (MAIL_PROVIDERS.has(p.provider) && connection.owner_user_id !== userId) {
            throw new RefusedAccount(new ConnectorError({ kind: "forbidden", message: ACCOUNT_OWNED_BY_OTHER_MESSAGE }));
          }
          // Defence in depth (T-238 review): a reconnect stores tokens only on the row it was started for, never on another row.
          if (boundId !== null && connection.id !== boundId) throw new WrongAccount();
          if (identity.beforeStore) {
            try {
              await identity.beforeStore({ connection, reconnect: boundId !== null });
            } catch (e) {
              if (isConnectorError(e) && OUTAGE_KINDS.has(e.info.kind)) throw e;
              throw new RefusedAccount(e);
            }
          }
          await refuseInUse(() =>
            deps.storeToken(laneId, connection, new SecretValue(JSON.stringify({ ...(p.storedTokens ? p.storedTokens(tokens) : tokens), obtained_at: new Date().toISOString() })), identity.expiresAt, userId),
          );
          if (identity.features) {
            if (!deps.connections.setFeatures) throw new TypeError("connections.setFeatures is required for a provider that reports features");
            await deps.connections.setFeatures(laneId, connection, identity.features);
          }
          return connection;
        });
        return { ok: true, provider: p.provider, laneId, connectionId: conn.id };
      } catch (e) {
        const reason: ConnectFailure =
          e instanceof WrongAccount
            ? "wrong_account"
            : e instanceof RefusedAccount
              ? e.cause instanceof ConnectRefusal
                ? e.cause.reason
                : "account_refused"
              : e instanceof ExchangeFailed
                ? "exchange_failed"
                : "unavailable";
        const cause = e instanceof RefusedAccount || e instanceof ExchangeFailed ? e.cause : e;
        (deps.logger ?? connectorLog).child({ laneId, provider: p.provider }).warn("connector.oauth_callback_failed", {
          reason,
          error: isConnectorError(cause) ? cause : { error_name: cause instanceof Error ? cause.name : typeof cause },
          ...(p.logFields?.(cause) ?? {}),
        });
        if (exchanged) {
          await deps.audit
            .log({ ...entry, action: "connection.connect.grant_not_stored", metadata: { reason } })
            .catch(() => undefined);
          const inUse = isConnectorError(cause) && cause.info.message === ACCOUNT_IN_USE_MESSAGE;
          const ownedByOther = isConnectorError(cause) && cause.info.message === ACCOUNT_OWNED_BY_OTHER_MESSAGE;
          const oneTeams = isConnectorError(cause) && cause.info.message === TEAMS_ONE_ACCOUNT_MESSAGE;
          const message = oneTeams
            ? `${TEAMS_ONE_ACCOUNT_MESSAGE}. Disconnect it first to use another one. ${GRANT_NOT_STORED_MESSAGE}`
            : inUse
            ? `This ${p.accountLabel ?? "account"} is already connected to another company in Jarvis. ${GRANT_NOT_STORED_MESSAGE}`
            : ownedByOther
              ? `This ${p.accountLabel ?? "account"} is already connected by another person in Jarvis. ${GRANT_NOT_STORED_MESSAGE}`
              : GRANT_NOT_STORED_MESSAGE;
          return { ok: false, reason, provider: p.provider, laneId, message };
        }
        return { ok: false, reason, provider: p.provider, laneId };
      }
    },
  };

  /** Code → token set (see `exchangeAuthorizationCode`); any failure is an ExchangeFailed. */
  async function exchange(p: OAuthProvider, laneId: LaneId, code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    try {
      return await exchangeAuthorizationCode(p, httpFor, laneId, code, verifier, redirectUri);
    } catch (e) {
      throw new ExchangeFailed(e);
    }
  }
}

/**
 * Code → token set at the provider's token endpoint (form body; client authenticated by Basic or in the body). Shared
 * by the callback and by a connector's `connect` (T-050). Throws ConnectorError; every credential in the response is
 * registered for redaction before it is returned.
 */
export async function exchangeAuthorizationCode(
  p: OAuthProvider,
  httpFor: (provider: OAuthProvider, laneId: LaneId, baseUrl: string) => HttpClient,
  laneId: LaneId,
  code: string,
  verifier: string | undefined,
  redirectUri: string,
): Promise<TokenResponse> {
  const { token } = await p.endpoints(laneId);
  const tokenUrl = new URL(token);
  if (tokenUrl.protocol !== "https:" || tokenUrl.search || tokenUrl.hash) {
    throw new ConnectorError({ kind: "provider_error", message: "Token endpoint must be an https URL without query" });
  }
  const { clientId, clientSecret, tokenAuth } = p.client();
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (verifier !== undefined) form.set("code_verifier", verifier);
  if (tokenAuth === "post") {
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret.reveal());
  }
  const res = await httpFor(p, laneId, tokenUrl.origin).request({
    method: "POST",
    path: tokenUrl.pathname,
    body: form,
    retry: false, // a code works once
    ...(tokenAuth === "basic" ? { auth: { scheme: "Basic" as const, secret: basicCredentials(clientId, clientSecret) } } : {}),
  });
  const parsed = TokenResponseSchema.safeParse(res.data);
  if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Token response is not valid", http_status: res.status });
  // Register every credential the response carries before anything can log it.
  new SecretValue(JSON.stringify(parsed.data));
  // A token broader than the scopes we asked for is refused (e.g. a provider that merges earlier grants).
  if (parsed.data.scope !== undefined && !p.scopeCheckedByProvider) {
    const allowed = new Set([...(p.scopesFor ? await p.scopesFor(laneId) : p.scopes), ...OIDC_SCOPES]);
    if (parsed.data.scope.split(/[\s,]+/).some((g) => g !== "" && !allowed.has(g))) {
      throw new ConnectorError({ kind: "provider_error", message: "Token carries scopes that were not requested" });
    }
  }
  return parsed.data;
}

class ExchangeFailed extends Error {
  override readonly name = "ExchangeFailed";
  constructor(override readonly cause: unknown) {
    super("token exchange failed");
  }
}

/** A reconnect came back with a different account than the connection it was started for (T-238). */
class WrongAccount extends Error {
  override readonly name = "WrongAccount";
  constructor() {
    super("wrong account");
  }
}

class RefusedAccount extends Error {
  override readonly name = "RefusedAccount";
  constructor(override readonly cause: unknown) {
    super("account refused");
  }
}
