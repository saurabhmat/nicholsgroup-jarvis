// The Microsoft provider for the OAuth connect framework (T-066, spec §5 and §7; mirrors google/provider.ts). Authorization code + PKCE +
// an OpenID nonce, the client secret in the token request body, delegated scopes only.
//
// START   (flow.start): the caller is authorized by the flow, then `startCheck` refuses unless Microsoft is enabled for the lane
//         (`microsoft` in `mail.providers` AND a valid `microsoft` block: one `mailProviderSettings` read). Nothing is stored and no
//         redirect is built for a lane that is not enabled. The consent URL names the lane's authority (its one tenant id, or
//         `organizations`; never `common`), the requested scopes, `response_mode=query`, `prompt=select_account`; on a reconnect
//         `login_hint` with the stored address and NO prompt (they cannot be combined, V-6).
// CALLBACK, in this order, everything before anything is stored:
//   1. `callbackErrorReason`: an `error=` answer never reaches the exchange; Microsoft's consent errors are `admin_consent_required` (V-7).
//   2. `precheck`: Microsoft enabled for the lane, at least one tenant id, the lane's mail domains configured. All before the exchange,
//      so a lane that cannot accept an account never obtains a grant.
//   3. the code exchange (the flow), at the lane's authority.
//   4. `identify`: granted scopes (V-5 formats) and a refresh token; the id_token (./id-token.ts: `tid` in the lane's list, `iss`, `aud`,
//      `exp`, `nonce`; no signature check, V-6); GCC (see below); Graph `GET /me` for the mailbox (`mail`, a Member, no `#EXT#`); the
//      lane's mail policy.
//   5. the flow's reconnect, D-23 and owner checks, then `beforeStore`: the tenant and cloud are recorded once on the connection row
//      (a reconnect must come back to the tenant already recorded); then the token set is stored in the Vault and the features recorded.
//
// GCC (spec §5.4, V-3): Microsoft's documentation does not describe any GCC signal in the sign-in metadata, so GCC is NOT detectable and
// this connector makes no metadata call. `microsoft.allow_gcc` is a documented manual gate for the people who configure the lane (a human
// sets it only after D-49 is decided; GCC tenants use the commercial endpoints, which this provider serves); the connect itself cannot tell.
//
// Nothing a provider answers is copied into a message, a redirect, a log line or an audit row, with ONE deliberate, tightly bounded exception
// (T-270): when a grant is refused because it holds a scope that was not requested, the structured log field `unexpected_scopes` of
// `connector.oauth_callback_failed` names those scopes, so the person who configures the Entra app can see which permission to remove. A name is
// copied only when it matches /^[A-Za-z0-9._-]{1,64}$/ AND looks like a permission name (letter first, at most 48 characters, dotted Graph name or openid/profile/email/offline_access; after the Graph prefix is dropped), at most 10 names; anything else (another resource's
// URL, odd characters, too long, the 11th and later) is counted as the single entry "other". The user-facing message, the redirect and the audit
// row never carry them. Tokens, the id_token, the code, the
// verifier and the client secret are SecretValues or are never held past the call. A grant refused after the exchange is dropped.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import { PROVIDER_DISABLED_MESSAGE, providerEnabledIn } from "../facade/gate";
import type { HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import { assertMailAccountAllowed, assertMailDomainsConfigured, readMailPolicy } from "../mail-policy";
import { ConnectRefusal, type ConnectFailure, type OAuthProvider, type TokenResponse } from "../oauth/flow";
import type { LaneConfigReader, MicrosoftSettings } from "../vault/lane-config";
import { SecretValue } from "../vault/secret";
import {
  authorityFor,
  GRAPH_COMMERCIAL_BASE,
  GRAPH_READ_RATE_LIMIT,
  GRAPH_SCOPE_PREFIX,
  isCloudSupported,
  loginEndpoints,
  MICROSOFT_CALLBACK_PATH,
  MICROSOFT_READ_SCOPES,
  MICROSOFT_SLUG,
  MICROSOFT_WRITE_SCOPES,
} from "./constants";
import { CLOUD_UNSUPPORTED_MESSAGE, type MicrosoftIdentityReader } from "./guard";
import { checkIdToken, IdTokenRefused } from "./id-token";
import type { MicrosoftIdentityWriter } from "./identity";
import { createGraphHttp } from "./http";

export type MicrosoftClientConfig = { clientId: string; clientSecret: SecretValue; redirectUri: string };

export type MicrosoftProviderDeps = {
  client: () => MicrosoftClientConfig;
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "mailDomains" | "mailProviderSettings">;
  /** The tenant and cloud already recorded on a connection row (a reconnect must come back to the same tenant). */
  identity: MicrosoftIdentityReader;
  /** Records the tenant and cloud once (T-254). */
  identityWriter: MicrosoftIdentityWriter;
  /** Whether the lane policy allows email writes (same switch as Google's compose, T-232). Default: never (read-only). Fails closed: a throw refuses. */
  writesAllowed?: (laneId: LaneId) => Promise<boolean>;
  logger?: ConnectorLogger;
  now?: () => number;
  /** Test hooks: the HTTP clients for the sign-in host and for Graph (defaults enforce the host allow-lists). */
  tokenHttpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
  graphHttpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

/** The registered redirect URI must be this app's Microsoft callback; anything else is a configuration error. */
export function assertRedirectUri(redirectUri: string): void {
  const ok = URL.canParse(redirectUri) && new URL(redirectUri).pathname === MICROSOFT_CALLBACK_PATH;
  if (!ok) throw new ConnectorError({ kind: "connection_unavailable", message: `GRAPH_REDIRECT_URI must end with ${MICROSOFT_CALLBACK_PATH}` });
}

/** Scopes that are not Graph permissions and that Microsoft may name in the token response without us having to require them (V-5: not required). */
const OIDC_EXTRAS: ReadonlySet<string> = new Set(["openid", "profile", "email", "offline_access"]);

/**
 * The granted scopes of a token response against the requested Graph scopes (V-5, docs/plan-review.md): split on whitespace, compared
 * case-insensitively; a Graph scope is accepted as its short name or with the `https://graph.microsoft.com/` prefix; EVERY requested Graph
 * scope must be present; a Graph scope that was not requested (a write scope under a read-only lane policy, anything else) or a scope of
 * another resource refuses the grant. `openid` and `offline_access` are neither required nor refused in the string (the id_token and the
 * refresh token prove them). `scope` absent counts as nothing granted. Throws a fixed-message `forbidden`.
 */
/** Scope names a refused grant carried, kept beside the error (never inside its message or its info): the callback logs them as a structured field. */
const refusedScopes = new WeakMap<object, readonly string[]>();
const SAFE_SCOPE = /^[A-Za-z0-9._-]{1,64}$/;
/** A name is logged only if it also looks like a permission name (a dotted Graph name, or a known plain OpenID name): an opaque string (a token-like value) is "other". */
// The first segment may hold a dash too (real names such as UserAuthMethod-Email.Read.All). A JWT-like value ("eyJ" is base64 of {") or a long opaque segment is not a name.
const PERMISSION_LIKE = /^(?!eyJ)[A-Za-z][A-Za-z0-9-]{0,23}(\.[A-Za-z0-9-]{1,24}){1,4}$/;
const PLAIN_NAMES: ReadonlySet<string> = new Set(["openid", "profile", "email", "offline_access"]);
const MAX_SCOPE_NAME = 48;
const loggable = (n: string): boolean => SAFE_SCOPE.test(n) && n.length <= MAX_SCOPE_NAME && (PERMISSION_LIKE.test(n) || PLAIN_NAMES.has(n.toLowerCase()));
const MAX_LOGGED_SCOPES = 10;

/** The names to log for the unexpected scopes: safe-pattern names only (without the Graph prefix), at most 10, everything else as one "other". */
export function loggableScopes(unexpected: readonly string[]): string[] {
  const out: string[] = [];
  let other = false;
  for (const raw of unexpected) {
    const name = raw.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX) ? raw.slice(GRAPH_SCOPE_PREFIX.length) : raw;
    if (loggable(name) && !out.includes(name) && out.length < MAX_LOGGED_SCOPES) out.push(name);
    else if (!loggable(name) || out.length >= MAX_LOGGED_SCOPES) other = true;
  }
  if (other) out.push("other");
  return out;
}

/** The scope names recorded for a refusal thrown by assertGrantedScopes, or undefined for any other error. */
export function refusedScopeNames(e: unknown): readonly string[] | undefined {
  return typeof e === "object" && e !== null ? refusedScopes.get(e) : undefined;
}

export function assertGrantedScopes(scope: string | undefined, requested: readonly string[]): void {
  const wanted = new Set(requested.filter((s) => !OIDC_EXTRAS.has(s)).map((s) => s.toLowerCase()));
  const granted = new Set<string>();
  const unexpected: string[] = [];
  for (const raw of (scope ?? "").split(/\s+/)) {
    if (raw === "") continue;
    const lower = raw.toLowerCase();
    if (OIDC_EXTRAS.has(lower)) continue;
    // A fully qualified Graph scope loses its prefix; one of another resource keeps its URL form and cannot match a short name.
    const name = lower.startsWith(GRAPH_SCOPE_PREFIX) ? lower.slice(GRAPH_SCOPE_PREFIX.length) : lower;
    if (!wanted.has(name)) {
      unexpected.push(raw.slice(0, 200));
      continue;
    }
    granted.add(name);
  }
  if (unexpected.length > 0) {
    // V-5: a v2 token response lists every consented scope of the resource, so ALL unexpected ones are collected before the refusal.
    const refusal = new ConnectorError({ kind: "forbidden", message: "Microsoft granted a scope that was not requested (write access is never accepted unless the company allows it)" });
    refusedScopes.set(refusal, loggableScopes(unexpected));
    throw refusal;
  }
  for (const w of wanted) {
    if (!granted.has(w)) throw new ConnectorError({ kind: "forbidden", message: "Microsoft did not grant every required scope" });
  }
}

/**
 * Consent errors of the callback (V-7, docs/plan-review.md). The OAuth `error` string decides: `consent_required` is a consent error.
 * For `access_denied` and `interaction_required` the AADSTS code in `error_description` only REFINES: 65001 (no consent) and 90094 (admin
 * consent required) are consent errors; any other code, or none, is `denied` (the user cancelled, or something else). Nothing from the
 * description is kept: only whether one of two numbers occurs.
 */
const CONSENT_AADSTS: ReadonlySet<string> = new Set(["65001", "90094"]);
export function microsoftCallbackErrorReason(query: URLSearchParams): ConnectFailure | null {
  const error = query.get("error");
  if (error === "consent_required") return "admin_consent_required";
  if (error === "access_denied" || error === "interaction_required") {
    const code = /AADSTS(\d{5,6})/.exec(query.get("error_description") ?? "")?.[1];
    if (code !== undefined && CONSENT_AADSTS.has(code)) return "admin_consent_required";
  }
  return null;
}

const MeSchema = z.looseObject({
  id: z.string().min(1).max(256),
  mail: z.string().max(320).nullish(),
  userPrincipalName: z.string().max(512).nullish(),
  userType: z.string().max(32).nullish(),
});
const ME_QUERY = { $select: "id,mail,userPrincipalName,userType" } as const;
const ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function createMicrosoftOAuthProvider(deps: MicrosoftProviderDeps): OAuthProvider {
  const now = deps.now ?? Date.now;

  /** ONE `mailProviderSettings` read decides whether Microsoft is enabled; returns that same read's Microsoft block. */
  const enabledSettings = async (laneId: LaneId): Promise<MicrosoftSettings> => {
    const settings = await deps.laneConfig.mailProviderSettings(laneId);
    if (!providerEnabledIn(settings, "microsoft") || !settings.microsoft) throw new ConnectorError({ kind: "forbidden", message: PROVIDER_DISABLED_MESSAGE });
    if (!isCloudSupported(settings.microsoft.cloud)) throw new ConnectorError({ kind: "forbidden", message: CLOUD_UNSUPPORTED_MESSAGE });
    return settings.microsoft;
  };
  const writesAllowed = async (laneId: LaneId): Promise<boolean> => (deps.writesAllowed ? (await deps.writesAllowed(laneId)) === true : false);
  const scopesFor = async (laneId: LaneId): Promise<readonly string[]> => ((await writesAllowed(laneId)) ? [...MICROSOFT_READ_SCOPES, ...MICROSOFT_WRITE_SCOPES] : MICROSOFT_READ_SCOPES);
  const policyOf = async (laneId: LaneId) => {
    const policy = await readMailPolicy(deps.laneConfig, laneId);
    assertMailDomainsConfigured(policy.domains);
    return policy;
  };
  const graphHttp = (laneId: LaneId, cloud: MicrosoftSettings["cloud"]): HttpClient =>
    deps.graphHttpFor
      ? deps.graphHttpFor(laneId, GRAPH_COMMERCIAL_BASE)
      : createGraphHttp({ baseUrl: GRAPH_COMMERCIAL_BASE, laneId, rateLimit: GRAPH_READ_RATE_LIMIT, ...(deps.logger ? { logger: deps.logger } : {}) }, cloud, "api");

  return {
    provider: "microsoft",
    slug: MICROSOFT_SLUG,
    accountLabel: "Microsoft mailbox",
    scopes: MICROSOFT_READ_SCOPES,
    scopesFor,
    // `prompt=select_account` on a first connect (the person picks the work account); dropped when a reconnect sends `login_hint`.
    authorizationParams: { response_mode: "query", prompt: "select_account" },
    loginHint: true,
    logFields(cause) {
      const names = refusedScopeNames(cause);
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
      if (lane.tenantIds.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No Microsoft tenant is configured for this company" });
      return loginEndpoints(lane.cloud, authorityFor(lane.tenantIds));
    },
    client() {
      const c = deps.client();
      assertRedirectUri(c.redirectUri);
      return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri, tokenAuth: "post" };
    },
    async startCheck({ laneId }) {
      await enabledSettings(laneId);
    },
    async precheck({ laneId }) {
      const lane = await enabledSettings(laneId);
      if (lane.tenantIds.length === 0) throw new ConnectorError({ kind: "forbidden", message: "No Microsoft tenant is configured for this company" });
      await policyOf(laneId);
    },
    async identify({ laneId, tokens, nonce }) {
      const requested = await scopesFor(laneId);
      assertGrantedScopes(tokens.scope, requested);
      if (!tokens.refresh_token) throw new ConnectorError({ kind: "forbidden", message: "Microsoft issued no refresh token" });
      const lane = await enabledSettings(laneId); // read again: the exchange took time
      const { clientId } = deps.client();
      let tenantId: string;
      try {
        tenantId = checkIdToken((tokens as { id_token?: unknown }).id_token, { cloud: lane.cloud, tenantIds: lane.tenantIds, clientId, nonce: nonce ?? "", now: now() }).tenantId;
      } catch (e) {
        if (e instanceof IdTokenRefused) throw new ConnectRefusal(e.failure === "wrong_tenant" ? "wrong_tenant" : "account_refused");
        throw e;
      }
      const policy = await policyOf(laneId);
      const res = await graphHttp(laneId, lane.cloud).request({ method: "GET", path: "/me", query: ME_QUERY, auth: { scheme: "Bearer", secret: new SecretValue(tokens.access_token) } });
      const me = MeSchema.safeParse(res.data);
      if (!me.success) throw new ConnectorError({ kind: "provider_error", message: "The Microsoft profile is not valid" });
      // A guest is refused: `#EXT#` in the UPN (the B2B collaboration format) always, and a non-empty `userType` other than `Member`
      // (case-insensitive: `Guest`, unknown values). Microsoft documents `Member` and `Guest`, does not rule out null, and says a B2B user
      // can be `Member`, so a null, missing or empty `userType` is accepted when the UPN has no `#EXT#`.
      const userType = (me.data.userType ?? "").trim().toLowerCase();
      if ((me.data.userPrincipalName ?? "").toUpperCase().includes("#EXT#") || (userType !== "" && userType !== "member")) {
        throw new ConnectorError({ kind: "forbidden", message: "Only member accounts of the organisation can be connected" });
      }
      const address = (me.data.mail ?? "").trim().toLowerCase();
      if (address === "" || !ADDRESS.test(address)) throw new ConnectorError({ kind: "forbidden", message: "This Microsoft account has no mailbox address" });
      assertMailAccountAllowed(policy, address);
      const writes = MICROSOFT_WRITE_SCOPES.every((s) => requested.includes(s)); // requested only when the lane allows writes, and required above, so granted
      return {
        externalAccountId: address,
        expiresAt: null,
        // Always recorded, so a reconnect under a stricter lane policy clears an earlier `true`.
        features: { graph_mail_write: writes },
        async beforeStore({ connection }) {
          // The tenant is recorded once and never changes (T-254): a row that already has another tenant is not this account.
          const recorded = await deps.identity.read(laneId, connection.id);
          if (recorded.tenantId === null) {
            await deps.identityWriter.setOnce(laneId, connection.id, tenantId, lane.cloud);
            return;
          }
          if (recorded.tenantId.toLowerCase() !== tenantId || recorded.cloud !== lane.cloud) throw new ConnectRefusal("wrong_account");
        },
      };
    },
  };
}
