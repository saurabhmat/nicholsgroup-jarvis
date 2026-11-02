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
import { ConnectorError, isConnectorError } from "../contract/errors";
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
  /** Authorization and token endpoints (from discovery where the provider has it). */
  endpoints(): Promise<{ authorization: string; token: string }>;
  /** Client credentials and the registered redirect URI, read from the connector env at call time. */
  client(): { clientId: string; clientSecret: SecretValue; redirectUri: string; tokenAuth: "basic" | "post" };
  /** Extra authorization parameters (e.g. Google `access_type=offline`, `prompt=consent`). */
  authorizationParams?: Readonly<Record<string, string>>;
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
  connections: { ensureConnection(laneId: LaneId, provider: Provider, externalAccountId: string): Promise<LaneBoundConnection> };
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
  | { ok: false; reason: ConnectFailure; provider?: Provider; laneId?: LaneId };

/** Thrown by `authorize` callbacks; the route maps it to 401/403. Anything else is an outage. */
export type AuthorizeFn = (laneId: LaneId) => Promise<Authorized>;

const SLUG = /^[a-z][a-z0-9-]{1,31}$/;

export function createOAuthFlow(deps: OAuthFlowDeps) {
  const bySlug = new Map<string, OAuthProvider>();
  for (const p of deps.providers) {
    if (!SLUG.test(p.slug) || bySlug.has(p.slug)) throw new TypeError(`invalid or duplicate OAuth provider slug ${p.slug}`);
    bySlug.set(p.slug, p);
  }
  const httpFor =
    deps.httpFor ??
    ((p: OAuthProvider, laneId: LaneId, baseUrl: string) =>
      createHttpClient({ provider: p.provider, laneId, baseUrl, errorCode: (b) => (b as { error?: unknown } | null)?.error as string | undefined }));

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
      const { authorization } = await p.endpoints();
      const state = newState(laneId, deps.random);
      const verifier = newCodeVerifier(deps.random);
      await deps.states.create(client, laneId, p.provider, hashState(state), verifier, redirectUri);
      await deps.audit.log({
        laneId,
        actor: { kind: "user", userId },
        action: "connection.connect_started",
        target: `provider:${p.provider}`,
      });
      const url = new URL(authorization);
      if (url.protocol !== "https:") throw new ConnectorError({ kind: "provider_error", message: "Authorization endpoint must be https" });
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
      if (!stored || stored.provider !== p.provider) return { ok: false, reason: "invalid_state", provider: p.provider, laneId };

      const entry = { laneId, actor: { kind: "user" as const, userId }, action: "connection.connect", target: `provider:${p.provider}` };
      // The user cancelled or the provider refused at its consent screen: nothing to exchange.
      if (query.get("error") !== null || !query.get("code")) {
        await deps.audit.log({ ...entry, action: "connection.connect.failed", metadata: { reason: "denied" } }).catch(() => undefined);
        return { ok: false, reason: "denied", provider: p.provider, laneId };
      }
      const code = query.get("code") as string;

      try {
        const conn = await withAudit(deps.audit, entry, async () => {
          const tokens = await exchange(p, laneId, code, stored.codeVerifier, stored.redirectUri);
          const http = httpFor(p, laneId, new URL((await p.endpoints()).token).origin);
          let identity: { externalAccountId: string; expiresAt: Date | null };
          try {
            identity = await p.identify({ laneId, tokens, callback: query, http });
          } catch (e) {
            throw new RefusedAccount(e);
          }
          const connection = await deps.connections.ensureConnection(laneId, p.provider, identity.externalAccountId);
          await deps.storeToken(laneId, connection, new SecretValue(JSON.stringify({ ...tokens, obtained_at: new Date().toISOString() })), identity.expiresAt, userId);
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
        return { ok: false, reason, provider: p.provider, laneId };
      }
    },
  };

  /** Code → token set at the provider's token endpoint (form body; client authenticated by Basic or in the body). */
  async function exchange(p: OAuthProvider, laneId: LaneId, code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    try {
      const { token } = await p.endpoints();
      const tokenUrl = new URL(token);
      if (tokenUrl.protocol !== "https:" || tokenUrl.search || tokenUrl.hash) {
        throw new ConnectorError({ kind: "provider_error", message: "Token endpoint must be an https URL without query" });
      }
      const { clientId, clientSecret, tokenAuth } = p.client();
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
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
      return parsed.data;
    } catch (e) {
      throw new ExchangeFailed(e);
    }
  }
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
