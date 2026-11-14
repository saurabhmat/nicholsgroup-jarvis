// @vitest-environment jsdom
// T-235 part 1: the owner's automatic-summary controls. The server action runs once on mount (never again on a re-render or a
// router.refresh()), "Updating summary…" shows while the run is open, the poll refreshes the page once through the shared refresh
// gate, and the ⋯ menu's Regenerate has its enabled / rate-limited / daily-limit states.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lastRefreshAttempt, resetRefreshGate, holdRefresh } from "@/lib/refresh-gate";
import type { BriefingRunStateView } from "@/lib/briefing-runs";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
const act_ = vi.hoisted(() => ({ ensure: vi.fn(), regen: vi.fn(), state: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/app/[laneId]/briefing-actions", () => ({
  ensureFreshBriefing: (l: string) => act_.ensure(l),
  regenerateBriefing: (l: string) => act_.regen(l),
  briefingRunState: (l: string) => act_.state(l),
}));
import { POLL_EVERY_MS, POLL_FOR_MS } from "@/lib/client-constants";
import { BriefingAuto } from "./briefing-auto";

const T0 = new Date("2026-11-12T15:00:00.000Z");
const OLD = "2026-11-12T08:00:00.000Z"; // 7 h before T0: stale
const FRESH = "2026-11-12T14:00:00.000Z";
const idle: BriefingRunStateView = { running: false, lastRegenerateAt: null, runsToday: 1, latestPreparedAt: OLD, lastAttemptAt: OLD };
const draw = (over: Partial<{ preparedAt: string | null; initial: BriefingRunStateView | null }> = {}) =>
  render(<BriefingAuto laneId="PKG" preparedAt={over.preparedAt === undefined ? OLD : over.preparedAt} initial={over.initial === undefined ? idle : over.initial} tz="America/New_York" />);
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  nav.refresh.mockReset();
  act_.ensure.mockReset().mockResolvedValue({ started: true });
  act_.regen.mockReset().mockResolvedValue({ started: true });
  act_.state.mockReset().mockResolvedValue({ ...idle, running: true });
  resetRefreshGate();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the automatic trigger", () => {
  it("fires once on mount when the latest briefing is stale, and shows 'Updating summary…'", async () => {
    draw();
    await advance(0);
    expect(act_.ensure).toHaveBeenCalledTimes(1);
    expect(act_.ensure).toHaveBeenCalledWith("PKG");
    expect(screen.getByTestId("briefing-updating").textContent).toContain("Updating summary…");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("the status live region is mounted from the start (empty), only its text changes", async () => {
    draw({ preparedAt: FRESH });
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    act_.regen.mockResolvedValueOnce({ started: true });
    fireEvent.click(screen.getByTestId("briefing-menu-button"));
    fireEvent.click(screen.getByTestId("briefing-regenerate"));
    await advance(0);
    expect(screen.getByRole("status")).toBe(region); // the same node
    expect(region.textContent).toContain("Updating summary…");
  });

  it("a REMOUNT in the same tab within 10 minutes does not call the action again; after 10 minutes it does", async () => {
    act_.ensure.mockResolvedValue({ started: false, gate: "cooldown" });
    draw();
    await advance(0);
    cleanup();
    draw();
    await advance(0);
    expect(act_.ensure).toHaveBeenCalledTimes(1);
    cleanup();
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000 + 1));
    draw();
    await advance(0);
    expect(act_.ensure).toHaveBeenCalledTimes(2);
  });

  it("another lane has its own guard", async () => {
    act_.ensure.mockResolvedValue({ started: false, gate: "cooldown" });
    draw();
    await advance(0);
    cleanup();
    render(<BriefingAuto laneId="APK" preparedAt={OLD} initial={idle} tz="America/New_York" />);
    await advance(0);
    expect(act_.ensure).toHaveBeenCalledTimes(2);
  });

  it("does not fire on a re-render or when the page refreshes with new props (router.refresh keeps the component mounted)", async () => {
    const { rerender } = draw();
    await advance(0);
    rerender(<BriefingAuto laneId="PKG" preparedAt={OLD} initial={idle} tz="America/New_York" />);
    rerender(<BriefingAuto laneId="PKG" preparedAt="2026-11-12T15:00:00.000Z" initial={{ ...idle, running: false }} tz="America/New_York" />);
    rerender(<BriefingAuto laneId="PKG" preparedAt={OLD} initial={null} tz="America/New_York" />);
    await advance(10 * 60_000);
    expect(act_.ensure).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the latest briefing is fresher than 3 hours", async () => {
    draw({ preparedAt: FRESH });
    await advance(0);
    expect(act_.ensure).not.toHaveBeenCalled();
    expect(screen.queryByTestId("briefing-updating")).toBeNull();
  });

  it("fires when there is no briefing at all", async () => {
    draw({ preparedAt: null });
    await advance(0);
    expect(act_.ensure).toHaveBeenCalledTimes(1);
  });

  it("a gate refusal (cap, cooldown, not stale) shows nothing and starts no poll", async () => {
    act_.ensure.mockResolvedValue({ started: false, gate: "cap_reached" });
    draw();
    await advance(POLL_EVERY_MS * 3);
    expect(screen.queryByTestId("briefing-updating")).toBeNull();
    expect(act_.state).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("an error from the action is silent on Home", async () => {
    act_.ensure.mockResolvedValue({ error: "not_configured" });
    draw();
    await advance(POLL_EVERY_MS * 2);
    expect(screen.queryByTestId("briefing-updating")).toBeNull();
    expect(screen.queryByTestId("briefing-regenerate-message")).toBeNull();
  });

  it("a run already open (initial state) shows 'Updating summary…' and polls without starting another", async () => {
    draw({ initial: { ...idle, running: true } });
    await advance(0);
    expect(act_.ensure).not.toHaveBeenCalled();
    expect(screen.getByTestId("briefing-updating")).toBeTruthy();
  });
});

describe("polling", () => {
  it("polls every 12 s while the run is open, then refreshes the page ONCE through the refresh gate and hides 'Updating summary…'", async () => {
    draw();
    await advance(0);
    await advance(POLL_EVERY_MS);
    expect(act_.state).toHaveBeenCalledTimes(1);
    expect(nav.refresh).not.toHaveBeenCalled();
    await advance(POLL_EVERY_MS);
    expect(act_.state).toHaveBeenCalledTimes(2);
    act_.state.mockResolvedValue({ ...idle, running: false, latestPreparedAt: FRESH });
    await advance(POLL_EVERY_MS);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(lastRefreshAttempt()).toBe(Date.now()); // went through requestRefresh: the shared refresh clock moved
    expect(screen.queryByTestId("briefing-updating")).toBeNull();
    await advance(POLL_EVERY_MS * 5);
    expect(act_.state).toHaveBeenCalledTimes(3); // the poll stopped
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 minutes without a refresh", async () => {
    draw();
    await advance(0);
    await advance(POLL_FOR_MS + POLL_EVERY_MS);
    expect(screen.queryByTestId("briefing-updating")).toBeNull();
    expect(nav.refresh).not.toHaveBeenCalled();
    const calls = act_.state.mock.calls.length;
    await advance(POLL_EVERY_MS * 4);
    expect(act_.state).toHaveBeenCalledTimes(calls);
  });

  it("waits while the reply drawer holds the refresh, then refreshes once", async () => {
    draw();
    await advance(0);
    const release = holdRefresh("drawer");
    act_.state.mockResolvedValue({ ...idle, running: false });
    await advance(POLL_EVERY_MS);
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => release());
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the ⋯ disclosure", () => {
  const openMenu = async () => {
    fireEvent.click(screen.getByTestId("briefing-menu-button"));
    await advance(0);
  };
  const panel = () => screen.getByTestId("briefing-menu");
  const item = () => screen.getByRole("button", { name: /Regenerate/ });

  it("is a disclosure button (aria-expanded, aria-controls), not a menu; the panel is always rendered and hidden when closed", async () => {
    draw({ preparedAt: FRESH });
    const btn = screen.getByRole("button", { name: "Summary options" });
    expect(btn.getAttribute("aria-haspopup")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe(panel().id);
    expect(panel().hidden).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    await openMenu();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(item()).toBeTruthy();
  });

  it("the trigger is 44 px on phones", () => {
    draw({ preparedAt: FRESH });
    expect(screen.getByTestId("briefing-menu-button").className).toContain("size-11");
  });

  it("Escape closes it and focus returns to the trigger", async () => {
    draw({ preparedAt: FRESH });
    const btn = screen.getByTestId("briefing-menu-button");
    await openMenu();
    item().focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it("the trigger toggles it with a click (Enter and Space click a button)", async () => {
    draw({ preparedAt: FRESH });
    const btn = screen.getByTestId("briefing-menu-button");
    await openMenu();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("focus moving out of the control closes it; focus moving inside does not", async () => {
    draw({ preparedAt: FRESH });
    const btn = screen.getByTestId("briefing-menu-button");
    await openMenu();
    fireEvent.blur(btn, { relatedTarget: item() });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(item(), { relatedTarget: document.body });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("Regenerate is enabled when the last one was over 30 minutes ago; clicking starts a run, closes the panel, returns focus and polls", async () => {
    draw({ preparedAt: FRESH, initial: { ...idle, lastRegenerateAt: "2026-11-12T14:00:00.000Z" } });
    await openMenu();
    expect(item().getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(item());
    await advance(0);
    expect(act_.regen).toHaveBeenCalledWith("PKG");
    expect(screen.getByTestId("briefing-updating")).toBeTruthy();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId("briefing-menu-button"));
  });

  it("within 30 minutes of the last Regenerate it is aria-disabled (still focusable), reads the reason and does nothing", async () => {
    draw({ preparedAt: FRESH, initial: { ...idle, lastRegenerateAt: "2026-11-12T14:45:00.000Z" } }); // 9:45 AM ET, available 10:15 AM
    await openMenu();
    const el = item() as HTMLButtonElement;
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.disabled).toBe(false); // not `disabled`: it stays reachable, so the reason is read
    expect(el.textContent).toContain("Available at 10:15 AM"); // inside the control: part of its accessible name
    expect(screen.getByTestId("briefing-regenerate-reason").textContent).toBe("Available at 10:15 AM");
    el.focus();
    expect(document.activeElement).toBe(el);
    fireEvent.click(el);
    await advance(0);
    expect(act_.regen).not.toHaveBeenCalled();
  });

  it("after 6 runs today it is aria-disabled and shows the daily limit", async () => {
    draw({ preparedAt: FRESH, initial: { ...idle, runsToday: 6 } });
    await openMenu();
    expect(item().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("briefing-regenerate-reason").textContent).toBe("Daily limit reached (6 a day)");
  });

  it("is aria-disabled while a run is open", async () => {
    draw({ preparedAt: FRESH, initial: { ...idle, running: true } });
    await openMenu();
    expect(item().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("briefing-regenerate-reason").textContent).toBe("Updating…");
  });

  it("a refused Regenerate re-reads the state and shows the limit; an error shows one muted line", async () => {
    draw({ preparedAt: FRESH });
    act_.regen.mockResolvedValueOnce({ started: false, gate: "rate_limited" });
    act_.state.mockResolvedValueOnce({ ...idle, lastRegenerateAt: "2026-11-12T14:50:00.000Z" });
    await openMenu();
    fireEvent.click(item());
    await advance(0);
    expect(screen.getByTestId("briefing-regenerate-reason").textContent).toMatch(/^Available at /);
    cleanup();
    draw({ preparedAt: FRESH });
    act_.regen.mockResolvedValueOnce({ error: "unavailable" });
    await openMenu();
    fireEvent.click(item());
    await advance(0);
    expect(screen.getByTestId("briefing-regenerate-message").textContent).toMatch(/could not be started/);
  });
});
