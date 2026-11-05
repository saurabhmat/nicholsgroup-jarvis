// Google Workspace constants (T-063). Nothing company-specific: one Google Cloud OAuth client serves every company; a
// lane's mailboxes come from lane_config (CLAUDE.md rule 2). Read-only scopes only (H-008).
export const GOOGLE_SLUG = "google";
/** The redirect URI registered with Google ends with this path (http://localhost:3000 in local dev). */
export const GOOGLE_CALLBACK_PATH = `/api/connect/${GOOGLE_SLUG}/callback`;

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_BASE = "https://gmail.googleapis.com";

/**
 * The only hosts connector code may call for Google: Gmail (also used for the profile that names the mailbox) and the
 * OAuth token/revoke host. accounts.google.com is only the browser consent redirect, never called from the server;
 * T-064 adds www.googleapis.com for Calendar.
 */
export const GOOGLE_HOSTS: ReadonlySet<string> = new Set(["gmail.googleapis.com", "oauth2.googleapis.com"]);
/** history.list event types requested (repeated parameter). */
export const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
/** Exactly these three, requested and required on the callback (H-008). Never a write scope. */
export const GOOGLE_SCOPES = [GMAIL_READONLY, CALENDAR_READONLY, DRIVE_READONLY] as const;

/** Extra parameters on the consent URL: a refresh token every time, and never merge earlier grants. */
export const GOOGLE_AUTHORIZATION_PARAMS = { access_type: "offline", prompt: "consent", include_granted_scopes: "false" } as const;

/** Gmail's per-user quota is 250 units/s and a metadata get costs 5: stay well under it. */
export const GMAIL_RATE_LIMIT = { requests: 40, perMs: 1000 } as const;
/** Refresh the access token when it has less than this left. */
export const REFRESH_SKEW_MS = 5 * 60_000;
/** metadataHeaders requested by sync: the five the index needs, plus Content-Type to tell mixed (attachments) mail. */
export const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Content-Type"] as const;
/** First sync loads this many days of mail (the lane policy's retention purges older rows anyway). */
export const DEFAULT_FULL_SYNC_DAYS = 90;
/** Largest body text returned when the caller gives no maxChars. */
export const DEFAULT_MAX_BODY_CHARS = 200_000;
