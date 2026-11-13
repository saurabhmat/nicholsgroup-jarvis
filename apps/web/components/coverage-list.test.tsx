// @vitest-environment jsdom
// T-238 part D5: Settings -> Connections Coverage shows the same fixed error text as Home when the latest sync failed.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CoverageItem } from "@nichols/briefing/domain";
import { CoverageList } from "./coverage-list";

afterEach(cleanup);
const NOW = new Date("2026-11-13T15:00:00Z");
const item = (over: Partial<CoverageItem>): CoverageItem => ({ stream: "mail", account: "a@pubk.test", connectionId: "c1", provider: "google", status: "active", configured: true, lastSyncAt: "2026-11-13T14:50:00Z", errorKind: null, state: "ok", reason: null, ...over });

describe("CoverageList sync errors", () => {
  it("an active source whose latest sync failed shows the fixed text for its code, never provider text", () => {
    render(<CoverageList view={{ items: [item({ errorKind: "reconnect_required" }), item({ account: "b@pubk.test", errorKind: "Bearer abc" })], unavailable: false }} tz="America/New_York" now={NOW} />);
    const lines = screen.getAllByTestId("coverage-sync-error").map((e) => e.textContent);
    expect(lines).toEqual(["Latest sync failed: Google access expired. Reconnect in Settings.", "Latest sync failed: The last sync did not finish. Try Sync now; if it continues, check Settings."]);
    expect(document.body.textContent).not.toMatch(/Bearer/);
  });
  it("a healthy source and an errored-state source (which already has its reason) get no extra line", () => {
    render(<CoverageList view={{ items: [item({}), item({ account: "c@pubk.test", state: "error", status: "reconnect_required", errorKind: "reconnect_required", reason: "Access expired. Reconnect in Settings." })], unavailable: false }} tz="America/New_York" now={NOW} />);
    expect(screen.queryAllByTestId("coverage-sync-error")).toHaveLength(0);
    expect(screen.getByText("Access expired. Reconnect in Settings.")).toBeTruthy();
  });
});
