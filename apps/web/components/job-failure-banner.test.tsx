// @vitest-environment jsdom
// T-238 part E: the banner. Sentences, Contact support, a link to Settings -> Connections, and nothing without items.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SUPPORT_HREF } from "@/lib/support";
import { JobFailureBanner } from "./job-failure-banner";
import type { JobFailureItem } from "@/lib/job-failures";

afterEach(cleanup);
const NOW = new Date("2026-11-13T15:00:00Z");
const item = (over: Partial<JobFailureItem> = {}): JobFailureItem => ({ functionId: "conn-sync.mail", name: "Mail sync", failures: 3, since: "2026-11-13T14:15:00Z", detail: null, ...over });

describe("JobFailureBanner", () => {
  it("says which function failed, how many times and since when (Eastern), with Contact support and a link to Settings", () => {
    render(<JobFailureBanner laneId="PKG" items={[item()]} now={NOW} />);
    const banner = screen.getByTestId("job-failure-banner");
    expect(banner.textContent).toContain("Mail sync has failed 3 times in a row since 9:15 AM ET.");
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toContain(SUPPORT_HREF);
    expect(screen.getByTestId("job-failure-settings-link").getAttribute("href")).toBe("/PKG/settings#connections");
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("on Settings the link stays on the page", () => {
    render(<JobFailureBanner laneId="PKG" items={[item()]} now={NOW} onSettings />);
    expect(screen.getByTestId("job-failure-settings-link").getAttribute("href")).toBe("#connections");
  });
  it("several functions are listed in one banner, each with its fixed last-error sentence", () => {
    render(<JobFailureBanner laneId="PKG" items={[item({ detail: "Google access expired. Reconnect in Settings." }), item({ functionId: "news-daily", name: "GovCon news", failures: 4, since: null })]} now={NOW} />);
    const text = screen.getByTestId("job-failure-banner").textContent;
    expect(text).toContain("Scheduled syncs keep failing");
    expect(text).toContain("Last error: Google access expired. Reconnect in Settings.");
    expect(text).toContain("GovCon news has failed 4 times in a row.");
  });
  it("draws nothing for null or an empty list (other roles get null from the loader)", () => {
    const { container } = render(<JobFailureBanner laneId="PKG" items={null} />);
    expect(container.innerHTML).toBe("");
    render(<JobFailureBanner laneId="PKG" items={[]} />);
    expect(screen.queryByTestId("job-failure-banner")).toBeNull();
  });
});
