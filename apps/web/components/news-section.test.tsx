// @vitest-environment jsdom
// T-234 part 4: Settings -> GovCon news: configured / web category / spend against the cap, read-only, fixed texts.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NewsSection } from "./news-section";

afterEach(cleanup);
const NOW = new Date("2026-11-12T15:00:00Z");
const base = { webAllowed: true, enabled: true, capUsd: 20, monthSpendUsd: 1.5, monthFetches: 3, lastStatus: "ok", lastFailure: null, lastFetchAt: "2026-11-12T11:00:00Z" };

describe("NewsSection", () => {
  it("configured: status, web category, spend vs cap and the last fetch; no setup hint, no form or button (read-only)", () => {
    const { container } = render(<NewsSection view={base} tz="America/New_York" now={NOW} />);
    expect(screen.getByTestId("news-status").textContent).toBe("Configured");
    expect(screen.getByTestId("news-web").textContent).toBe("On");
    expect(screen.getByTestId("news-spend").textContent).toBe("$1.50 of $20.00 · 3 fetches");
    expect(screen.getByTestId("news-last").textContent).toBe("6:00 AM · ok");
    expect(screen.queryByTestId("news-setup-hint")).toBeNull();
    expect(container.querySelectorAll("button, input, form")).toHaveLength(0);
  });
  it("not configured when either the web category or the switch is off, with a hint", () => {
    for (const v of [{ ...base, webAllowed: false }, { ...base, enabled: false }]) {
      render(<NewsSection view={v} tz="America/New_York" now={NOW} />);
      expect(screen.getByTestId("news-status").textContent).toBe("Not configured");
      expect(screen.getByTestId("news-setup-hint")).toBeTruthy();
      cleanup();
    }
  });
  it("a failed last fetch shows its fixed reason; none yet is plain", () => {
    render(<NewsSection view={{ ...base, lastStatus: "failed", lastFailure: "the fetch took too long", monthFetches: 1 }} tz="America/New_York" now={NOW} />);
    expect(screen.getByTestId("news-last").textContent).toBe("6:00 AM · failed: the fetch took too long");
    expect(screen.getByTestId("news-spend").textContent).toContain("1 fetch");
    cleanup();
    render(<NewsSection view={{ ...base, lastFetchAt: null, lastStatus: null }} tz="America/New_York" now={NOW} />);
    expect(screen.getByTestId("news-last").textContent).toBe("None yet");
  });
});
