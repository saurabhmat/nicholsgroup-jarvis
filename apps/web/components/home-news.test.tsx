// @vitest-environment jsdom
// T-234 part 4: the GovCon news card. States (not configured / none yet / could not be fetched / items), safe links, "Updated",
// the owner's Refresh states (disabled with the next time, monthly budget, in flight), and that rendering never fetches.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { registrableHost, type NewsCard } from "@/lib/news-types";

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
    { headline: "FAR overhaul: part 19 rewrite", why: "Changes small-business set-asides.", source: "Federal Register", publishedAt: "2026-11-12T09:00:00Z", url: "https://www.federalregister.gov/d/2026-1", preferred: true },
    { headline: "CMMC phase 2 date", why: "Affects DoD subcontracts.", source: "defense.gov", publishedAt: null, url: "https://www.defense.gov/news/1", preferred: false },
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

describe("T-237: times are America/New_York, never ISO or a trailing Z", () => {
  it("story dates, 'Updated' and the next-refresh time are shown in New York time by default", () => {
    render_(card({ items: [{ headline: "H", why: "w", source: "S", publishedAt: "2026-11-12T03:30:00Z", url: "https://www.example.test/1", preferred: true }], updatedAt: "2026-11-12T11:05:00Z", canRefresh: true, nextRefreshAt: "2026-11-12T16:00:00Z" }));
    expect(screen.getByTestId("news-meta").textContent).toContain("Nov 11"); // 03:30Z is 10:30 PM the evening before in New York
    expect(screen.getByTestId("news-updated").textContent).toBe("Updated 6:05 AM");
    expect(screen.getByTestId("news-footer").textContent).toContain("Next refresh available at 11:00 AM");
    expect(screen.getByTestId("news-list").parentElement?.textContent).not.toMatch(/\dZ\b|\d{4}-\d{2}-\d{2}T/);
  });
});

describe("T-237: at most three stories", () => {
  it("shows the first three of five, each with its source link", () => {
    const items = Array.from({ length: 5 }, (_, n) => ({ headline: `Story ${String(n)}`, why: "w", source: "S", publishedAt: null, url: `https://www.example.test/${String(n)}`, preferred: true }));
    render_(card({ items }));
    const list = screen.getByTestId("news-list");
    expect(within(list).getAllByRole("link").map((a) => a.textContent)).toEqual(["Story 0", "Story 1", "Story 2"]);
    expect(within(list).getAllByRole("link").every((a) => a.getAttribute("href")?.startsWith("https://"))).toBe(true);
  });
});

describe("states", () => {
  it("off (no card, or not configured): one slim line 'GovCon news is off'; only admins get 'Set up in Settings'", () => {
    render_(null);
    expect(screen.getByTestId("news-empty").textContent).toBe("GovCon news is off");
    expect(screen.queryByTestId("news-admin-hint")).toBeNull();
    cleanup();
    render_(card({ configured: false, items: [], isAdmin: true }));
    expect(screen.getByTestId("news-empty").textContent).toBe("GovCon news is off\u00b7Set up in Settings");
    expect(screen.getByTestId("news-admin-hint").getAttribute("href")).toBe("/PKG/settings#news");
    const slim = screen.getByRole("region", { name: "GovCon news" });
    expect(slim.className).toMatch(/\bpy-3\b/); // slim: no 24px card padding, no body
    expect(slim.querySelector("h2")).toBeNull();
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
    expect(list[0]?.textContent).toContain("Federal Register · federalregister.gov · Nov 12");
    expect(list[1]?.textContent).toContain("defense.gov · via defense.gov · date unknown");
    expect(screen.getByTestId("news-updated").textContent).toBe("Updated 6:00 AM · Last refresh failed: the fetch took too long");
  });
});

describe("normalised links (T-235 part 5 review)", () => {
  it("renders the url httpsUrl returns (trimmed, normalised), and drops items with credentials or without https", () => {
    const base = card().items[0];
    if (!base) throw new Error("no fixture item");
    render_(
      card({
        items: [
          { ...base, headline: "Padded and upper-case host", url: "  HTTPS://WWW.FederalRegister.gov/d/9  " },
          { ...base, headline: "With credentials", url: "https://www.federalregister.gov@evil.test/d/9" },
          { ...base, headline: "Not https", url: "http://example.test/x" },
        ],
      }),
    );
    const links = within(screen.getByTestId("news-list")).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://www.federalregister.gov/d/9");
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
  it("a story URL with credentials ('https://defense.gov@evil.test') is not rendered as a link", () => {
    render_(card({ items: [{ headline: "Sneaky", why: "w", source: "S", publishedAt: null, url: "https://defense.gov@evil.test/x", preferred: false }] }));
    expect(screen.queryByText("Sneaky")).toBeNull();
  });
  it("shows where the link really goes (registrable host), 'via <host>' outside the preferred domains, whatever the model called the source", () => {
    const items = [
      { headline: "Official", why: "w", source: "Acquisition.gov", publishedAt: "2026-11-12T09:00:00Z", url: "https://www.acquisition.gov/far", preferred: true },
      { headline: "Spoofed", why: "w", source: "Federal Register", publishedAt: "2026-11-12T09:00:00Z", url: "https://news.shady-site.org/a", preferred: false },
      { headline: "UK", why: "w", source: "S", publishedAt: "2026-11-12T09:00:00Z", url: "https://www.contracts.gov.uk/x", preferred: false },
    ];
    render_(card({ items }));
    const meta = screen.getAllByTestId("news-meta").map((m) => m.textContent);
    expect(meta[0]).toBe("Acquisition.gov · acquisition.gov · Nov 12");
    expect(meta[1]).toBe("Federal Register · via shady-site.org · Nov 12");
    expect(meta[2]).toBe("S · via contracts.gov.uk · Nov 12");
    expect(registrableHost("https://a.b.c.example.com/x")).toBe("example.com");
    expect(registrableHost("not a url")).toBeNull();
  });
  it("a non-https item is not rendered at all; model text is text, never HTML", () => {
    const evil = { headline: "<img src=x onerror=alert(1)>Bold", why: "<b>why</b>", source: "S", publishedAt: null, url: "https://a.gov/x", preferred: false };
    const bad = { headline: "javascript", why: "w", source: "S", publishedAt: null, url: "javascript:alert(1)", preferred: false };
    const http = { headline: "plain http", why: "w", source: "S", publishedAt: null, url: "http://a.gov/x", preferred: false };
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
  it("a successful refresh says 'Updated just now'", async () => {
    refreshNews.mockResolvedValueOnce({ ok: true, status: "ok" });
    render_(card({ canRefresh: true }));
    fireEvent.click(screen.getByTestId("news-refresh"));
    await waitFor(() => expect(screen.getByTestId("news-refresh-note").textContent).toBe("Updated just now"));
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
