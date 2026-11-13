import { describe, expect, it } from "vitest";
import { attendeeNames, nameFromEmail, parseEvents, summarizeAhead } from "./calendar";

const owners = new Set(["me@pubk.test"]);
const row = (over: Record<string, unknown>) => ({
  connection_id: "c1",
  calendar_id: "primary",
  event_id: String(over.title),
  title: "Meeting",
  start_at: "2026-11-12T14:00:00Z",
  end_at: "2026-11-12T15:00:00Z",
  all_day: false,
  attendees: [],
  ...over,
});
const first = (attendees: unknown[]) => {
  const e = parseEvents([row({ attendees })])[0];
  if (!e) throw new Error("no event");
  return e;
};

describe("nameFromEmail", () => {
  it("capitalises the local part", () => {
    expect(nameFromEmail("dana.whitfield@x.test")).toBe("Dana Whitfield");
    expect(nameFromEmail("sam_o-neil+tag@x.test")).toBe("Sam O Neil");
  });
  it("shows role mailboxes unchanged", () => {
    for (const r of ["info", "noreply", "no-reply", "sales", "support", "admin"]) expect(nameFromEmail(`${r}@x.test`)).toBe(r);
  });
  it("falls back to Guest", () => {
    expect(nameFromEmail("@x.test")).toBe("Guest");
  });
});

describe("attendeeNames", () => {
  it("uses names, never addresses; skips owners and resources; counts the rest", () => {
    const e = first([
      { email: "me@pubk.test" },
      { email: "a@x.test", name: "Anna Lee" },
      { email: "b@x.test", name: "b@x.test" },
      { email: "room1@resource.calendar.google.com", name: "Room 1" },
      { email: "c@x.test" },
      { email: "d@x.test", name: "Dee" },
      { email: "e@x.test", name: "Eve" },
    ]);
    expect(attendeeNames(e, owners, 3)).toEqual({ names: ["Anna Lee", "b@x.test", "c@x.test"], more: 2 });
  });
  it("only google calendar domains are resources", () => {
    const e = first([{ email: "x@notcalendar.google.com.evil.test", name: "X" }, { email: "y@evilcalendar.google.com", name: "Y" }]);
    expect(attendeeNames(e, owners).names).toEqual(["X", "Y"]);
  });
  it("T-237: the same person is listed once (name compared case and whitespace insensitively, also the organizer's entry), and 'more' counts people", () => {
    const e = parseEvents([row({ organizer_email: "dana@x.test", attendees: [
      { email: "me@pubk.test" },
      { email: "dana@x.test", name: "Dana  Whitfield" },
      { email: "dana.whitfield@x.test", name: "dana whitfield" },
      { email: "d2@x.test", name: "DANA WHITFIELD " },
      { email: "ann@x.test", name: "Ann Lee" },
      { email: "ann@x.test", name: "Ann Lee" },
      { email: "ben@x.test", name: "Ben Ray" },
      { email: "cy@x.test", name: "Cy Wu" },
    ] })])[0];
    if (!e) throw new Error("no event");
    expect(attendeeNames(e, owners, 3)).toEqual({ names: ["Dana Whitfield", "Ann Lee", "Ben Ray"], more: 1 });
  });
  it("two people with the same first name at different domains stay two", () => {
    const e = first([{ email: "sam@a.test", name: "Sam" }, { email: "sam@b.test", name: "Sam" }]);
    expect(attendeeNames(e, owners)).toEqual({ names: ["Sam", "Sam"], more: 0 });
  });
  it("the same address twice (different case) is one person; local-part names dedupe by full address only", () => {
    expect(attendeeNames(first([{ email: "Ann@X.test", name: "Ann Lee" }, { email: "ann@x.test", name: "Ann Lee" }]), owners).names).toEqual(["Ann Lee"]);
    expect(attendeeNames(first([{ email: "sam@a.test" }, { email: "sam@b.test" }, { email: "SAM@a.test" }]), owners).names).toEqual(["sam@a.test", "sam@b.test"]);
  });
  it("a look-alike external named like an internal colleague stays separate and is counted in 'more'", () => {
    const e = first([
      { email: "me@pubk.test" },
      { email: "dana@pubk.test", name: "Dana Whitfield" },
      { email: "dana@lookalike.test", name: "Dana Whitfield" },
      { email: "b@x.test", name: "Ben" },
      { email: "c@x.test", name: "Cy" },
    ]);
    expect(attendeeNames(e, owners, 3)).toEqual({ names: ["Dana Whitfield", "Dana Whitfield", "Ben"], more: 1 });
  });
  it("T-240: never makes a name from the address's local part: no display name shows the full address", () => {
    expect(attendeeNames(first([{ email: "rnichols@pubk-example.test" }, { email: "wcobb@pubk-example.test" }, { email: "dana.whitfield@x.test" }]), owners).names).toEqual(["rnichols@pubk-example.test", "wcobb@pubk-example.test", "dana.whitfield@x.test"]);
    expect(attendeeNames(first([{ email: "support@x.test" }]), owners).names).toEqual(["support@x.test"]);
  });
  it("T-240: a name held for that exact address (the mail index) is used when the event has none; the event's own name wins", () => {
    const known = new Map([["rob.n@x.test", "Rob N"], ["ann@x.test", "Annie From Mail"]]);
    const e = first([{ email: "Rob.N@x.test" }, { email: "ann@x.test", name: "Ann Lee" }, { email: "other@x.test" }, { email: "x@x.test", name: "a@b.test" }]);
    expect(attendeeNames(e, owners, 5, known).names).toEqual(["Rob N", "Ann Lee", "other@x.test", "x@x.test"]);
    // a known name for a DIFFERENT address is never applied
    expect(attendeeNames(first([{ email: "rob@x.test" }]), owners, 3, known).names).toEqual(["rob@x.test"]);
  });
  it("T-240: a known name that is itself an address is ignored; known names dedupe by name and domain like event names", () => {
    expect(attendeeNames(first([{ email: "a@x.test" }]), owners, 3, new Map([["a@x.test", "a@x.test"]])).names).toEqual(["a@x.test"]);
    const known = new Map([["d1@x.test", "Dana W"], ["d2@x.test", "dana  w"]]);
    expect(attendeeNames(first([{ email: "d1@x.test" }, { email: "d2@x.test" }]), owners, 3, known).names).toEqual(["Dana W"]);
  });
});

describe("summarizeAhead", () => {
  it("counts a duplicate invitation (one per connected calendar) once", () => {
    const a = row({ title: "Sync", event_id: "1", calendar_id: "c1" });
    const b = row({ title: "Sync", event_id: "2", calendar_id: "c2" });
    expect(summarizeAhead(parseEvents([a, b]), owners)).toEqual({ meetings: 1, clashes: 0 });
  });
  it("counts same-title same-time events with different meeting links as two (a clash)", () => {
    const a = row({ title: "Sync", event_id: "1", calendar_id: "c1", online_meeting_url: "https://meet.example.test/one" });
    const b = row({ title: "Sync", event_id: "2", calendar_id: "c2", online_meeting_url: "https://meet.example.test/two" });
    expect(summarizeAhead(parseEvents([a, b]), owners)).toEqual({ meetings: 2, clashes: 1 });
  });
  it("still counts real clashes", () => {
    const a = row({ title: "A" });
    const b = row({ title: "B", start_at: "2026-11-12T14:30:00Z", end_at: "2026-11-12T15:30:00Z" });
    expect(summarizeAhead(parseEvents([a, b]), owners)).toEqual({ meetings: 2, clashes: 1 });
  });
});
