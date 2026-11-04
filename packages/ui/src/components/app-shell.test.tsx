import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AppShell } from "./app-shell";
import { LaneSwitcher } from "./lane-switcher";

const BRAND = { wordmark: "Brand", product: "Jarvis · Executive Portal" };
const ONE = [{ laneId: "PKG", name: "Pub K Group" }];
const TWO = [...ONE, { laneId: "APK", name: "Ask Pub K" }];
const noop = () => undefined;

function shell(over: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return render(
    <AppShell brand={BRAND} lanes={ONE} currentLaneId="PKG" pathname="/PKG" signOut={noop} {...over}>
      <h1>Content</h1>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("shows the signed-off side menu in order, linked inside the current lane", () => {
    shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Finance", "Inbox", "Calendar", "Approvals", "Assistant", "Projects", "Settings"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG", "/PKG/finance", "/PKG/inbox", "/PKG/calendar", "/PKG/approvals", "/PKG/assistant", "/PKG/projects", "/PKG/settings"]);
  });

  it("has no Search, Commitments or All companies entry anywhere", () => {
    const { container } = shell({ lanes: TWO });
    const text = container.textContent ?? "";
    for (const hidden of ["Search", "Commitments", "All companies"]) expect(text).not.toContain(hidden);
  });

  it("marks the selected entry and shows the wordmark, star and product line", () => {
    const { container } = shell({ pathname: "/PKG/finance" });
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Finance" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Home" }).hasAttribute("aria-current")).toBe(false);
    const side = container.querySelector("[data-slot=side-menu]");
    expect(side?.textContent).toContain("Brand");
    expect(side?.textContent).toContain("Jarvis · Executive Portal");
    expect(side?.querySelector("svg")).not.toBeNull();
  });

  it("has the iPhone tabs Home, Approvals, Inbox, Ask, More and no back link", () => {
    shell({ pathname: "/PKG/assistant" });
    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Approvals", "Inbox", "Ask", "More"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG", "/PKG/approvals", "/PKG/inbox", "/PKG/assistant", "/PKG/more"]);
    expect(within(tabs).getByRole("link", { name: "Ask" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText(/‹|Back/)).toBeNull();
  });

  it("renders the optional menu extra (theme control) in the side menu", () => {
    shell({ menuExtra: <button type="button">Theme</button> });
    expect(within(screen.getByRole("complementary")).getByRole("button", { name: "Theme" })).toBeTruthy();
  });

  it("selects More for the entries that live under it", () => {
    shell({ pathname: "/PKG/settings" });
    expect(within(screen.getByRole("navigation", { name: "Tabs" })).getByRole("link", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows the approvals count only when above zero", () => {
    const { rerender } = shell({ approvalsCount: 3 });
    expect(screen.getAllByLabelText("3 pending")).toHaveLength(2); // side menu and tab
    rerender(
      <AppShell brand={BRAND} lanes={ONE} currentLaneId="PKG" pathname="/PKG" signOut={noop} approvalsCount={0}>
        x
      </AppShell>,
    );
    expect(screen.queryByLabelText(/pending/)).toBeNull();
  });

  it("limits the content width with the token and renders the page content", () => {
    shell();
    const main = screen.getByRole("main");
    expect(main.className).toContain("max-w-content");
    expect(within(main).getByRole("heading", { name: "Content" })).toBeTruthy();
  });

  it("uses token classes only (no hard-coded colours)", () => {
    const { container } = shell({ lanes: TWO });
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgb\(|\bbg-(?:white|black|gray|slate|blue|red)\b|text-(?:white|black|gray|slate)\b/);
  });
});

describe("LaneSwitcher", () => {
  it("is a static label with one lane", () => {
    const { container } = render(<LaneSwitcher lanes={ONE} currentLaneId="PKG" />);
    expect(screen.getByText("Pub K Group")).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
  });

  it("lists exactly the lanes it is given, linking to the same module in the other lane", () => {
    render(<LaneSwitcher lanes={TWO} currentLaneId="PKG" segment="finance" />);
    const links = screen.getAllByRole("link", { hidden: true });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG/finance", "/APK/finance"]);
    expect(screen.queryByText("Nichols Law")).toBeNull();
    expect(links[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("never lists an All companies option", () => {
    render(<LaneSwitcher lanes={TWO} currentLaneId="PKG" />);
    expect(screen.queryByText(/all companies/i)).toBeNull();
  });
});
