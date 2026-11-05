// Google Workspace constants (T-063). Nothing company-specific: one Google Cloud OAuth client serves every company; a
// lane's mailboxes come from lane_config (CLAUDE.md rule 2). Read-only scopes only (H-008).
export const GOOGLE_SLUG = "google";
/** The redirect URI registered with Google ends with this path (http://localhost:3000 in local dev). */
export const GOOGLE_CALLBACK_PATH = `/api/connect/${GOOGLE_SLUG}/callback`;

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_BASE = "https://gmail.googleapis.com";
/** Google Calendar lives on the shared www.googleapis.com host; only the paths in CALENDAR_PATHS may be called there (T-064). */
export const CALENDAR_BASE = "https://www.googleapis.com";
/** The only Calendar API path templates connector code may GET. Everything else on www.googleapis.com is refused before a token is read. */
export const CALENDAR_PATHS: ReadonlySet<string> = new Set([
  "/calendar/v3/users/me/calendarList",
  "/calendar/v3/calendars/{calendarId}/events",
  "/calendar/v3/calendars/{calendarId}/events/{eventId}",
]);

/**
 * The only hosts connector code may call for Google: Gmail (also used for the profile that names the mailbox) and the
 * OAuth token/revoke host, and www.googleapis.com for Calendar (T-064; the API client restricts it to CALENDAR_PATHS).
 * accounts.google.com is only the browser consent redirect, never called from the server.
 */
export const GOOGLE_HOSTS: ReadonlySet<string> = new Set(["gmail.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"]);
/** Narrower sets for clients that only ever talk to one host: token/revoke (OAuth) and the connect-time Gmail profile. */
export const GOOGLE_TOKEN_HOSTS: ReadonlySet<string> = new Set(["oauth2.googleapis.com"]);
export const GOOGLE_GMAIL_HOSTS: ReadonlySet<string> = new Set(["gmail.googleapis.com"]);
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

/** Calendar quota is per user and per project; stay far below it. Separate bucket from Gmail (key suffix in the API client). */
export const CALENDAR_RATE_LIMIT = { requests: 10, perMs: 1000 } as const;
/** Events older than this are purged (cal.event_index_purge maximum); the first load never reaches back further than it or the lane's retention. */
export const EVENT_RETENTION_DAYS = 180;
/** Default look-ahead of a calendar load. Overridden by lane_config.calendar.forward_days. */
export const DEFAULT_FORWARD_DAYS = 365;
/** At most this many calendars per connection are synced (the composite cursor must stay under 16 KB). */
export const MAX_CALENDARS = 10;
