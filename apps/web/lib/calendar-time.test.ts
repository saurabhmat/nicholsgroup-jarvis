// T-274: the Calendar page's date rules: URL parsing, windows, day splitting, overlap layout, and the two daylight-saving days of 2026 (Mar 8: 23 hours, Nov 1: 25 hours).
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayStart,
  clampDate,
  defaultViewFor,
  eventsOnDay,
  hoursInDay,
  hourRange,
  isYmd,
  layoutOverlaps,
  onDay,
  parseCalendarQuery,
  periodFor,
  segmentOn,
  step,
  stepTarget,
  ymdOf,
  type Span,
} from "./calendar-time";

const TODAY = "2026-11-23";
const timed = (startAt: string, endAt: string, title = "t"): Span & { title: string } => ({ allDay: false, startAt, endAt, startDate: null, endDate: null, title });
const allDay = (startDate: string, endDate: string, title = "a"): Span & { title: string } => ({
  allDay: true,
  startAt: `${startDate}T05:00:00.000Z`,
  endAt: `${endDate}T05:00:00.000Z`,
  startDate,
  endDate,
  title,
});

describe("civil dates", () => {
  it("accept real dates only", () => {
    expect(isYmd("2026-02-28")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "", null, undefined, 20260101, "2026-01-01T00:00", "2026-01-01 "]) expect(isYmd(bad)).toBe(false);
  });
  it("move by days and months across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-31", -1)).toBe("2025-12-01");
  });
});

describe("the URL", () => {
  it("reads view and date", () => {
    expect(parseCalendarQuery({ view: "month", date: "2026-12-05" }, TODAY)).toEqual({ view: "month", date: "2026-12-05", explicitView: true });
  });
  it("falls back to today and the default view for anything else", () => {
    expect(parseCalendarQuery({}, TODAY)).toEqual({ view: "week", date: TODAY, explicitView: false });
    expect(parseCalendarQuery({ view: "year", date: "tomorrow" }, TODAY, "day")).toEqual({ view: "day", date: TODAY, explicitView: false });
    expect(parseCalendarQuery({ view: ["day", "week"], date: ["2026-12-01"] }, TODAY)).toEqual({ view: "week", date: TODAY, explicitView: false });
    expect(parseCalendarQuery({ date: "2026-02-30" }, TODAY).date).toBe(TODAY);
    expect(parseCalendarQuery({ view: "DAY" }, TODAY).view).toBe("week");
  });
  it("clamps a date more than two years from today", () => {
    expect(parseCalendarQuery({ date: "2040-01-01" }, TODAY).date).toBe(addDays(TODAY, 731));
    expect(parseCalendarQuery({ date: "1999-01-01" }, TODAY).date).toBe(addDays(TODAY, -731));
    expect(parseCalendarQuery({ date: "2028-11-01" }, TODAY).date).toBe("2028-11-01");
  });
  it("defaults to Day on a phone and Week elsewhere", () => {
    expect(defaultViewFor("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe("day");
    expect(defaultViewFor("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")).toBe("day");
    expect(defaultViewFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("week");
    expect(defaultViewFor("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("week");
    expect(defaultViewFor(null)).toBe("week");
    expect(defaultViewFor("Mozilla/5.0 (Linux; Android 14) Mobile")).toBe("day");
    expect(defaultViewFor("Mozilla/5.0 (Linux; Android 14; Tablet)")).toBe("week");
  });
  it("reads only the first 512 characters of a very long User-Agent, quickly", () => {
    const long = `Mozilla/5.0 (X11; Linux x86_64) ${"Android ".repeat(2000)}`; // 16 KB, no "Mobile"
    const t = Date.now();
    expect(defaultViewFor(long)).toBe("week");
    expect(defaultViewFor(`${"a".repeat(600)} iPhone`)).toBe("week"); // past the limit
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("New York days", () => {
  it("are 23 hours on Mar 8 2026, 25 on Nov 1 2026 and 24 otherwise", () => {
    expect(hoursInDay("2026-03-08")).toBe(23);
    expect(hoursInDay("2026-11-01")).toBe(25);
    expect(hoursInDay("2026-03-07")).toBe(24);
    expect(hoursInDay("2026-11-02")).toBe(24);
  });
  it("start at midnight Eastern", () => {
    expect(new Date(dayStart("2026-03-08")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(dayStart("2026-03-09")).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(new Date(dayStart("2026-11-01")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(dayStart("2026-11-02")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
  it("name the date of an instant in New York, not UTC", () => {
    expect(ymdOf(Date.parse("2026-11-24T03:30:00Z"))).toBe("2026-11-23");
    expect(ymdOf(Date.parse("2026-11-24T05:00:00Z"))).toBe("2026-11-24");
  });
});

describe("windows", () => {
  it("Day is one day, Week runs Sunday to Saturday", () => {
    const d = periodFor("day", "2026-11-23");
    expect(d.days).toEqual(["2026-11-23"]);
    expect(d.to.getTime() - d.from.getTime()).toBe(24 * 3_600_000);
    const w = periodFor("week", "2026-11-23"); // a Monday
    expect(w.days[0]).toBe("2026-11-22");
    expect(w.days[6]).toBe("2026-11-28");
    expect(periodFor("week", "2026-11-22").days[0]).toBe("2026-11-22"); // a Sunday starts its own week
    expect(periodFor("week", "2026-11-28").days[0]).toBe("2026-11-22"); // a Saturday ends it
  });
  it("Month is the weeks that cover the month, 4 to 6 of them, and the window is at most 43 days", () => {
    const nov = periodFor("month", "2026-11-23");
    expect(nov.days[0]).toBe("2026-11-01");
    expect(nov.days).toHaveLength(35);
    expect(nov.days[34]).toBe("2026-12-05");
    const feb = periodFor("month", "2026-02-10"); // Feb 2026 starts on a Sunday and has 28 days: exactly four weeks
    expect(feb.days).toHaveLength(28);
    const aug = periodFor("month", "2026-08-10"); // Aug 1 2026 is a Saturday, Aug 31 a Monday: six weeks
    expect(aug.days).toHaveLength(42);
    for (let m = 1; m <= 12; m += 1) {
      const p = periodFor("month", `2026-${String(m).padStart(2, "0")}-15`);
      expect(p.days.length % 7).toBe(0);
      expect(p.days.length).toBeLessThanOrEqual(42);
      expect(p.to.getTime() - p.from.getTime()).toBeLessThan(43 * 86_400_000);
      expect(p.to.getTime()).toBeGreaterThan(p.from.getTime());
    }
  });
  it("the windows across the two daylight-saving days end at New York midnight", () => {
    const mar = periodFor("week", "2026-03-08");
    expect(mar.from.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(mar.to.toISOString()).toBe("2026-03-15T04:00:00.000Z");
    const nov = periodFor("month", "2026-11-15"); // the month holding the fall-back day: 35 days, one of them 25 hours
    expect(nov.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(nov.to.toISOString()).toBe("2026-12-06T05:00:00.000Z");
    const marMonth = periodFor("month", "2026-03-15");
    expect(marMonth.from.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(marMonth.to.getTime() - marMonth.from.getTime()).toBe((marMonth.days.length * 24 - 1) * 3_600_000);
  });
  it("step moves a day, a week or a month", () => {
    expect(step("day", "2026-11-30", 1)).toBe("2026-12-01");
    expect(step("week", "2026-11-23", -1)).toBe("2026-11-16");
    expect(step("month", "2026-11-23", 1)).toBe("2026-12-01");
    expect(step("month", "2026-01-10", -1)).toBe("2025-12-01");
  });
});

describe("events on days", () => {
  it("a timed event that crosses midnight is on both days, each with its part", () => {
    const e = timed("2026-11-24T02:00:00Z", "2026-11-24T06:00:00Z"); // 9 PM to 1 AM Eastern
    expect(onDay(e, "2026-11-23")).toBe(true);
    expect(onDay(e, "2026-11-24")).toBe(true);
    expect(onDay(e, "2026-11-25")).toBe(false);
    expect(segmentOn(e, "2026-11-23")).toMatchObject({ top: 21 * 60, bottom: 1440 });
    expect(segmentOn(e, "2026-11-24")).toMatchObject({ top: 0, bottom: 60 });
  });
  it("an event that ends exactly at midnight is not on the next day", () => {
    const e = timed("2026-11-24T03:00:00Z", "2026-11-24T05:00:00Z"); // 10 PM to midnight
    expect(onDay(e, "2026-11-23")).toBe(true);
    expect(onDay(e, "2026-11-24")).toBe(false);
  });
  it("an all-day event is on [start, end): the end date is exclusive", () => {
    const e = allDay("2026-11-23", "2026-11-25");
    expect([onDay(e, "2026-11-22"), onDay(e, "2026-11-23"), onDay(e, "2026-11-24"), onDay(e, "2026-11-25")]).toEqual([false, true, true, false]);
  });
  it("lists all-day events by title, timed events by start", () => {
    const x = eventsOnDay([timed("2026-11-23T20:00:00Z", "2026-11-23T21:00:00Z", "Late"), timed("2026-11-23T15:00:00Z", "2026-11-23T16:00:00Z", "Early"), allDay("2026-11-23", "2026-11-24", "B"), allDay("2026-11-23", "2026-11-24", "A")], "2026-11-23");
    expect(x.allDay.map((e) => e.title)).toEqual(["A", "B"]);
    expect(x.timed.map((s) => s.event.title)).toEqual(["Early", "Late"]);
  });
  it("gives a very short event a visible height and keeps it inside the day", () => {
    expect(segmentOn(timed("2026-11-23T15:00:00Z", "2026-11-23T15:00:00Z"), "2026-11-23")).toMatchObject({ top: 600, bottom: 620 });
    expect(onDay(timed("2026-11-23T15:00:00Z", "2026-11-23T15:00:00Z"), "2026-11-23")).toBe(true);
    const late = segmentOn(timed("2026-11-24T04:55:00Z", "2026-11-24T04:59:00Z"), "2026-11-23"); // 11:55 PM
    expect(late.bottom).toBe(1440);
    expect(late.top).toBe(1420);
  });
  it("splits correctly on the spring-forward day (23 hours)", () => {
    // 1:30 AM EST to 3:30 AM EDT is one real hour; midnight to midnight is 23 hours.
    const e = timed("2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z");
    expect(segmentOn(e, "2026-03-08")).toMatchObject({ top: 90, bottom: 210 });
    const fromEve = timed("2026-03-08T03:00:00Z", "2026-03-08T05:30:00Z"); // 10 PM Mar 7 to 12:30 AM Mar 8
    expect(onDay(fromEve, "2026-03-07")).toBe(true);
    expect(onDay(fromEve, "2026-03-08")).toBe(true);
    expect(segmentOn(fromEve, "2026-03-08")).toMatchObject({ top: 0, bottom: 30 });
    const ends = timed("2026-03-08T20:00:00Z", "2026-03-09T04:00:00Z"); // 4 PM EDT to midnight: the end of the 23-hour day
    expect(onDay(ends, "2026-03-08")).toBe(true);
    expect(onDay(ends, "2026-03-09")).toBe(false);
    expect(segmentOn(ends, "2026-03-08").bottom).toBe(1440);
    expect(onDay(allDay("2026-03-08", "2026-03-09"), "2026-03-08")).toBe(true);
    expect(onDay(allDay("2026-03-08", "2026-03-09"), "2026-03-09")).toBe(false);
  });
  it("splits correctly on the fall-back day (25 hours)", () => {
    const e = timed("2026-11-01T04:30:00Z", "2026-11-01T09:00:00Z"); // 12:30 AM EDT to 4 AM EST
    expect(segmentOn(e, "2026-11-01")).toMatchObject({ top: 30, bottom: 240 });
    const wrap = timed("2026-11-01T05:30:00Z", "2026-11-01T06:15:00Z"); // 1:30 AM EDT to 1:15 AM EST: 45 real minutes
    const s = segmentOn(wrap, "2026-11-01");
    expect(s.bottom).toBeGreaterThanOrEqual(s.top + 20); // never upside down on the wall clock
    const lateNight = timed("2026-11-02T04:00:00Z", "2026-11-02T06:00:00Z"); // 11 PM EST Nov 1 to 1 AM Nov 2
    expect(onDay(lateNight, "2026-11-01")).toBe(true);
    expect(onDay(lateNight, "2026-11-02")).toBe(true);
    expect(segmentOn(lateNight, "2026-11-01")).toMatchObject({ top: 23 * 60, bottom: 1440 });
    expect(segmentOn(lateNight, "2026-11-02")).toMatchObject({ top: 0, bottom: 60 });
    // 11 PM to midnight on the 25-hour day ends exactly at the next day's start: not on Nov 2.
    const toMidnight = timed("2026-11-02T04:00:00Z", "2026-11-02T05:00:00Z");
    expect(onDay(toMidnight, "2026-11-02")).toBe(false);
    expect(onDay(allDay("2026-11-01", "2026-11-02"), "2026-11-02")).toBe(false);
  });
});

describe("overlap layout", () => {
  const seg = (top: number, bottom: number, id: string) => ({ event: id, top, bottom });
  const byId = (xs: ReturnType<typeof layoutOverlaps<string>>) => Object.fromEntries(xs.map((p) => [p.event, [p.column, p.columns]]));
  it("leaves events that do not overlap full width", () => {
    expect(byId(layoutOverlaps([seg(540, 600, "a"), seg(600, 660, "b")]))).toEqual({ a: [0, 1], b: [0, 1] });
  });
  it("puts two overlapping events side by side", () => {
    expect(byId(layoutOverlaps([seg(540, 630, "a"), seg(600, 660, "b")]))).toEqual({ a: [0, 2], b: [1, 2] });
  });
  it("reuses a free column inside a chain and sizes the whole group by its widest point", () => {
    // a overlaps b and c; b and c do not overlap each other: two columns for the group.
    expect(byId(layoutOverlaps([seg(540, 720, "a"), seg(540, 600, "b"), seg(600, 660, "c")]))).toEqual({ a: [0, 2], b: [1, 2], c: [1, 2] });
    // three at once
    expect(byId(layoutOverlaps([seg(540, 600, "a"), seg(540, 600, "b"), seg(540, 600, "c")]))).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3] });
  });
  it("starts a new group after a gap", () => {
    expect(byId(layoutOverlaps([seg(540, 600, "a"), seg(540, 600, "b"), seg(700, 760, "c")]))).toEqual({ a: [0, 2], b: [1, 2], c: [0, 1] });
  });
  it("is empty for no events", () => {
    expect(layoutOverlaps([])).toEqual([]);
  });
});

describe("the hour grid range", () => {
  it("is 8 AM to 8 PM and widens for early and late events", () => {
    expect(hourRange([])).toEqual({ startHour: 8, endHour: 20 });
    expect(hourRange([{ top: 6 * 60 + 30, bottom: 7 * 60 }])).toEqual({ startHour: 6, endHour: 20 });
    expect(hourRange([{ top: 21 * 60, bottom: 1440 }])).toEqual({ startHour: 8, endHour: 24 });
  });
});

describe("Previous and Next at the two-year limit", () => {
  it("clamps, and gives no target when it would land in the same period", () => {
    expect(clampDate("2040-01-01", TODAY)).toBe("2028-11-23");
    expect(stepTarget("day", "2028-11-23", 1, TODAY)).toBeNull();
    expect(stepTarget("day", "2028-11-23", -1, TODAY)).toBe("2028-11-22");
    expect(stepTarget("day", "2024-11-22", -1, TODAY)).toBeNull();
    expect(stepTarget("week", "2028-11-23", 1, TODAY)).toBeNull(); // the next week clamps back into this one
    expect(stepTarget("week", "2028-11-12", 1, TODAY)).toBe("2028-11-19");
  });
});
