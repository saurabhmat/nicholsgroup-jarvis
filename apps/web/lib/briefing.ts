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
  type DayEvent,
  type NotableEvent,
} from "@nichols/briefing/domain";

const DAY_MS = 86_400_000;

export type BriefingConfig = LaneConfig["briefing"];

export type CalendarSection = { access: true; today: DayEvent[]; ahead: NotableEvent[]; owners: string[] } | { access: false; unavailable?: true };

export type BriefingView = {
  viewerTz: string;
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
export function briefingConfigFrom(config: unknown): { briefing: BriefingConfig; mailboxes: string[] } {
  const c = (typeof config === "object" && config !== null ? config : {}) as Record<string, unknown>;
  const b = laneConfigSchema.shape.briefing.safeParse(c.briefing ?? {});
  const m = laneConfigSchema.shape.mailboxes.safeParse(c.mailboxes ?? []);
  return { briefing: b.success ? b.data : laneConfigSchema.shape.briefing.parse({}), mailboxes: m.success ? m.data.map((x) => x.toLowerCase()) : [] };
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
  const [cfg, cov, events] = await Promise.all([
    core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(),
    core.rpc("briefing_coverage", { p_lane: laneId }),
    core.rpc("briefing_events", { p_lane: laneId, p_from: win.from.toISOString(), p_to: win.to.toISOString() }),
  ]);
  if (cov.error) throw new Error("briefing data unavailable: coverage");
  if (events.error) console.error("[home] briefing events unavailable", { laneId });
  // A role that may not read the config still gets the defaults (the config read is optional).
  const { briefing, mailboxes } = briefingConfigFrom(cfg.error ? null : cfg.data?.config);
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
  return { viewerTz, coverage, coverageLine: coverageLine(coverage, mailAccess || calendarAccess), calendar, config: briefing, mailboxes };
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
      config: laneConfigSchema.shape.briefing.parse({}),
      mailboxes: [],
      unavailable: true,
    };
  }
}
