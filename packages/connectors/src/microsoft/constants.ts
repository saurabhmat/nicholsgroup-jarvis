// Microsoft Graph constants (T-256). Provider facts only, nothing company-specific: one Entra app serves every company; a
// lane's tenants, cloud and mail folders come from lane_config (CLAUDE.md rule 2). The commercial endpoint hosts are spec §5.3 /
// V-1, checked against Microsoft's documentation on Nov 21, 2026 (docs/plan-review.md, "T-256: spec §15 verify items").
export const MICROSOFT_SLUG = "microsoft";
/** The registered redirect URI ends with this path (T-066). */
export const MICROSOFT_CALLBACK_PATH = `/api/connect/${MICROSOFT_SLUG}/callback`;

export type MicrosoftCloud = "commercial" | "gcc_high";

export const GRAPH_COMMERCIAL_BASE = "https://graph.microsoft.com/v1.0";
export const LOGIN_COMMERCIAL_ORIGIN = "https://login.microsoftonline.com";
/** Path template of the token endpoint; `{tenant}` is the connection's own tenant id (a lower-case UUID), never `common`. */
export const TOKEN_PATH = "/{tenant}/oauth2/v2.0/token";

type CloudHosts = { readonly api: ReadonlySet<string>; readonly token: ReadonlySet<string> };
const NONE: ReadonlySet<string> = new Set();

/**
 * The only hosts connector code may call, per cloud. `gcc_high` is deliberately EMPTY until T-267 (spec §5.3, §5.4: a separate
 * app registration and different hosts, needing their own verification): every host of that cloud is refused, so a lane
 * configured for it cannot send a token anywhere. Loopback is never allowed from production wiring (tests inject `allowed`).
 */
export const MICROSOFT_HOSTS: Readonly<Record<MicrosoftCloud, CloudHosts>> = Object.freeze({
  commercial: Object.freeze({ api: new Set(["graph.microsoft.com"]), token: new Set(["login.microsoftonline.com"]) }),
  gcc_high: Object.freeze({ api: NONE, token: NONE }),
});

export function microsoftHostsFor(cloud: MicrosoftCloud, kind: "api" | "token"): ReadonlySet<string> {
  return MICROSOFT_HOSTS[cloud]?.[kind] ?? NONE;
}

/** The origin of the sign-in host (token endpoint) of a cloud this build serves; anything else is refused. */
export function loginOriginFor(cloud: MicrosoftCloud): string {
  if (cloud === "commercial") return LOGIN_COMMERCIAL_ORIGIN;
  throw new Error("unsupported cloud");
}

/** Whether T-256 serves this cloud at all (only `commercial`; `gcc_high` waits for T-267). */
export const isCloudSupported = (cloud: string): cloud is MicrosoftCloud => cloud === "commercial";

/** Through the Graph client only the signed-in user's own mailbox and calendar (`/me`...) is reachable (never `/users/{id}`). */
export const GRAPH_PATH = /^\/me(\/[^?#\s]*)?$/;
/** A template that holds a backslash or a percent-encoded dot, slash or backslash (`%2e`, `%2f`, `%5c`, any case) could move the request. */
const SMUGGLED = /\\|%(?:2e|2f|5c)/i;
/** The one path rule: under `/me`, no query or fragment, and no encoded or backslash separator tricks (holds on its own, besides the shared client's checks). */
export const isGraphPath = (path: string): boolean => GRAPH_PATH.test(path) && !SMUGGLED.test(path);

/** Refresh the access token when it has less than this left. */
export const REFRESH_SKEW_MS = 5 * 60_000;
/**
 * OUR OWN client-side cap on requests in flight per mailbox. It is not presented as a Microsoft limit: the Outlook figure usually
 * quoted (4 concurrent per app and mailbox, 10,000 requests per 10 minutes) could not be confirmed in Microsoft's page text (V-16).
 * Correctness rests on honouring 429 and `Retry-After`, which Microsoft documents; this cap only keeps one process polite.
 */
export const MAX_CONCURRENT_PER_MAILBOX = 4;
/** Per-connection buckets (spec §8.5; our own pacing, same V-16 caveat): reads 4 requests/s, writes (T-262) in their own `:write` bucket. */
export const GRAPH_READ_RATE_LIMIT = { requests: 4, perMs: 1000 } as const;
export const GRAPH_WRITE_RATE_LIMIT = { requests: 2, perMs: 1000 } as const;
/** Header that carries Graph's request id. */
export const GRAPH_REQUEST_ID_HEADER = "request-id";

/** The rate-limit bucket (key within the lane and limit) of a connection's `read` or `write` calls. */
export function graphBucket(connectionId: string, kind: "read" | "write") {
  return kind === "write" ? { key: `${connectionId}:write`, limit: GRAPH_WRITE_RATE_LIMIT } : { key: connectionId, limit: GRAPH_READ_RATE_LIMIT };
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isTenantId = (v: unknown): v is string => typeof v === "string" && TENANT_ID.test(v);

/** The sign-in authority of a lane (spec §5.3): its one tenant id, or `organizations` (work and school accounts only). NEVER `common` or `consumers`. */
export function authorityFor(tenantIds: readonly string[]): string {
  const only = tenantIds.length === 1 ? String(tenantIds[0]).toLowerCase() : "organizations";
  if (only !== "organizations" && !isTenantId(only)) throw new Error("invalid tenant id");
  return only;
}

/** The authorization and token endpoints of the commercial cloud for an authority (a tenant id or `organizations`). */
export function loginEndpoints(cloud: MicrosoftCloud, authority: string): { authorization: string; token: string } {
  if (authority !== "organizations" && !isTenantId(authority)) throw new Error("invalid authority");
  const origin = loginOriginFor(cloud);
  return { authorization: `${origin}/${authority}/oauth2/v2.0/authorize`, token: `${origin}/${authority}/oauth2/v2.0/token` };
}

/** The v2.0 issuer of an id_token for a tenant of a cloud (`iss` of the commercial cloud: `https://login.microsoftonline.com/{tid}/v2.0`). */
export function issuerFor(cloud: MicrosoftCloud, tenantId: string): string {
  return `${loginOriginFor(cloud)}/${tenantId}/v2.0`;
}

/** Delegated scopes (V-4: none needs admin consent as a delegated permission; a tenant's own user-consent policy may still block). */
export const MICROSOFT_READ_SCOPES = ["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"] as const;
/** Added only when the lane policy allows email writes (same switch as Google's gmail.compose, T-232). */
export const MICROSOFT_WRITE_SCOPES = ["Mail.ReadWrite", "Mail.Send"] as const;
/** The prefix of a fully qualified Graph scope in a token response (V-5). */
export const GRAPH_SCOPE_PREFIX = "https://graph.microsoft.com/";
/** `tid` of personal Microsoft accounts (quoted in the V-6 check). Never an organisation: refused even if a lane lists it. */
export const NON_ORGANISATION_TENANTS: ReadonlySet<string> = new Set(["9188040d-6c67-4c5b-b112-36a304b66dad"]);

/**
 * Hosts a message's `webLink` may point to (spec §8.2, V-15). UNCONFIRMED ASSUMPTION: Microsoft's documentation says only "the URL to open the
 * message in Outlook on the web" and names no host. These two are the commonly seen ones for the commercial cloud; the real host is a live
 * check (H-070). Any other host, a non-https link or a link with credentials or a port gives `source_url` null (the row has no "Open in
 * Outlook" link), never a wrong link. `gcc_high` is empty until T-267.
 */
export const OUTLOOK_WEB_HOSTS: Readonly<Record<MicrosoftCloud, ReadonlySet<string>>> = Object.freeze({
  commercial: new Set(["outlook.office.com", "outlook.office365.com"]),
  gcc_high: new Set<string>(),
});

/** The connection feature the connect callback records when Microsoft granted `Mail.ReadWrite` and `Mail.Send` (T-066, spec §7; the Microsoft counterpart of Google's `gmail_compose`). */
export const GRAPH_MAIL_WRITE_FEATURE = "graph_mail_write";
/**
 * The idempotency marker of an approved email (T-262, spec §10, V-19): a single-value extended property, id form `String {guid} Name <name>` (the name is case
 * sensitive), holding the action id. Custom `internetMessageHeaders` can be set only when a message is created, so they cannot mark a reply draft; this property
 * can be set by PATCH on a draft. The GUID is ours alone (a fixed property set; any GUID is valid for a named property).
 */
export const PORTAL_MARKER_PROPERTY_ID = "String {b3c1d2e4-5f60-4a7b-8c9d-0e1f2a3b4c5d} Name NicholsPortalActionId";
/** Well-known folder names the writer looks in (they work as a path segment of `/me/mailFolders/{id}/messages`). */
export const DRAFTS_FOLDER = "drafts";
export const SENT_FOLDER = "sentitems";
