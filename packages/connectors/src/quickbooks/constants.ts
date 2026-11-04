// QuickBooks Online constants (T-050). Nothing here is company-specific: one Intuit app serves every company file, and a
// lane's realm comes from lane_config (CLAUDE.md rule 2). Scope is the Accounting API only (QB-7 scope of use).
export type IntuitEnvironment = "sandbox" | "production";

/** The only scope the Jarvis app requests. */
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
/** Route segment: /api/connect/qbo/callback (the redirect URI registered with Intuit ends with it). */
export const QBO_SLUG = "qbo";
export const QBO_CALLBACK_PATH = `/api/connect/${QBO_SLUG}/callback`;
/** Header carrying Intuit's transaction id; logged for every response (QB-9). */
export const INTUIT_TID_HEADER = "intuit_tid";

/** Intuit's OpenID discovery documents (QB-5: endpoints are read from here, not hard-coded). */
export const DISCOVERY_ORIGIN = "https://developer.api.intuit.com";
export const DISCOVERY_PATH: Record<IntuitEnvironment, string> = {
  sandbox: "/.well-known/openid_sandbox_configuration",
  production: "/.well-known/openid_configuration",
};

/** Accounting API base per environment. */
export const API_BASE: Record<IntuitEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

/** Intuit allows 500 requests per minute per realm; stay under it. */
export const API_RATE_LIMIT = { requests: 450, perMs: 60_000 } as const;
/** Minor version sent on API calls. */
export const MINOR_VERSION = 75;
/** Refresh the access token when it has less than this left. */
export const REFRESH_SKEW_MS = 5 * 60_000;
