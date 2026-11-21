// The tenant admin consent link and the return from it (T-257, spec §5.5; checked against Microsoft's documentation on Nov 21, 2026,
// docs/plan-review.md "T-257: spec §15 verify items", V-9 part "Admin consent link").
//
// LINK: `https://login.microsoftonline.com/{tenant}/v2.0/adminconsent` with `client_id`, the registered `redirect_uri` (the same one the connect
// uses), `scope` (the Graph scopes the connect requests for the lane, fully qualified, as the documentation's example) and a `state` that is a
// FIXED marker naming the lane. `{tenant}` is the lane's one tenant id, or `organizations` when several are listed; never `common`. Only for the
// `commercial` cloud: a lane on another cloud gets no link (the GCC High host of this endpoint is not stated, T-267).
//   - It carries no secret: the client id and the redirect URI are public values of the app registration; the client secret is never read here.
//   - No state is stored anywhere: the `state` value is a constant of the lane code, not a random value looked up later, and the callback
//     treats it as nothing but "which lane's Settings page to go back to".
// RETURN: Microsoft redirects the admin's browser to the connect callback WITHOUT a `code`, with `admin_consent=True` or `error=...` and the
// marker `state`. `consentReturn` recognises exactly that shape. It is NOT a connect: the handler answers with a redirect carrying one of two fixed
// codes and nothing from the request (`tenant`, `scope`, `admin_consent`, `error`, `error_description` are never copied).
import type { LaneId } from "@nichols/core";
import { authorityFor, GRAPH_SCOPE_PREFIX, isCloudSupported, isTenantId, LOGIN_COMMERCIAL_ORIGIN, MICROSOFT_SLUG } from "./constants";
import { assertRedirectUri } from "./provider";

const OIDC_EXTRAS: ReadonlySet<string> = new Set(["openid", "profile", "email", "offline_access"]);
const LANE = /^[A-Z]{1,8}$/;
const MARKER = /^([A-Z]{1,8})\.adminconsent$/;

/** The fixed `state` of an admin consent link of a lane. It never matches a connect state (those carry 43 random characters after the lane). */
export const adminConsentState = (laneId: string): string => `${laneId}.adminconsent`;

export type AdminConsentInput = {
  clientId: string;
  redirectUri: string;
  cloud: string;
  tenantIds: readonly string[];
  /** The scopes the connect requests for the lane (`scopesFor`); only the Graph ones are put in the link. */
  scopes: readonly string[];
  laneId: string;
};

/** The link, or null when none can be built (not the commercial cloud, no valid tenant, no client id, a redirect URI that is not the app's callback). Pure. */
export function buildAdminConsentUrl(input: AdminConsentInput): string | null {
  if (!isCloudSupported(input.cloud) || !LANE.test(input.laneId) || input.clientId.length === 0) return null;
  if (input.tenantIds.length === 0 || !input.tenantIds.every(isTenantId)) return null;
  try {
    assertRedirectUri(input.redirectUri);
    const tenant = authorityFor(input.tenantIds); // the one tenant id, or `organizations`; never `common`
    const scope = input.scopes.filter((s) => !OIDC_EXTRAS.has(s.toLowerCase())).map((s) => `${GRAPH_SCOPE_PREFIX}${s}`);
    if (scope.length === 0) return null;
    const url = new URL(`${LOGIN_COMMERCIAL_ORIGIN}/${tenant}/v2.0/adminconsent`);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", scope.join(" "));
    url.searchParams.set("state", adminConsentState(input.laneId));
    return url.toString();
  } catch {
    return null;
  }
}

/** The link for a lane from its settings (one read, taken by the caller) over the app's client id and the lane's connect scopes. Any failure is null (no link). */
export function createAdminConsentLink(deps: { client: () => { clientId: string; redirectUri: string }; scopesFor: (laneId: LaneId) => Promise<readonly string[]> }) {
  return async function link(laneId: LaneId, settings: { cloud: string; tenantIds: readonly string[] }): Promise<string | null> {
    if (!isCloudSupported(settings.cloud)) return null; // before any other read
    try {
      const { clientId, redirectUri } = deps.client();
      return buildAdminConsentUrl({ clientId, redirectUri, cloud: settings.cloud, tenantIds: settings.tenantIds, scopes: await deps.scopesFor(laneId), laneId });
    } catch {
      return null;
    }
  };
}

export type ConsentReturn = { laneId: string; ok: boolean };

/**
 * Whether a callback request is the return from an admin consent link, and what it says. ONLY when all of these hold:
 *   - the provider is Microsoft,
 *   - there is no `code` parameter at all (not even an empty one): a request with a `code` is a connect and takes the normal path, whatever
 *     else it carries,
 *   - there is exactly one `state` and it is the fixed marker of a lane (a real connect state has 43 random characters, so it never matches).
 * A real connect (or its denied / error return) always carries its own stored state, so it is never taken for this. `ok` is true only for
 * `admin_consent=True` without any `error`. Nothing else of the query is read.
 */
export function consentReturn(provider: string, query: URLSearchParams): ConsentReturn | null {
  if (provider !== MICROSOFT_SLUG || query.has("code")) return null;
  const states = query.getAll("state");
  const lane = states.length === 1 ? MARKER.exec(states[0] ?? "")?.[1] : undefined;
  if (lane === undefined) return null;
  const ok = !query.has("error") && query.getAll("admin_consent").length === 1 && query.get("admin_consent")?.toLowerCase() === "true";
  return { laneId: lane, ok };
}
