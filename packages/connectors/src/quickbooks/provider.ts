// The QuickBooks provider for the OAuth connect framework (T-035, T-050). Endpoints come from Intuit's discovery
// document; the client id, secret and redirect URI from the connector env at call time (never at import); the callback's
// `realmId` must be the lane's configured realm when one is set.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { OAuthProvider } from "../oauth/flow";
import type { LaneConfigReader } from "../vault/lane-config";
import type { SecretValue } from "../vault/secret";
import { QBO_CALLBACK_PATH, QBO_SCOPE, QBO_SLUG, INTUIT_TID_HEADER, type IntuitEnvironment } from "./constants";
import type { Discovery } from "./discovery";
import { assertRealmAllowed, realmFromCallback } from "./realm";

export type QboClientConfig = { clientId: string; clientSecret: SecretValue; redirectUri: string };

export type QboProviderDeps = {
  environment: () => IntuitEnvironment;
  client: () => QboClientConfig;
  discovery: Discovery;
  laneConfig: LaneConfigReader;
  now?: () => number;
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
  return {
    provider: "quickbooks",
    slug: QBO_SLUG,
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
      await assertRealmAllowed(deps.laneConfig, laneId, realmFromCallback(callback));
    },
    async identify({ laneId, tokens, callback }) {
      const realm = realmFromCallback(callback);
      await assertRealmAllowed(deps.laneConfig, laneId, realm);
      return { externalAccountId: realm, expiresAt: refreshExpiry(tokens, now()) };
    },
  };
}
