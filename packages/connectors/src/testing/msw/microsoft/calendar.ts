// Fake Microsoft Graph calendar (MSW) for the Microsoft calendar sync tests (T-067): `GET /me/calendarView/delta` for the DEFAULT calendar and
// `GET /me/events/{id}`, over the same synthetic accounts as ./handlers.ts. Synthetic data only (rule 10). Faithful where the sync relies on Microsoft's
// documentation (docs/plan-review.md, "T-067: spec §15 verify items", D-59):
//  - the INITIAL request needs `startDateTime` and `endDateTime` (ISO 8601); a link request carries the link's query as given, and a window parameter is
//    accepted on it only when the link itself carried it (the fake answers 400 to an initial request without a window);
//  - `$select`, `$filter`, `$orderby`, `$search` and `$expand` are NOT supported on this delta: the fake refuses (400) a request that has any of them;
//  - `Prefer: IdType="ImmutableId"` is REQUIRED on every request, including a request made from a stored link: the fake refuses (400) one without it and
//    records every Prefer header it saw (`outlook.timezone` and `odata.maxpagesize` are read from it);
//  - the answer carries the FULL event, `body` and `bodyPreview` included, on every page (no `$select` is possible), so the mapper must drop them;
//  - start and end are `dateTimeTimeZone` in UTC (the preference), `dateTime` with seven fractional digits and no offset; an all-day event starts and ends at
//    midnight in its own zone (`originalStartTimeZone` is a WINDOWS zone name); calendarView returns occurrences, exceptions and single instances;
//  - a page ends with exactly one of `@odata.nextLink` / `@odata.deltaLink`; a deleted event is `{ id, "@removed": { reason: "deleted" } }`, and an event that
//    changed so that it no longer overlaps the window is reported the same way (the guide describes removals for events that fall out of the date range);
//  - an expired delta state answers 410 (or a 4xx with `syncStateNotFound` / `resyncRequired`).
// Every request is recorded (path, raw query, Prefer, the account) so a test can prove what was and was not sent.
import { HttpResponse, http, type RequestHandler } from "msw";
import { zonedMidnightMs } from "../../../comms/schemas";
import { FAKE_NOW, DAY_MS } from "./mail";
import { GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY, type FakeMicrosoft, type FakeMsAccount } from "./handlers";

export const CAL_BODY_CANARY = "synthetic-graph-event-body-canary-8e27-not-real";
export const CAL_PREVIEW_CANARY = "synthetic-graph-event-preview-canary-31ac-not-real";
export const CAL_SERIES_CANARY = "synthetic-graph-event-extra-canary-77d0-not-real";

export type FakeEvent = {
  id: string;
  iCalUId: string;
  subject: string;
  webLink: string;
  isAllDay: boolean;
  isCancelled: boolean;
  type: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId: string | null;
  /** Instants (UTC epoch ms). For an all-day event: local midnights of its own zone. */
  startMs: number;
  endMs: number;
  originalStart: string | null;
  originalStartTimeZone: string | null;
  lastModifiedDateTime: string;
  location: string;
  organizer: { address: string; name: string };
  attendees: { address: string; name: string; response: string }[];
  joinUrl: string | null;
  bodyContentType: string;
  bodyContent: string;
  /** The version counter value when it last changed (the delta cursor is a version). */
  changedAt: number;
  /** Fields merged over the serialized event after everything else (odd shapes: another time zone, a malformed start, a hostile field). */
  raw?: Record<string, unknown>;
};

export type CalFault = "auth_revoked" | "rate_limited" | "server_error" | "expired_cursor";
export type CalRequest = { method: string; path: string; search: string; prefer: string | null; address: string | null; kind: "delta" | "event" | "other" };

export type FakeCalendarOptions = {
  now?: () => number;
  /** Events per page when the request has no `odata.maxpagesize`. Default 10. */
  defaultPageSize?: number;
  /** Characters added to every token (long synthetic links). Default 0. */
  tokenPad?: number;
};

export interface FakeCalendar {
  handlers: RequestHandler[];
  requests: CalRequest[];
  /** Requests refused because the Prefer header lacked `IdType="ImmutableId"`. */
  refusedForImmutableId: number;
  /** Requests refused because the query had `$select`, `$filter`, `$orderby`, `$search` or `$expand`. */
  refusedForQuery: number;
  /** Mutable: how links are written. */
  settings: {
    defaultPageSize: number;
    tokenPad: number;
    /** Links repeat the window parameters (`startDateTime`, `endDateTime`) as the initial request sent them. */
    linkCarriesWindow: boolean;
    /** Rewrites every nextLink / deltaLink the fake emits (tampered-link tests). */
    rewriteLink: ((link: string) => string) | null;
  };
  events(account: FakeMsAccount): FakeEvent[];
  bySubject(account: FakeMsAccount, subject: string): FakeEvent;
  /** Adds an event (or replaces the one with that id, as a change). Returns its id. */
  add(account: FakeMsAccount, over?: Partial<Omit<FakeEvent, "changedAt">> & { startInDays?: number; hours?: number }): string;
  /** The event is deleted: the delta reports `@removed`. */
  remove(account: FakeMsAccount, id: string): string;
  /** The event is cancelled by its organizer: it stays, with `isCancelled: true`. */
  cancel(account: FakeMsAccount, id: string): string;
  /** An edit: the event changes (its version moves). */
  change(account: FakeMsAccount, id: string, patch: Partial<Omit<FakeEvent, "changedAt" | "id">>): void;
  setFault(account: FakeMsAccount, kind: CalFault, count?: number): void;
  /** The next `times` (default 1) link requests on this account answer this expired-state error (default 410, `syncStateNotFound`). */
  expireDeltaState(account: FakeMsAccount, how?: { status?: number; code?: string; times?: number }): void;
  deltaRequests(): CalRequest[];
  eventRequests(): CalRequest[];
  /** The raw query of every INITIAL delta request (no token), in order. */
  initialSearches(): string[];
}

const pageSizeOf = (prefer: string | null): number | null => {
  const m = /odata\.maxpagesize\s*=\s*(\d{1,5})/i.exec(prefer ?? "");
  return m ? Number(m[1]) : null;
};
const hasImmutable = (prefer: string | null): boolean => /(^|,)\s*IdType\s*=\s*"ImmutableId"\s*(,|$)/i.test(prefer ?? "");
const rawParams = (search: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (part === "") continue;
    const i = part.indexOf("=");
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
    const v = i < 0 ? "" : decodeURIComponent(part.slice(i + 1).replace(/\+/g, " "));
    out.set(k, v);
  }
  return out;
};
/** Graph's `dateTime`: seven fractional digits, no offset. */
const graphTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}.0000000`;

type Window = { s: string; e: string; sMs: number; eMs: number };

export function createFakeCalendar(fake: FakeMicrosoft, opts: FakeCalendarOptions = {}): FakeCalendar {
  const now = opts.now ?? (() => FAKE_NOW);
  const settings: FakeCalendar["settings"] = { defaultPageSize: opts.defaultPageSize ?? 10, tokenPad: opts.tokenPad ?? 0, linkCarriesWindow: false, rewriteLink: null };
  type Cal = { events: Map<string, FakeEvent>; removed: { id: string; at: number }[]; version: number };
  const cals = new Map<FakeMsAccount, Cal>();
  const faults = new Map<FakeMsAccount, { kind: CalFault; left: number }>();
  const expired = new Map<FakeMsAccount, { status: number; code: string; left: number }>();
  const requests: CalRequest[] = [];
  const windows: Window[] = [];
  let refusedForImmutableId = 0;
  let refusedForQuery = 0;
  let counter = 0;
  let accountCounter = 0;
  const accountNo = new Map<FakeMsAccount, number>();

  const calendar = (a: FakeMsAccount): Cal => {
    let c = cals.get(a);
    if (c) return c;
    c = { events: new Map(), removed: [], version: 0 };
    cals.set(a, c);
    accountNo.set(a, ++accountCounter);
    const n = accountNo.get(a);
    // Seed: every account gets the same shape (the contract needs equal-sized seeds): 3 single events, a recurring series (2 occurrences and 1 exception),
    // 2 all-day events (one spanning the 2026-11-01 DST change, in a Windows zone), 1 cancelled event.
    for (let k = 1; k <= 3; k++) add(a, { subject: `Synthetic single ${String(k)}`, startInDays: k });
    const master = `AAMkSyntheticSeries${String(n)}=`;
    add(a, { id: `AAMkSyntheticOccurrence${String(n)}-1=`, subject: "Synthetic weekly", type: "occurrence", seriesMasterId: master, startInDays: 1.25, originalStart: new Date(now() + 1.25 * DAY_MS).toISOString(), originalStartTimeZone: "Eastern Standard Time" });
    add(a, { id: `AAMkSyntheticOccurrence${String(n)}-2=`, subject: "Synthetic weekly", type: "occurrence", seriesMasterId: master, startInDays: 8.25, originalStart: new Date(now() + 8.25 * DAY_MS).toISOString(), originalStartTimeZone: "Eastern Standard Time" });
    add(a, { id: `AAMkSyntheticException${String(n)}-1=`, subject: "Synthetic weekly (moved)", type: "exception", seriesMasterId: master, startInDays: 15.5, originalStart: new Date(now() + 15.25 * DAY_MS).toISOString(), originalStartTimeZone: "Eastern Standard Time" });
    add(a, { subject: "Synthetic holiday", isAllDay: true, startMs: zonedMidnightMs("2026-10-31", "America/New_York"), endMs: zonedMidnightMs("2026-11-02", "America/New_York"), originalStartTimeZone: "Eastern Standard Time" });
    add(a, { subject: "Synthetic offsite", isAllDay: true, startMs: zonedMidnightMs("2026-11-10", "America/Los_Angeles"), endMs: zonedMidnightMs("2026-11-11", "America/Los_Angeles"), originalStartTimeZone: "Pacific Standard Time" });
    add(a, { subject: "Synthetic cancelled", isCancelled: true, startInDays: 4 });
    return c;
  };

  function add(a: FakeMsAccount, over: Partial<Omit<FakeEvent, "changedAt">> & { startInDays?: number; hours?: number } = {}): string {
    const c = cals.get(a) ?? calendar(a);
    const n = ++counter;
    const id = over.id ?? `AAMkSyntheticEvent${String(accountNo.get(a))}-${String(n)}=`;
    const startMs = over.startMs ?? now() + (over.startInDays ?? 5) * DAY_MS;
    const { startInDays: _s, hours: _h, ...rest } = over;
    void _s;
    void _h;
    c.version += 1;
    const at = new Date(now()).toISOString();
    c.events.set(id, {
      id,
      iCalUId: `synthetic-ical-${String(n)}`,
      subject: `Synthetic event ${String(n)}`,
      webLink: `https://outlook.office365.com/calendar/item/${encodeURIComponent(id)}`,
      isAllDay: false,
      isCancelled: false,
      type: "singleInstance",
      seriesMasterId: null,
      startMs,
      endMs: startMs + (over.hours ?? 1) * 3_600_000,
      originalStart: null,
      originalStartTimeZone: "Pacific Standard Time",
      lastModifiedDateTime: at,
      location: "Synthetic Room 1",
      organizer: { address: `organizer${String(n)}@sender.example.test`, name: "Synthetic Organizer" },
      attendees: [{ address: a.address, name: "Synthetic Executive", response: "accepted" }],
      joinUrl: `https://teams.microsoft.com/l/meetup-join/synthetic-${String(n)}`,
      bodyContentType: "html",
      bodyContent: `<html><body><p>${CAL_BODY_CANARY} ${id}</p></body></html>`,
      ...rest,
      changedAt: c.version,
    });
    c.removed = c.removed.filter((r) => r.id !== id); // a removed id that comes back is present again
    return id;
  }

  const token = (kind: "sk" | "dt", ...parts: (string | number)[]): string => `${kind}-${parts.join("-")}-${"Z".repeat(settings.tokenPad)}Zm9v%3D%3D`;
  const linkFor = (tokenName: "$skiptoken" | "$deltatoken", value: string, w: Window): string => {
    const window = settings.linkCarriesWindow ? `&startDateTime=${w.s}&endDateTime=${w.e}` : "";
    const link = `${GRAPH_V1}/me/calendarView/delta?${tokenName}=${value}${window}`;
    return settings.rewriteLink ? settings.rewriteLink(link) : link;
  };

  const accountOf = (authorization: string | null): FakeMsAccount | undefined => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    return [...fake.accounts.values()].find((x) => x.accessTokens.has(bearer));
  };
  // Graph error messages ECHO the bearer token here (and carry a canary text), so a leak into an error, a log or a record would show.
  let echoed = "";
  const gErr = (status: number, code: string, headers: Record<string, string> = {}) =>
    HttpResponse.json({ error: { code, message: `${echoed} ${MICROSOFT_ERROR_TEXT_CANARY}` } }, { status, headers: { "request-id": `synthetic-${String(++counter)}`, ...headers } });

  function admit(request: Request, kind: CalRequest["kind"]): { account: FakeMsAccount } | { response: Response } {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    const account = accountOf(authorization);
    const prefer = request.headers.get("prefer");
    echoed = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    requests.push({ method: request.method, path: url.pathname, search: url.search, prefer, address: account?.address ?? null, kind });
    if (!account) return { response: gErr(401, "InvalidAuthenticationToken") };
    const f = faults.get(account);
    if (f && f.left > 0 && f.kind !== "expired_cursor") {
      f.left -= 1;
      if (f.kind === "auth_revoked") {
        account.revoked = true; // the refresh that follows the 401 is refused: reconnect_required
        return { response: gErr(401, "InvalidAuthenticationToken") };
      }
      if (f.kind === "rate_limited") return { response: gErr(429, "TooManyRequests", { "retry-after": "120" }) };
      return { response: gErr(500, "InternalServerError") };
    }
    const t = account.throttle;
    if (t && t.remaining > 0) {
      t.remaining -= 1;
      return { response: gErr(t.status, "TooManyRequests", t.retryAfter === null ? {} : { "retry-after": String(t.retryAfter) }) };
    }
    if (!hasImmutable(prefer)) {
      refusedForImmutableId += 1;
      return { response: gErr(400, "ImmutableIdRequired") };
    }
    return { account };
  }

  const overlaps = (e: FakeEvent, w: Window): boolean => e.startMs < w.eMs && e.endMs > w.sMs;

  /** The whole event as Graph returns it from a calendarView delta: every property, body and preview included (no `$select` is possible). */
  const serialize = (e: FakeEvent): Record<string, unknown> => ({
    "@odata.etag": `W/"synthetic-${e.id}"`,
    id: e.id,
    iCalUId: e.iCalUId,
    subject: e.subject,
    bodyPreview: `${CAL_PREVIEW_CANARY} ${e.id}`,
    body: { contentType: e.bodyContentType, content: e.bodyContent },
    webLink: e.webLink,
    isAllDay: e.isAllDay,
    isCancelled: e.isCancelled,
    type: e.type,
    seriesMasterId: e.seriesMasterId,
    start: { dateTime: graphTime(e.startMs), timeZone: "UTC" },
    end: { dateTime: graphTime(e.endMs), timeZone: "UTC" },
    originalStart: e.originalStart,
    originalStartTimeZone: e.originalStartTimeZone,
    originalEndTimeZone: e.originalStartTimeZone,
    lastModifiedDateTime: e.lastModifiedDateTime,
    location: { displayName: e.location },
    organizer: { emailAddress: { address: e.organizer.address, name: e.organizer.name } },
    attendees: e.attendees.map((x) => ({ type: "required", status: { response: x.response }, emailAddress: { address: x.address, name: x.name } })),
    onlineMeeting: e.joinUrl === null ? null : { joinUrl: e.joinUrl },
    onlineMeetingUrl: `https://deprecated.example.test/${CAL_SERIES_CANARY}`,
    showAs: "busy",
    sensitivity: "normal",
    ...(e.raw ?? {}),
  });

  const handlers: RequestHandler[] = [
    http.get(`${GRAPH_V1}/me/calendarView/delta`, ({ request }) => {
      const a = admit(request, "delta");
      if ("response" in a) return a.response;
      const account = a.account;
      const url = new URL(request.url);
      const q = rawParams(url.search);
      if (["$select", "$filter", "$orderby", "$search", "$expand"].some((k) => q.has(k))) {
        refusedForQuery += 1;
        return gErr(400, "UnsupportedQuery"); // not supported on a calendarView delta (documented)
      }
      const skip = /[?&]\$skiptoken=([^&]*)/.exec(url.search)?.[1];
      const delta = /[?&]\$deltatoken=([^&]*)/.exec(url.search)?.[1];
      const isLink = skip !== undefined || delta !== undefined;
      const f = faults.get(account);
      const ex = expired.get(account);
      if (isLink && ex && ex.left > 0) {
        ex.left -= 1;
        return gErr(ex.status, ex.code);
      }
      if (isLink && f && f.left > 0 && f.kind === "expired_cursor") {
        f.left -= 1;
        return gErr(410, "syncStateNotFound");
      }
      const c = calendar(account);
      const size = pageSizeOf(request.headers.get("prefer")) ?? settings.defaultPageSize;
      let mode: "i" | "d" = "i";
      let base = 0;
      let offset = 0;
      let w: Window;
      if (skip !== undefined) {
        const m = /^sk-(i|d)-(\d+)-(\d+)-(\d+)-/.exec(skip);
        if (!m) return gErr(400, "InvalidSkipToken");
        mode = m[1] as "i" | "d";
        base = Number(m[2]);
        offset = Number(m[3]);
        w = windows[Number(m[4])] as Window;
      } else if (delta !== undefined) {
        const m = /^dt-(\d+)-(\d+)-/.exec(delta);
        if (!m) return gErr(400, "InvalidDeltaToken");
        mode = "d";
        base = Number(m[1]);
        w = windows[Number(m[2])] as Window;
      } else {
        const s = q.get("startDateTime");
        const e = q.get("endDateTime");
        if (s === undefined || e === undefined) return gErr(400, "ErrorInvalidParameter"); // the window is required on the initial request
        const sMs = Date.parse(s);
        const eMs = Date.parse(e);
        if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) return gErr(400, "ErrorInvalidParameter");
        // The raw text goes into the link exactly as the sync sent it.
        const raw = (name: string) => new RegExp(`[?&]${name}=([^&]*)`).exec(url.search)?.[1] ?? "";
        w = { s: raw("startDateTime"), e: raw("endDateTime"), sMs, eMs };
      }
      let wi = windows.findIndex((x) => x === w);
      if (wi < 0) {
        windows.push(w);
        wi = windows.length - 1;
      }
      type Item = { ev?: FakeEvent; removedId?: string };
      let items: Item[];
      if (mode === "i") items = [...c.events.values()].filter((e) => overlaps(e, w)).sort((x, y) => x.startMs - y.startMs || (x.id < y.id ? -1 : 1)).map((ev) => ({ ev }));
      else {
        const changed = [...c.events.values()].filter((e) => e.changedAt > base).sort((x, y) => x.changedAt - y.changedAt);
        // An event that changed and is no longer in the window is reported as removed (the guide: removals for events that fall out of the date range).
        items = [...changed.map((ev) => (overlaps(ev, w) ? { ev } : { removedId: ev.id })), ...c.removed.filter((r) => r.at > base).map((r) => ({ removedId: r.id }))];
      }
      const slice = items.slice(offset, offset + size);
      const value = slice.map((it) => (it.removedId !== undefined ? { "@odata.type": "#microsoft.graph.event", id: it.removedId, "@removed": { reason: "deleted" } } : serialize(it.ev as FakeEvent)));
      const more = offset + size < items.length;
      const page: Record<string, unknown> = { "@odata.context": `${GRAPH_V1}/$metadata#Collection(event)`, value };
      if (more) page["@odata.nextLink"] = linkFor("$skiptoken", token("sk", mode, base, offset + size, wi), w);
      else page["@odata.deltaLink"] = linkFor("$deltatoken", token("dt", c.version, wi), w);
      return HttpResponse.json(page, { headers: { "request-id": `synthetic-${String(++counter)}` } });
    }),

    // One event: the live body. `$select` is honoured (only what is selected comes back). Graph says it returns event bodies in HTML (the fake does, by default).
    http.get(`${GRAPH_V1}/me/events/:id`, ({ request, params }) => {
      const a = admit(request, "event");
      if ("response" in a) return a.response;
      const id = decodeURIComponent(String(params.id));
      const select = rawParams(new URL(request.url).search).get("$select") ?? "id";
      const e = calendar(a.account).events.get(id);
      if (!e) return gErr(404, "ErrorItemNotFound");
      const wanted = new Set(select.split(",").map((x) => x.trim()));
      const out: Record<string, unknown> = { id: e.id };
      if (wanted.has("body")) out.body = { contentType: e.bodyContentType, content: e.bodyContent };
      return HttpResponse.json(out, { headers: { "request-id": `synthetic-${String(++counter)}`, "preference-applied": 'outlook.body-content-type="text"' } });
    }),
  ];

  const api: FakeCalendar = {
    handlers,
    requests,
    get refusedForImmutableId() {
      return refusedForImmutableId;
    },
    get refusedForQuery() {
      return refusedForQuery;
    },
    settings,
    events: (a) => [...calendar(a).events.values()],
    bySubject(a, subject) {
      const e = [...calendar(a).events.values()].find((x) => x.subject === subject);
      if (!e) throw new Error("no such fake event");
      return e;
    },
    add: (a, over) => {
      calendar(a);
      return add(a, over);
    },
    remove(a, id) {
      const c = calendar(a);
      if (!c.events.delete(id)) throw new Error("no such fake event");
      c.version += 1;
      c.removed.push({ id, at: c.version });
      return id;
    },
    cancel(a, id) {
      api.change(a, id, { isCancelled: true });
      return id;
    },
    change(a, id, patch) {
      const c = calendar(a);
      const e = c.events.get(id);
      if (!e) throw new Error("no such fake event");
      c.version += 1;
      c.events.set(id, { ...e, ...patch, lastModifiedDateTime: patch.lastModifiedDateTime ?? new Date(now()).toISOString(), changedAt: c.version });
    },
    setFault(a, kind, count = 1) {
      faults.set(a, { kind, left: kind === "server_error" ? Math.max(count, 2) : count });
    },
    expireDeltaState(a, how = {}) {
      expired.set(a, { status: how.status ?? 410, code: how.code ?? "syncStateNotFound", left: how.times ?? 1 });
    },
    deltaRequests: () => requests.filter((r) => r.kind === "delta"),
    eventRequests: () => requests.filter((r) => r.kind === "event"),
    initialSearches: () => requests.filter((r) => r.kind === "delta" && !/[?&]\$(skip|delta)token=/.test(r.search)).map((r) => r.search),
  };
  return api;
}

/** Default handlers: none (a test builds its own fake). */
export const handlers: RequestHandler[] = [];
