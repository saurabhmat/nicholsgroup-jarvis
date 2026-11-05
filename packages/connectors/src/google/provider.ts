// The Google provider for the OAuth connect framework (T-035, T-063): authorization code + PKCE, `access_type=offline`,
// `prompt=consent`, `include_granted_scopes=false`, and exactly the three read-only scopes of H-008.
//
// The callback is checked twice:
//  1. before the code is exchanged (`precheck`): the lane must have mailboxes configured (fail closed), so a lane with
//     no allowlist never obtains a grant;
//  2. after the exchange (`identify`): the granted scopes must be exactly the required read-only ones (a write scope or a
//     missing one refuses; the user can untick scopes on Google's consent screen), a refresh token must be present, and
//     the mailbox is the verified primary address from Gmail's own profile (the access token proves it; nothing from
//     the redirect URL is trusted). That address must be one of the lane's `lane_config.mailboxes`, which is the
//     allowlist for both pubkgroup.com and pub-k.org addresses. No domain is hard-coded (rule 2). The Workspace hosted
//     domain (`hd`) needs an id_token and so extra OIDC scopes; there is no lane_config field for it, so the mailbox
//     list is the only allowlist (see notes T-063).
// A grant refused after the exchange is dropped from memory and never stored; the flow tells the owner to remove the
// app's access at Google (D-24: revoking is an external write and runs only through approvals).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import type { HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { OAuthProvider, TokenResponse } from "../oauth/flow";
import type { LaneConfigReader } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import { GMAIL_BASE, GMAIL_RATE_LIMIT, GOOGLE_GMAIL_HOSTS, GOOGLE_AUTHORIZATION_PARAMS, GOOGLE_AUTHORIZATION_URL, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES, GOOGLE_SLUG, GOOGLE_TOKEN_URL } from "./constants";
import { createGoogleHttp } from "./http";

export type GoogleClientConfig = { clientId: string; clientSecret: SecretValue; redirectUri: string };

export type GoogleProviderDeps = {
  client: () => GoogleClientConfig;
  laneConfig: Pick<LaneConfigReader, "mailboxes">;
  logger?: ConnectorLogger;
  /** Test hook: the HTTP client for the Gmail host. */
  httpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

/** Scopes the token response may carry besides ours: OpenID ones Google adds on its own are harmless. */
const HARMLESS = new Set(["openid", "email", "profile"]);
const REQUIRED: ReadonlySet<string> = new Set(GOOGLE_SCOPES);

/** The registered redirect URI must be this app's Google callback; anything else is a configuration error. */
export function assertRedirectUri(redirectUri: string): void {
  const ok = URL.canParse(redirectUri) && new URL(redirectUri).pathname === GOOGLE_CALLBACK_PATH;
  if (!ok) throw new ConnectorError({ kind: "connection_unavailable", message: `GOOGLE_REDIRECT_URI must end with ${GOOGLE_CALLBACK_PATH}` });
}

/**
 * Refuses a grant whose scopes are not exactly the required read-only set. `scope` absent counts as missing: we cannot
 * tell what was granted. Throws forbidden (the flow turns it into `account_refused`).
 */
export function assertGrantedScopes(scope: string | undefined): void {
  const granted = new Set((scope ?? "").split(/[\s,]+/).filter((s) => s !== ""));
  for (const g of granted) {
    if (!REQUIRED.has(g) && !HARMLESS.has(g)) throw new ConnectorError({ kind: "forbidden", message: "Google granted a scope that was not requested (write access is never accepted)" });
  }
  for (const r of REQUIRED) {
    if (!granted.has(r)) throw new ConnectorError({ kind: "forbidden", message: "Google did not grant every required read-only scope" });
  }
}

const ProfileSchema = z.object({ emailAddress: z.string().min(3).max(320) }).loose();

export function createGoogleOAuthProvider(deps: GoogleProviderDeps): OAuthProvider {
  const httpFor = (laneId: LaneId, baseUrl: string): HttpClient =>
    deps.httpFor
      ? deps.httpFor(laneId, baseUrl)
      : createGoogleHttp({ baseUrl, laneId, rateLimit: GMAIL_RATE_LIMIT, ...(deps.logger ? { logger: deps.logger } : {}) }, GOOGLE_GMAIL_HOSTS);
  const allowlist = async (laneId: LaneId): Promise<string[]> => {
    const mailboxes = await deps.laneConfig.mailboxes(laneId);
    if (mailboxes.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No mailboxes are configured for this lane" });
    return mailboxes;
  };

  return {
    provider: "google",
    slug: GOOGLE_SLUG,
    accountLabel: "Google mailbox",
    scopes: GOOGLE_SCOPES,
    authorizationParams: GOOGLE_AUTHORIZATION_PARAMS,
    async endpoints() {
      return { authorization: GOOGLE_AUTHORIZATION_URL, token: GOOGLE_TOKEN_URL };
    },
    client() {
      const c = deps.client();
      assertRedirectUri(c.redirectUri);
      return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, tokenAuth: "post" };
    },
    async precheck({ laneId }) {
      await allowlist(laneId);
    },
    async identify({ laneId, tokens }: { laneId: LaneId; tokens: TokenResponse; callback: URLSearchParams; http: HttpClient }) {
      assertGrantedScopes(tokens.scope);
      if (!tokens.refresh_token) throw new ConnectorError({ kind: "forbidden", message: "Google issued no refresh token" });
      const mailboxes = await allowlist(laneId);
      const base = new URL(GMAIL_BASE);
      const res = await httpFor(laneId, base.origin).request({
        method: "GET",
        path: "/gmail/v1/users/me/profile",
        auth: { scheme: "Bearer", secret: new SecretValue(tokens.access_token) },
      });
      const profile = ProfileSchema.safeParse(res.data);
      if (!profile.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail profile is not valid" });
      const email = profile.data.emailAddress.toLowerCase();
      if (!mailboxes.includes(email)) throw new ConnectorError({ kind: "forbidden", message: "This Google account is not one of the lane's configured mailboxes" });
      return { externalAccountId: email, expiresAt: null };
    },
  };
}
