// T-231a review fixes: the events window never exceeds the SQL cap (DST fall-back day), all-day events go by the viewer's
// dates, "nothing set up" is not "no access", owner domains on public mail providers are not internal, and an events
// error keeps Coverage.
import { describe, expect, it } from "vitest";
import { briefingFor, eventsWindow, internalDomains, knownNamesFrom, loadBriefing, ownMailDomains, parseSavedBriefing, viewerZone, withSummaryApplied, type MailSection, type SavedBriefingView } from "./briefing";
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

describe("T-240: names for attendees and the lane's own domains", () => {
  it("knownNamesFrom keeps display names for exact addresses, never an address as a name, first one wins (any case)", () => {
    expect(
      knownNamesFrom([
        { fromAddress: "Rob@pubk.test", fromName: "Rob  N", isAuthPass: true },
        { fromAddress: "rob@pubk.test", fromName: "Other", isAuthPass: true },
        { fromAddress: "x@acme.test", fromName: "x@acme.test", isAuthPass: true },
        { fromAddress: "y@acme.test", fromName: null, isAuthPass: true },
        { fromAddress: null, fromName: "Nobody", isAuthPass: true },
        { fromAddress: "constructor", fromName: "Proto", isAuthPass: true },
      ]),
    ).toEqual({ "rob@pubk.test": "Rob N", constructor: "Proto" });
  });
  it("knownNamesFrom ignores mail that did not pass sender authentication (a forged From cannot rename an attendee)", () => {
    expect(knownNamesFrom([{ fromAddress: "cfo@partner.test", fromName: "Acme Escrow Officer" }, { fromAddress: "cfo@partner.test", fromName: "Forged", isAuthPass: false }])).toEqual({});
    expect(knownNamesFrom([{ fromAddress: "cfo@partner.test", fromName: "Forged" }, { fromAddress: "cfo@partner.test", fromName: "Pat Lee", isAuthPass: true }])).toEqual({ "cfo@partner.test": "Pat Lee" });
  });
  it("ownMailDomains: the domains of the lane's mailboxes, public providers and duplicates left out", () => {
    expect(ownMailDomains(["me@pubk.test", "ceo@PUBK.test", "x@gmail.com", "y@other.test", "bad"])).toEqual(["pubk.test", "other.test"]);
  });
  it("calendar attendees come back with the names the mail index holds for their exact address", async () => {
    const { client } = fakeClient({
      briefing_coverage: { data: [covRow, { ...covRow, stream: "mail" }], error: null },
      briefing_events: { data: [{ event_id: "e1", calendar_id: "c1", title: "Sync", start_at: "2026-11-11T19:00:00Z", end_at: "2026-11-11T20:00:00Z", all_day: false, status: "confirmed", attendees: [{ email: "me@pubk.test" }, { email: "rnichols@pubk.test" }] }], error: null },
      briefing_threads: { data: [{ connection_id: "c", thread_key: "t1", message_id: "m1", from_address: "rnichols@pubk.test", from_name: "Robert N", subject: "Hi", received_at: "2026-11-11T18:00:00Z", labels: ["INBOX"], unread_count: 1, inbound_count: 1, is_auth_pass: true }], error: null },
    });
    const view = await loadBriefing(client, "PKG", new Date("2026-11-11T17:00:00Z"), "America/New_York");
    expect(view.calendar.access && view.calendar.knownNames).toEqual({ "rnichols@pubk.test": "Robert N" });
  });
});

describe("T-243: the summary may only remove items from Home's attention list", () => {
  const thread = (i: number) => ({ connectionId: "c1", threadKey: `t${String(i)}`, messageId: `m${String(i)}`, fromAddress: "a@x.test", fromName: "A", subject: "s", receivedAt: "2026-11-11T10:00:00Z", sourceUrl: null, labels: [], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1 });
  const item = (i: number) => ({ key: `c1:t${String(i)}`, kind: "unread" as const, reason: "r", flags: { vip: false, money: null, deadline: false, waitingOnYou: false }, thread: thread(i) });
  const fresh = [1, 2, 3, 4, 5, 6, 7].map(item);
  const mail: MailSection = { access: true, attention: fresh.slice(0, 5), more: 2, fresh, stillWaiting: [], money: [], mailboxOf: {} };
  const brief = (needsReply: boolean | undefined, over: Partial<SavedBriefingView> = {}): SavedBriefingView => ({
    id: "b", status: "ready", trigger: "manual", preparedAt: "2026-11-11T12:00:00Z", windowFrom: "", windowTo: "", lastFailedAt: null, lastRunAt: null,
    refs: [{ ref: "r1", connectionId: "c1", messageId: "m2", threadKey: "t2", mailbox: null, fromAddress: null, fromName: null, subject: null, receivedAt: "", sourceUrl: null, reason: "", kind: "unread" }],
    content: { lines: [], attention: [{ ref: "r1", what: "w", why: "y", next: "n", ...(needsReply === undefined ? {} : { needsReply }) }], deadlines: [], priorities: [], replies: [], moreReplies: [], notes: [] }, ...over,
  });
  const ids = (m: MailSection) => (m.access ? m.attention.map((a) => a.thread.messageId) : []);
  it("needs_reply false: the item leaves, the next ranked one moves up, the count drops", () => {
    const out = withSummaryApplied(mail, brief(false));
    expect(ids(out)).toEqual(["m1", "m3", "m4", "m5", "m6"]);
    expect(out.access && out.more).toBe(1);
  });
  it("unknown, true, failed, none: the same list object comes back", () => {
    for (const b of [brief(undefined), brief(true), brief(false, { status: "failed" }), null]) expect(withSummaryApplied(mail, b)).toBe(mail);
    expect(withSummaryApplied({ access: false }, brief(false))).toEqual({ access: false });
  });
  it("a list without `fresh` (older shape) is cut from `attention` and never grows", () => {
    const { fresh: _unused, ...plain } = mail;
    expect(ids(withSummaryApplied(plain as MailSection, brief(false)))).toEqual(["m1", "m3", "m4", "m5"]);
  });
  it("stored briefings: needsReply is read back as a boolean, any other value is unknown", () => {
    const row = (needsReply: unknown) => [{ id: "00000000-0000-4000-8000-000000000001", status: "ready", prepared_at: "2026-11-11T12:00:00Z", source_refs: [], content: { attention: [{ ref: "r1", what: "w", why: "y", next: "n", needsReply }] } }];
    expect(parseSavedBriefing(row(false))?.content.attention[0]).toMatchObject({ needsReply: false });
    expect(parseSavedBriefing(row(true))?.content.attention[0]).toMatchObject({ needsReply: true });
    for (const v of ["false", 0, null, undefined]) expect(parseSavedBriefing(row(v))?.content.attention[0]).not.toHaveProperty("needsReply");
  });
});
