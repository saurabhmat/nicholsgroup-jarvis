// @vitest-environment jsdom
// T-238 part B: the Sync now button. Fixed texts by status and code, a live region, a refresh after a start, no double click. Mocks only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
import { SYNC_NOW_TEXT, SyncNowButton, rateLimitedText, syncNowText } from "./sync-now-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  refresh.mockReset();
});

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("syncNowText", () => {
  it("maps status and code to fixed texts, never the server's own words", () => {
    expect(syncNowText(200, { status: "started" })).toEqual({ text: SYNC_NOW_TEXT.started, ok: true });
    expect(syncNowText(200, { status: "no_connections" }).text).toBe(SYNC_NOW_TEXT.none);
    expect(syncNowText(429, { retryAfterSeconds: 77 }).text).toBe(rateLimitedText(77));
    expect(rateLimitedText(77)).toBe("A sync was just started. You can start another in 77 seconds.");
    expect(syncNowText(429, {}).text).toBe(rateLimitedText(120));
    expect(syncNowText(429, { retryAfterSeconds: 99999 }).text).toBe(rateLimitedText(120));
    expect(syncNowText(403, { error: "forbidden" }).text).toBe(SYNC_NOW_TEXT.forbidden);
    expect(syncNowText(404, {}).text).toBe(SYNC_NOW_TEXT.forbidden);
    expect(syncNowText(401, {}).text).toBe(SYNC_NOW_TEXT.signedOut);
    expect(syncNowText(503, { error: "jane@example.test leaked" }).text).toBe(SYNC_NOW_TEXT.failed);
  });
});

describe("SyncNowButton", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("is a real button with a polite live region", () => {
    render(<SyncNowButton laneId="PKG" />);
    expect(screen.getByRole("button", { name: "Sync now" }).tagName).toBe("BUTTON");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("posts to the lane's route, announces 'Sync started' and refreshes the page twice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(reply(200, { status: "started", connections: 2 }));
    render(<SyncNowButton laneId="PKG" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(SYNC_NOW_TEXT.started));
    expect(fetchMock).toHaveBeenCalledWith("/api/lanes/PKG/sync-now", { method: "POST" });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a rate-limited click shows the fixed wait text and does not refresh", async () => {
    fetchMock.mockResolvedValue(reply(429, { error: "rate_limited", retryAfterSeconds: 45 }));
    render(<SyncNowButton laneId="PKG" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(rateLimitedText(45)));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a refusal and an outage show fixed texts; a network error too", async () => {
    fetchMock.mockResolvedValueOnce(reply(403, { error: "forbidden" }));
    render(<SyncNowButton laneId="PKG" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(SYNC_NOW_TEXT.forbidden));
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(SYNC_NOW_TEXT.network));
  });

  it("is disabled while a request is running (no double click)", async () => {
    let done: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { done = r; }));
    render(<SyncNowButton laneId="PKG" />);
    const button = screen.getByRole("button", { name: "Sync now" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "Starting…" }).hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Starting…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    done(reply(200, { status: "started" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false));
  });
});
