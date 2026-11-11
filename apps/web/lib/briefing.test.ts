// T-231a review fixes: the events window never exceeds the SQL cap (DST fall-back day), all-day events go by the viewer's
// dates, "nothing set up" is not "no access", owner domains on public mail providers are not internal, and an events
// error keeps Coverage.
import { describe, expect, it } from "vitest";
import { briefingFor, eventsWindow, internalDomains, loadBriefing, viewerZone } from "./briefing";
import { dayWindow } from "@nichols/briefing/domain";

type Res = { data: unknown; error: unknown };
function fakeClient(rpc: Record<string, Res>, config: unknown = { mailboxes: ["me@pubk.test"] }) {
  const calls: { fn: string; args: Record<string, string> }[] = [];
  const client = {
    schema: () => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config }, error: null }) }) }) }),
      rpc: async (fn: string, args: Record<string, string>) => {
        calls.push({ fn, args });
        return rpc[fn] ?? { data: [], error: null };
      },
    }),
  };
  return { client: client as unknown as Parameters<typeof loadBriefing>[0], calls };
}

const covRow = { stream: "calendar", account: "me@pubk.test", connection_id: "c", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-11T19:00:00Z" };

describe("loadBriefing", () => {
  it("on a 25-hour DST day the events window stays within 8 x 24 h", () => {
    const { from, to } = dayWindow(new Date("2026-11-01T15:00:00Z"), "America/New_York");
    const w = eventsWindow(from, to);
    expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(8 * 86_400_000);
  });

  it("a Los Angeles viewer sees a New York all-day event of tomorrow under the look-ahead, not today", async () => {
    const { client } = fakeClient({
      briefing_coverage: { data: [covRow], error: null },
      briefing_events: {
        data: [
          { calendar_id: "en.usa#holiday@group.v.calendar.google.com", event_id: "h", title: "Holiday tomorrow", all_day: true, start_at: "2026-11-12T05:00:00Z", end_at: "2026-11-13T05:00:00Z", start_date: "2026-11-12", end_date: "2026-11-13", attendees: [] },
          { calendar_id: "primary", event_id: "t", title: "Today timed", all_day: false, start_at: "2026-11-11T22:00:00Z", end_at: "2026-11-11T23:00:00Z", attendees: [] },
        ],
        error: null,
      },
    });
    const v = await loadBriefing(client, "PKG", new Date("2026-11-11T20:00:00Z"), "America/Los_Angeles");
    if (!v.calendar.access) throw new Error("expected calendar");
    expect(v.calendar.today.map((e) => e.title)).toEqual(["Today timed"]);
    expect(v.calendar.ahead.map((e) => e.title)).toEqual(["Holiday tomorrow"]);
  });

  it("nothing set up (marker rows) is access, with the 'not set up' Coverage line", async () => {
    const { client } = fakeClient({
      briefing_coverage: { data: [{ stream: "mail", account: null, status: "not_configured", configured: false }, { stream: "calendar", account: null, status: "not_configured", configured: false }], error: null },
    }, {});
    const v = await loadBriefing(client, "PKG", new Date("2026-11-11T15:00:00Z"), "America/New_York");
    expect(v.coverage).toEqual([]);
    expect(v.coverageLine).toMatch(/no mailbox or calendar is set up/);
    expect(v.calendar.access).toBe(true);
  });

  it("no rows at all means the role has no mail or calendar", async () => {
    const { client } = fakeClient({ briefing_coverage: { data: [], error: null } });
    const v = await loadBriefing(client, "PKG", new Date("2026-11-11T15:00:00Z"), "America/New_York");
    expect(v.coverageLine).toMatch(/does not include mail or calendar/);
    expect(v.calendar.access).toBe(false);
  });

  it("an events error keeps Coverage and marks the calendar unavailable", async () => {
    const { client } = fakeClient({ briefing_coverage: { data: [covRow], error: null }, briefing_events: { data: null, error: { message: "x" } } });
    const v = await loadBriefing(client, "PKG", new Date("2026-11-11T19:30:00Z"), "America/New_York");
    expect(v.coverage).toHaveLength(1);
    expect(v.calendar).toEqual({ access: false, unavailable: true });
  });

  it("a coverage error gives the unavailable view, never an empty day", async () => {
    const { client } = fakeClient({ briefing_coverage: { data: null, error: { message: "x" } } });
    const v = await briefingFor(client, "PKG", new Date(), "America/New_York");
    expect(v.unavailable).toBe(true);
    expect(v.coverageLine).toMatch(/could not be checked/);
  });
});

describe("helpers", () => {
  it("public mail domains are never internal; configured ones are", () => {
    expect([...internalDomains(["partner.test"], ["me@gmail.com", "ops@pubk.test"])].sort()).toEqual(["partner.test", "pubk.test"]);
  });
  it("viewer zone: valid names canonicalised, anything else New York", () => {
    expect(viewerZone("europe/london")).toBe("Europe/London");
    expect(viewerZone("x;y")).toBe("America/New_York");
    expect(viewerZone(undefined)).toBe("America/New_York");
  });
});
