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
  it("T-271: shows the side menu in the new order, linked inside the current lane", () => {
    shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Inbox", "Calendar", "Claude", "ChatGPT", "Finance", "Tasks", "Contacts", "Messages", "Settings"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG", "/PKG/inbox", "/PKG/calendar", "/PKG/claude", "/PKG/chatgpt", "/PKG/finance", "/PKG/projects", "/PKG/contacts", "/PKG/messages", "/PKG/settings"]);
  });

  it("T-271: Get started, Approvals and Assistant have no menu entry; Settings is selected while one of them is open", () => {
    for (const path of ["/PKG/onboarding", "/PKG/approvals", "/PKG/assistant"]) {
      const { unmount } = shell({ pathname: path });
      const nav = screen.getByRole("navigation", { name: "Main" });
      expect(within(nav).queryByRole("link", { name: /Get started|AI brain|Approvals|Assistant|Ask/ })).toBeNull();
      expect(within(nav).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe("page");
      expect(within(nav).getAllByRole("link").filter((l) => l.hasAttribute("aria-current"))).toHaveLength(1);
      // on the phone they sit under More
      expect(within(screen.getByRole("navigation", { name: "Tabs" })).getByRole("link", { name: "More" }).getAttribute("aria-current")).toBe("page");
      unmount();
    }
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

  // T-240: no visual test here, so the structure is pinned: nothing on the brand truncates, clips or forbids wrapping, the star keeps its size,
  // the side menu keeps its width, and the colours are tokens (light and dark come from the --sidebar-* variables).
  it("the brand is not clipped: wraps instead of truncating, star keeps its size, side menu keeps its width", () => {
    const { container } = shell({ pathname: "/PKG" });
    const side = container.querySelector("[data-slot=side-menu]") as HTMLElement;
    const brand = side.querySelector("[data-slot=brand]") as HTMLElement;
    for (const el of [brand, ...Array.from(brand.querySelectorAll("*"))]) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/\b(truncate|text-ellipsis|overflow-hidden|whitespace-nowrap|line-clamp-\d|max-w-)/);
    }
    expect(brand.className).toContain("overflow-visible");
    expect(brand.querySelector("[data-slot=brand-wordmark]")?.className).toContain("break-words");
    expect(brand.querySelector("[data-slot=brand-product]")?.className).toContain("break-words");
    expect(brand.querySelector("svg")?.getAttribute("class")).toContain("shrink-0");
    expect(brand.querySelector("p")?.className).toMatch(/leading-tight/); // room for descenders
    expect(side.className).toMatch(/\bw-60\b/);
    expect(side.className).toMatch(/\bmin-w-60\b/);
    expect(side.className).toMatch(/\bbg-sidebar\b/);
    expect(brand.querySelector("p")?.className).toContain("text-sidebar-strong");
    expect(brand.querySelector("[data-slot=brand-product]")?.className).toContain("text-sidebar-section");
  });

  it("T-271: has the iPhone tabs Home, Inbox, Calendar, Claude, More and no back link", () => {
    shell({ pathname: "/PKG/claude" });
    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Inbox", "Calendar", "Claude", "More"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG", "/PKG/inbox", "/PKG/calendar", "/PKG/claude", "/PKG/more"]);
    expect(within(tabs).getByRole("link", { name: "Claude" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText(/‹|Back/)).toBeNull();
  });

  it("T-265: hiddenKeys drops the entries a company does not use from the side menu and the phone tabs; Home, Settings and More stay", () => {
    shell({ hiddenKeys: ["finance", "approvals", "assistant", "projects", "onboarding", "home", "settings"] });
    const menu = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link");
    expect(menu.map((l) => l.textContent)).toEqual(["Home", "Inbox", "Calendar", "Claude", "ChatGPT", "Contacts", "Messages", "Settings"]); // home and settings cannot be hidden
    const tabs = within(screen.getByRole("navigation", { name: "Tabs" })).getAllByRole("link");
    expect(tabs.map((l) => l.textContent)).toEqual(["Home", "Inbox", "Calendar", "Claude", "More"]);
  });

  it("T-265: a company without mail or calendar loses those entries and tabs", () => {
    shell({ hiddenKeys: ["inbox", "calendar"] });
    expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((l) => l.textContent)).toEqual(["Home", "Claude", "ChatGPT", "Finance", "Tasks", "Contacts", "Messages", "Settings"]);
    expect(within(screen.getByRole("navigation", { name: "Tabs" })).getAllByRole("link").map((l) => l.textContent)).toEqual(["Home", "Claude", "More"]);
  });

  it("T-265: no hiddenKeys, no change", () => {
    shell({ hiddenKeys: [] });
    expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link")).toHaveLength(10);
    expect(within(screen.getByRole("navigation", { name: "Tabs" })).getAllByRole("link")).toHaveLength(5);
  });

  it("renders the optional menu extra (theme control) in the side menu", () => {
    shell({ menuExtra: <button type="button">Theme</button> });
    expect(within(screen.getByRole("complementary")).getByRole("button", { name: "Theme" })).toBeTruthy();
  });

  it("selects More for the entries that live under it", () => {
    shell({ pathname: "/PKG/settings" });
    expect(within(screen.getByRole("navigation", { name: "Tabs" })).getByRole("link", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });

  it("T-271: the menu carries no badge or count (the approvals count and the setup badge left with their entries)", () => {
    const { container } = shell();
    expect(screen.queryByLabelText(/pending/)).toBeNull();
    expect(container.querySelector("[data-testid=onboarding-badge]")).toBeNull();
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
