// @vitest-environment jsdom
// T-230 B / T-234 part 1: the Home grid. Row 1: attention 2/3 + calendar column; row 2: five KPI tiles; row 3: GovCon news 2/3 +
// projects 1/3; the phone-only setup banner has a reserved slot while it loads. Data comes from lib (mocked here); only structure is checked.
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { HomeView } from "@/lib/home";

const m = vi.hoisted(() => ({ coverage: { items: [], unavailable: false } as unknown, view: null as unknown, progress: null as unknown, finance: { state: "not_connected", asOf: null, lastSyncAt: null, connectionStatus: null, cash: { reason: null, total: null, asOf: null, accounts: [], unmapped: 0 }, ar: { reason: null, over30: null, invoices: 0, unmapped: 0 }, pnl: { reason: null, income: null, expenses: null, net: null, start: null, end: null, method: null, partial: false, asOf: null } } as unknown }));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ client: {}, session: { userId: "u1" } }), requireRole: async () => { throw new Error("not admin"); } }) }));
vi.mock("@/lib/briefing-setup", () => ({ aiSetupFailure: () => null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/briefing", async (orig) => ({
  ...(await orig<typeof import("@/lib/briefing")>()),
  briefingFor: async () => ({ viewerTz: "America/New_York", coverage: [], coverageLine: "Coverage: test.", calendar: { access: false }, mail: { access: false }, config: {}, mailboxes: [] }),
}));
vi.mock("@/lib/coverage", async (orig) => ({ ...(await orig<typeof import("@/lib/coverage")>()), coverageFor: async () => m.coverage }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(_n: string, f: () => Promise<T>) => f() }));
vi.mock("@/lib/onboarding-progress", () => ({
  onboardingFor: async () => m.progress,
}));
vi.mock("@/lib/home-finance", async (orig) => ({ ...(await orig<typeof import("@/lib/home-finance")>()), homeFinanceFor: async () => m.finance }));
vi.mock("@/lib/home", async (orig) => ({ ...(await orig<typeof import("@/lib/home")>()), homeFor: async () => m.view }));

import { HomePage } from "./home-page";

const view = (over: Partial<HomeView> = {}): HomeView => ({ calendar: "not_connected", meetings: [], upcoming: [], feeds: [], unreadImportant: null, attention: [], ...over });

type El = ReactElement<{ children?: ReactNode; fallback?: ReactNode; actions?: ReactNode }>;
/** Server components are async functions, which a client render cannot run: resolve them (and their Suspense children) up front. Fallbacks are collected. */
async function resolve(node: ReactNode, fallbacks: ReactNode[]): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolve(n, fallbacks)));
  if (!isValidElement(node)) return node;
  const el = node as El;
  if (el.type === Suspense) {
    fallbacks.push(el.props.fallback);
    return resolve(el.props.children, fallbacks);
  }
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolve(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props), fallbacks);
  }
  // PageHeader's `actions` is a prop, not children: resolve it too (the status dot lives there).
  const actions = el.props.actions;
  const extra = actions === undefined ? undefined : { actions: await resolve(actions, fallbacks) };
  if (el.props.children === undefined) return extra ? cloneElement(el, extra) : el;
  return cloneElement(el, extra, await resolve(el.props.children, fallbacks));
}

async function draw() {
  const fallbacks: ReactNode[] = [];
  render(<>{await resolve(await HomePage({ params: Promise.resolve({ laneId: "PKG" }) }), fallbacks)}</>);
  return fallbacks;
}
afterEach(() => {
  cleanup();
  m.progress = null;
  m.coverage = { items: [], unavailable: false };
});

describe("Home layout (T-234 part 1)", () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("row 1: attention 2/3 | calendar column (Next 7 days under it); row 2: five KPIs; row 3: news 2/3 | projects 1/3; in this DOM order (= the phone's single column)", async () => {
    m.view = view();
    await draw();
    const row1 = screen.getByTestId("home-row-attention");
    expect(row1.className).toMatch(/lg:grid-cols-3/);
    const attentionSlot = screen.getByTestId("home-attention-slot");
    const calendarSlot = screen.getByTestId("home-calendar-slot");
    expect(attentionSlot.className).toMatch(/lg:col-span-2/);
    expect(calendarSlot.className).not.toMatch(/col-span/);
    expect(within(attentionSlot).getByRole("region", { name: "Needs your attention" })).toBeTruthy();
    const today = within(calendarSlot).getByRole("region", { name: "Today's calendar" });
    const next7 = within(calendarSlot).getByTestId("next-7-days");
    expect(follows(today, next7)).toBe(true);
    expect(next7.getAttribute("data-open")).toBe("false"); // collapsed by default

    const kpis = screen.getByTestId("home-kpis");
    expect(kpis.className).toMatch(/lg:grid-cols-5/);
    expect(kpis.querySelectorAll("[data-slot=kpi-tile]")).toHaveLength(5);

    const row3 = screen.getByTestId("home-row-news");
    expect(row3.className).toMatch(/lg:grid-cols-3/);
    expect(screen.getByTestId("home-news-slot").className).toMatch(/lg:col-span-2/);
    expect(within(screen.getByTestId("home-news-slot")).getByRole("region", { name: "GovCon news" })).toBeTruthy();
    expect(screen.getByTestId("home-news-slot").textContent).toContain("News not configured");
    expect(within(screen.getByTestId("home-projects-slot")).getByRole("region", { name: "Projects at a glance" })).toBeTruthy();

    // phone order: attention, calendar, KPIs, news, projects
    const order = [attentionSlot, calendarSlot, kpis, screen.getByTestId("home-news-slot"), screen.getByTestId("home-projects-slot")];
    order.forEach((el, i) => {
      const prev = order[i - 1];
      if (prev) expect(follows(prev, el)).toBe(true);
    });
  });

  it("the briefing, Money and Coverage cards are gone from Home; the briefing's summary and Run now live inside 'Needs your attention'", async () => {
    m.view = view();
    await draw();
    expect(screen.queryByRole("region", { name: "Today's briefing" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Money" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Coverage" })).toBeNull();
    expect(screen.queryByTestId("coverage-strip")).toBeNull();
    expect(screen.queryByTestId("coverage-line")).toBeNull();
    expect(screen.queryByTestId("home-finance")).toBeNull();
    const attention = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(attention).getByTestId("ai-briefing")).toBeTruthy();
  });

  it("KPI tiles: Cash book balance, AR, P&L from the finance read; MRR and Paid subscribers not connected", async () => {
    m.view = view();
    await draw();
    const tiles = screen.getAllByTestId("kpi-tile");
    expect(tiles.map((t) => t.getAttribute("data-kpi"))).toEqual(["cash", "ar30", "pnl", "mrr", "subscribers"]);
    expect(tiles.slice(0, 3).every((t) => t.getAttribute("data-status") === "not_connected")).toBe(true); // finance mock: QuickBooks not connected
    expect(tiles.slice(3).every((t) => t.getAttribute("data-status") === "no_data")).toBe(true); // this mock sees no feeds: "Not available yet", never "Not connected"
    expect(within(tiles[0] as HTMLElement).getByText("Book balance")).toBeTruthy();
  });

  it("the header status dot shows only when a source is stale or in error, inside the header, linking to Settings -> Connections", async () => {
    m.view = view();
    await draw();
    expect(screen.queryByTestId("coverage-dot")).toBeNull(); // all quiet: nothing in the header
    cleanup();
    m.coverage = { items: [{ stream: "mail", account: "a@pubk.test", connectionId: "c", provider: "google", status: "active", configured: true, lastSyncAt: null, errorKind: null, state: "stale", reason: "Not synced yet." }], unavailable: false };
    await draw();
    const dot = screen.getByTestId("coverage-dot");
    expect(dot.closest("header")).toBeTruthy();
    expect(dot.getAttribute("href")).toBe("/PKG/settings#connections");
    expect(dot.getAttribute("aria-label")).toMatch(/stale or in error/);
  });

  it("cards use the shared card look: 12px radius token, subtle shadow", async () => {
    m.view = view();
    await draw();
    for (const el of [screen.getByRole("region", { name: "Needs your attention" }), screen.getByRole("region", { name: "GovCon news" }), screen.getAllByTestId("kpi-tile")[0] as HTMLElement]) {
      expect(el.className).toMatch(/rounded-card/);
      expect(el.className).toMatch(/shadow-card/);
    }
  });

  it("the setup banner's Suspense slot is reserved while it loads (phone only) and the banner has the same height", async () => {
    m.view = view();
    m.progress = { done: 2, total: 10 };
    const fallbacks = await draw();
    const slot = fallbacks.map((f) => (isValidElement(f) ? (f as ReactElement<{ "data-testid"?: string; className?: string }>) : null)).find((f) => f?.props["data-testid"] === "setup-banner-slot");
    expect(slot?.props.className).toMatch(/md:hidden/);
    expect(slot?.props.className).toMatch(/h-\[3\.25rem\]/);
    expect(screen.getByTestId("onboarding-banner").className).toMatch(/h-\[3\.25rem\]/);
  });

  it("the streaming fallback of the cards has the same grid as the page (2/3 + 1/3, five KPI tiles, 2/3 + 1/3)", async () => {
    m.view = view();
    const fallbacks = await draw();
    cleanup();
    const skeleton = fallbacks.find((f) => isValidElement(f) && (f.type as { name?: string }).name === "HomeSkeleton");
    expect(skeleton).toBeTruthy();
    render(<>{skeleton}</>);
    const root = screen.getByTestId("card-skeleton");
    expect(root.querySelector(".lg\\:grid-cols-5")?.children).toHaveLength(5);
    expect(root.querySelectorAll(".lg\\:grid-cols-3")).toHaveLength(2);
  });
});
