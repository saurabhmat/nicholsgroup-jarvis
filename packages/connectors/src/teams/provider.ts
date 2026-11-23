// The Teams provider for the OAuth connect framework (T-279; docs/specs/messages.md 4, 5; decision D-66; mirrors microsoft/provider.ts). Authorization code + PKCE + an OpenID nonce,
// the client secret in the token request body, delegated scopes only, through a SECOND Entra app registration used only for Teams (`GRAPH_TEAMS_*`). Slug `teams`, provider
// `microsoft_teams`.
//
// START   (flow.start): the caller is authorized by the flow, then `startCheck` refuses unless Teams is enabled for the lane (`teams.enabled` AND a supported cloud, tenant ids and
//         allowed domains: ONE `teamsSettings` read). The lane's mail provider list is NEVER consulted: a lane with Google mail only can have Teams. The consent URL names the lane's
//         authority (its one tenant id, or `organizations`; never `common`), the scopes of the lane's features, `response_mode=query`, `prompt=select_account`; on a reconnect `login_hint`
//         with the stored address and NO prompt (they cannot be combined).
// CALLBACK, in this order, everything before anything is stored:
//   1. `callbackErrorReason`: an `error=` answer never reaches the exchange; Microsoft's consent errors are `admin_consent_required` (the same mapping as mail).
//   2. `precheck`: the same settings checks as start, before the code is exchanged.
//   3. the code exchange (the flow), at the lane's authority.
//   4. `identify`: the TEAMS scope rule (below) and a refresh token; the id_token (`tid` in the lane's list, `iss`, `aud` = the Teams client id, `exp`, `nonce`; no signature check, as for
//      mail); Graph `GET /me` for the account (`id`, `userPrincipalName`, a Member, no `#EXT#`); the UPN's domain must be in `teams.allowed_domains`.
//   5. the flow's reconnect (same account), D-23 and owner checks, then `beforeStore`: the tenant, cloud and Entra object id are recorded ONCE on the connection row (a reconnect must come
//      back to the tenant and object already recorded; a second usable Teams account of the same person is refused here, before any token is stored); then the token set is stored in the
//      Vault and the features recorded.
//
// THE TEAMS SCOPE RULE (differs from mail on purpose, spec 4.4): every REQUESTED scope must be granted; a granted scope that was not requested is accepted ONLY if it is a scope of this
// app (`TEAMS_KNOWN_SCOPES`); anything else (a `Mail.*` scope, another resource) refuses the grant and nothing is stored. Why: tenant-wide admin consent covers every permission on the
// registration and Microsoft lists them all in the token response, so an exact-set rule would refuse every connect the moment an administrator consents one phase ahead. The features
// recorded on the connection are REQUESTED ∩ GRANTED (here: the lane's features, because every requested scope is required).
//
// Nothing a provider answers is copied into a message, a redirect, a log line or an audit row, with the same bounded exception as mail: when a grant is refused for a scope outside the Teams
// set, the structured log field `unexpected_scopes` names it (a name is copied only when it looks like a permission name, at most 10; anything else is "other"). Tokens, the id_token, the
// code, the verifier and the client secret are SecretValues or are never held past the call. A grant refused after the exchange is dropped.
import type { LaneId } from "@nichols/core";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import type { HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import { ConnectRefusal, type OAuthProvider, type TokenResponse } from "../oauth/flow";
import { authorityFor, loginEndpoints, isCloudSupported } from "../microsoft/constants";
import { checkIdToken, IdTokenRefused } from "../microsoft/id-token";
import { loggableScopes, microsoftCallbackErrorReason } from "../microsoft/provider";
import type { LaneConfigReader, TeamsSettings } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import { createGraphHttp } from "../microsoft/http";
import { TEAMS_CALLBACK_PATH, TEAMS_KNOWN_SCOPES, TEAMS_PROVIDER, TEAMS_SLUG, TEAMS_BASE_SCOPES, teamsFeatureKey, teamsScopesFor, TEAMS_GRAPH_BASE } from "./constants";
import { createTeamsHttp } from "./http";
import { TEAMS_CLOUD_UNSUPPORTED_MESSAGE, TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE, TEAMS_NOT_ENABLED_MESSAGE, type TeamsIdentityReader } from "./guard";
import type { TeamsIdentityWriter } from "./identity";

export type TeamsClientConfig = { clientId: string; clientSecret: SecretValue; redirectUri: string };

export type TeamsProviderDeps = {
  client: () => TeamsClientConfig;
  laneConfig: Pick<LaneConfigReader, "teamsSettings">;
  /** The tenant, cloud and object id already recorded on a connection row (a reconnect must come back to the same account). */
  identity: TeamsIdentityReader;
  /** Records the tenant, cloud and object id once. */
  identityWriter: TeamsIdentityWriter;
  logger?: ConnectorLogger;
  now?: () => number;
  /** Test hooks: the HTTP clients for the sign-in host and for Graph (defaults enforce the host allow-lists). */
  tokenHttpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
  graphHttpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

/** The registered redirect URI must be this app's Teams callback; anything else is a configuration error (a fixed message: the handler shows the Settings banner). */
export function assertTeamsRedirectUri(redirectUri: string): void {
  const ok = URL.canParse(redirectUri) && new URL(redirectUri).pathname === TEAMS_CALLBACK_PATH;
  if (!ok) throw new ConnectorError({ kind: "connection_unavailable", message: `GRAPH_TEAMS_REDIRECT_URI must end with ${TEAMS_CALLBACK_PATH}` });
}

const OIDC_EXTRAS: ReadonlySet<string> = new Set(["openid", "profile", "email", "offline_access"]);
const GRAPH_PREFIX = "https://graph.microsoft.com/";

/** Scope names a refused grant carried, kept beside the error (never inside its message or its info): the callback logs them as a structured field. */
const refusedScopes = new WeakMap<object, readonly string[]>();
export function teamsRefusedScopeNames(e: unknown): readonly string[] | undefined {
  return typeof e === "object" && e !== null ? refusedScopes.get(e) : undefined;
}

/**
 * The Teams scope rule (see the header). Split on whitespace, compared case-insensitively; a Graph scope is accepted as its short name or with the `https://graph.microsoft.com/`
 * prefix; EVERY requested Graph scope must be present; a granted scope that is not requested is accepted only if it is on `TEAMS_KNOWN_SCOPES`; a scope of another resource or an
 * unknown Graph scope refuses the grant. `openid` and `offline_access` are neither required nor refused in the string (the id_token and the refresh token prove them). `scope` absent
 * counts as nothing granted. Throws a fixed-message `forbidden`.
 */
export function assertTeamsGrantedScopes(scope: string | undefined, requested: readonly string[]): void {
  const wanted = new Set(requested.filter((s) => !OIDC_EXTRAS.has(s)).map((s) => s.toLowerCase()));
  const granted = new Set<string>();
  const unexpected: string[] = [];
  for (const raw of (scope ?? "").split(/\s+/)) {
    if (raw === "") continue;
    const lower = raw.toLowerCase();
    if (OIDC_EXTRAS.has(lower)) continue;
    // A fully qualified Graph scope loses its prefix; one of another resource keeps its URL form and can match nothing on the list.
    const name = lower.startsWith(GRAPH_PREFIX) ? lower.slice(GRAPH_PREFIX.length) : lower;
    if (!TEAMS_KNOWN_SCOPES.has(name)) {
      unexpected.push(raw.slice(0, 200));
      continue;
    }
    granted.add(name);
  }
  if (unexpected.length > 0) {
    // A token response lists every consented scope, so ALL unexpected ones are collected before the refusal.
    const refusal = new ConnectorError({ kind: "forbidden", message: "Microsoft granted a scope that does not belong to the Teams connection" });
    refusedScopes.set(refusal, loggableScopes(unexpected));
    throw refusal;
  }
  for (const w of wanted) {
    if (!granted.has(w)) throw new ConnectorError({ kind: "forbidden", message: "Microsoft did not grant every required scope" });
  }
}

const MeSchema = z.looseObject({
  id: z.string().min(1).max(64),
  userPrincipalName: z.string().max(512).nullish(),
  userType: z.string().max(32).nullish(),
});
const ME_QUERY = { $select: "id,userPrincipalName,userType" } as const;
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createTeamsOAuthProvider(deps: TeamsProviderDeps): OAuthProvider {
  const now = deps.now ?? Date.now;

  /** ONE `teamsSettings` read decides whether Teams is enabled; returns that same read's settings. Never reads the lane's mail providers. */
  const enabledSettings = async (laneId: LaneId): Promise<TeamsSettings> => {
    const settings = await deps.laneConfig.teamsSettings(laneId);
    if (settings === null || !settings.enabled) throw new ConnectorError({ kind: "forbidden", message: TEAMS_NOT_ENABLED_MESSAGE });
    if (!isCloudSupported(settings.cloud)) throw new ConnectorError({ kind: "forbidden", message: TEAMS_CLOUD_UNSUPPORTED_MESSAGE });
    if (settings.tenantIds.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No Teams tenant is configured for this company" });
    if (settings.allowedDomains.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No Teams account domain is configured for this company" });
    return settings;
  };
  const scopesFor = async (laneId: LaneId): Promise<readonly string[]> => teamsScopesFor((await enabledSettings(laneId)).features);
  const graphHttp = (laneId: LaneId, cloud: TeamsSettings["cloud"]): HttpClient =>
    deps.graphHttpFor
      ? deps.graphHttpFor(laneId, TEAMS_GRAPH_BASE)
      : createTeamsHttp({ baseUrl: TEAMS_GRAPH_BASE, laneId, ...(deps.logger ? { logger: deps.logger } : {}) }, cloud, "read");

  return {
    provider: TEAMS_PROVIDER,
    slug: TEAMS_SLUG,
    accountLabel: "Teams account",
    scopes: TEAMS_BASE_SCOPES,
    scopesFor,
    // `prompt=select_account` on a first connect (the person picks the work account); dropped when a reconnect sends `login_hint`.
    authorizationParams: { response_mode: "query", prompt: "select_account" },
    loginHint: true,
    logFields(cause) {
      const names = teamsRefusedScopeNames(cause);
      return names === undefined ? undefined : { unexpected_scopes: names };
    },
    omitOnLoginHint: ["prompt"],
    nonce: true,
    scopeCheckedByProvider: true,
    callbackErrorReason: microsoftCallbackErrorReason,
    tokenHttp(laneId, baseUrl) {
      return deps.tokenHttpFor ? deps.tokenHttpFor(laneId, baseUrl) : createGraphHttp({ baseUrl, laneId, ...(deps.logger ? { logger: deps.logger } : {}) }, "commercial", "token");
    },
    // The id_token is not needed after the connect and holds personal claims: it is not stored.
    storedTokens(tokens) {
      const rest: Record<string, unknown> = { ...tokens };
      delete rest.id_token;
      return rest as TokenResponse;
    },
    async endpoints(laneId) {
      const lane = await enabledSettings(laneId);
      return loginEndpoints(lane.cloud, authorityFor(lane.tenantIds));
    },
    client() {
      const c = deps.client();
      assertTeamsRedirectUri(c.redirectUri);
      return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, tokenAuth: "post" };
    },
    async startCheck({ laneId }) {
      await enabledSettings(laneId);
    },
    async precheck({ laneId }) {
      await enabledSettings(laneId);
    },
    async identify({ laneId, tokens, nonce }) {
      const lane = await enabledSettings(laneId); // read again: the exchange took time; this one read decides the scopes, the tenant and the domains below
      const requested = teamsScopesFor(lane.features);
      assertTeamsGrantedScopes(tokens.scope, requested);
      if (!tokens.refresh_token) throw new ConnectorError({ kind: "forbidden", message: "Microsoft issued no refresh token" });
      const { clientId } = deps.client();
      let tenantId: string;
      try {
        tenantId = checkIdToken((tokens as { id_token?: unknown }).id_token, { cloud: lane.cloud, tenantIds: lane.tenantIds, clientId, nonce: nonce ?? "", now: now() }).tenantId;
      } catch (e) {
        if (e instanceof IdTokenRefused) throw new ConnectRefusal(e.failure === "wrong_tenant" ? "wrong_tenant" : "account_refused");
        throw e;
      }
      const res = await graphHttp(laneId, lane.cloud).request({ method: "GET", path: "/me", query: ME_QUERY, auth: { scheme: "Bearer", secret: new SecretValue(tokens.access_token) } });
      const me = MeSchema.safeParse(res.data);
      if (!me.success) throw new ConnectorError({ kind: "provider_error", message: "The Microsoft profile is not valid" });
      // A guest is refused: `#EXT#` in the UPN always, and a non-empty `userType` other than `Member` (the same rule as mail). A null or missing `userType` is accepted when the UPN has no `#EXT#`.
      const userType = (me.data.userType ?? "").trim().toLowerCase();
      if ((me.data.userPrincipalName ?? "").toUpperCase().includes("#EXT#") || (userType !== "" && userType !== "member")) {
        throw new ConnectorError({ kind: "forbidden", message: "Only member accounts of the organisation can be connected" });
      }
      const entraObjectId = me.data.id.trim().toLowerCase();
      if (!OBJECT_ID.test(entraObjectId)) throw new ConnectorError({ kind: "provider_error", message: "The Microsoft profile is not valid" });
      // The sign-in name is the account; a Teams account may have no mailbox, so `mail` is not read.
      const upn = (me.data.userPrincipalName ?? "").trim().toLowerCase();
      if (upn === "" || !ADDRESS.test(upn)) throw new ConnectorError({ kind: "forbidden", message: "This Microsoft account has no sign-in name" });
      const domain = upn.slice(upn.lastIndexOf("@") + 1);
      if (!lane.allowedDomains.some((d) => d.toLowerCase() === domain)) throw new ConnectorError({ kind: "forbidden", message: TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE });
      // Always recorded (true or false), so a reconnect under fewer features clears an earlier `true`. Every requested scope is granted (checked above), so a feature the lane lists is on.
      const features: Record<string, boolean> = {};
      for (const f of ["chat_read", "chat_send", "call_links", "channels_read", "channels_send"] as const satisfies readonly TeamsFeature[]) features[teamsFeatureKey(f)] = lane.features.includes(f);
      return {
        externalAccountId: upn,
        expiresAt: null,
        features,
        async beforeStore({ connection }) {
          // The identity is recorded once and never changes: a row that already has another tenant, cloud or object is not this account.
          const recorded = await deps.identity.read(laneId, connection.id);
          if (recorded.tenantId === null) {
            await deps.identityWriter.setOnce(laneId, connection.id, { tenantId, cloud: lane.cloud, entraObjectId });
            return;
          }
          if (recorded.tenantId.toLowerCase() !== tenantId || recorded.cloud !== lane.cloud || (recorded.entraObjectId ?? "").toLowerCase() !== entraObjectId) throw new ConnectRefusal("wrong_account");
        },
      };
    },
  };
}
