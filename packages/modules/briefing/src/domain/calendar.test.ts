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
    expect(attendeeNames(e, owners, 3)).toEqual({ names: ["Anna Lee", "B", "C"], more: 2 });
  });
  it("only google calendar domains are resources", () => {
    const e = first([{ email: "x@notcalendar.google.com.evil.test", name: "X" }, { email: "y@evilcalendar.google.com", name: "Y" }]);
    expect(attendeeNames(e, owners).names).toEqual(["X", "Y"]);
  });
  it("T-237: the same person is listed once (name compared case and whitespace insensitively, also the organizer's entry), and 'more' counts people", () => {
    const e = parseEvents([row({ organizer_email: "dana@x.test", attendees: [
      { email: "me@pubk.test" },
      { email: "dana@x.test", name: "Dana  Whitfield" },
      { email: "dana.whitfield@alt.test", name: "dana whitfield" },
      { email: "d2@x.test", name: "DANA WHITFIELD " },
      { email: "ann@x.test", name: "Ann Lee" },
      { email: "ann@x.test", name: "Ann Lee" },
      { email: "ben@x.test", name: "Ben Ray" },
      { email: "cy@x.test", name: "Cy Wu" },
    ] })])[0];
    if (!e) throw new Error("no event");
    expect(attendeeNames(e, owners, 3)).toEqual({ names: ["Dana Whitfield", "Ann Lee", "Ben Ray"], more: 1 });
  });
  it("shows a role mailbox as its local part", () => {
    expect(attendeeNames(first([{ email: "support@x.test" }]), owners).names).toEqual(["support"]);
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
