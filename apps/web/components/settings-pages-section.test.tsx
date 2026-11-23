// @vitest-environment jsdom
// T-271: Approvals and Assistant are opened from Settings (they have no side menu entry).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SettingsPagesSection, settingsPagesTitle } from "./settings-pages-section";

afterEach(cleanup);

describe("Settings: Approvals and Assistant", () => {
  it("links both pages inside the current company, in order", () => {
    render(<SettingsPagesSection laneId="PKG" pages={["approvals", "assistant"]} />);
    const region = screen.getByRole("region", { name: "Approvals and Assistant" });
    const links = within(region).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG/approvals", "/PKG/assistant"]);
    expect(links[0]?.textContent).toContain("Approvals");
    expect(links[0]?.textContent).toContain("Nothing is sent or changed until you approve it.");
    expect(links[1]?.textContent).toContain("Assistant");
    expect(region.getAttribute("id")).toBe("pages");
  });

  it("a company that uses only one of them shows that one, titled after it; none shows nothing", () => {
    const { unmount } = render(<SettingsPagesSection laneId="NC" pages={["approvals"]} />);
    expect(within(screen.getByRole("region", { name: "Approvals" })).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/NC/approvals"]);
    unmount();
    const { container } = render(<SettingsPagesSection laneId="NC" pages={[]} />);
    expect(container.textContent).toBe("");
    expect(settingsPagesTitle(["approvals", "assistant"])).toBe("Approvals and Assistant");
    expect(settingsPagesTitle(["assistant"])).toBe("Assistant");
  });
});
