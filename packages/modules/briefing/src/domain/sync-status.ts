// Sync freshness (T-238 parts D and F): what Home says about how fresh mail and calendar are, from the same coverage rows the
// briefing reads. Deterministic and pure; the texts are FIXED per error code (never provider text, never AI text).
//  - syncStatus: one entry per stream that has a connected source: "Mail synced 4 min ago", or the stream's real failure
//    ("Mail sync failed: Google access expired. Reconnect in Settings."). Ages use the OLDEST last-good sync among the stream's
//    sources, so the line is never optimistic.
//  - staleDataLine: one line when mail or calendar data is older than 24 hours (or never synced), or the summary itself is.
import type { CoverageItem } from "./coverage";
import { BUSINESS_TZ, ago, formatDateTimeIn, formatTimeIn, localDate } from "./time";

export type SyncStream = "mail" | "calendar";
const LABEL: Record<SyncStream, string> = { mail: "Mail", calendar: "Calendar" };
const NOUNS: Record<SyncStream, string> = { mail: "mailboxes", calendar: "calendars" };

/** Fixed, plain-English reason for a connector error code; `{P}` is the provider's name ("Google"), or "The provider" when unknown. */
const ERROR_TEXT: Record<string, string> = {
  reconnect_required: "{P} access expired. Reconnect in Settings.",
  forbidden: "{P} access was refused. Reconnect in Settings.",
  rate_limited: "{P} is limiting requests; retrying.",
  transient: "{P} had a temporary problem; retrying.",
  timeout: "{P} did not answer in time; retrying.",
  provider_error: "{P} returned an error. Try Sync now; if it continues, contact support.",
  invalid_input: "{P} rejected the request. Try Sync now; if it continues, contact support.",
  connection_unavailable: "The connection is unavailable. Check Settings.",
  not_found: "The mailbox or calendar was not found. Check Settings.",
  unsupported_op: "This connection cannot sync. Check Settings.",
  lane_mismatch: "The connection does not belong to this company. Check Settings.",
};
const GENERIC_ERROR = "The last sync did not finish. Try Sync now; if it continues, check Settings.";
const PROVIDER_NAME: Record<string, string> = { google: "Google", microsoft: "Microsoft" };
/** Which code to report when several sources failed: the one that needs a person first. */
const SEVERITY = ["reconnect_required", "forbidden", "not_found", "connection_unavailable", "unsupported_op", "lane_mismatch", "invalid_input", "provider_error", "timeout", "transient", "rate_limited"];

/** "Google access expired. Reconnect in Settings." for a code and provider; fixed text only, never the provider's own words. */
export function syncErrorText(code: string | null, provider: string | null): string {
  const text = (code !== null && Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : undefined) ?? GENERIC_ERROR;
  return text.replace("{P}", (provider !== null && Object.hasOwn(PROVIDER_NAME, provider) ? PROVIDER_NAME[provider] : undefined) ?? "The provider");
}

export type StreamSync = {
  stream: SyncStream;
  /** Connected sources of this stream, and how many of them failed their latest sync. */
  total: number;
  failed: number;
  state: "ok" | "stale" | "failed" | "never";
  /** The oldest last-good sync among the connected sources (null when any has never synced, or none is known). */
  oldestSyncAt: string | null;
  /** The visible sentence ("Mail synced 4 min ago", "Mail sync failed: ..."). */
  text: string;
  /** For the tooltip and the accessible name: the same with Eastern clock times. */
  detail: string;
};

/** Eastern clock time of a sync: "9:42 AM ET" today, "Thu, Nov 12, 9:42 AM ET" on another day. */
export function easternTime(iso: string, now: Date): string {
  const sameDay = localDate(new Date(iso), BUSINESS_TZ) === localDate(now, BUSINESS_TZ);
  return `${sameDay ? formatTimeIn(iso, BUSINESS_TZ) : formatDateTimeIn(iso, BUSINESS_TZ)} ET`;
}

const connected = (items: CoverageItem[], stream: SyncStream) => items.filter((c) => c.stream === stream && c.state !== "not_connected" && c.connectionId !== null);

/** A source failed its latest sync when it is in error, or its connection carries an error from the last sync. */
const failedSync = (c: CoverageItem) => c.state === "error" || c.errorKind !== null;
const codeOf = (c: CoverageItem): string => c.errorKind ?? (c.status === "reconnect_required" ? "reconnect_required" : "unknown");

function oldestOf(sources: CoverageItem[]): string | null {
  const times = sources.map((c) => (c.lastSyncAt === null ? Number.NaN : Date.parse(c.lastSyncAt)));
  if (times.length === 0 || times.some((t) => Number.isNaN(t))) return null;
  return new Date(Math.min(...times)).toISOString();
}

/** One entry per stream that has at least one connected source (none: the stream is omitted, nothing to report). */
export function syncStatus(items: CoverageItem[], now: Date): StreamSync[] {
  return (["mail", "calendar"] as const).flatMap((stream): StreamSync[] => {
    const sources = connected(items, stream);
    if (sources.length === 0) return [];
    const bad = sources.filter(failedSync);
    const oldest = oldestOf(sources);
    const last = oldest ? ` Last good sync ${easternTime(oldest, now)}.` : "";
    if (bad.length > 0) {
      const codes = bad.map(codeOf);
      const code = [...SEVERITY, "unknown"].find((k) => codes.includes(k)) ?? "unknown";
      const provider = bad.find((c) => codeOf(c) === code)?.provider ?? null;
      const how = sources.length > 1 ? ` for ${String(bad.length)} of ${String(sources.length)} ${NOUNS[stream]}` : "";
      const text = `${LABEL[stream]} sync failed${how}: ${syncErrorText(code, provider)}`;
      return [{ stream, total: sources.length, failed: bad.length, state: "failed", oldestSyncAt: oldest, text, detail: `${text}${last}` }];
    }
    if (oldest === null) {
      const text = `${LABEL[stream]} not synced yet`;
      return [{ stream, total: sources.length, failed: 0, state: "never", oldestSyncAt: null, text, detail: `${text}.` }];
    }
    const text = `${LABEL[stream]} synced ${ago(oldest, now)}`;
    const stale = sources.some((c) => c.state === "stale");
    return [{ stream, total: sources.length, failed: 0, state: stale ? "stale" : "ok", oldestSyncAt: oldest, text, detail: `${LABEL[stream]} last synced ${easternTime(oldest, now)}.` }];
  });
}

export const STALE_DATA_MS = 24 * 3_600_000;

const age = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000);
  return h < 48 ? `${String(h)} hours ago` : `${String(Math.floor(h / 24))} days ago`;
};

/**
 * ONE plain line when mail or calendar data is older than 24 hours (strictly: exactly 24 h is fresh) or has never synced, or when
 * the summary itself is older than 24 hours; null when everything is fresh. "Older" means the oldest last-good sync among the
 * connected sources of that kind. The summary's own age is folded into the same line, never a second one.
 * `summaryAt`: when the summary shown was prepared (ISO), or null when there is none.
 */
export function staleDataLine(items: CoverageItem[], now: Date, summaryAt: string | null = null): string | null {
  const stale: { stream: SyncStream; ms: number | null }[] = [];
  for (const stream of ["mail", "calendar"] as const) {
    const sources = connected(items, stream);
    if (sources.length === 0) continue;
    const oldest = oldestOf(sources);
    if (oldest === null) stale.push({ stream, ms: null });
    else if (now.getTime() - Date.parse(oldest) > STALE_DATA_MS) stale.push({ stream, ms: now.getTime() - Date.parse(oldest) });
  }
  const summaryMs = summaryAt !== null && !Number.isNaN(Date.parse(summaryAt)) ? now.getTime() - Date.parse(summaryAt) : null;
  const summaryOld = summaryMs !== null && summaryMs > STALE_DATA_MS;
  const summaryTail = summaryOld ? ` This summary was prepared ${age(summaryMs)}.` : "";
  const phrase = (s: { ms: number | null }) => (s.ms === null ? "never" : age(s.ms));
  const miss = (streams: SyncStream[]) => (streams.length === 2 ? "newer email and schedule changes" : streams[0] === "mail" ? "newer email" : "schedule changes");
  if (stale.length === 0) return summaryOld ? `This summary was prepared ${age(summaryMs)}, so it may be out of date.` : null;
  const [first, second] = stale;
  if (first && !second) {
    const name = LABEL[first.stream];
    const head = first.ms === null ? `${name} has not synced yet` : `${name} was last synced ${phrase(first)}`;
    return `${head}, so this summary may miss ${miss([first.stream])}.${summaryTail}`;
  }
  const m = stale[0] as { ms: number | null };
  const c = second as { ms: number | null };
  const both = m.ms !== null && c.ms !== null ? `Mail was last synced ${phrase(m)} and calendar ${phrase(c)}` : `${m.ms === null ? "Mail has not synced yet" : `Mail was last synced ${phrase(m)}`} and ${c.ms === null ? "calendar has not synced yet" : `calendar was last synced ${phrase(c)}`}`;
  return `${both}, so this summary may miss ${miss(["mail", "calendar"])}.${summaryTail}`;
}
