// @vitest-environment jsdom
// T-234 part 4: the GovCon news card. States (not configured / none yet / could not be fetched / items), safe links, "Updated",
// the owner's Refresh states (disabled with the next time, monthly budget, in flight), and that rendering never fetches.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NewsCard } from "@/lib/news-types";

const refreshNews = vi.fn<(lane: string) => Promise<unknown>>(async () => ({ ok: true, status: "ok" }));
vi.mock("@/app/[laneId]/news-actions", () => ({ refreshNews: (l: string) => refreshNews(l) }));
import { GovConNews, newsTime } from "./home-news";

afterEach(() => {
  cleanup();
  refreshNews.mockClear();
});
const NOW = new Date("2026-11-12T15:00:00Z");
const card = (over: Partial<NewsCard> = {}): NewsCard => ({
  configured: true,
  items: [
    { headline: "FAR overhaul: part 19 rewrite", why: "Changes small-business set-asides.", source: "Federal Register", publishedAt: "2026-11-12T09:00:00Z", url: "https://www.federalregister.gov/d/2026-1" },
    { headline: "CMMC phase 2 date", why: "Affects DoD subcontracts.", source: "defense.gov", publishedAt: null, url: "https://www.defense.gov/news/1" },
  ],
  updatedAt: "2026-11-12T11:00:00Z",
  failure: null,
  canRefresh: false,
  nextRefreshAt: null,
  budgetReached: false,
  isAdmin: false,
  inFlight: false,
  ...over,
});
const render_ = (c: NewsCard | null, laneId = "PKG") => render(<GovConNews laneId={laneId} card={c} now={NOW} />);

describe("states", () => {
  it("off (no card, or not configured): 'News not configured'; admins get a Settings hint, others do not", () => {
    render_(null);
    expect(screen.getByTestId("news-empty").textContent).toContain("News not configured");
    expect(screen.queryByTestId("news-admin-hint")).toBeNull();
    cleanup();
    render_(card({ configured: false, items: [], isAdmin: true }));
    expect(screen.getByTestId("news-empty").textContent).toContain("News not configured");
    expect(within(screen.getByTestId("news-admin-hint")).getByRole("link").getAttribute("href")).toBe("/PKG/settings#news");
    expect(screen.queryByTestId("news-refresh")).toBeNull();
  });
  it("configured, nothing stored: 'No news yet today'", () => {
    render_(card({ items: [], updatedAt: null }));
    expect(screen.getByTestId("news-none").textContent).toBe("No news yet today");
  });
  it("failed with nothing to show: 'News could not be fetched: <fixed reason>' (never a raw code)", () => {
    render_(card({ items: [], updatedAt: null, failure: "model_busy" }));
    expect(screen.getByTestId("news-failed").textContent).toBe("News could not be fetched: the AI service was busy");
    cleanup();
    render_(card({ items: [], updatedAt: null, failure: "<script>alert(1)</script>" }));
    expect(screen.getByTestId("news-failed").textContent).toBe("News could not be fetched: an unexpected error");
  });
  it("items: headline link, why line, source name and date, 'Updated <time>'; a newer failure is noted under them", () => {
    render_(card({ failure: "timed_out" }));
    const list = within(screen.getByTestId("news-list")).getAllByRole("listitem");
    expect(list).toHaveLength(2);
    expect(list[0]?.textContent).toContain("Changes small-business set-asides.");
    expect(list[0]?.textContent).toContain("Federal Register · Nov 12");
    expect(list[1]?.textContent).toContain("defense.gov");
    expect(list[1]?.textContent).not.toContain("·");
    expect(screen.getByTestId("news-updated").textContent).toBe("Updated 6:00 AM · Last refresh failed: the fetch took too long");
  });
});

describe("links and text", () => {
  it("every headline is an https link that opens in a new tab with noopener noreferrer", () => {
    render_(card());
    for (const a of within(screen.getByTestId("news-list")).getAllByRole("link")) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
  it("a non-https item is not rendered at all; model text is text, never HTML", () => {
    const evil = { headline: "<img src=x onerror=alert(1)>Bold", why: "<b>why</b>", source: "S", publishedAt: null, url: "https://a.gov/x" };
    const bad = { headline: "javascript", why: "w", source: "S", publishedAt: null, url: "javascript:alert(1)" };
    const http = { headline: "plain http", why: "w", source: "S", publishedAt: null, url: "http://a.gov/x" };
    const { container } = render_(card({ items: [evil, bad, http] }));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("b")).toHaveLength(0);
    expect(screen.getByText("<img src=x onerror=alert(1)>Bold")).toBeTruthy();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.queryByText("javascript")).toBeNull();
  });
  it("newsTime shows the clock today and the date otherwise, in the viewer's zone", () => {
    expect(newsTime("2026-11-12T11:00:00Z", "America/New_York", NOW)).toBe("6:00 AM");
    expect(newsTime("2026-11-11T11:00:00Z", "America/New_York", NOW)).toBe("Nov 11, 6:00 AM");
    expect(newsTime("2026-11-12T11:00:00Z", "Not/AZone", NOW)).toBe("6:00 AM");
  });
});

describe("Refresh (owner only)", () => {
  it("is not shown to anyone but the owner, and rendering never calls the action (no fetch on render)", () => {
    render_(card({ canRefresh: false }));
    expect(screen.queryByTestId("news-refresh")).toBeNull();
    cleanup();
    render_(card({ canRefresh: true }));
    expect(screen.getByTestId("news-refresh")).toBeTruthy();
    expect(refreshNews).not.toHaveBeenCalled();
  });
  it("rate-limited: disabled with 'Next refresh available at <time>'; budget reached and in flight are disabled with their text", () => {
    render_(card({ canRefresh: true, nextRefreshAt: "2026-11-12T15:30:00Z" }));
    expect((screen.getByTestId("news-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("news-refresh-note").textContent).toBe("Next refresh available at 10:30 AM");
    cleanup();
    render_(card({ canRefresh: true, budgetReached: true }));
    expect((screen.getByTestId("news-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("news-refresh-note").textContent).toBe("Monthly news budget reached");
    cleanup();
    render_(card({ canRefresh: true, inFlight: true }));
    expect((screen.getByTestId("news-refresh") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a press calls the action once for this lane; a refusal shows a fixed message", async () => {
    refreshNews.mockResolvedValueOnce({ error: "rate_limited" });
    render_(card({ canRefresh: true }));
    fireEvent.click(screen.getByTestId("news-refresh"));
    await waitFor(() => expect(screen.getByTestId("news-refresh-note").textContent).toBe("Refresh is limited to once an hour."));
    expect(refreshNews).toHaveBeenCalledTimes(1);
    expect(refreshNews).toHaveBeenCalledWith("PKG");
  });
  it("a fetch that failed is reported with its fixed reason", async () => {
    refreshNews.mockResolvedValueOnce({ ok: true, status: "failed", failure: "search_failed" });
    render_(card({ canRefresh: true }));
    fireEvent.click(screen.getByTestId("news-refresh"));
    await waitFor(() => expect(screen.getByTestId("news-refresh-note").textContent).toBe("News could not be fetched: web search was unavailable"));
  });
  it("the owner can refresh from the empty state too", () => {
    render_(card({ canRefresh: true, items: [], updatedAt: null }));
    expect(screen.getByTestId("news-none")).toBeTruthy();
    expect((screen.getByTestId("news-refresh") as HTMLButtonElement).disabled).toBe(false);
  });
});
