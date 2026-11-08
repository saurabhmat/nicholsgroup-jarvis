// Composio constants (T-219; AI Brain spec §8). Everything the connector may call is listed here: the toolkits, the tool
// slugs (the allow-list, spec §8.4 initial read list) and the pinned toolkit versions. Nothing company-specific (rule 2):
// auth config ids come from the environment, mailboxes from lane_config.

/** The Composio API; pinned in the SDK constructor so a stray COMPOSIO_BASE_URL in the environment cannot redirect calls. */
export const COMPOSIO_BASE_URL = "https://backend.composio.dev";

/** Our callback route (a static route beside the generic /api/connect/[provider]/callback). */
export const COMPOSIO_CALLBACK_PATH = "/api/connect/composio/callback";

/** Provider recorded on the connection: Composio is a transport for the Google connector (D-35). */
export const COMPOSIO_PROVIDER = "google" as const;

/** Per-call timeout for every SDK call (the SDK has its own HTTP stack, so we bound it here; spec §8.5). */
export const COMPOSIO_TIMEOUT_MS = 15_000;

/** Toolkit versions pinned in the constructor (spec §8.6, latest on Nov 7, 2026). Never `dangerouslySkipVersionCheck`. */
export const TOOLKIT_VERSIONS = { gmail: "20261103_00", googlecalendar: "20261103_00" } as const;

export const TOOLKITS = ["gmail", "googlecalendar"] as const;
export type Toolkit = (typeof TOOLKITS)[number];

export function isToolkit(value: unknown): value is Toolkit {
  return typeof value === "string" && (TOOLKITS as readonly string[]).includes(value);
}

export type ToolkitSpec = {
  /** Shown on Settings. */
  label: string;
  /** Environment variable holding this toolkit's auth config id (not a secret; a Composio project setting). */
  authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID" | "COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID";
  /** Read-only tool that returns the account's address. */
  identityTool: string;
  /** Read-only tool for the "Test" page read: one item, never returned to the browser. */
  testTool: string;
  /** Fixed arguments of the test read (small, metadata-leaning). */
  testArguments: Readonly<Record<string, unknown>>;
};

export const TOOLKIT_SPECS: Readonly<Record<Toolkit, ToolkitSpec>> = {
  gmail: {
    label: "Gmail",
    authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
    identityTool: "GMAIL_GET_PROFILE",
    testTool: "GMAIL_FETCH_EMAILS",
    testArguments: { max_results: 1, include_spam_trash: false, verbose: false },
  },
  googlecalendar: {
    label: "Google Calendar",
    authConfigEnv: "COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID",
    identityTool: "GOOGLECALENDAR_GET_CURRENT_USER",
    testTool: "GOOGLECALENDAR_EVENTS_LIST",
    testArguments: { calendarId: "primary", maxResults: 1, singleEvents: true },
  },
};

/**
 * The runtime allow-list (spec §8.4, initial read list). A slug not listed here is refused by our code before any
 * network call, whatever Composio would accept. Writes are not here: they join with the approvals executors (T-225).
 */
export const ALLOWED_TOOL_SLUGS: Readonly<Record<Toolkit, readonly string[]>> = {
  gmail: [
    "GMAIL_FETCH_EMAILS",
    "GMAIL_LIST_THREADS",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_LIST_LABELS",
    "GMAIL_GET_PROFILE",
    "GMAIL_SEARCH_PEOPLE",
  ],
  googlecalendar: [
    "GOOGLECALENDAR_EVENTS_LIST",
    "GOOGLECALENDAR_EVENTS_GET",
    "GOOGLECALENDAR_FIND_EVENT",
    "GOOGLECALENDAR_FIND_FREE_SLOTS",
    "GOOGLECALENDAR_FREE_BUSY_QUERY",
    "GOOGLECALENDAR_LIST_CALENDARS",
    "GOOGLECALENDAR_GET_CURRENT_USER",
  ],
};

/** Composio connected account ids look like `ca_...`; refuse anything else before it is stored or sent. */
export const CONNECTED_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Hosts a Composio-hosted consent link may point at (https only). Verified by the live check (H-039). */
export const COMPOSIO_LINK_HOST = /(^|\.)composio\.dev$/;
