// Home briefing sections from synced metadata (T-231a, T-231b): Coverage, today's calendar, the 7-day look-ahead. No AI
// here. Read-only SQL through the signed-in user's lane client: core.briefing_coverage (definer, answers only for the
// caller's comms/calendar views) and core.briefing_events (invoker, RLS on cal.event_index). Times are rendered in the
// viewer's zone (the `tz` cookie set by the browser; America/New_York when absent or invalid).
import { laneConfigSchema, type LaneConfig } from "@nichols/core/lane-config";
import type { LaneClient } from "@nichols/core/lane-router";
import {
  analyzeDay,
  BUSINESS_TZ,
  coverageLine,
  dayWindow,
  localDate,
  notableAhead,
  PUBLIC_MAIL_DOMAINS,
  splitByDay,
  parseCoverageRows,
  parseEvents,
  toCoverage,
  validTimeZone,
  type CoverageItem,
  parseThreads,
  rankAttention,
  moneyThreads,
  type AttentionRules,
  type BriefContent,
  type BriefRef,
  type AttentionThread,
  type MoneyThread,
  type DayEvent,
  type NotableEvent,
} from "@nichols/briefing/domain";

const DAY_MS = 86_400_000;

export type BriefingConfig = LaneConfig["briefing"];

export type CalendarSection = { access: true; today: DayEvent[]; ahead: NotableEvent[]; owners: string[] } | { access: false; unavailable?: true };

/** "Needs your attention" + Money from mail metadata; `access: false` when the caller may not read the lane's mail. */
export type MailSection =
  | { access: true; attention: AttentionThread[]; more: number; money: MoneyThread[]; mailboxOf: Record<string, string> }
  | { access: false; unavailable?: true };

export type BriefingView = {
  viewerTz: string;
  mail: MailSection;
  coverage: CoverageItem[];
  coverageLine: string;
  calendar: CalendarSection;
  config: BriefingConfig;
  mailboxes: string[];
  unavailable?: true;
};

/** The viewer's zone from the cookie value, or the business zone. */
export const viewerZone = (cookie: string | undefined): string => validTimeZone(cookie) ?? BUSINESS_TZ;

/** The lane's briefing settings and mailboxes from a lane_config row; invalid or missing parts fall back to defaults. */
export function briefingConfigFrom(config: unknown): { briefing: BriefingConfig; mailboxes: string[]; prioritySenders: string[] } {
  const c = (typeof config === "object" && config !== null ? config : {}) as Record<string, unknown>;
  const b = laneConfigSchema.shape.briefing.safeParse(c.briefing ?? {});
  const m = laneConfigSchema.shape.mailboxes.safeParse(c.mailboxes ?? []);
  const p = laneConfigSchema.shape.priority_senders.safeParse(c.priority_senders ?? []);
  return { briefing: b.success ? b.data : laneConfigSchema.shape.briefing.parse({}), mailboxes: m.success ? m.data.map((x) => x.toLowerCase()) : [], prioritySenders: p.success ? p.data : [] };
}

export const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

type Db = Pick<LaneClient, "schema">;

/** The events window: the viewer's day plus 7 days, never more than the SQL cap of 8 x 24 h (a 25-hour DST day included). */
export function eventsWindow(from: Date, to: Date): { from: Date; to: Date } {
  return { from, to: new Date(Math.min(to.getTime() + 7 * DAY_MS, from.getTime() + 8 * DAY_MS)) };
}

/** Owner domains count as internal, except public mail providers (gmail.com says nothing about who is a colleague). */
export function internalDomains(configured: readonly string[], owners: Iterable<string>): Set<string> {
  const own = [...owners].map(domainOf).filter((d) => d !== "" && !PUBLIC_MAIL_DOMAINS.has(d));
  return new Set([...configured, ...own]);
}

/**
 * Loads Coverage + calendar for one lane. Throws only when Coverage itself cannot be read (Home then says
 * "unavailable", never an empty day); an events error keeps Coverage and marks the calendar unavailable.
 */
export async function loadBriefing(client: Db, laneId: string, now: Date, viewerTz: string): Promise<BriefingView> {
  const core = client.schema("core");
  const { from, to } = dayWindow(now, viewerTz);
  const win = eventsWindow(from, to);
  const cfg = await core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
  if (cfg.error) console.error("[home] briefing config unavailable: defaults used", { laneId });
  // A role that may not read the config still gets the defaults (the config read is optional).
  const { briefing, mailboxes, prioritySenders } = briefingConfigFrom(cfg.error ? null : cfg.data?.config);
  const [cov, events, threads] = await Promise.all([
    core.rpc("briefing_coverage", { p_lane: laneId }),
    core.rpc("briefing_events", { p_lane: laneId, p_from: win.from.toISOString(), p_to: win.to.toISOString() }),
    core.rpc("briefing_threads", { p_lane: laneId, p_since: new Date(now.getTime() - briefing.attention_days * DAY_MS).toISOString() }),
  ]);
  if (cov.error) throw new Error("briefing data unavailable: coverage");
  if (events.error) console.error("[home] briefing events unavailable", { laneId });
  if (threads.error) console.error("[home] briefing threads unavailable", { laneId });
  const rows = parseCoverageRows(cov.data);
  const coverage = toCoverage(rows, now, briefing.coverage_stale_minutes);
  // Any row, including the "nothing set up" marker, means the caller holds that stream's view.
  const calendarAccess = rows.some((c) => c.stream === "calendar");
  const mailAccess = rows.some((c) => c.stream === "mail");
  const owners = new Set([...mailboxes, ...coverage.map((c) => c.account.toLowerCase())].filter((o) => o !== ""));
  const internal = internalDomains(briefing.internal_domains, owners);
  let calendar: CalendarSection = { access: false };
  if (calendarAccess && events.error) calendar = { access: false, unavailable: true };
  else if (calendarAccess) {
    const split = splitByDay(parseEvents(events.data), from, to, localDate(from, viewerTz), 7);
    calendar = { access: true, today: analyzeDay(split.today, owners, internal), ahead: notableAhead(split.later, owners, internal), owners: [...owners] };
  }
  let mail: MailSection = { access: false };
  if (mailAccess && threads.error) mail = { access: false, unavailable: true };
  else if (mailAccess) {
    const rows = parseThreads(threads.data);
    const rules: AttentionRules = { prioritySenders, securitySubjects: briefing.security_subjects, securitySenders: briefing.security_senders, exclusions: briefing.exclusions, money: briefing.money };
    const ranked = rankAttention(rows, rules, now);
    const mailboxOf = Object.fromEntries(coverage.filter((c) => c.connectionId && c.stream === "mail").map((c) => [c.connectionId as string, c.account]));
    mail = { access: true, attention: ranked.top, more: ranked.more, money: moneyThreads(rows, rules), mailboxOf };
  }
  return { viewerTz, coverage, coverageLine: coverageLine(coverage, mailAccess || calendarAccess), calendar, mail, config: briefing, mailboxes };
}

/** Home's briefing view; an outage gives `unavailable` (with a Coverage line that says so), never an empty day. */
export async function briefingFor(client: Db, laneId: string, now: Date, viewerTz: string, load = loadBriefing): Promise<BriefingView> {
  try {
    return await load(client, laneId, now, viewerTz);
  } catch (e) {
    console.error("[home] briefing unavailable", { laneId, error: e instanceof Error ? e.name : typeof e });
    return {
      viewerTz,
      coverage: [],
      coverageLine: "Coverage: could not be checked right now. Reload in a minute.",
      calendar: { access: false },
      mail: { access: false, unavailable: true },
      config: laneConfigSchema.shape.briefing.parse({}),
      mailboxes: [],
      unavailable: true,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------- AI briefing (T-231c)

export type SavedBriefingView = {
  id: string;
  status: "ready" | "partial" | "failed";
  trigger: string;
  preparedAt: string;
  windowFrom: string;
  windowTo: string;
  content: BriefContent;
  refs: BriefRef[];
  /** Newest failed attempt after this briefing (Home says so); null when none. */
  lastFailedAt: string | null;
  /** Newest attempt of any kind (the Run-now cooldown). */
  lastRunAt: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Parses core.briefing_latest's row (stored content was checked when it was written; parsed again defensively). The row
 * is the newest non-failed briefing; when every attempt failed its id is null and this returns a "failed" view at the
 * newest failed attempt.
 */
export function parseSavedBriefing(data: unknown): SavedBriefingView | null {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  const lastFailedAt = typeof row.last_failed_at === "string" ? row.last_failed_at : null;
  const lastRunAt = typeof row.last_run_at === "string" ? row.last_run_at : null;
  if (row.id === null && lastFailedAt) {
    return {
      id: "",
      status: "failed",
      trigger: "manual",
      preparedAt: lastFailedAt,
      windowFrom: lastFailedAt,
      windowTo: lastFailedAt,
      refs: [],
      content: { lines: [], attention: [], deadlines: [], priorities: [], replies: [], moreReplies: [], notes: [] },
      lastFailedAt,
      lastRunAt,
    };
  }
  if (typeof row.id !== "string" || typeof row.prepared_at !== "string") return null;
  const status = row.status === "ready" || row.status === "partial" || row.status === "failed" ? row.status : "failed";
  const c = (typeof row.content === "object" && row.content !== null ? row.content : {}) as Record<string, unknown>;
  const list = <T,>(v: unknown, f: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.flatMap((x) => (typeof x === "object" && x !== null ? [f(x as Record<string, unknown>)].filter((y): y is T => y !== null) : [])) : [];
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const refs = list(row.source_refs, (r) =>
    typeof r.ref === "string" && typeof r.connectionId === "string" && typeof r.messageId === "string"
      ? ({
          ref: r.ref,
          connectionId: r.connectionId,
          messageId: r.messageId,
          threadKey: s(r.threadKey) ?? "",
          mailbox: s(r.mailbox),
          fromAddress: s(r.fromAddress),
          fromName: s(r.fromName),
          subject: s(r.subject),
          receivedAt: s(r.receivedAt) ?? "",
          sourceUrl: typeof r.sourceUrl === "string" && r.sourceUrl.startsWith("https://") ? r.sourceUrl : null,
          reason: s(r.reason) ?? "",
          kind: s(r.kind) ?? "",
        } satisfies BriefRef)
      : null,
  );
  return {
    id: row.id,
    status,
    trigger: s(row.trigger) ?? "manual",
    preparedAt: row.prepared_at,
    windowFrom: s(row.window_from) ?? row.prepared_at,
    windowTo: s(row.window_to) ?? row.prepared_at,
    lastFailedAt,
    lastRunAt,
    refs,
    content: {
      lines: strs(c.lines),
      attention: list(c.attention, (a) => (typeof a.ref === "string" ? { ref: a.ref, what: s(a.what) ?? "", why: s(a.why) ?? "", next: s(a.next) ?? "" } : null)),
      deadlines: list(c.deadlines, (d) => (typeof d.text === "string" ? { ref: s(d.ref), text: d.text, due: s(d.due) } : null)),
      priorities: list(c.priorities, (p) => (typeof p.text === "string" ? { text: p.text, reason: s(p.reason) ?? "", refs: strs(p.refs) } : null)),
      replies: list(c.replies, (r) =>
        typeof r.ref === "string" && typeof r.text === "string"
          ? {
              ref: r.ref,
              status: r.status === "ready" ? ("ready" as const) : ("awaiting_input" as const),
              context: s(r.context) ?? "",
              text: r.text,
              proposalId: typeof r.proposalId === "string" && UUID_RE.test(r.proposalId) ? r.proposalId : null,
            }
          : null,
      ),
      moreReplies: strs(c.moreReplies),
      notes: strs(c.notes),
    },
  };
}

/** The caller's latest prepared briefing (null when none, or on error: Home then shows the rule-based sections only). */
export async function latestBriefing(client: Db, laneId: string): Promise<SavedBriefingView | null> {
  try {
    const { data, error } = await client.schema("core").rpc("briefing_latest", { p_lane: laneId });
    if (error) return null;
    return parseSavedBriefing(data);
  } catch {
    return null;
  }
}
