// GovCon news (T-234 part 4): client-safe types and the fixed reason texts. Nothing here imports a server module.

/** One validated story, as shown on Home. Text is plain (React renders it as text, never as HTML). */
export type NewsItem = {
  headline: string;
  why: string;
  source: string;
  /** null = the page's date could not be confirmed ("date unknown"). */
  publishedAt: string | null;
  url: string;
  /** The link's host is one of the lane's preferred domains (checked when the digest was stored). */
  preferred: boolean;
};

const MULTI_PART_SUFFIXES = new Set(["co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "com.au", "gov.au", "org.au", "co.nz", "co.jp", "co.in", "com.br", "co.za", "com.cn"]);

/** The registrable host of a stored link ("www.acquisition.gov" -> "acquisition.gov"): where the link really goes, not what the model called it. */
export function registrableHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  const labels = host.split(".");
  if (labels.length <= 2) return host || null;
  const two = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(two) ? labels.slice(-3).join(".") : two;
}

/** One digest row's items as stored (brief.news_digests.items). */
export type StoredNewsItem = { headline: string; why: string; source_name: string; source_url: string; published_at: string | null; citations: string[]; preferred: boolean };

/**
 * The refresh limit, enforced in SQL (brief.news_reserve): one OK/partial refresh per hour; after a FAILED refresh one retry is
 * allowed 5 minutes later. Home shows the time SQL reports (core.news_latest.next_refresh_at).
 */
export const NEWS_REFRESH_INTERVAL_MS = 60 * 60_000;

/** The whole owner-refresh fetch (model call with its searches and resumes) is cut off here (Home's maxDuration is 90 s); the SQL row is then closed as failed/timed_out. */
export const NEWS_REFRESH_TIMEOUT_MS = 70_000;

/** Why a stored attempt failed (brief.news_digests.failure_code): fixed codes only, never a vendor message. */
export const NEWS_FAILURE_CODES = ["model_failed", "model_busy", "timed_out", "model_refused", "output_unusable", "no_valid_items", "search_failed", "incomplete", "output_truncated"] as const;
export type NewsFailureCode = (typeof NEWS_FAILURE_CODES)[number];

const FAILURE_TEXT: Record<NewsFailureCode, string> = {
  model_failed: "the AI service did not answer",
  model_busy: "the AI service was busy",
  timed_out: "the fetch took too long",
  model_refused: "the AI declined the request",
  output_unusable: "the AI answer could not be used",
  no_valid_items: "no stories could be verified",
  search_failed: "web search was unavailable",
  incomplete: "the search did not finish",
  output_truncated: "the AI answer was too long",
};

/** A fixed reason for any stored code; an unknown code (newer or tampered data) gets a generic one. */
export const newsFailureText = (code: string | null | undefined): string => (code && Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code as NewsFailureCode] : "an unexpected error");

/** Why a fetch was refused before any model call (nothing is stored). */
export type NewsGateCode = "not_configured" | "cap_reached" | "rate_limited" | "busy" | "already_fetched" | "retry_later" | "attempts_exhausted";
export const NEWS_GATE_CODES: readonly NewsGateCode[] = ["not_configured", "cap_reached", "rate_limited", "busy", "already_fetched", "retry_later", "attempts_exhausted"];

/** What Home needs to draw the card. Built on the server from SQL only (core.news_latest, news_enabled, news_spend). */
export type NewsCard = {
  /** web category on AND news.enabled (core.news_enabled): false shows "News not configured". */
  configured: boolean;
  items: NewsItem[];
  /** When the shown digest was stored (ISO). */
  updatedAt: string | null;
  /** Fixed code of the newest failed attempt after the shown digest, if any. */
  failure: string | null;
  /** The owner may press Refresh (owner role; a lane owner always holds the briefing view). */
  canRefresh: boolean;
  /** ISO time from which Refresh is allowed again (the last owner refresh + 1 hour), when that is still in the future. */
  nextRefreshAt: string | null;
  /** Month-to-date estimate + the worst case of one call exceeds the cap (owner only). */
  budgetReached: boolean;
  /** Admin/owner only: shows the Settings hint on the empty state. */
  isAdmin: boolean;
  /** A fetch is running right now. */
  inFlight: boolean;
};

/** The Refresh action's answer: codes only. */
export type RefreshNewsState =
  | { ok: true; status: string; failure?: string }
  | { error: "forbidden" | "not_configured" | "cap_reached" | "rate_limited" | "busy" | "ai_not_set_up" | "unavailable" }
  | null;
