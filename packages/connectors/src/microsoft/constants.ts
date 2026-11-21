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
