// T-274: the real page body (CalendarBody) with headers() and the guards mocked: the phone default view, an explicit view, and the date clamp.
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ua = vi.hoisted(() => ({ value: "" as string | null }));
const calls = vi.hoisted(() => ({ periods: [] as { view: string; date: string }[] }));

vi.mock("next/headers", () => ({ headers: () => Promise.resolve({ get: (k: string) => (k === "user-agent" ? ua.value : null) }) }));
vi.mock("@/lib/guards", () => ({ guards: () => Promise.resolve({}) }));
vi.mock("@/lib/calendar-page", async (orig) => ({
  ...(await orig<typeof import("@/lib/calendar-page")>()),
  calendarFor: (_g: unknown, _lane: string, period: { view: string; date: string }) => {
    calls.periods.push({ view: period.view, date: period.date });
    return Promise.resolve({ state: "not_connected" });
  },
}));

import { CalendarBody } from "./calendar-page";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

async function body(sp: Record<string, string>): Promise<string> {
  const el = await CalendarBody({ laneId: "PKG", searchParams: Promise.resolve(sp) });
  const stream = await renderToReadableStream(el);
  await stream.allReady;
  return new Response(stream).text();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T15:00:00Z"));
  calls.periods = [];
});
afterEach(() => vi.useRealTimers());

describe("Calendar page body", () => {
  it("an iPhone with no view gets Day; the same iPhone asking for week gets Week; a desktop gets Week", async () => {
    ua.value = IPHONE;
    const day = await body({});
    expect(calls.periods[0]).toEqual({ view: "day", date: "2026-11-23" });
    expect(day).toContain("Monday, November 23, 2026");
    const week = await body({ view: "week" });
    expect(calls.periods[1]).toEqual({ view: "week", date: "2026-11-23" });
    expect(week).toContain("Nov 22 – 28, 2026");
    ua.value = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    await body({});
    expect(calls.periods[2]?.view).toBe("week");
  });

  it("clamps a date more than two years away", async () => {
    ua.value = null;
    await body({ view: "day", date: "2099-01-01" });
    expect(calls.periods[0]).toEqual({ view: "day", date: "2028-11-23" });
    await body({ view: "day", date: "1990-01-01" });
    expect(calls.periods[1]).toEqual({ view: "day", date: "2024-11-22" });
  });
});
