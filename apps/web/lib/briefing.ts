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
  notableAhead,
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

export type CalendarSection = { access: true; today: DayEvent[]; ahead: NotableEvent[]; owners: string[] } | { access: false };

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

/** Loads Coverage + calendar for one lane. Throws on a database error (Home then says "unavailable", never an empty day). */
export async function loadBriefing(client: Db, laneId: string, now: Date, viewerTz: string): Promise<BriefingView> {
  const core = client.schema("core");
  const { from, to } = dayWindow(now, viewerTz);
  const [cfg, cov, events] = await Promise.all([
    core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(),
    core.rpc("briefing_coverage", { p_lane: laneId }),
    core.rpc("briefing_events", { p_lane: laneId, p_from: from.toISOString(), p_to: new Date(to.getTime() + 7 * DAY_MS).toISOString() }),
  ]);
  if (cov.error || events.error) throw new Error(`briefing data unavailable: ${[cov.error && "coverage", events.error && "events"].filter(Boolean).join(",")}`);
  // A role that may not read the config still gets the defaults (the config read is optional).
  const { briefing, mailboxes } = briefingConfigFrom(cfg.error ? null : cfg.data?.config);
  const coverage = toCoverage(parseCoverageRows(cov.data), now, briefing.coverage_stale_minutes);
  const calendarAccess = coverage.some((c) => c.stream === "calendar");
  const mailAccess = coverage.some((c) => c.stream === "mail");
  // The owner's own addresses: every account the briefing covers (their RSVP decides "pending" and "declined").
  const owners = new Set([...mailboxes, ...coverage.map((c) => c.account.toLowerCase())]);
  const internal = new Set([...briefing.internal_domains, ...[...owners].map(domainOf)].filter((d) => d !== ""));
  const all = parseEvents(events.data);
  const todays = all.filter((e) => Date.parse(e.startAt) < to.getTime() && Date.parse(e.endAt) > from.getTime());
  const later = all.filter((e) => Date.parse(e.startAt) >= to.getTime());
  return {
    viewerTz,
    coverage,
    coverageLine: coverageLine(coverage, mailAccess || calendarAccess),
    calendar: calendarAccess ? { access: true, today: analyzeDay(todays, owners, internal), ahead: notableAhead(later, owners, internal), owners: [...owners] } : { access: false },
    config: briefing,
    mailboxes,
  };
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
