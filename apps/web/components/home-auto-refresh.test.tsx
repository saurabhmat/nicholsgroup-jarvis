// @vitest-environment jsdom
// T-234 part 5: the Home auto-refresh. Fake timers and a mocked router: the interval refreshes only while the tab is visible, focus
// refreshes only when the data is older than the interval, a drawer / a send / a focused text field pause it (one catch-up refresh
// afterwards), the "Updated" text moves on, and nothing but router.refresh() is ever called (no fetch).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { holdRefresh, requestRefresh, resetRefreshGate } from "@/lib/refresh-gate";
import { HomeAutoRefresh, updatedLabel } from "./home-auto-refresh";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const MIN = 60_000;
const T0 = new Date("2026-11-12T15:00:00.000Z");
let visibility: "visible" | "hidden" = "visible";
const fetchSpy = vi.fn();

function setVisibility(v: "visible" | "hidden") {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  nav.refresh.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  resetRefreshGate();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const draw = (renderedAt = T0.toISOString()) => render(<HomeAutoRefresh renderedAt={renderedAt} />);

describe("interval", () => {
  it("refreshes every 5 minutes while the tab is visible", async () => {
    draw();
    await advance(5 * MIN - 1);
    expect(nav.refresh).not.toHaveBeenCalled();
    await advance(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    await advance(5 * MIN);
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh while the tab is hidden", async () => {
    draw();
    setVisibility("hidden");
    await advance(12 * MIN);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("only calls router.refresh(): no fetch, no server action", async () => {
    draw();
    await advance(11 * MIN);
    fireEvent.focus(window);
    expect(nav.refresh).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("one refresh per interval", () => {
  it("a tick within 5 minutes of a catch-up refresh does nothing", async () => {
    draw();
    const release = holdRefresh("drawer");
    await advance(6 * MIN); // the 5-minute tick was skipped (held); the data is 6 minutes old
    act(() => release()); // catch-up refresh at 6 min
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    await advance(4 * MIN); // the tick at 10 min is 4 minutes after the catch-up
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    await advance(5 * MIN); // the tick at 15 min, 9 minutes after the catch-up
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });

  it("a refresh the drawer made counts: the release catch-up and the next tick leave it alone", async () => {
    draw();
    const release = holdRefresh("drawer");
    await advance(6 * MIN);
    requestRefresh(nav.refresh); // the drawer's own refresh on close
    act(() => release());
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    await advance(4 * MIN);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("focus and visibility", () => {
  it("refreshes on return to the tab when the data is older than 5 minutes", async () => {
    draw();
    setVisibility("hidden");
    await advance(6 * MIN);
    setVisibility("visible");
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on focus before 5 minutes", async () => {
    draw();
    setVisibility("hidden");
    await advance(4 * MIN);
    setVisibility("visible");
    fireEvent.focus(window);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("window focus after 5 minutes refreshes once, not again on the next focus", async () => {
    draw();
    visibility = "hidden";
    await advance(6 * MIN);
    visibility = "visible";
    fireEvent.focus(window);
    fireEvent.focus(window);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("pauses", () => {
  it("skips the tick while the drawer is open and refreshes once when it closes (stale)", async () => {
    draw();
    const release = holdRefresh("drawer");
    await advance(5 * MIN);
    await advance(5 * MIN);
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => release());
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on release when the data is still fresh", async () => {
    draw();
    const release = holdRefresh("drawer");
    await advance(MIN);
    act(() => release());
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("is paused while a send is in progress, even with the drawer's own hold released", async () => {
    draw();
    const drawer = holdRefresh("drawer");
    const sending = holdRefresh("sending");
    await advance(6 * MIN);
    act(() => drawer());
    expect(nav.refresh).not.toHaveBeenCalled(); // the send still holds
    act(() => sending());
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("is paused while a text field has the focus and refreshes once after it loses it", async () => {
    render(
      <>
        <HomeAutoRefresh renderedAt={T0.toISOString()} />
        <input aria-label="Reply to" />
        <button type="button">Other</button>
      </>,
    );
    const input = screen.getByLabelText("Reply to");
    input.focus();
    await advance(6 * MIN);
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => input.blur());
    await advance(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("a focused button does not pause it", async () => {
    render(
      <>
        <HomeAutoRefresh renderedAt={T0.toISOString()} />
        <button type="button">Other</button>
      </>,
    );
    screen.getByRole("button").focus();
    await advance(5 * MIN);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the Updated text", () => {
  it("moves from just now to N min ago, silently (no live region), with the absolute time in the title", async () => {
    draw();
    const el = screen.getByTestId("home-updated");
    expect(el.textContent).toBe("Updated just now");
    expect(el.closest("[aria-live]")).toBeNull();
    expect(el.getAttribute("role")).toBeNull();
    await advance(2 * MIN + 30_000);
    expect(el.textContent).toBe("Updated 2 min ago");
    expect(el.getAttribute("title")).toMatch(/^Data read at /);
  });

  it("goes back to just now when the server render is newer (after a refresh)", async () => {
    const { rerender } = draw();
    await advance(4 * MIN);
    expect(screen.getByTestId("home-updated").textContent).toBe("Updated 4 min ago");
    rerender(<HomeAutoRefresh renderedAt={new Date(Date.now()).toISOString()} />);
    expect(screen.getByTestId("home-updated").textContent).toBe("Updated just now");
  });

  it("labels", () => {
    expect(updatedLabel(0, 59_999)).toBe("Updated just now");
    expect(updatedLabel(0, 60_000)).toBe("Updated 1 min ago");
    expect(updatedLabel(0, 59 * MIN)).toBe("Updated 59 min ago");
    expect(updatedLabel(0, 125 * MIN)).toBe("Updated 2 h ago");
    expect(updatedLabel(10, 0)).toBe("Updated just now");
  });
});
