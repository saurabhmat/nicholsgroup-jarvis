// The Google provider for the OAuth connect framework (T-035, T-063): authorization code + PKCE, `access_type=offline`,
// `prompt=consent`, `include_granted_scopes=false`, and exactly the three read-only scopes of H-008.
//
// The callback is checked twice:
//  1. before the code is exchanged (`precheck`): the lane must allow at least one mail domain (lane_config.mail.allowed_domains,
//     fail closed, T-247), so a lane with no allowlist never obtains a grant;
//  2. after the exchange (`identify`): the granted scopes must be exactly the required read-only ones (a write scope or a
//     missing one refuses; the user can untick scopes on Google's consent screen), a refresh token must be present, and
//     the mailbox is the verified primary address from Gmail's own profile (the access token proves it; nothing from
//     the redirect URL is trusted). That address must be on one of the lane's `lane_config.mail.allowed_domains` and, when the
//     lane also keeps an exact `lane_config.mailboxes` list, on that list too (T-247). No domain is hard-coded (rule 2).
// A grant refused after the exchange is dropped from memory and never stored; the flow tells the owner to remove the
// app's access at Google (D-24: revoking is an external write and runs only through approvals).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import type { HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { OAuthProvider, TokenResponse } from "../oauth/flow";
import type { LaneConfigReader } from "../vault/lane-config";
import { assertMailAccountAllowed, assertMailDomainsConfigured, readMailPolicy } from "../vault/mail-policy";
import { SecretValue } from "../vault/secret";
import { GMAIL_BASE, GMAIL_COMPOSE, GMAIL_RATE_LIMIT, GOOGLE_GMAIL_HOSTS, GOOGLE_AUTHORIZATION_PARAMS, GOOGLE_AUTHORIZATION_URL, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES, GOOGLE_SLUG, GOOGLE_TOKEN_URL } from "./constants";
import { createGoogleHttp } from "./http";

export type GoogleClientConfig = { clientId: string; clientSecret: SecretValue; redirectUri: string };

export type GoogleProviderDeps = {
  client: () => GoogleClientConfig;
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "mailDomains">;
  /**
   * Whether the lane's policy allows email writes (`write_actions_allowed` has email_send or email_draft, T-232). When
   * true the consent asks for gmail.compose too and the callback accepts it (never otherwise). Default: never (read-only).
   * Fails closed: if it throws, no connect starts and no callback completes.
   */
  composeAllowed?: (laneId: LaneId) => Promise<boolean>;
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
export function assertGrantedScopes(scope: string | undefined, composeAllowed = false): { compose: boolean } {
  const granted = new Set((scope ?? "").split(/[\s,]+/).filter((s) => s !== ""));
  for (const g of granted) {
    if (g === GMAIL_COMPOSE && composeAllowed) continue;
    if (!REQUIRED.has(g) && !HARMLESS.has(g)) throw new ConnectorError({ kind: "forbidden", message: "Google granted a scope that was not requested (write access is never accepted)" });
  }
  for (const r of REQUIRED) {
    if (!granted.has(r)) throw new ConnectorError({ kind: "forbidden", message: "Google did not grant every required read-only scope" });
  }
  // With the lane flag the compose scope is optional on the consent screen: unticked means the connection cannot send.
  return { compose: composeAllowed && granted.has(GMAIL_COMPOSE) };
}

const ProfileSchema = z.object({ emailAddress: z.string().min(3).max(320) }).loose();

export function createGoogleOAuthProvider(deps: GoogleProviderDeps): OAuthProvider {
  const httpFor = (laneId: LaneId, baseUrl: string): HttpClient =>
    deps.httpFor
      ? deps.httpFor(laneId, baseUrl)
      : createGoogleHttp({ baseUrl, laneId, rateLimit: GMAIL_RATE_LIMIT, ...(deps.logger ? { logger: deps.logger } : {}) }, GOOGLE_GMAIL_HOSTS);
  // T-247: the lane's mail policy: allowed domains (empty = nothing is allowed: fail closed) and the optional exact mailbox list.
  const policyOf = async (laneId: LaneId) => {
    const policy = await readMailPolicy(deps.laneConfig, laneId);
    assertMailDomainsConfigured(policy.domains);
    return policy;
  };

  const composeAllowed = async (laneId: LaneId): Promise<boolean> => (deps.composeAllowed ? (await deps.composeAllowed(laneId)) === true : false);

  return {
    provider: "google",
    slug: GOOGLE_SLUG,
    accountLabel: "Google mailbox",
    scopes: GOOGLE_SCOPES,
    async scopesFor(laneId) {
      return (await composeAllowed(laneId)) ? [...GOOGLE_SCOPES, GMAIL_COMPOSE] : GOOGLE_SCOPES;
    },
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
      await policyOf(laneId);
    },
    async identify({ laneId, tokens }: { laneId: LaneId; tokens: TokenResponse; callback: URLSearchParams; http: HttpClient }) {
      const { compose } = assertGrantedScopes(tokens.scope, await composeAllowed(laneId));
      if (!tokens.refresh_token) throw new ConnectorError({ kind: "forbidden", message: "Google issued no refresh token" });
      const policy = await policyOf(laneId);
      const base = new URL(GMAIL_BASE);
      const res = await httpFor(laneId, base.origin).request({
        method: "GET",
        path: "/gmail/v1/users/me/profile",
        auth: { scheme: "Bearer", secret: new SecretValue(tokens.access_token) },
      });
      const profile = ProfileSchema.safeParse(res.data);
      if (!profile.success) throw new ConnectorError({ kind: "provider_error", message: "Gmail profile is not valid" });
      const email = profile.data.emailAddress.toLowerCase();
      // The verified primary address from Gmail itself must be on an allowed domain (and on the exact list when the lane keeps one).
      assertMailAccountAllowed(policy, email);
      // Always recorded, so a reconnect without the scope clears an earlier `true`.
      return { externalAccountId: email, expiresAt: null, features: { gmail_compose: compose } };
    },
  };
}
