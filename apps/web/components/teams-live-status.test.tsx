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

  it("T-295: two rows of one person each show THEIR OWN live state from the one answer, and the page makes ONE request for both", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const A = "00000000-0000-4000-8000-0000000000c1";
    const B = "00000000-0000-4000-8000-0000000000c2";
    answer({
      live: true, liveUntil: "2026-11-26T15:30:00.000Z", dot: false, lastNoticeAt: null,
      accounts: [{ conn: A, live: true, liveUntil: "2026-11-26T15:30:00.000Z", dot: false, lastNoticeAt: null }, { conn: B, live: false, liveUntil: null, dot: false, lastNoticeAt: null }],
    });
    render(
      <>
        <TeamsLiveStatus laneId="PKG" connectionId={A}>row A</TeamsLiveStatus>
        <TeamsLiveStatus laneId="PKG" connectionId={B}>row B</TeamsLiveStatus>
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId("teams-live-status")).toHaveLength(2));
    expect(screen.getAllByTestId("teams-live-status").map((e) => e.textContent)).toEqual(["Live updates until Nov 26, 2026, 10:30 AM ET", "Live updates unavailable"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // a row the answer has no entry for (an older server, or an account that is not usable) is not given another account's state
    cleanup();
    fetchMock.mockReset();
    answer({ live: true, liveUntil: "2026-11-26T15:30:00.000Z", dot: false, lastNoticeAt: null, accounts: [{ conn: A, live: true, liveUntil: "2026-11-26T15:30:00.000Z", dot: false, lastNoticeAt: null }] });
    render(<TeamsLiveStatus laneId="PKG" connectionId={B}>row B</TeamsLiveStatus>);
    await waitFor(() => expect(screen.getByTestId("teams-live-status").textContent).toBe("Live updates unavailable"));
  });
});
