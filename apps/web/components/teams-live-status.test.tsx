// @vitest-environment jsdom
// T-289, T-290: the "Live updates" line of your own Teams row in Settings (H-083 step 3): the fixed text first, then the browser's own answer from the portal's database.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamsLiveStatus } from "./teams-live-status";

const fetchMock = vi.fn();
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});
const answer = (body: unknown, status = 200) => fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));

describe("TeamsLiveStatus", () => {
  it("renders only the fixed text on the server (no read, nothing said about live updates)", () => {
    expect(renderToStaticMarkup(<TeamsLiveStatus laneId="PKG">No sync: chats are read live</TeamsLiveStatus>)).toBe("No sync: chats are read live");
  });

  it("says 'Live updates until <time> ET' when Microsoft gave an expiry, from this portal's own route", async () => {
    vi.stubGlobal("fetch", fetchMock);
    answer({ live: true, liveUntil: "2026-11-26T15:30:00.000Z", dot: false, lastNoticeAt: null });
    render(<TeamsLiveStatus laneId="PKG">No sync: chats are read live</TeamsLiveStatus>);
    await waitFor(() => expect(screen.getByTestId("teams-live-status").textContent).toBe("Live updates until Nov 26, 2026, 10:30 AM ET"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/lanes/PKG/messages/activity");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says 'Live updates unavailable' when notices are off, and nothing at all when the question fails", async () => {
    vi.stubGlobal("fetch", fetchMock);
    answer({ live: false, liveUntil: null, dot: false, lastNoticeAt: null });
    render(<TeamsLiveStatus laneId="PKG">No sync: chats are read live</TeamsLiveStatus>);
    await waitFor(() => expect(screen.getByTestId("teams-live-status").textContent).toBe("Live updates unavailable"));
    cleanup();
    answer({ error: "unavailable" }, 503);
    render(<TeamsLiveStatus laneId="PKG">No sync: chats are read live</TeamsLiveStatus>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("teams-live-status")).toBeNull();
  });
});
