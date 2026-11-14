import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppShell } from "./app-shell";
import { PageHeader } from "./page-header";
import { PageSection } from "./page-section";
import { PeriodToggle } from "./period-toggle";
import { TabIcon } from "./tab-icon";
import { MOBILE_TABS } from "../lib/nav";

const noop = () => undefined;

describe("PageHeader", () => {
  it("renders the eyebrow, a serif h1 and the italic accent", () => {
    const { container } = render(<PageHeader eyebrow="Nothing is sent or changed until you approve it" title="Approvals" accent="waiting for you" />);
    expect(screen.getByText("Nothing is sent or changed until you approve it")).toBeTruthy();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Approvals waiting for you");
    expect(h1.className).toContain("font-heading");
    expect(container.querySelector("em")?.textContent).toBe("waiting for you");
  });

  it("has no accent or eyebrow when not given, and shows actions", () => {
    const { container } = render(<PageHeader title="Inbox" actions={<a href="/x">Ask Jarvis</a>} />);
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("[data-slot=page-eyebrow]")).toBeNull();
    expect(screen.getByRole("link", { name: "Ask Jarvis" })).toBeTruthy();
  });

  it("uses tokens only", () => {
    const { container } = render(<PageHeader eyebrow="e" title="t" accent="a" />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgb\(|text-(?:white|black|gray|slate)\b/);
  });
});

describe("PageSection", () => {
  it("shows the title and a T-022 empty state with no sample label", () => {
    const { container } = render(<PageSection title="Today's briefing" emptyTitle="No briefing yet" emptyDescription="Appears once sources are connected." />);
    expect(screen.getByRole("heading", { level: 2, name: "Today's briefing" })).toBeTruthy();
    expect(container.querySelector("[data-slot=empty-state]")).not.toBeNull();
    expect(container.textContent).not.toMatch(/sample data/i);
  });

  it("replaces the empty state with real content", () => {
    const { container } = render(<PageSection title="Reports"><p>content</p></PageSection>);
    expect(container.querySelector("[data-slot=empty-state]")).toBeNull();
    expect(screen.getByText("content")).toBeTruthy();
  });
});

describe("PeriodToggle", () => {
  it("offers the three periods, defaults to month to date and switches as UI state", () => {
    const onChange = vi.fn();
    render(<PeriodToggle onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Period" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["This week (Sat–Fri)", "Month to date", "Year to date"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    const first = buttons[0];
    if (!first) throw new Error("no period buttons");
    fireEvent.click(first);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(onChange).toHaveBeenCalledWith("week");
  });
});

describe("TabIcon", () => {
  it("is decorative for every tab", () => {
    for (const tab of MOBILE_TABS) {
      const { container, unmount } = render(<TabIcon name={tab.icon} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("data-icon")).toBe(tab.icon);
      unmount();
    }
  });
});

describe("AppShell iPhone header and tabs", () => {
  // The greeting follows the time the server passes (T-240, T-243: the shell never reads the clock itself): 9:00 AM Eastern.
  const NOW = new Date("2026-11-11T14:00:00Z");
  const lanes = [{ laneId: "PKG", name: "Pub K Group" }];
  const shell = (pathname: string, firstName?: string) =>
    render(
      <AppShell brand={{ wordmark: "Jarvis", product: "Executive Portal" }} lanes={lanes} currentLaneId="PKG" pathname={pathname} signOut={noop} firstName={firstName} now={NOW}>
        x
      </AppShell>,
    );

  it("puts the company chip and the title with the gold italic accent in the band", () => {
    const { container } = shell("/PKG", "Robert");
    const band = container.querySelector("[data-slot=mobile-header]");
    expect(band?.textContent).toContain("Pub K Group");
    const title = band?.querySelector("[data-slot=mobile-title]");
    expect(title?.getAttribute("aria-hidden")).toBe("true");
    expect(title?.textContent).toBe("Good morning, Robert");
    expect(title?.querySelector("em")?.className).toContain("text-gold");
  });

  it("says just Good morning without a name, and names the module elsewhere", () => {
    const home = shell("/PKG");
    expect(home.container.querySelector("[data-slot=mobile-title]")?.textContent).toBe("Good morning");
    home.unmount();
    const approvals = shell("/PKG/approvals");
    expect(approvals.container.querySelector("[data-slot=mobile-title]")?.textContent).toBe("Approvals waiting for you");
    approvals.unmount();
    expect(shell("/PKG/more").container.querySelector("[data-slot=mobile-title]")?.textContent).toBe("More");
  });

  it("gives every tab a hidden icon and keeps the label", () => {
    shell("/PKG");
    const tabs = screen.getByRole("navigation", { name: "Tabs" });
    for (const link of within(tabs).getAllByRole("link")) {
      expect(link.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(within(tabs).getAllByRole("link").map((l) => l.textContent)).toEqual(["Home", "Approvals", "Inbox", "Ask", "More"]);
  });
});

describe("AppShell never reads the clock (T-243)", () => {
  it("without a time from the server the Home title is the neutral nav heading, and no Date is constructed", () => {
    const RealDate = Date;
    const seen = { constructed: 0 };
    class Spy extends RealDate {
      constructor(...a: unknown[]) {
        if (a.length === 0) seen.constructed++;
        super(...(a as [string]));
      }
    }
    vi.stubGlobal("Date", Spy);
    try {
      const { container } = render(
        <AppShell brand={{ wordmark: "Jarvis", product: "Executive Portal" }} lanes={[{ laneId: "PKG", name: "Pub K Group" }]} currentLaneId="PKG" pathname="/PKG" signOut={noop} firstName="Robert">
          x
        </AppShell>,
      );
      expect(container.querySelector("[data-slot=mobile-title]")?.textContent).toBe("Good morning");
      expect(seen.constructed).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
