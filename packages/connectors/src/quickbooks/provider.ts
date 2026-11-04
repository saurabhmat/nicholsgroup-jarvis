// The QuickBooks provider for the OAuth connect framework (T-035, T-050). Endpoints come from Intuit's discovery
// document; the client id, secret and redirect URI from the connector env at call time (never at import); the callback's
// `realmId` must be the lane's configured realm (required in production), and, once the code is exchanged, CompanyInfo
// read with the new access token must name that same realm: the realm is chosen by the user in the redirect URL, the
// token is what Intuit issued, and only a match between them is stored. A grant refused after the exchange is dropped
// from memory and never stored; the flow tells the owner to remove the app's access in Intuit (D-24: revoking is an
// external write and runs only through approvals).
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { createHttpClient, type HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { OAuthProvider } from "../oauth/flow";
import type { LaneConfigReader } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import { API_BASE, API_RATE_LIMIT, QBO_CALLBACK_PATH, QBO_SCOPE, QBO_SLUG, INTUIT_TID_HEADER, type IntuitEnvironment } from "./constants";
import { fetchCompanyInfoWithToken } from "./company-info";
import type { Discovery } from "./discovery";
import { intuitErrorCode } from "./api";
import { assertRealmAllowed, realmFromCallback } from "./realm";

export type QboClientConfig = { clientId: string; clientSecret: SecretValue; redirectUri: string };

export type QboProviderDeps = {
  environment: () => IntuitEnvironment;
  client: () => QboClientConfig;
  discovery: Discovery;
  laneConfig: LaneConfigReader;
  /** True in production: a lane with no configured realm refuses to connect (fail closed). */
  requireConfiguredRealm?: () => boolean;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Test hook: the HTTP client for an Intuit origin (the API base, the revocation host). */
  httpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

/** The registered redirect URI must be this app's QuickBooks callback; anything else is a configuration error. */
export function assertRedirectUri(redirectUri: string): void {
  const ok = URL.canParse(redirectUri) && new URL(redirectUri).pathname === QBO_CALLBACK_PATH;
  if (!ok) throw new ConnectorError({ kind: "connection_unavailable", message: `INTUIT_REDIRECT_URI must end with ${QBO_CALLBACK_PATH}` });
}

/** Expiry of the refresh token (the credential whose loss forces a reconnect), from the token response. */
export function refreshExpiry(tokens: Record<string, unknown>, now: number): Date | null {
  const s = tokens.x_refresh_token_expires_in;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? new Date(now + s * 1000) : null;
}

export function createQuickBooksOAuthProvider(deps: QboProviderDeps): OAuthProvider {
  const now = deps.now ?? Date.now;
  const requireConfigured = () => deps.requireConfiguredRealm?.() ?? false;
  const httpFor = (laneId: LaneId, baseUrl: string): HttpClient =>
    deps.httpFor
      ? deps.httpFor(laneId, baseUrl)
      : createHttpClient({
          provider: "quickbooks",
          baseUrl,
          laneId,
          requestIdHeader: INTUIT_TID_HEADER,
          rateLimit: API_RATE_LIMIT,
          errorCode: (b) => {
            const oauth = (b as { error?: unknown } | null)?.error;
            return typeof oauth === "string" ? oauth : intuitErrorCode(b);
          },
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
  return {
    provider: "quickbooks",
    slug: QBO_SLUG,
    accountLabel: "QuickBooks company",
    scopes: [QBO_SCOPE],
    requestIdHeader: INTUIT_TID_HEADER,
    async endpoints(laneId: LaneId) {
      const e = await deps.discovery.get(laneId, deps.environment());
      return { authorization: e.authorization, token: e.token };
    },
    client() {
      const c = deps.client();
      assertRedirectUri(c.redirectUri);
      return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, tokenAuth: "basic" };
    },
    async precheck({ laneId, callback }) {
      // Before any token is requested: a callback for another company never gets a token set.
      await assertRealmAllowed(deps.laneConfig, laneId, realmFromCallback(callback), { requireConfigured: requireConfigured() });
    },
    async identify({ laneId, tokens, callback }) {
      const realm = realmFromCallback(callback);
      await assertRealmAllowed(deps.laneConfig, laneId, realm, { requireConfigured: requireConfigured() });
      // The realm came from the redirect URL, which the user can edit. The token is what Intuit issued: it must be
      // for this company, or it would overwrite another connection's tokens (security M1). A 401/403/404 or another
      // company's answer refuses; an outage is reported as an outage (the flow tells them apart by error kind).
      await fetchCompanyInfoWithToken(httpFor(laneId, API_BASE[deps.environment()]), realm, new SecretValue(tokens.access_token));
      return { externalAccountId: realm, expiresAt: refreshExpiry(tokens, now()) };
    },
  };
}
