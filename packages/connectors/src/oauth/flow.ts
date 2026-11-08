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
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError, isConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { Provider } from "../contract/schemas";
import { createHttpClient, basicCredentials, type HttpClient } from "../http/client";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { SecretValue } from "../vault/secret";
import { codeChallenge, hashState, laneOfState, newCodeVerifier, newState } from "./pkce";
import type { StateStore } from "./state";

/** Who may connect or reconnect an account (T-050: owner or admin_technical of the lane). */
export const CONNECT_ROLES = ["owner", "admin_technical"] as const;

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
  /**
   * Optional check of the callback before the code is exchanged (e.g. QuickBooks: the realm must be the lane's). Throw a
   * ConnectorError to refuse; no token is requested then. `identify` still runs after the exchange.
   */
  precheck?(input: { laneId: LaneId; callback: URLSearchParams }): Promise<void>;
  /**
   * The connected account and the expiry of the credential whose loss forces a reconnect. Throw a ConnectorError to
   * refuse the account (e.g. a QuickBooks realm that is not the lane's). May call the provider with `http`.
   */
  identify(input: { laneId: LaneId; tokens: TokenResponse; callback: URLSearchParams; http: HttpClient }): Promise<{
    externalAccountId: string;
    expiresAt: Date | null;
  }>;
}

export type Authorized = { userId: string; client: LaneClient };

export type OAuthFlowDeps = {
  providers: readonly OAuthProvider[];
  states: StateStore;
  connections: { ensureConnection(laneId: LaneId, provider: Provider, externalAccountId: string, createdBy?: string): Promise<LaneBoundConnection> };
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
  | "unavailable";

export type CallbackResult =
  | { ok: true; provider: Provider; laneId: LaneId; connectionId: string }
  | { ok: false; reason: ConnectFailure; provider?: Provider; laneId?: LaneId; message?: string };

/** Thrown by `authorize` callbacks; the route maps it to 401/403. Anything else is an outage. */
export type AuthorizeFn = (laneId: LaneId) => Promise<Authorized>;

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
    async start(slug: string, laneId: LaneId, authorize: AuthorizeFn): Promise<string> {
      const p = bySlug.get(slug);
      if (!p) throw new ConnectorError({ kind: "not_found", message: "Unknown provider" });
      const { userId, client } = await authorize(laneId);
      const { clientId, redirectUri } = p.client();
      const { authorization } = await p.endpoints(laneId);
      const url = new URL(authorization);
      if (url.protocol !== "https:") throw new ConnectorError({ kind: "provider_error", message: "Authorization endpoint must be https" });
      const state = newState(laneId, deps.random);
      const verifier = newCodeVerifier(deps.random);
      await deps.states.create(client, laneId, p.provider, hashState(state), verifier, redirectUri);
      await deps.audit.log({
        laneId,
        actor: { kind: "user", userId },
        action: "connection.connect_started",
        target: `provider:${p.provider}`,
      });
      const params = {
        ...p.authorizationParams,
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: p.scopes.join(" "),
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
      const { userId, client } = await authorize(laneId);

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
        await deps.audit.log({ ...entry, action: "connection.connect.failed", metadata: { reason: "denied" } }).catch(() => undefined);
        return { ok: false, reason: "denied", provider: p.provider, laneId };
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
          let identity: { externalAccountId: string; expiresAt: Date | null };
          try {
            identity = await p.identify({ laneId, tokens, callback: query, http });
          } catch (e) {
            // An outage while checking the account is not a refusal of the account.
            if (isConnectorError(e) && OUTAGE_KINDS.has(e.info.kind)) throw e;
            throw new RefusedAccount(e);
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
          const connection = await refuseInUse(() => deps.connections.ensureConnection(laneId, p.provider, identity.externalAccountId, userId));
          await refuseInUse(() =>
            deps.storeToken(laneId, connection, new SecretValue(JSON.stringify({ ...tokens, obtained_at: new Date().toISOString() })), identity.expiresAt, userId),
          );
          return connection;
        });
        return { ok: true, provider: p.provider, laneId, connectionId: conn.id };
      } catch (e) {
        const reason: ConnectFailure = e instanceof RefusedAccount ? "account_refused" : e instanceof ExchangeFailed ? "exchange_failed" : "unavailable";
        const cause = e instanceof RefusedAccount || e instanceof ExchangeFailed ? e.cause : e;
        (deps.logger ?? connectorLog).child({ laneId, provider: p.provider }).warn("connector.oauth_callback_failed", {
          reason,
          error: isConnectorError(cause) ? cause : { error_name: cause instanceof Error ? cause.name : typeof cause },
        });
        if (exchanged) {
          await deps.audit
            .log({ ...entry, action: "connection.connect.grant_not_stored", metadata: { reason } })
            .catch(() => undefined);
          const inUse = isConnectorError(cause) && cause.info.message === ACCOUNT_IN_USE_MESSAGE;
          const message = inUse
            ? `This ${p.accountLabel ?? "account"} is already connected to another company in Jarvis. ${GRANT_NOT_STORED_MESSAGE}`
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
  if (parsed.data.scope !== undefined) {
    const allowed = new Set([...p.scopes, ...OIDC_SCOPES]);
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

class RefusedAccount extends Error {
  override readonly name = "RefusedAccount";
  constructor(override readonly cause: unknown) {
    super("account refused");
  }
}
