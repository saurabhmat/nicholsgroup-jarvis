// @vitest-environment jsdom
// T-290: the "new" dot. It is fetched by the browser after the shell rendered (nothing on the server), asks the portal's own database at most once per 20 seconds (a page change, the tab coming back),
// has no timer, shares one answer between the side menu, the More tab and the More list, and draws nothing without a dot. fetch is faked; synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const path = vi.hoisted(() => ({ value: "/PKG/inbox" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.value }));

import { MessagesDot } from "./messages-dot";
import { publishDot, refreshDot, resetDotForTests, dotSnapshot } from "@/lib/messages-activity-client";
import { DOT_MIN_GAP_MS } from "@/lib/messages-live-config";

let answer: { live: boolean; dot: boolean; lastNoticeAt: string | null; liveUntil: string | null; status: number };
const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: answer.status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T15:00:00.000Z"));
  vi.stubGlobal("fetch", fetchMock);
  answer = { live: true, dot: true, lastNoticeAt: "2026-11-23T14:59:00.000Z", liveUntil: null, status: 200 };
  path.value = "/PKG/inbox";
  resetDotForTests();
});
afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settle = async (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("the dot", () => {
  it("draws nothing on the server (no read, no clock) and fetches only after it mounted; then shows the dot with a screen-reader label", async () => {
    expect(renderToStaticMarkup(<MessagesDot laneId="PKG" />)).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    render(<MessagesDot laneId="PKG" />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls as unknown[][])[0]?.[0]).toBe("/api/lanes/PKG/messages/activity");
    expect(screen.getByTestId("messages-dot")).toBeTruthy();
    expect(screen.getByText("New messages").className).toContain("sr-only");
  });

  it("no dot when the answer says none, when notices are off, or when the request fails: nothing is drawn", async () => {
    for (const a of [{ ...answer, dot: false }, { ...answer, live: false, dot: false }, { ...answer, status: 503 }]) {
      cleanup();
      resetDotForTests();
      answer = a;
      render(<MessagesDot laneId="PKG" />);
      await settle();
      expect(screen.queryByTestId("messages-dot")).toBeNull();
    }
  });

  it("three places that draw it (side menu, More tab, More list) share ONE request, and none of them has a timer: nothing more is asked however long the page stays", async () => {
    render(
      <>
        <MessagesDot laneId="PKG" />
        <MessagesDot laneId="PKG" />
        <MessagesDot laneId="PKG" />
      </>,
    );
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("messages-dot")).toHaveLength(3);
    await settle(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again on a page change and when the tab comes back, but never more than once per 20 seconds", async () => {
    const view = render(<MessagesDot laneId="PKG" />);
    await settle();
    path.value = "/PKG/finance";
    view.rerender(<MessagesDot laneId="PKG" />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // too soon
    await settle(DOT_MIN_GAP_MS);
    path.value = "/PKG/calendar";
    view.rerender(<MessagesDot laneId="PKG" />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle(DOT_MIN_GAP_MS);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("opening Messages (the page publishes `no dot`) clears it everywhere at once", async () => {
    render(
      <>
        <MessagesDot laneId="PKG" />
        <MessagesDot laneId="PKG" />
      </>,
    );
    await settle();
    expect(screen.getAllByTestId("messages-dot")).toHaveLength(2);
    await act(async () => publishDot("PKG", false));
    expect(screen.queryByTestId("messages-dot")).toBeNull();
    expect(dotSnapshot("PKG")).toBe(false);
  });

  it("is per lane: one company's dot is not another's", async () => {
    render(<MessagesDot laneId="PKG" />);
    await settle();
    expect(dotSnapshot("PKG")).toBe(true);
    expect(dotSnapshot("APK")).toBe(false);
  });
});

describe("refreshDot", () => {
  it("one request in flight at a time", async () => {
    await Promise.all([refreshDot("PKG", 1_000_000), refreshDot("PKG", 1_000_000), refreshDot("PKG", 1_000_001)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
