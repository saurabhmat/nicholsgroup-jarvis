// The cursor and the link rules of the Microsoft calendar sync (T-067, D-59): the encoding, the 16 KB bound, binding to the connection, the window, the
// half-horizon rule and the link validation (exact origin and path, one token, optionally our own window parameters byte for byte).
import { describe, expect, it } from "vitest";
import { CommsCursorSchema } from "../comms/schemas";
import { CAL_LINK_HEAD, cursorPrefix, DEFAULT_CALENDAR_ID, encodeCalCursor, initialQuery, MAX_CURSOR_CHARS, MAX_LINK_CHARS, newWindow, parseCalCursor, reloadDue, validateCalendarLink, windowParams, type CalState, type CalWindow } from "./cal-cursor";
import { ProviderIdParamSchema } from "../comms/schemas";

const CONN = "00000000-0000-4000-8000-000000006701";
const OTHER_CONN = "00000000-0000-4000-8000-000000006702";
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const W: CalWindow = newWindow(NOW, 90, 365);
const [START, END] = windowParams(W);
const link = (query: string) => `${CAL_LINK_HEAD}?${query}`;
const delta = (token = "abc%3D%3D") => link(`$deltatoken=${token}`);
const state = (over: Partial<CalState> = {}): CalState => ({ v: 1, w: W, k: "d", l: delta(), ...over });
/** A link of exactly `length` characters. */
const linkOfLength = (length: number) => {
  const prefix = `${CAL_LINK_HEAD}?$deltatoken=`;
  return prefix + "A".repeat(length - prefix.length);
};

describe("the fixed calendar id", () => {
  it("is not a Graph id (it has the colon no Graph id has), is stable, and passes the id-parameter rule readBody uses", () => {
    expect(DEFAULT_CALENDAR_ID).toBe("microsoft:default");
    expect(DEFAULT_CALENDAR_ID).toContain(":");
    expect(ProviderIdParamSchema.safeParse(DEFAULT_CALENDAR_ID).success).toBe(true);
  });
});

describe("the window", () => {
  it("is UTC midnights: retention (at most 180 days) back, forward_days ahead, in ISO 8601", () => {
    expect(W).toEqual({ s: "2026-08-07T00:00:00.000Z", e: "2027-11-05T00:00:00.000Z" });
    expect(newWindow(NOW, 400, 30).s).toBe("2026-05-09T00:00:00.000Z"); // 180 days back at most
    expect(newWindow(NOW, 0, 30).s).toBe("2026-11-04T00:00:00.000Z"); // at least one day
  });
  it("the initial query is the two window parameters and nothing else", () => {
    expect(initialQuery(W)).toBe("startDateTime=2026-08-07T00:00:00.000Z&endDateTime=2027-11-05T00:00:00.000Z");
    expect(initialQuery(W)).not.toMatch(/\$/);
  });
  it("half-horizon: a reload is due when fewer than half of forward_days remain (as T-064)", () => {
    const w = newWindow(NOW, 90, 365);
    expect(reloadDue(w, NOW, 365)).toBe(false);
    expect(reloadDue(w, NOW + 182 * 86_400_000, 365)).toBe(false); // 183 days left: not below 182
    expect(reloadDue(w, NOW + 184 * 86_400_000, 365)).toBe(true); // 181 days left
    expect(reloadDue(w, NOW + 400 * 86_400_000, 365)).toBe(true);
  });
});

describe("encoding and parsing", () => {
  it("round-trips a state under the prefix m1.<connection id>.c:", () => {
    const s = state();
    const c = encodeCalCursor(CONN, s);
    expect(c?.value.startsWith(cursorPrefix(CONN))).toBe(true);
    expect(c?.value.startsWith(`m1.${CONN}.c:`)).toBe(true);
    expect(parseCalCursor(c?.value ?? "", CONN)).toEqual(s);
    const next = state({ k: "n", l: link("$skiptoken=sk-1") });
    expect(parseCalCursor(encodeCalCursor(CONN, next)?.value ?? "", CONN)).toEqual(next);
  });

  it("holds one link and its window, no credential-looking text", () => {
    const c = encodeCalCursor(CONN, state());
    const json = Buffer.from((c?.value ?? "").slice(cursorPrefix(CONN).length), "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual(["k", "l", "v", "w"]);
    expect(json).not.toMatch(/bearer|access_token|refresh_token|authorization/i);
  });

  it("the largest allowed state (a link of MAX_LINK_CHARS) stays under 16 KB and still parses", () => {
    const s = state({ l: linkOfLength(MAX_LINK_CHARS) });
    const c = encodeCalCursor(CONN, s);
    expect(c).not.toBeNull();
    expect((c?.value ?? "").length).toBeLessThan(MAX_CURSOR_CHARS);
    expect(CommsCursorSchema.safeParse(c).success).toBe(true);
    expect(parseCalCursor(c?.value ?? "", CONN)).toEqual(s);
    // 4,096 characters of query is the Graph client's own bound: the link bound is derived from it
    expect(MAX_LINK_CHARS).toBe(CAL_LINK_HEAD.length + 1 + 4096);
  });

  it("a link one character over the bound does not validate; a state too big for the cursor is refused (null), never cut", () => {
    expect(validateCalendarLink(linkOfLength(MAX_LINK_CHARS + 1), W)).toBeNull();
    expect(parseCalCursor(encodeCalCursor(CONN, state({ l: linkOfLength(MAX_LINK_CHARS + 1) }))?.value ?? "", CONN)).toBeNull();
    expect(encodeCalCursor(CONN, state({ l: "A".repeat(13_000) }))).toBeNull(); // encodes past 16,384
  });

  it("an oversized stored value fails safe: null, without parsing it", () => {
    expect(parseCalCursor(`${cursorPrefix(CONN)}${"A".repeat(MAX_CURSOR_CHARS)}`, CONN)).toBeNull();
  });
});

describe("a cursor is bound to its connection and its stream", () => {
  const good = encodeCalCursor(CONN, state())?.value ?? "";
  it("another connection's cursor, a mail cursor (m1.<id>.m:), a Google cursor (g1.<id>.c:), and values without a prefix are null", () => {
    expect(parseCalCursor(good, OTHER_CONN)).toBeNull();
    expect(parseCalCursor(good.replace(`m1.${CONN}.c:`, `m1.${CONN}.m:`), CONN)).toBeNull();
    expect(parseCalCursor(good.replace(`m1.${CONN}.c:`, `g1.${CONN}.c:`), CONN)).toBeNull();
    expect(parseCalCursor(good.replace("m1.", "x1."), CONN)).toBeNull();
    for (const v of ["", "stale-token", `m1.${CONN}.c:`, `m1.${CONN}.c:!!!`, `m1.${CONN}.c:${Buffer.from("not json").toString("base64url")}`, `m1.${CONN}.c:${Buffer.from("[]").toString("base64url")}`]) {
      expect(parseCalCursor(v, CONN), v).toBeNull();
    }
  });

  it("a state with extra keys, a wrong version, a bad kind, an invalid window or a window the link does not belong to is null", () => {
    const enc = (o: unknown) => `${cursorPrefix(CONN)}${Buffer.from(JSON.stringify(o), "utf8").toString("base64url")}`;
    expect(parseCalCursor(enc({ ...state(), extra: 1 }), CONN)).toBeNull();
    expect(parseCalCursor(enc({ ...state(), v: 2 }), CONN)).toBeNull();
    expect(parseCalCursor(enc({ ...state(), k: "x" }), CONN)).toBeNull();
    expect(parseCalCursor(enc({ ...state(), w: { s: "2026-08-07", e: W.e } }), CONN)).toBeNull();
    expect(parseCalCursor(enc({ ...state(), w: { s: W.e, e: W.s } }), CONN)).toBeNull(); // end before start
    // a link carrying the window parameters of ANOTHER window
    const other = newWindow(NOW + 86_400_000, 90, 365);
    expect(parseCalCursor(enc({ ...state(), l: link(`$deltatoken=x&${windowParams(other)[0]}`) }), CONN)).toBeNull();
    expect(parseCalCursor(enc({ ...state(), l: link(`$deltatoken=x&${START}`) }), CONN)).not.toBeNull();
  });
});

describe("link validation: exact origin and path, one token, our own window parameters only", () => {
  it("accepts a deltaLink and a nextLink, with or without our two window parameters byte for byte", () => {
    for (const q of ["$deltatoken=abc", "$skiptoken=abc", `$deltatoken=abc&${START}&${END}`, `${START}&$skiptoken=abc`, `$deltatoken=abc&${END}`, "$deltatoken=a%3D%3D-_.~"]) {
      expect(validateCalendarLink(link(q), W), q).toEqual({ query: q });
    }
  });

  it("another host, scheme, port, user info or a look-alike host is refused", () => {
    const tail = "calendarView/delta?$deltatoken=x";
    for (const l of [
      `https://evil.example.test/v1.0/me/${tail}`,
      `http://graph.microsoft.com/v1.0/me/${tail}`,
      `https://graph.microsoft.com:8443/v1.0/me/${tail}`,
      `https://user@graph.microsoft.com/v1.0/me/${tail}`,
      `https://graph.microsoft.com.evil.example.test/v1.0/me/${tail}`,
      `https://graph.microsoft.us/v1.0/me/${tail}`,
      `//graph.microsoft.com/v1.0/me/${tail}`,
      `/v1.0/me/${tail}`,
    ]) {
      expect(validateCalendarLink(l, W), l).toBeNull();
    }
  });

  it("another path is refused: a calendar, a user, a mail folder, another version, other case, a trailing slash, an encoded or dotted path", () => {
    const base = "https://graph.microsoft.com";
    for (const p of [
      "/v1.0/me/calendars/AAMkX=/calendarView/delta",
      "/v1.0/users/someone@example.test/calendarView/delta",
      "/v1.0/users('00000000-0000-4000-8000-000000000001')/calendarView/delta",
      "/v1.0/me/mailFolders/AAMkInbox=/messages/delta",
      "/v1.0/me/messages/delta",
      "/v1.0/me/calendar/calendarView/delta",
      "/v1.0/me/events/delta",
      "/beta/me/calendarView/delta",
      "/v1.0/me/calendarview/delta",
      "/v1.0/me/calendarView/delta/",
      "/v1.0/me/calendarView/delta/../delta",
      "/v1.0/me/calendarView/%64elta",
      "/v1.0//me/calendarView/delta",
      "/me/calendarView/delta",
    ]) {
      expect(validateCalendarLink(`${base}${p}?$deltatoken=x`, W), p).toBeNull();
    }
  });

  it("extra or odd query parameters are refused: $select, $filter, $expand, $search, $orderby, $top, a window with another value, two tokens, none, empty parts, repeats", () => {
    const bad = [
      "$deltatoken=x&$select=body",
      "$deltatoken=x&$filter=isCancelled eq true".replace(/ /g, "%20"),
      "$deltatoken=x&$expand=attachments",
      "$deltatoken=x&$search=%22a%22",
      "$deltatoken=x&$orderby=start/dateTime",
      "$deltatoken=x&$top=5",
      "$deltatoken=x&startDateTime=2020-01-01T00:00:00.000Z",
      `$deltatoken=x&${START.replace("2026", "2025")}`,
      `$deltatoken=x&${END}&${END}`,
      `$deltatoken=x&${START}&${START}`,
      "$deltatoken=x&$deltatoken=y",
      "$deltatoken=x&$skiptoken=y",
      "startDateTime=2026-08-07T00:00:00.000Z",
      `${START}&${END}`,
      "$deltatoken=",
      "$deltatoken=x&",
      "&$deltatoken=x",
      "$deltatoken=x&&startDateTime=",
      "$DELTATOKEN=x",
      "deltatoken=x",
      "$deltatoken=x&Prefer=1",
      `startDateTime=${W.s.replace(/:/g, "%3A")}&$deltatoken=x`, // our window parameter, re-encoded: not byte for byte
    ];
    for (const q of bad) expect(validateCalendarLink(link(q), W), q).toBeNull();
    expect(validateCalendarLink(`${CAL_LINK_HEAD}`, W)).toBeNull(); // no query at all
    expect(validateCalendarLink(`${CAL_LINK_HEAD}?`, W)).toBeNull();
  });

  it("a fragment, whitespace, control or non-ASCII characters, a backslash, and non-strings are refused", () => {
    for (const l of [`${delta()}#frag`, `${delta()} `, `${delta()}\n`, `${delta()}é`, `${delta()}\\x`, ` ${delta()}`, "", undefined, null, 5, {}]) {
      expect(validateCalendarLink(l, W)).toBeNull();
    }
  });
});

describe("review fixes (T-067): the window in a stored cursor is bounded and canonical", () => {
  const enc = (w: { s: string; e: string }) => `${cursorPrefix(CONN)}${Buffer.from(JSON.stringify({ ...state(), w, l: delta() }), "utf8").toString("base64url")}`;
  it("years 0001 to 9999, a window longer than 911 days, an end far past now, and a non-canonical string are malformed", () => {
    expect(parseCalCursor(enc({ s: "0001-01-01T00:00:00.000Z", e: "9999-12-31T00:00:00.000Z" }), CONN, NOW)).toBeNull();
    expect(parseCalCursor(enc({ s: "2020-01-01T00:00:00.000Z", e: "2026-11-30T00:00:00.000Z" }), CONN, NOW)).toBeNull(); // too long
    expect(parseCalCursor(enc({ s: "2029-01-01T00:00:00.000Z", e: "2029-02-01T00:00:00.000Z" }), CONN, NOW)).toBeNull(); // end beyond two years ahead
    expect(parseCalCursor(enc({ s: "2026-02-30T00:00:00.000Z", e: "2026-11-30T00:00:00.000Z" }), CONN, NOW)).toBeNull(); // rolls over: not canonical
  });
  it("a window we create is accepted, including the longest", () => {
    expect(parseCalCursor(enc(newWindow(NOW, 180, 730)), CONN, NOW)).not.toBeNull();
    expect(parseCalCursor(enc(W), CONN, NOW)).not.toBeNull();
  });
});
