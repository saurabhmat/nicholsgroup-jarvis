// The Microsoft calendar delta sync (T-067, D-59: the default calendar only) end to end over the fake Graph (MSW): spec §17 tests 18 and 19, the request rules (the
// window on the initial request only, no $select/$filter, the three Prefer values on every request), the cursor and its half-horizon reload, tampered links, removals
// (including one for an event that left the window), cancelled events, recurring events, all-day events, bodies that never reach the store, the token canary, the
// run budget, and a Microsoft sync beside a Google connection of the same user. Synthetic data only (rule 10); nothing waits on a real timer (the clock is injected).
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { PROVIDER_DISABLED_MESSAGE } from "../facade/gate";
import { RateLimiter } from "../http/rate-limit";
import type { CalendarSyncResult, CommsCursor } from "../comms/schemas";
import { attachMicrosoftCalendar, type MicrosoftCalendarOptions } from "../testing/microsoft-calendar-harness";
import { TENANT_A } from "../testing/microsoft-harness";
import { createMicrosoftMailHarness, MAIL_DOMAIN, type MicrosoftMailHarnessOptions } from "../testing/microsoft-mail-harness";
import { HttpResponse, http, useMockServer } from "../testing/msw/index";
import { CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY, createFakeCalendar, type FakeCalendarOptions } from "../testing/msw/microsoft/calendar";
import { createFakeMicrosoft, GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";
import { createFakeMail, FAKE_NOW } from "../testing/msw/microsoft/mail";
import { DEFAULT_CALENDAR_SETTINGS } from "../vault/lane-config";
import { REDACTED } from "../vault/secret";
import { CAL_LINK_HEAD, DEFAULT_CALENDAR_ID, encodeCalCursor, initialQuery, MAX_CURSOR_CHARS, MAX_LINK_CHARS, newWindow, parseCalCursor, windowParams, type CalState } from "./cal-cursor";
import { calendarPrefer } from "./calendar";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});
const DAY = 86_400_000;

type Options = { cal?: FakeCalendarOptions; harness?: Partial<MicrosoftMailHarnessOptions>; calendar?: MicrosoftCalendarOptions };
function setup(options: Options = {}) {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake);
  const cal = createFakeCalendar(fake, options.cal);
  server.use(...fake.handlers, ...mail.handlers, ...cal.handlers);
  const m = createMicrosoftMailHarness({ fake, mail, ...options.harness });
  const c = attachMicrosoftCalendar(m, cal, options.calendar);
  const made = m.connect("PKG");
  return { fake, mail, cal, m, c, ...made };
}
type Env = ReturnType<typeof setup>;

/** Pages one provider call at a time until the run ends. */
async function drain(env: Env, start: CommsCursor | null = null, pageSize?: number, conn = env.conn) {
  const upserts: CalendarSyncResult["upserts"] = [];
  const removals: CalendarSyncResult["removals"] = [];
  let pages = 0;
  let cursor = start;
  for (let i = 0; i < 200; i++) {
    const r = await env.c.provider.sync("PKG", conn, cursor, pageSize ? { pageSize } : undefined);
    if (r.fullResyncRequired) return { resync: true as const, upserts, removals, cursor: null, pages };
    pages += 1;
    upserts.push(...r.upserts);
    removals.push(...r.removals);
    cursor = r.nextCursor;
    if (!r.hasMore) return { resync: false as const, upserts, removals, cursor: cursor as CommsCursor, pages };
  }
  throw new Error("sync did not terminate");
}
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isConnectorError(e)) return e;
    throw e;
  }
  throw new Error("expected a ConnectorError");
}
const stateOf = (value: string, connectionId: string) => {
  const s = parseCalCursor(value, connectionId);
  if (!s) throw new Error("cursor does not parse");
  return s;
};
const logsOf = (env: Env, event: string) => env.m.h.logs.filter((l) => l.event === event);
const SEED = 9; // 3 single events, 3 recurring instances, 2 all-day events, 1 cancelled event

describe("spec §17 test 18: the default calendar", () => {
  it("a first load indexes the default calendar's events under one fixed calendar id with no calendar discovery and no per-calendar request; an @removed event reads cancelled; a body in the delta page reaches no store", async () => {
    const env = setup();
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ mode: "full", written: SEED, removed: 0, resynced: false, conflict: false });
    const rows = env.c.twin.rowsOf(env.conn.id);
    expect(rows).toHaveLength(SEED);
    expect(new Set(rows.map((r) => r.calendar_id))).toEqual(new Set([DEFAULT_CALENDAR_ID]));
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toMatch(new RegExp(`^m1\\.${env.conn.id}\\.c:`));
    // The only path ever requested is the documented one; nothing names a calendar and nothing asks for the list of calendars.
    expect(env.cal.requests.length).toBeGreaterThan(0);
    expect([...new Set(env.cal.requests.map((r) => r.path))]).toEqual(["/v1.0/me/calendarView/delta"]);
    expect(env.cal.requests.some((r) => /calendars/i.test(r.path))).toBe(false);
    expect(env.mail.requests).toHaveLength(0);
    expect(env.fake.state.graphRequests).toHaveLength(0);

    const gone = env.cal.bySubject(env.account, "Synthetic single 2").id;
    env.cal.remove(env.account, gone);
    const second = await env.c.sync.run("PKG", env.conn);
    expect(second).toMatchObject({ mode: "incremental", removed: 1 });
    expect(env.c.twin.rowsOf(env.conn.id).find((r) => r.event_id === gone)?.status).toBe("cancelled");
    expect(env.c.contentWriteCount()).toBe(0);
  });

  it("the deltas carry bodies (the fake returns one on every event of every page) and none reaches a row, a write, a log, an error or the cursor", async () => {
    const env = setup({ calendar: { pageSize: 2 } });
    // proof that the fake really sends them: a raw page
    const token = env.fake.issueAccess(env.account);
    const raw = await fetch(`${GRAPH_V1}/me/calendarView/delta?startDateTime=2026-11-01T00:00:00.000Z&endDateTime=2026-12-01T00:00:00.000Z`, { headers: { authorization: `Bearer ${token}`, prefer: 'IdType="ImmutableId"' } });
    const text = await raw.text();
    expect(text).toContain(CAL_BODY_CANARY);
    expect(text).toContain(CAL_PREVIEW_CANARY);
    expect(text).toContain(CAL_SERIES_CANARY);

    await env.c.sync.run("PKG", env.conn);
    env.cal.change(env.account, env.cal.bySubject(env.account, "Synthetic single 1").id, { subject: "Synthetic single 1 (edited)" });
    await env.c.sync.run("PKG", env.conn);
    env.cal.setFault(env.account, "server_error");
    const err = await failure(env.c.sync.run("PKG", env.conn));
    expect(err.info.kind).toBe("transient");
    const everything = JSON.stringify([env.c.twin.writes, [...env.c.twin.rows.values()], [...env.c.twin.cursors.values()], env.m.h.logs, env.m.h.apiErrors, err.toJSON(), err.message]);
    for (const c of [CAL_BODY_CANARY, CAL_PREVIEW_CANARY, CAL_SERIES_CANARY]) expect(everything).not.toContain(c);
    for (const row of env.c.twin.rows.values()) for (const k of ["body", "bodyPreview", "description", "uniqueBody"]) expect(k in row).toBe(false);
    expect(env.c.contentWriteCount()).toBe(0);
  });
});

describe("spec §17 test 19 under D-59: no calendar list, no selection, no cap", () => {
  const lanes = (calendarIds: string[] | null) => ({ PKG: { providers: ["microsoft" as const], microsoft: { tenantIds: [TENANT_A], calendarIds }, domains: [MAIL_DOMAIN] } });

  it("a configured microsoft.calendar_ids (7 ids) is ignored and logged ONCE per run as a count, never the ids, never an error; calendar.* Google settings are not applied either", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `AAMkSyntheticCalendarId${String(i)}=`);
    const env = setup({ harness: { lanes: lanes(ids) }, calendar: { pageSize: 2, calendar: { PKG: { calendarIds: ["en.usa#holiday@group.v.calendar.google.com"], includeReadOnly: true, forwardDays: 365 } } } });
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run.pages).toBeGreaterThan(3); // several pages in one run, one log line
    expect(run).toMatchObject({ written: SEED });
    const lines = logsOf(env, "microsoft.calendar.calendar_ids_ignored");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({ count: 7 });
    expect(JSON.stringify(env.m.h.logs)).not.toContain("AAMkSyntheticCalendarId");
    expect(JSON.stringify(env.m.h.logs)).not.toContain("holiday@group");
    expect(env.cal.requests.some((r) => /calendars/i.test(r.path))).toBe(false);
    expect(new Set(env.c.twin.rowsOf(env.conn.id).map((r) => r.calendar_id))).toEqual(new Set([DEFAULT_CALENDAR_ID]));
    // the next run is a new run: one more line
    await env.c.sync.run("PKG", env.conn);
    expect(logsOf(env, "microsoft.calendar.calendar_ids_ignored")).toHaveLength(2);
  });

  it("with no microsoft.calendar_ids configured nothing about the list is logged", async () => {
    const env = setup({ harness: { lanes: lanes(null) } });
    await env.c.sync.run("PKG", env.conn);
    expect(logsOf(env, "microsoft.calendar.calendar_ids_ignored")).toHaveLength(0);
  });
});

describe("the request rules", () => {
  it("the window is on the INITIAL request only (UTC ISO 8601, retention back to forward_days ahead); every later request is the returned link; no $select, $filter, $orderby, $search or $expand is ever sent", async () => {
    const env = setup({ calendar: { pageSize: 2 } });
    await env.c.sync.run("PKG", env.conn);
    await env.c.sync.run("PKG", env.conn);
    const w = newWindow(FAKE_NOW, 90, DEFAULT_CALENDAR_SETTINGS.forwardDays);
    expect(w).toEqual({ s: "2026-08-07T00:00:00.000Z", e: "2027-11-05T00:00:00.000Z" });
    expect(env.cal.initialSearches()).toEqual([`?${initialQuery(w)}`]);
    const links = env.cal.deltaRequests().filter((r) => /[?&]\$(skip|delta)token=/.test(r.search));
    expect(links.length).toBeGreaterThan(3);
    for (const r of env.cal.deltaRequests()) expect(/\$(select|filter|orderby|search|expand)/i.test(decodeURIComponent(r.search)), r.search).toBe(false);
    for (const r of links) expect(r.search).not.toMatch(/startDateTime|endDateTime/);
    expect(env.cal.refusedForQuery).toBe(0);
  });

  it("a link that repeats our window parameters byte for byte is accepted and sent back unchanged", async () => {
    const env = setup({ calendar: { pageSize: 2 } });
    env.cal.settings.linkCarriesWindow = true;
    await env.c.sync.run("PKG", env.conn);
    const links = env.cal.deltaRequests().filter((r) => /[?&]\$(skip|delta)token=/.test(r.search));
    expect(links.length).toBeGreaterThan(3);
    for (const r of links) expect(r.search).toContain("startDateTime=2026-08-07T00:00:00.000Z&endDateTime=2027-11-05T00:00:00.000Z");
    expect(env.c.twin.rowsOf(env.conn.id)).toHaveLength(SEED);
  });

  it("every request, link requests included, carries ONE Prefer header with IdType ImmutableId, outlook.timezone UTC and odata.maxpagesize; the fake refuses a request without ImmutableId", async () => {
    const env = setup({ calendar: { pageSize: 2 } });
    await env.c.sync.run("PKG", env.conn);
    await env.c.sync.run("PKG", env.conn);
    expect(env.cal.deltaRequests().length).toBeGreaterThan(5);
    for (const r of env.cal.requests) {
      expect(r.prefer).toBe('IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=2');
      expect(r.prefer?.split(",")).toHaveLength(3);
    }
    expect(env.cal.refusedForImmutableId).toBe(0);
    expect(calendarPrefer(50).Prefer).toBe('IdType="ImmutableId", outlook.timezone="UTC", odata.maxpagesize=50');
    // the fake refuses a request that lacks ImmutableId (and counts it)
    const token = env.fake.issueAccess(env.account);
    const refused = await fetch(`${GRAPH_V1}/me/calendarView/delta?startDateTime=2026-11-01T00:00:00.000Z&endDateTime=2026-12-01T00:00:00.000Z`, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' } });
    expect(refused.status).toBe(400);
    expect(env.cal.refusedForImmutableId).toBe(1);
  });

  it("without a page size option the page asks for 50 events; the option overrides it", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    expect(env.cal.requests.every((r) => r.prefer?.endsWith("odata.maxpagesize=50"))).toBe(true);
  });
});

describe("the cursor", () => {
  it("is m1.<connection id>.c: with one link and its window; a finished load keeps the deltaLink, a load in progress the nextLink", async () => {
    const env = setup({ calendar: { pageSize: 4 } });
    const first = await env.c.provider.sync("PKG", env.conn, null, { pageSize: 4 });
    expect(first.hasMore).toBe(true);
    const mid = stateOf(first.nextCursor?.value ?? "", env.conn.id);
    expect(mid).toMatchObject({ v: 1, k: "n", w: { s: "2026-08-07T00:00:00.000Z", e: "2027-11-05T00:00:00.000Z" } });
    expect(mid.l).toMatch(/\$skiptoken=/);
    const done = await drain(env, first.nextCursor, 4);
    expect(stateOf(done.cursor?.value ?? "", env.conn.id)).toMatchObject({ k: "d", w: mid.w });
    expect(stateOf(done.cursor?.value ?? "", env.conn.id).l).toMatch(/\$deltatoken=/);
  });

  it("the largest allowed link (MAX_LINK_CHARS) is stored and used; the cursor stays under 16 KB", async () => {
    const env = setup({ calendar: { pageSize: 50 } });
    env.cal.settings.rewriteLink = (l) => l.padEnd(MAX_LINK_CHARS, "A");
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run.written).toBe(SEED);
    const stored = env.c.twin.cursorOf("PKG", env.conn.id) ?? "";
    expect(stateOf(stored, env.conn.id).l).toHaveLength(MAX_LINK_CHARS);
    expect(stored.length).toBeLessThan(MAX_CURSOR_CHARS);
    const again = await env.c.sync.run("PKG", env.conn); // the long link is sent back and accepted
    expect(again).toMatchObject({ mode: "incremental", written: 0, resynced: false });
  });

  it("a link one character over the bound is never cut and never stored: the first page answers fullResyncRequired, and a run fails instead of looping", async () => {
    const env = setup();
    env.cal.settings.rewriteLink = (l) => l.padEnd(MAX_LINK_CHARS + 1, "A");
    const r = await env.c.provider.sync("PKG", env.conn, null);
    expect(r).toMatchObject({ fullResyncRequired: true, nextCursor: null, upserts: [], removals: [] });
    const err = await failure(env.c.sync.run("PKG", env.conn));
    expect(err.info.kind).toBe("provider_error");
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toBeUndefined();
    expect(env.c.twin.rowsOf(env.conn.id)).toHaveLength(0);
  });

  it("an oversized cursor value, a malformed one and a stale token are fullResyncRequired with no request", async () => {
    const env = setup();
    const requests = env.c.externalRequestCount();
    for (const value of ["x".repeat(MAX_CURSOR_CHARS + 1), "x".repeat(MAX_CURSOR_CHARS), "stale-token", `m1.${env.conn.id}.c:!!!`]) {
      const r = await env.c.provider.sync("PKG", env.conn, { value });
      expect(r, value.slice(0, 20)).toMatchObject({ fullResyncRequired: true, nextCursor: null });
    }
    expect(env.c.externalRequestCount()).toBe(requests);
  });
});

describe("the half-horizon reload (as T-064 does for Google)", () => {
  const forward30 = { PKG: { ...DEFAULT_CALENDAR_SETTINGS, forwardDays: 30 } };

  it("when the forward part of the window has run down below half, a fresh full load with a NEW window starts; before that the stored link is used", async () => {
    let t = FAKE_NOW;
    const env = setup({ calendar: { providerNow: () => t, calendar: forward30 } });
    await env.c.sync.run("PKG", env.conn);
    const first = stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id);
    expect(first.w).toEqual({ s: "2026-08-07T00:00:00.000Z", e: "2026-12-05T00:00:00.000Z" });
    expect(env.cal.initialSearches()).toHaveLength(1);

    t = FAKE_NOW + 10 * DAY; // 20 days ahead are left: not below 15
    await env.c.sync.run("PKG", env.conn);
    expect(env.cal.initialSearches()).toHaveLength(1);
    expect(stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id).w).toEqual(first.w);

    t = FAKE_NOW + 16 * DAY; // 14 days ahead are left: a reload is due
    const writesBefore = env.c.twin.stats.applies;
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ mode: "incremental", resynced: false });
    const searches = env.cal.initialSearches();
    expect(searches).toHaveLength(2);
    const w2 = newWindow(t, 90, 30);
    expect(w2.e).toBe("2026-12-21T00:00:00.000Z");
    expect(searches[1]).toBe(`?${initialQuery(w2)}`);
    expect(stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id).w).toEqual(w2);
    expect(env.c.twin.stats.applies).toBeGreaterThan(writesBefore);
    expect(run.written).toBeGreaterThan(0); // the window is loaded in full again
    expect(logsOf(env, "microsoft.calendar.window_reload")).toHaveLength(1);
    // and the new link continues from there
    t += DAY;
    await env.c.sync.run("PKG", env.conn);
    expect(env.cal.initialSearches()).toHaveLength(2);
  });

  it("a load in progress is never reloaded, however late: its nextLink belongs to its window", async () => {
    let t = FAKE_NOW;
    const env = setup({ calendar: { providerNow: () => t, calendar: forward30 } });
    const first = await env.c.provider.sync("PKG", env.conn, null, { pageSize: 2 });
    expect(first.hasMore).toBe(true);
    t = FAKE_NOW + 40 * DAY; // far past half
    const second = await env.c.provider.sync("PKG", env.conn, first.nextCursor, { pageSize: 2 });
    expect(env.cal.initialSearches()).toHaveLength(1);
    expect(second.fullResyncRequired).toBe(false);
    expect(stateOf(second.nextCursor?.value ?? "", env.conn.id).w).toEqual(stateOf(first.nextCursor?.value ?? "", env.conn.id).w);
  });

  it("a failed reload leaves the old cursor in place (nothing advances)", async () => {
    let t = FAKE_NOW;
    const env = setup({ calendar: { providerNow: () => t, calendar: forward30 } });
    await env.c.sync.run("PKG", env.conn);
    const before = env.c.twin.cursorOf("PKG", env.conn.id);
    t = FAKE_NOW + 20 * DAY;
    env.cal.setFault(env.account, "server_error");
    await failure(env.c.sync.run("PKG", env.conn));
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toBe(before);
  });
});

describe("tampered links: nothing is ever followed to another host or path", () => {
  const tampers: Record<string, (link: string) => string> = {
    "another host": (l) => l.replace("graph.microsoft.com", "evil.example.test"),
    "another path (a calendar)": (l) => l.replace("/me/calendarView/delta", "/me/calendars/AAMkX=/calendarView/delta"),
    "another path (a mail folder)": (l) => l.replace("/me/calendarView/delta", "/me/mailFolders/AAMkInbox=/messages/delta"),
    "another path (another user)": (l) => l.replace("/me/calendarView/delta", "/users/someone@example.test/calendarView/delta"),
    "an extra $select": (l) => `${l}&$select=body`,
    "an extra $expand": (l) => `${l}&$expand=attachments`,
    "an extra parameter": (l) => `${l}&$top=1000`,
    "another window": (l) => `${l}&startDateTime=2020-01-01T00:00:00.000Z`,
    "http": (l) => l.replace("https://", "http://"),
  };

  it("in a stored cursor each variant is fullResyncRequired with ZERO requests of any kind (no token read), and nothing reaches the other host", async () => {
    const env = setup();
    const evil: string[] = [];
    server.use(http.all("https://evil.example.test/*", ({ request }) => { evil.push(request.url); return HttpResponse.json({}); }));
    await env.c.sync.run("PKG", env.conn);
    const good = stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id);
    const requests = env.c.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    for (const [name, tamper] of Object.entries(tampers)) {
      const cursor = encodeCalCursor(env.conn.id, { ...good, l: tamper(good.l) });
      const r = await env.c.provider.sync("PKG", env.conn, cursor);
      expect(r, name).toMatchObject({ fullResyncRequired: true, nextCursor: null });
    }
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.m.h.stats.tokenReads).toBe(reads);
    expect(evil).toEqual([]);
  });

  it("a run over a tampered stored cursor reloads once and ends with a good cursor", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const good = stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id);
    env.c.twin.cursors.set(`PKG\u0000${env.conn.id}\u0000calendar`, encodeCalCursor(env.conn.id, { ...good, l: tampers["another host"]?.(good.l) ?? "" })?.value ?? "");
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ resynced: true, mode: "full" });
    expect(stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id).l.startsWith(CAL_LINK_HEAD)).toBe(true);
  });

  it("a link Graph itself returns that points elsewhere (or asks for more) is not stored and not followed: a fixed-message provider_error", async () => {
    for (const [name, tamper] of Object.entries(tampers)) {
      const env = setup({ calendar: { pageSize: 2 } });
      const evil: string[] = [];
      server.use(http.all("https://evil.example.test/*", ({ request }) => { evil.push(request.url); return HttpResponse.json({}); }));
      env.cal.settings.rewriteLink = tamper;
      const err = await failure(env.c.sync.run("PKG", env.conn));
      expect(err.info, name).toMatchObject({ kind: "provider_error", message: "Microsoft returned a link that cannot be used" });
      expect(JSON.stringify(err.toJSON()), name).not.toMatch(/evil|AAMkX|\$top|\$select/);
      expect(env.c.twin.cursorOf("PKG", env.conn.id), name).toBeUndefined();
      expect(env.c.twin.rowsOf(env.conn.id), name).toHaveLength(0);
      expect(evil, name).toEqual([]);
    }
  });

  it("a nextLink equal to the one just used is an error, not a loop", async () => {
    const env = setup({ calendar: { pageSize: 2 } });
    const first = await env.c.provider.sync("PKG", env.conn, null, { pageSize: 2 });
    const stored = stateOf(first.nextCursor?.value ?? "", env.conn.id).l;
    env.cal.settings.rewriteLink = () => stored;
    const err = await failure(env.c.provider.sync("PKG", env.conn, first.nextCursor, { pageSize: 2 }));
    expect(err.info).toMatchObject({ kind: "provider_error", message: "Microsoft returned the same page link again" });
  });

  it("foreign, other-connection, mail-prefixed and Google-prefixed cursors are fullResyncRequired with zero requests", async () => {
    const env = setup();
    const other = env.m.connect("PKG");
    env.cal.events(other.account);
    await env.c.sync.run("PKG", other.conn);
    await env.m.sync.run("PKG", env.conn);
    const mailCursor = env.m.twin.cursorOf("PKG", env.conn.id) ?? "";
    expect(mailCursor).toMatch(new RegExp(`^m1\\.${env.conn.id}\\.m:`));
    const otherCursor = env.c.twin.cursorOf("PKG", other.conn.id) ?? "";
    const requests = env.c.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    for (const value of [otherCursor, mailCursor, `g1.${env.conn.id}.c:AAAA`, `x1.${env.conn.id}.c:AAAA`]) {
      const r = await env.c.provider.sync("PKG", env.conn, { value });
      expect(r, value.slice(0, 14)).toMatchObject({ fullResyncRequired: true, nextCursor: null });
    }
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.m.h.stats.tokenReads).toBe(reads);
  });
});

describe("an expired delta state (410, or syncStateNotFound / resyncRequired on a stored link) is a resync, not a failure", () => {
  const variants: { name: string; how: { status?: number; code?: string } }[] = [
    { name: "410 Gone", how: {} },
    { name: "410 with another code", how: { status: 410, code: "SomethingElse" } },
    { name: "400 syncStateNotFound", how: { status: 400, code: "syncStateNotFound" } },
    { name: "404 SYNCSTATENOTFOUND (upper case)", how: { status: 404, code: "SYNCSTATENOTFOUND" } },
    { name: "400 resyncRequired", how: { status: 400, code: "resyncRequired" } },
    { name: "400 ResyncRequired (mixed case)", how: { status: 400, code: "ResyncRequired" } },
  ];
  it.each(variants)("$name: the provider answers fullResyncRequired and the run reloads once and recovers", async ({ how }) => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    env.cal.expireDeltaState(env.account, how);
    env.cal.add(env.account, { subject: "Synthetic after expiry" });
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ resynced: true, mode: "full" });
    expect(run.written).toBeGreaterThan(SEED); // the reload reads everything again
    expect(env.c.twin.rowsOf(env.conn.id).some((r) => r.title === "Synthetic after expiry")).toBe(true);
    expect(logsOf(env, "microsoft.calendar.delta_state_expired")).toHaveLength(1);
  });

  it("a 400 with another code, a 403 and a 5xx on a stored link are failures; the cursor stays", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const before = env.c.twin.cursorOf("PKG", env.conn.id);
    for (const how of [{ status: 400, code: "InvalidRequest" }, { status: 403, code: "ErrorAccessDenied" }, { status: 500, code: "InternalServerError" }]) {
      env.cal.expireDeltaState(env.account, { ...how, times: 5 }); // a 5xx is retried once by the client: keep it failing
      const err = await failure(env.c.provider.sync("PKG", env.conn, before === undefined ? null : { value: before }));
      expect(err.info.http_status, JSON.stringify(how)).toBe(how.status);
    }
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toBe(before);
  });

  it("the INITIAL request is never answered with a resync (it would loop): a 410 there is an error", async () => {
    const env = setup();
    server.use(http.get(`${GRAPH_V1}/me/calendarView/delta`, () => HttpResponse.json({ error: { code: "syncStateNotFound", message: "x" } }, { status: 410 })));
    const err = await failure(env.c.provider.sync("PKG", env.conn, null));
    expect(err.info.http_status).toBe(410);
  });
});

describe("removals and cancelled events", () => {
  it("an @removed event becomes a removal and its row reads cancelled (nothing is deleted from the index)", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const id = env.cal.bySubject(env.account, "Synthetic single 3").id;
    env.cal.remove(env.account, id);
    const delta = await drain(env, { value: env.c.twin.cursorOf("PKG", env.conn.id) as string });
    expect(delta.removals).toEqual([{ calendar_id: DEFAULT_CALENDAR_ID, event_id: id }]);
    expect(delta.upserts).toEqual([]);
    await env.c.sync.run("PKG", env.conn);
    expect(env.c.twin.rowsOf(env.conn.id).find((r) => r.event_id === id)).toMatchObject({ status: "cancelled", title: "Synthetic single 3" });
  });

  it("a removal for an event that fell OUT of the date range is applied the same way (the row becomes cancelled, which is right for an event that left the window)", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const moved = env.cal.bySubject(env.account, "Synthetic single 1").id;
    env.cal.change(env.account, moved, { startMs: FAKE_NOW + 900 * DAY, endMs: FAKE_NOW + 900 * DAY + 3_600_000 }); // far beyond forward_days
    const delta = await drain(env, { value: env.c.twin.cursorOf("PKG", env.conn.id) as string });
    expect(delta.removals).toEqual([{ calendar_id: DEFAULT_CALENDAR_ID, event_id: moved }]);
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run.removed).toBe(1);
    expect(env.c.twin.rowsOf(env.conn.id).find((r) => r.event_id === moved)?.status).toBe("cancelled");
  });

  it("an `@removed` entry without a usable id is skipped and counted; the page is still applied", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const cursor = env.c.twin.cursorOf("PKG", env.conn.id) as string;
    const link = stateOf(cursor, env.conn.id).l;
    server.use(http.get(`${GRAPH_V1}/me/calendarView/delta`, () => HttpResponse.json({ value: [{ "@removed": { reason: "deleted" } }, { id: "", "@removed": {} }], "@odata.deltaLink": link.replace(/\$deltatoken=[^&]*/, "$deltatoken=dt-1-0-Zm9v") })));
    const r = await env.c.provider.sync("PKG", env.conn, { value: cursor });
    expect(r).toMatchObject({ removals: [], upserts: [], fullResyncRequired: false });
    expect(logsOf(env, "microsoft.calendar.events_skipped").at(-1)?.fields).toEqual({ invalid_removal: 2 });
  });

  it("isCancelled becomes a cancelled stub (no times); the stored title and times stay (the writer merges the status only)", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const id = env.cal.bySubject(env.account, "Synthetic single 1").id;
    const before = structuredClone(env.c.twin.rowsOf(env.conn.id).find((r) => r.event_id === id));
    env.cal.cancel(env.account, id);
    const delta = await drain(env, { value: env.c.twin.cursorOf("PKG", env.conn.id) as string });
    expect(delta.upserts).toHaveLength(1);
    expect(delta.upserts[0]).toMatchObject({ event_id: id, status: "cancelled", start_at: null, end_at: null, title: null });
    await env.c.sync.run("PKG", env.conn);
    const after = env.c.twin.rowsOf(env.conn.id).find((r) => r.event_id === id);
    expect(after).toMatchObject({ status: "cancelled", title: before?.title, start_at: before?.start_at });
  });

  it("a cancelled event seen for the first time is indexed as a cancelled stub", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const row = env.c.twin.rowsOf(env.conn.id).find((r) => r.status === "cancelled");
    expect(row).toMatchObject({ start_at: null, end_at: null, title: null });
  });
});

describe("recurring events: occurrences and exceptions are instances", () => {
  it("each instance is its own row with the series master as recurring_event_id and an original start; no series master row exists, and a master item that shows up anyway is skipped and counted", async () => {
    const env = setup();
    env.cal.add(env.account, { id: "AAMkSyntheticMasterItem=", subject: "Synthetic weekly master", type: "seriesMaster" });
    await env.c.sync.run("PKG", env.conn);
    const rows = env.c.twin.rowsOf(env.conn.id);
    const instances = rows.filter((r) => r.recurring_event_id !== null);
    expect(instances).toHaveLength(3);
    expect(new Set(instances.map((r) => r.recurring_event_id)).size).toBe(1);
    for (const r of instances) {
      expect(r.original_start_at).not.toBeNull();
      expect(r.event_id).not.toBe(r.recurring_event_id);
    }
    expect(instances.map((r) => r.title).sort()).toEqual(["Synthetic weekly", "Synthetic weekly", "Synthetic weekly (moved)"]);
    expect(rows.some((r) => r.event_id === "AAMkSyntheticMasterItem=")).toBe(false);
    expect(logsOf(env, "microsoft.calendar.events_skipped").at(-1)?.fields).toEqual({ series_master: 1 });
  });
});

describe("all-day events and zones", () => {
  it("a mapped zone gives local dates and local-midnight instants (the DST weekend of 2026-11-01 included); unmapped, custom and non-UTC events are skipped and counted without any subject or id in the log", async () => {
    const env = setup();
    env.cal.add(env.account, { subject: "Synthetic unmapped holiday", isAllDay: true, startMs: Date.parse("2026-11-12T00:00:00Z"), endMs: Date.parse("2026-11-13T00:00:00Z"), originalStartTimeZone: "Synthetic Standard Time" });
    env.cal.add(env.account, { subject: "Synthetic custom holiday", isAllDay: true, startMs: Date.parse("2026-11-12T00:00:00Z"), endMs: Date.parse("2026-11-13T00:00:00Z"), originalStartTimeZone: "tzone://Microsoft/Custom" });
    env.cal.add(env.account, { subject: "Synthetic missing-zone holiday", isAllDay: true, startMs: Date.parse("2026-11-12T00:00:00Z"), endMs: Date.parse("2026-11-13T00:00:00Z"), originalStartTimeZone: null });
    env.cal.add(env.account, { id: "AAMkSyntheticNotUtc=", subject: "Synthetic Pacific answer", raw: { start: { dateTime: "2026-11-12T08:00:00.0000000", timeZone: "Pacific Standard Time" } } });
    await env.c.sync.run("PKG", env.conn);
    const rows = env.c.twin.rowsOf(env.conn.id);
    expect(rows).toHaveLength(SEED); // none of the four added events
    const holiday = rows.find((r) => r.title === "Synthetic holiday");
    expect(holiday).toMatchObject({ all_day: true, start_date: "2026-10-31", end_date: "2026-11-02", timezone: "America/New_York", start_at: "2026-10-31T04:00:00.000Z", end_at: "2026-11-02T05:00:00.000Z" });
    expect(rows.find((r) => r.title === "Synthetic offsite")).toMatchObject({ all_day: true, start_date: "2026-11-10", end_date: "2026-11-11", timezone: "America/Los_Angeles" });
    const line = logsOf(env, "microsoft.calendar.events_skipped").at(-1);
    expect(line?.fields).toEqual({ all_day_zone_unusable: 3, not_utc: 1 });
    const logText = JSON.stringify(env.m.h.logs);
    for (const leak of ["Synthetic unmapped holiday", "Synthetic custom holiday", "Synthetic missing-zone", "Synthetic Pacific answer", "AAMkSyntheticNotUtc", "Synthetic Standard Time", "tzone://"]) expect(logText).not.toContain(leak);
  });

  it("one malformed item is skipped and counted, never failing the page; a hostile attendee address costs only the address", async () => {
    const env = setup();
    env.cal.add(env.account, { id: "AAMkSyntheticBroken=", subject: "Synthetic broken", raw: { start: "garbage", attendees: "x" } });
    env.cal.add(env.account, { subject: "Synthetic hostile attendees", attendees: [{ address: "bad\u202E@example.test", name: "X", response: "accepted" }, { address: "good@example.test", name: "Good", response: "accepted" }] });
    const run = await env.c.sync.run("PKG", env.conn);
    expect(run.written).toBe(SEED + 1);
    const rows = env.c.twin.rowsOf(env.conn.id);
    expect(rows.find((r) => r.title === "Synthetic hostile attendees")?.attendees).toEqual([{ email: "good@example.test", name: "Good", response: "accepted" }]);
    expect(logsOf(env, "microsoft.calendar.events_skipped").at(-1)?.fields).toEqual({ invalid_item: 1 });
  });

  it("join links are https only and webLink is host-checked, through the whole sync", async () => {
    const env = setup();
    env.cal.add(env.account, { subject: "Synthetic odd links", joinUrl: "http://teams.example.test/x", webLink: "https://evil.example.test/calendar/item/x" });
    await env.c.sync.run("PKG", env.conn);
    const odd = env.c.twin.rowsOf(env.conn.id).find((r) => r.title === "Synthetic odd links");
    expect(odd).toMatchObject({ online_meeting_url: null, source_url: null });
    const normal = env.c.twin.rowsOf(env.conn.id).find((r) => r.title === "Synthetic single 1");
    expect(normal?.online_meeting_url).toMatch(/^https:\/\/teams\.microsoft\.com\//);
    expect(normal?.source_url).toMatch(/^https:\/\/outlook\.office365\.com\/calendar\/item\//);
  });
});

describe("failures that are ours or Graph's never advance the cursor", () => {
  it("a refusal of ours (reconnect required, provider disabled, a guard failure) fails the page before any request; the stored cursor stays", async () => {
    const env = setup({ calendar: { pageSize: 2 } });
    await env.c.sync.run("PKG", env.conn);
    const before = env.c.twin.cursorOf("PKG", env.conn.id);
    const row = env.m.h.rows.get(env.conn.id);
    if (!row) throw new Error("no row");
    const requests = env.c.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    row.status = "reconnect_required";
    expect((await failure(env.c.sync.run("PKG", env.conn))).info.kind).toBe("reconnect_required");
    row.status = "active";
    env.m.h.setLane("PKG", { providers: ["google"] });
    expect((await failure(env.c.sync.run("PKG", env.conn))).info).toMatchObject({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    env.m.h.setLane("PKG", { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] } });
    env.m.h.setIdentity(env.conn.id, { tenantId: "99999999-9999-4999-8999-999999999999", cloud: "commercial" });
    expect((await failure(env.c.sync.run("PKG", env.conn))).info.kind).toBe("forbidden");
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.m.h.stats.tokenReads).toBe(reads);
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toBe(before);
  });

  it("the gate and guard run before EVERY request: a provider switched off between two pages stops the load there, the first page's cursor is kept", async () => {
    const env = setup({ calendar: { pageSize: 2, maxPages: 1 } });
    await env.c.sync.run("PKG", env.conn); // one page, then the page cap
    const stored = env.c.twin.cursorOf("PKG", env.conn.id);
    expect(stateOf(stored ?? "", env.conn.id).k).toBe("n");
    const requests = env.c.externalRequestCount();
    env.m.h.setLane("PKG", { providers: ["google"] });
    await expect(env.c.sync.run("PKG", env.conn)).rejects.toMatchObject({ info: { message: PROVIDER_DISABLED_MESSAGE } });
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toBe(stored);
  });

  it("a Graph failure on page 2 leaves page 1's cursor in place and the next run continues from it", async () => {
    const env = setup({ calendar: { pageSize: 2, maxPages: 1 } });
    await env.c.sync.run("PKG", env.conn);
    const stored = env.c.twin.cursorOf("PKG", env.conn.id);
    env.cal.setFault(env.account, "server_error");
    await failure(env.c.sync.run("PKG", env.conn));
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).toBe(stored);
    const run = await env.c.sync.run("PKG", env.conn); // still one page per run; keep going
    expect(run.pages).toBe(1);
    expect(env.c.twin.cursorOf("PKG", env.conn.id)).not.toBe(stored);
  });

  it("unreadable calendar settings or retention fail the sync closed before any request", async () => {
    const env = setup({ calendar: { calendar: { PKG: "unreadable" } } });
    const err = await failure(env.c.sync.run("PKG", env.conn));
    expect(err.info.kind).toBe("provider_error");
    expect(env.cal.requests).toHaveLength(0);
    const env2 = setup({ harness: { retention: { PKG: -1 } } });
    expect((await failure(env2.c.sync.run("PKG", env2.conn))).info.kind).toBe("transient");
    expect(env2.cal.requests).toHaveLength(0);
  });

  it("malformed answers (not a page, both links, neither) are provider errors with fixed messages", async () => {
    const env = setup();
    for (const body of [{ nope: 1 }, { value: [], "@odata.nextLink": "x", "@odata.deltaLink": "y" }, { value: [] }, { value: "x" }]) {
      server.use(http.get(`${GRAPH_V1}/me/calendarView/delta`, () => HttpResponse.json(body as never)));
      const err = await failure(env.c.provider.sync("PKG", env.conn, null));
      expect(err.info).toMatchObject({ kind: "provider_error", message: "Microsoft calendar delta is not valid" });
    }
  });
});

describe("the run budget (injected clock)", () => {
  it("a run stops between pages when the budget is spent and the next run continues from the stored cursor until the load is complete", async () => {
    let t = 1_000_000;
    const env = setup({ calendar: { maxRunMs: 1000, runnerNow: () => (t += 600), pageSize: 2 } });
    const first = await env.c.sync.run("PKG", env.conn);
    expect(first.pages).toBeLessThan(5); // 9 events at 2 per page need 5 pages
    expect(stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id).k).toBe("n");
    expect(logsOf(env, "microsoft.calendar.sync_time_budget")).toHaveLength(1);
    let runs = 1;
    while (stateOf(env.c.twin.cursorOf("PKG", env.conn.id) ?? "", env.conn.id).k === "n" && runs < 10) {
      await env.c.sync.run("PKG", env.conn);
      runs += 1;
    }
    expect(runs).toBeGreaterThan(1);
    expect(env.c.twin.rowsOf(env.conn.id)).toHaveLength(SEED);
    expect(env.cal.initialSearches()).toHaveLength(1); // one load, continued across runs
  });
});

describe("live event body (readBody)", () => {
  it("returns the text of an event of the default calendar: HTML converted, bounded, an UntrustedBody labelled live, and nothing stored or logged", async () => {
    const env = setup();
    await env.c.sync.run("PKG", env.conn);
    const id = env.cal.bySubject(env.account, "Synthetic single 1").id;
    env.cal.change(env.account, id, { bodyContentType: "html", bodyContent: `<html><body><p>Agenda <b>one</b></p><script>alert(1)</script><p>${CAL_BODY_CANARY}</p></body></html>` });
    const writes = env.c.twin.writes.length;
    const res = await env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, id);
    expect(res).toMatchObject({ freshness: "live", provider: "microsoft", connection_id: env.conn.id, lane_id: "PKG", op: "calendar.read_body" });
    const text = res.data.reveal();
    expect(text).toContain("Agenda one");
    expect(text).toContain(CAL_BODY_CANARY);
    expect(text).not.toMatch(/<[a-z]/i);
    expect(res.data.origin).toBe("calendar");
    const small = await env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, id, { maxChars: 10 });
    expect(small.data.reveal().length).toBeLessThanOrEqual(10);
    expect(small.data.truncated).toBe(true);
    // the request: the id in the path, `$select=body`, the text preference, ImmutableId
    const read = env.cal.eventRequests().at(-1);
    expect(read?.search).toBe("?$select=body");
    expect(read?.prefer).toBe('IdType="ImmutableId", outlook.body-content-type="text"');
    expect(env.c.twin.writes).toHaveLength(writes);
    expect(JSON.stringify([env.m.h.logs, env.m.h.apiErrors, [...env.c.twin.rows.values()], [...env.c.twin.cursors.values()]])).not.toContain(CAL_BODY_CANARY);
    expect(env.c.contentWriteCount()).toBe(0);
  });

  it("a text answer is used as is; the type comes from the answer, not from the preference sent", async () => {
    const env = setup();
    const id = env.cal.add(env.account, { bodyContentType: "text", bodyContent: "Plain <b>text</b> agenda" });
    expect((await env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, id)).data.reveal()).toBe("Plain <b>text</b> agenda");
  });

  it("ids are checked BEFORE any request or token read; another calendar id is refused; a missing event is not_found", async () => {
    const env = setup();
    const requests = env.c.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    for (const bad of ["", "a/b", "..", "x?y", "x#y", "a%2Fb", "a\\b", "a".repeat(513)]) {
      await expect(env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, bad)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
      await expect(env.c.provider.readBody("PKG", env.conn, bad, "AAMkX=")).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    for (const other of ["primary", "AAMkSecondaryCalendar=", "microsoft:other"]) {
      await expect(env.c.provider.readBody("PKG", env.conn, other, "AAMkX=")).rejects.toMatchObject({ info: { kind: "forbidden" } });
    }
    await expect(env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, "AAMkX=", { maxChars: 0 })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.m.h.stats.tokenReads).toBe(reads);
    await expect(env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, "AAMkNoSuchEvent=")).rejects.toMatchObject({ info: { kind: "not_found" } });
  });

  it("an answer that is not a body is a provider error with a fixed message (never the content)", async () => {
    const env = setup();
    server.use(http.get(`${GRAPH_V1}/me/events/:id`, () => HttpResponse.json({ id: "x", body: { contentType: "rtf", content: CAL_BODY_CANARY } })));
    const err = await failure(env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, "AAMkX="));
    expect(err.info).toMatchObject({ kind: "provider_error", message: "Microsoft event body is not valid" });
    expect(JSON.stringify(err.toJSON())).not.toContain(CAL_BODY_CANARY);
  });
});

describe("watch, renew, stop and writes", () => {
  it("polling: one entry, no request; prepareWrite is guarded first and then unsupported", async () => {
    const env = setup();
    const requests = env.c.externalRequestCount();
    const [w] = await env.c.provider.watch("PKG", env.conn);
    expect(w).toMatchObject({ mode: "polling", resource: "calendar", channel_id: null });
    await env.c.provider.renew("PKG", env.conn, w as never);
    await env.c.provider.stop("PKG", env.conn, w as never);
    await expect(env.c.provider.prepareWrite("PKG", env.conn, { action_type: "calendar.event.create", calendar_id: DEFAULT_CALENDAR_ID, changes: { title: "x" } })).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.c.provider.capabilities).toEqual({ watch: "polling", prepareWrite: false });
  });
});

describe("the token canary: no token in logs, errors, the cursor or the store", () => {
  it("through a full load, an expired access token (refresh), a 401, a 5xx, a throttle and a revoked grant", async () => {
    const env = setup();
    const surfaces: unknown[] = [];
    const thrown: unknown[] = [];
    const attempt = async (p: Promise<unknown>) => {
      try {
        surfaces.push(await p);
      } catch (e) {
        thrown.push(isConnectorError(e) ? { info: e.info, message: e.message, json: e.toJSON() } : String(e));
      }
    };
    await attempt(env.c.sync.run("PKG", env.conn));
    env.m.h.expireStoredAccess(env.conn.id); // the next call refreshes the token
    env.cal.add(env.account);
    await attempt(env.c.sync.run("PKG", env.conn));
    env.cal.setFault(env.account, "server_error");
    await attempt(env.c.sync.run("PKG", env.conn));
    env.cal.setFault(env.account, "rate_limited");
    await attempt(env.c.sync.run("PKG", env.conn));
    await attempt(env.c.provider.readBody("PKG", env.conn, DEFAULT_CALENDAR_ID, "AAMkNoSuchEvent="));
    env.cal.setFault(env.account, "auth_revoked");
    await attempt(env.c.sync.run("PKG", env.conn));
    expect(thrown.length).toBeGreaterThanOrEqual(4);
    const tokens = new Set<string>();
    for (const a of env.fake.accounts.values()) for (const t of [...a.accessTokens, ...a.refreshTokens]) tokens.add(t);
    const stored = env.m.h.storedSet(env.conn.id);
    for (const k of ["access_token", "refresh_token"]) if (typeof stored?.[k] === "string") tokens.add(stored[k] as string);
    expect(tokens.size).toBeGreaterThan(3);
    const text = JSON.stringify([env.m.h.logs, env.m.h.apiErrors, env.m.h.reconnects, thrown, surfaces, env.c.twin.writes, [...env.c.twin.cursors.values()], env.c.twin.rows.size]);
    for (const t of tokens) expect(text, "a token reached a log, error, cursor or store").not.toContain(t);
    expect(text).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
    expect(text).not.toContain(REDACTED);
    expect(env.m.h.logs.length).toBeGreaterThan(5);
  });
});

describe("a Microsoft calendar sync beside a Google connection of the same user (D-57)", () => {
  const OWNER = "00000000-0000-4000-8000-0000000b0670";
  const lanes = { PKG: { providers: ["google" as const, "microsoft" as const], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] } };

  it("reads and writes only its own connection and stream: the Google calendar rows and cursor, the Google mail rows and cursor, and the Microsoft MAIL cursor of the same connection are identical afterwards", async () => {
    const env = setup({ harness: { lanes } });
    const g = env.c.seedGoogleCalendar("PKG", { ownerId: OWNER });
    const ms = env.m.connect("PKG", { ownerId: OWNER });
    env.cal.events(ms.account);
    await env.m.sync.run("PKG", ms.conn); // the mail stream of the Microsoft connection has its own cursor
    const mailCursor = env.m.twin.cursorOf("PKG", ms.conn.id);
    const mailRows = structuredClone(env.m.twin.rowsOf(ms.conn.id));
    const googleCalRows = structuredClone(env.c.twin.rowsOf(g.row.id));
    const googleMailRows = structuredClone(env.m.twin.rowsOf(g.row.id));
    const googleConn = structuredClone(env.m.h.rows.get(g.row.id));
    const mailWrites = env.m.twin.writes.length;

    const run = await env.c.sync.run("PKG", ms.conn);
    expect(run).toMatchObject({ mode: "full", written: SEED });
    expect(env.c.twin.rowsOf(g.row.id)).toEqual(googleCalRows);
    expect(env.c.twin.cursorOf("PKG", g.row.id)).toBe(g.calendarCursor);
    expect(env.m.twin.rowsOf(g.row.id)).toEqual(googleMailRows);
    expect(env.m.twin.cursorOf("PKG", g.row.id)).toBe(g.cursor);
    expect(env.m.h.rows.get(g.row.id)).toEqual(googleConn);
    expect(env.m.twin.cursorOf("PKG", ms.conn.id)).toBe(mailCursor);
    expect(env.m.twin.rowsOf(ms.conn.id)).toEqual(mailRows);
    expect(env.m.twin.writes).toHaveLength(mailWrites); // the calendar run wrote nothing into the mail index
    expect(env.c.twin.writes.length).toBeGreaterThan(0);
    expect(env.c.twin.writes.every((w) => w.connectionId === ms.conn.id)).toBe(true);
    expect(env.c.twin.stats.resets).toBe(0);
    expect(env.c.twin.cursorOf("PKG", ms.conn.id)).toMatch(/^m1\..*\.c:/);
    // and a second run with changes still leaves Google alone
    env.cal.add(ms.account);
    await env.c.sync.run("PKG", ms.conn);
    expect(env.c.twin.rowsOf(g.row.id)).toEqual(googleCalRows);
    expect(env.c.twin.cursorOf("PKG", g.row.id)).toBe(g.calendarCursor);
  });

  it("the Microsoft calendar runner and provider refuse the Google connection before any request or token read", async () => {
    const env = setup({ harness: { lanes } });
    const g = env.c.seedGoogleCalendar("PKG", { ownerId: OWNER });
    const requests = env.c.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    await expect(env.c.sync.run("PKG", g.conn as never)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(env.c.provider.sync("PKG", g.conn as never, null)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(env.c.provider.sync("PKG", g.conn as never, { value: g.calendarCursor })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(env.c.provider.readBody("PKG", g.conn as never, DEFAULT_CALENDAR_ID, "AAMkX=")).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(env.c.externalRequestCount()).toBe(requests);
    expect(env.m.h.stats.tokenReads).toBe(reads);
    expect(env.c.twin.cursorOf("PKG", g.row.id)).toBe(g.calendarCursor);
  });
});

describe("the state the contract and the page writer rely on", () => {
  it("the first page of a load has the cursor prefix the SQL writer demands (m1.<connection id>.c:) and a state that parses", async () => {
    const env = setup();
    const r = await env.c.provider.sync("PKG", env.conn, null, { pageSize: 3 });
    const s: CalState = stateOf(r.nextCursor?.value ?? "", env.conn.id);
    expect(r.nextCursor?.value.startsWith(`m1.${env.conn.id}.c:`)).toBe(true);
    expect(windowParams(s.w)).toEqual(["startDateTime=2026-08-07T00:00:00.000Z", "endDateTime=2027-11-05T00:00:00.000Z"]);
  });
});
