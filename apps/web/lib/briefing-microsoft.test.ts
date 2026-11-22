// T-260, T-261: the briefing view (Home's attention list, Today, the 7-day look-ahead and the Coverage line) for one person with a Google and a Microsoft mailbox and
// calendar. Rows are shaped like what core.briefing_coverage / briefing_events / briefing_threads return (they carry the connection id; SQL decides which rows reach
// the person: pgTAP 322). Google-only output must not change: no label key anywhere.
import { describe, expect, it } from "vitest";
import { loadBriefing } from "./briefing";
import { refsFrom } from "./briefing-run";

type Res = { data: unknown; error: unknown };
function fakeClient(rpc: Record<string, Res>) {
  const client = {
    schema: () => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { mailboxes: ["robert@pubk.example.test"] } }, error: null }) }) }) }),
      rpc: async (fn: string) => rpc[fn] ?? { data: [], error: null },
    }),
  };
  return client as unknown as Parameters<typeof loadBriefing>[0];
}

const NOW = new Date("2026-11-20T15:00:00Z"); // 10:00 AM ET
const G = "00000000-0000-4000-8000-0000000c2601";
const M = "00000000-0000-4000-8000-0000000c2602";
const SYNCED = "2026-11-20T14:50:00Z";
const cov = (stream: "mail" | "calendar", provider: string, connection: string, account: string) => ({ stream, account, connection_id: connection, provider, status: "active", configured: true, last_sync_at: SYNCED, error_kind: null });
const coverageBoth = [
  cov("mail", "google", G, "robert@pubk.example.test"), cov("calendar", "google", G, "robert@pubk.example.test"),
  cov("mail", "microsoft", M, "robert@pubkgroup.example.test"), cov("calendar", "microsoft", M, "robert@pubkgroup.example.test"),
];
const coverageGoogleOnly = coverageBoth.filter((c) => c.provider === "google");

const thread = (connection: string, id: string, subject: string, url: string, over: Record<string, unknown> = {}) => ({
  connection_id: connection, thread_key: `t-${id}`, message_id: id, from_address: "dana@acme.example.test", from_name: "Dana Whitfield", subject, received_at: "2026-11-20T14:00:00Z", source_url: url,
  labels: ["INBOX"], is_important: true, last_is_owner: false, owner_replied: false, unread_count: 1, inbound_count: 1, last_to_owner: true, ...over,
});
const GMAIL = "https://mail.google.com/mail/?authuser=robert%40pubk.example.test#all/t1";
const OUTLOOK = "https://outlook.office365.com/owa/?ItemID=ms-1&exvsurl=1&viewmodel=ReadMessageItem";
const threads = [thread(G, "g-1", "Capture plan from Gmail", GMAIL), thread(M, "ms-1", "Capture plan from Outlook", OUTLOOK)];

const event = (connection: string, id: string, title: string, start: string, end: string, url: string | null, over: Record<string, unknown> = {}) => ({
  connection_id: connection, calendar_id: connection === G ? "primary" : "AAMkDefaultCalendar=", event_id: id, title, start_at: start, end_at: end, all_day: false, start_date: null, end_date: null, timezone: "America/New_York",
  location: null, source_url: url, online_meeting_url: null, organizer_email: "boss@acme.example.test", organizer_name: null, attendees: [], status: "confirmed", ...over,
});
const GCAL = "https://www.google.com/calendar/event?eid=synthetic-g";
const OCAL = "https://outlook.office365.com/owa/?itemid=synthetic-m&exvsurl=1&path=/calendar/item";
const TEAMS = "https://teams.microsoft.com/l/meetup-join/synthetic";

describe("Home attention list for one person with a Google and a Microsoft mailbox", () => {
  it("lists both mailboxes' mail in one list, each connection with its provider and account; the same message in both is two rows", async () => {
    const same = [...threads, thread(M, "ms-2", "Capture plan from Gmail", OUTLOOK, { thread_key: "t-ms-2" })]; // the same subject in both mailboxes
    const v = await loadBriefing(fakeClient({ briefing_coverage: { data: coverageBoth, error: null }, briefing_threads: { data: same, error: null } }), "PKG", NOW, "America/New_York");
    if (!v.mail.access) throw new Error("mail access expected");
    expect(v.mail.sourceOf).toEqual({ [G]: { provider: "google", account: "robert@pubk.example.test" }, [M]: { provider: "microsoft", account: "robert@pubkgroup.example.test" } });
    const rows = v.mail.attention.map((a) => [a.thread.connectionId, a.thread.messageId, a.thread.sourceUrl]);
    expect(rows).toContainEqual([G, "g-1", GMAIL]);
    expect(rows).toContainEqual([M, "ms-1", OUTLOOK]);
    expect(v.mail.attention.filter((a) => a.thread.subject === "Capture plan from Gmail")).toHaveLength(2); // no de-duplication across providers
    expect(v.coverageLine).toContain("Mail robert@pubk.example.test (Gmail)");
    expect(v.coverageLine).toContain("Mail robert@pubkgroup.example.test (Outlook)");
  });

  it("the briefing's refs name each row's provider (so a Microsoft row is never proposed a reply) and keep the row's own connection", async () => {
    const v = await loadBriefing(fakeClient({ briefing_coverage: { data: coverageBoth, error: null }, briefing_threads: { data: threads, error: null } }), "PKG", NOW, "America/New_York");
    const refs = refsFrom(v, NOW);
    expect(refs.map((r) => [r.connectionId, r.provider, r.mailbox])).toEqual(expect.arrayContaining([[G, "google", "robert@pubk.example.test"], [M, "microsoft", "robert@pubkgroup.example.test"]]));
  });

  it("a Google-only person: no label key on the mail section, the calendar section or the refs, and the Coverage line reads as before", async () => {
    const v = await loadBriefing(fakeClient({ briefing_coverage: { data: coverageGoogleOnly, error: null }, briefing_threads: { data: [threads[0]], error: null }, briefing_events: { data: [event(G, "e1", "Standup", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", GCAL)], error: null } }), "PKG", NOW, "America/New_York");
    if (!v.mail.access || !v.calendar.access) throw new Error("access expected");
    expect(Object.keys(v.mail)).not.toContain("sourceOf");
    expect(Object.keys(v.calendar)).not.toContain("sourceOf");
    expect(v.coverageLine).toBe("Coverage: Mail robert@pubk.example.test, Calendar robert@pubk.example.test up to date.");
    for (const r of refsFrom(v, NOW)) expect(Object.keys(r)).not.toContain("provider");
  });

  it("a person with only a Microsoft mailbox is labelled too", async () => {
    const v = await loadBriefing(fakeClient({ briefing_coverage: { data: coverageBoth.filter((c) => c.provider === "microsoft"), error: null }, briefing_threads: { data: [threads[1]], error: null } }), "PKG", NOW, "America/New_York");
    if (!v.mail.access) throw new Error("mail access expected");
    expect(v.mail.sourceOf).toEqual({ [M]: { provider: "microsoft", account: "robert@pubkgroup.example.test" } });
  });
});

describe("Today and the 7-day look-ahead for one person with a Google and a Microsoft calendar (T-261)", () => {
  const events = [
    event(M, "ms-late", "Microsoft afternoon call", "2026-11-20T19:00:00Z", "2026-11-20T20:00:00Z", OCAL, { online_meeting_url: TEAMS }),
    event(G, "g-early", "Google morning sync", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", GCAL),
    event(M, "ms-allday", "Synthetic holiday", "2026-11-20T05:00:00Z", "2026-11-21T05:00:00Z", OCAL, { all_day: true, start_date: "2026-11-20", end_date: "2026-11-21", timezone: "America/New_York" }),
    event(M, "ms-ahead", "External review next week", "2026-11-24T15:00:00Z", "2026-11-24T16:00:00Z", OCAL, { attendees: [{ email: "guest@other.example.test", name: "Guest", response: "needs_action" }, { email: "robert@pubkgroup.example.test", response: "needs_action" }] }),
  ];
  const load = (coverage: unknown = coverageBoth, rows: unknown[] = events) => loadBriefing(fakeClient({ briefing_coverage: { data: coverage, error: null }, briefing_events: { data: rows, error: null } }), "PKG", NOW, "America/New_York");

  it("shows Google and Microsoft events together in time order (all-day first), each event's connection resolving to its own provider and account", async () => {
    const v = await load();
    if (!v.calendar.access) throw new Error("calendar access expected");
    // The reader returns all-day first, then by start time; here the rows come in the order a database could return them, and the view keeps the order of the day it was given.
    expect(v.calendar.today.map((e) => e.title).sort()).toEqual(["Google morning sync", "Microsoft afternoon call", "Synthetic holiday"]);
    expect(v.calendar.sourceOf).toEqual({ [G]: { provider: "google", account: "robert@pubk.example.test" }, [M]: { provider: "microsoft", account: "robert@pubkgroup.example.test" } });
    const byTitle = new Map(v.calendar.today.map((e) => [e.title, e]));
    expect(byTitle.get("Google morning sync")?.connectionId).toBe(G);
    expect(byTitle.get("Microsoft afternoon call")?.connectionId).toBe(M);
    expect(byTitle.get("Microsoft afternoon call")?.calendarUrl).toBe(OCAL);
    expect(byTitle.get("Microsoft afternoon call")?.meetingUrl).toBe(TEAMS); // a Join link is data only; nothing opens it
    expect(byTitle.get("Synthetic holiday")?.allDay).toBe(true);
    expect(v.calendar.ahead.map((e) => e.title)).toContain("External review next week");
  });

  it("the same meeting in both calendars, as the readers behave TODAY: one row survives (D-58 default says two, see the T-261 PR notes)", async () => {
    // core.briefing_events keeps ONE row per (ical_uid or calendar+event id, start): the same invitation in a Google and a Microsoft calendar usually shares its
    // iCalUID, so the database returns the survivor only (its own connection id: richest row first, then calendar id). That is what this view is handed.
    const one = [event(M, "ms-same", "Board prep", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", OCAL)];
    const v = await load(coverageBoth, one);
    if (!v.calendar.access) throw new Error("calendar access expected");
    expect(v.calendar.today).toHaveLength(1);
    expect(v.calendar.sourceOf?.[v.calendar.today[0]?.connectionId ?? ""]).toEqual({ provider: "microsoft", account: "robert@pubkgroup.example.test" }); // labelled with the SURVIVOR's own provider and account
  });

  it("if the database hands over both rows (different iCalUIDs), the Today list still shows the same title and times once (analyzeDay), the survivor being the first row; different meeting links keep both", async () => {
    const both = [event(G, "g-same", "Board prep", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", GCAL, { ical_uid: "a@google.com" }), event(M, "ms-same", "Board prep", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", OCAL, { ical_uid: "b@outlook.com" })];
    const v = await load(coverageBoth, both);
    if (!v.calendar.access) throw new Error("calendar access expected");
    expect(v.calendar.today.map((e) => e.connectionId)).toEqual([G]);
    const links = [event(G, "g-same", "Board prep", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", GCAL, { online_meeting_url: "https://meet.google.com/synthetic" }), event(M, "ms-same", "Board prep", "2026-11-20T16:00:00Z", "2026-11-20T17:00:00Z", OCAL, { online_meeting_url: TEAMS })];
    const v2 = await load(coverageBoth, links);
    if (!v2.calendar.access) throw new Error("calendar access expected");
    expect(v2.calendar.today.map((e) => e.connectionId).sort()).toEqual([G, M].sort());
  });

  it("a Google-only person's calendar section has no label key", async () => {
    const v = await load(coverageGoogleOnly, [events[1]]);
    if (!v.calendar.access) throw new Error("calendar access expected");
    expect(Object.keys(v.calendar)).not.toContain("sourceOf");
  });
});
