// @vitest-environment jsdom
// T-230 B / T-234 part 1 / T-237 part C: the Home grid. Desktop: KPI row, attention 2/3 | Today then GovCon news 1/3, Finance, Projects; the phone
// reorders the same DOM with CSS `order` (attention, Today, KPIs, news, projects; no Finance). The phone-only setup banner has a reserved slot while it loads.
// Data comes from lib (mocked here); only structure is checked.
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { HomeView } from "@/lib/home";

const m = vi.hoisted(() => ({ owner: false, mail: { access: false } as { access: boolean; attention?: unknown[]; more?: number; money?: unknown[]; mailboxOf?: Record<string, string> }, coverage: { items: [], unavailable: false } as unknown, view: null as unknown, progress: null as unknown, detail: { state: "no_access" } as unknown, userName: undefined as string | undefined, finance: { state: "not_connected", asOf: null, lastSyncAt: null, connectionStatus: null, cash: { reason: null, total: null, asOf: null, accounts: [], unmapped: 0 }, ar: { reason: null, over30: null, invoices: 0, unmapped: 0 }, pnl: { reason: null, income: null, expenses: null, net: null, start: null, end: null, method: null, partial: false, asOf: null } } as unknown }));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [], userId: "u1" }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ client: {}, session: { userId: "u1" } }), requireRole: async (_l: string, roles: string[]) => { if (m.owner && roles.includes("owner")) return { client: {}, session: { userId: "u1" } }; throw new Error("not admin"); } }) }));
vi.mock("@/app/[laneId]/briefing-actions", () => ({ ensureFreshBriefing: async () => ({ started: false, gate: "not_stale" }), regenerateBriefing: async () => ({ started: false, gate: "not_stale" }), briefingRunState: async () => null }));
vi.mock("@/lib/briefing-setup", () => ({ aiSetupFailure: () => null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/briefing", async (orig) => ({
  ...(await orig<typeof import("@/lib/briefing")>()),
  briefingFor: async () => ({ viewerTz: "America/New_York", coverage: [], coverageLine: "Coverage: test.", calendar: { access: false }, mail: m.mail.access ? { access: true, attention: [], more: 0, money: [], mailboxOf: {} } : { access: false }, config: {}, mailboxes: [] }),
}));
vi.mock("@/lib/coverage", async (orig) => ({ ...(await orig<typeof import("@/lib/coverage")>()), coverageFor: async () => m.coverage }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(_n: string, f: () => Promise<T>) => f() }));
vi.mock("@/lib/onboarding-progress", () => ({
  onboardingFor: async () => m.progress,
}));
vi.mock("@/lib/first-name", async (orig) => ({ ...(await orig<typeof import("@/lib/first-name")>()), firstNameFor: async () => m.userName }));
vi.mock("@/lib/home-finance", async (orig) => ({ ...(await orig<typeof import("@/lib/home-finance")>()), homeFinanceFor: async () => m.finance }));
vi.mock("@/lib/home-finance-detail", async (orig) => ({ ...(await orig<typeof import("@/lib/home-finance-detail")>()), homeFinanceDetailFor: async () => m.detail }));
vi.mock("@/lib/home", async (orig) => ({ ...(await orig<typeof import("@/lib/home")>()), homeFor: async () => m.view }));

import { HomePage } from "./home-page";
import { toHomeFinance } from "@/lib/home-finance";
import { toHomeFinanceDetail } from "@/lib/home-finance-detail";

const okRow = {
  state: "ok", as_of: "2026-11-11T20:00:00Z", last_sync_at: "2026-11-11T19:55:00Z", connection_status: "active",
  cash_reason: null, cash_total: 1314.66, cash_as_of: "2026-11-10T20:00:00Z", cash_accounts: [], cash_unmapped: 0,
  ar_reason: null, ar_over_30: 160.25, ar_invoices: 3, ar_unmapped: 0,
  pnl_reason: null, pnl_income: 500, pnl_expenses: 200, pnl_net: 300, pnl_start: "2026-11-01", pnl_end: "2026-11-11", pnl_method: "accrual", pnl_partial: false, pnl_as_of: "2026-11-11T20:00:00Z",
};
const allFeeds = [{ provider: "quickbooks", status: "active" }, { provider: "stripe", status: "active" }, { provider: "ghl", status: "active" }];

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
const defaultFinance = m.finance;
const defaultDetail = m.detail;
afterEach(() => {
  cleanup();
  m.finance = defaultFinance;
  m.detail = defaultDetail;
  m.userName = undefined;
  m.progress = null;
  m.owner = false;
  m.mail = { access: false };
  m.coverage = { items: [], unavailable: false };
});

describe("Home layout (T-234 part 1)", () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  const detailRow = { state: "ok", as_of: "2026-11-11T20:00:00Z", bills_due_14_total: 410.5, bills_due_14_count: 2, aging: [{ bucket: "current", total: 100, count: 1 }, { bucket: "1_30", total: 50, count: 1 }, { bucket: "31_60", total: 0, count: 0 }, { bucket: "61_90", total: 20, count: 1 }, { bucket: "90_plus", total: 10, count: 1 }], oldest: [{ customer: "Customer A", balance: 10, days_overdue: 94 }], unmapped_invoices: 0, unmapped_bills: 0 };

  it("desktop order: KPI row, then attention | calendar and news (right column), Finance, Projects; the grid items are placed explicitly from md", async () => {
    m.finance = toHomeFinance([okRow]);
    m.detail = toHomeFinanceDetail([detailRow]);
    m.view = view({ feeds: allFeeds as HomeView["feeds"] });
    await draw();
    const grid = screen.getByTestId("home-grid");
    expect(grid.className).toMatch(/md:grid-cols-3/);
    const kpiSlot = screen.getByTestId("home-kpi-slot");
    const attentionSlot = screen.getByTestId("home-attention-slot");
    const calendarSlot = screen.getByTestId("home-calendar-slot");
    const newsSlot = screen.getByTestId("home-news-slot");
    const financeSlot = screen.getByTestId("home-finance-slot");
    const projectsSlot = screen.getByTestId("home-projects-slot");
    // DOM = desktop reading order
    const order = [kpiSlot, attentionSlot, calendarSlot, newsSlot, financeSlot, projectsSlot];
    order.forEach((el, i) => {
      const prev = order[i - 1];
      if (prev) expect(follows(prev, el)).toBe(true);
    });
    expect(attentionSlot.className).toMatch(/md:col-span-2/);
    expect(calendarSlot.className).toMatch(/md:col-start-3/);
    expect(newsSlot.className).toMatch(/md:col-start-3/);
    expect(within(attentionSlot).getByRole("region", { name: "Needs your attention" })).toBeTruthy();
    const today = within(calendarSlot).getByRole("region", { name: "Today's calendar" });
    // T-237 part E: the visible heading is "Today" with an "Eastern time" note; the region keeps its accessible name.
    expect(within(today).getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(within(today).getByText("Eastern time")).toBeTruthy();
    const next7 = within(calendarSlot).getByTestId("next-7-days");
    expect(follows(today, next7)).toBe(true);
    expect(next7.getAttribute("data-open")).toBe("false"); // collapsed by default
    const kpis = within(kpiSlot).getByTestId("home-kpis");
    expect(kpis.className).toContain("auto-fit");
    expect(kpis.querySelectorAll("[data-slot=kpi-tile]")).toHaveLength(5);
    expect(within(newsSlot).getByRole("region", { name: "GovCon news" })).toBeTruthy(); // slim "off" card here too
    expect(newsSlot.textContent).toContain("GovCon news is off");
    expect(within(financeSlot).getByRole("region", { name: "Finance" })).toBeTruthy();
    expect(within(projectsSlot).getByRole("region", { name: "Projects at a glance" })).toBeTruthy();
  });

  it("phone order by CSS `order` classes on the one DOM: attention, Today, KPIs, news, projects; Finance is hidden below md", async () => {
    m.finance = toHomeFinance([okRow]);
    m.detail = toHomeFinanceDetail([detailRow]);
    m.view = view({ feeds: allFeeds as HomeView["feeds"] });
    await draw();
    const ord = (id: string) => Number(/(?:^|\s)order-(\d)(?:\s|$)/.exec(screen.getByTestId(id).className)?.[1] ?? "0");
    const phone = ["home-attention-slot", "home-calendar-slot", "home-kpi-slot", "home-news-slot", "home-projects-slot"].map(ord);
    expect(phone).toEqual([...phone].sort((a, b) => a - b));
    expect(new Set(phone).size).toBe(5);
    for (const id of ["home-attention-slot", "home-calendar-slot", "home-kpi-slot", "home-news-slot", "home-projects-slot"]) expect(screen.getByTestId(id).className).toMatch(/md:order-none/);
    expect(screen.getByTestId("home-finance-slot").className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByTestId("home-finance-slot").className).toMatch(/md:block/);
    // nothing is rendered twice
    expect(screen.getAllByRole("region", { name: "Needs your attention" })).toHaveLength(1);
    expect(screen.getAllByTestId("home-kpis")).toHaveLength(1);
  });

  it("the heading says 'Good morning' with the profile's first name when there is one, else plain 'Good morning'", async () => {
    m.view = view();
    await draw();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning");
    cleanup();
    m.userName = "Dana";
    await draw();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good morning, Dana");
    expect(screen.getByRole("link", { name: "Ask Jarvis" })).toBeTruthy();
  });

  it("Finance is hidden when QuickBooks is not connected and for a role without the finance view", async () => {
    m.view = view();
    await draw();
    expect(screen.queryByTestId("home-finance")).toBeNull(); // the default mock is not_connected
    cleanup();
    m.finance = { state: "no_access" };
    await draw();
    expect(screen.queryByTestId("home-finance")).toBeNull();
    expect(screen.queryAllByTestId("kpi-tile")).toHaveLength(0);
  });

  it("the briefing, Money and Coverage cards are gone from Home; the briefing's summary lives inside 'Needs your attention'", async () => {
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

  it("KPI tiles: Cash book balance, AR, bills, net income from the finance reads; MRR only when Stripe is connected", async () => {
    m.finance = toHomeFinance([okRow]);
    m.view = view({ feeds: [{ provider: "quickbooks", status: "active" }] as HomeView["feeds"] });
    await draw();
    const tiles = screen.getAllByTestId("kpi-tile");
    expect(tiles.map((t) => t.getAttribute("data-kpi"))).toEqual(["cash", "ar30", "bills14", "pnl"]);
    expect(within(tiles[0] as HTMLElement).getByText("Book balance")).toBeTruthy();
  });

  it("nothing connected: no tiles; a caller who cannot connect (not owner / admin in this mock) sees no banner either", async () => {
    m.view = view();
    await draw();
    expect(screen.queryAllByTestId("kpi-tile")).toHaveLength(0);
    expect(screen.queryByTestId("home-kpis-banner")).toBeNull(); // the banner for owner / admin is in home-widgets.test.tsx
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
    m.finance = toHomeFinance([okRow]);
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

  it("the streaming fallback of the cards has the same grid as the page (2/3 + 1/3, one slim KPI bar, two slim blocks)", async () => {
    m.view = view();
    const fallbacks = await draw();
    cleanup();
    const skeleton = fallbacks.find((f) => isValidElement(f) && (f.type as { name?: string }).name === "HomeSkeleton");
    expect(skeleton).toBeTruthy();
    render(<>{skeleton}</>);
    const root = screen.getByTestId("card-skeleton");
    expect(root.querySelector(".lg\\:grid-cols-5")).toBeNull();
    expect(screen.getByTestId("kpi-skeleton").className).toMatch(/\bh-10\b/);
    expect(root.querySelectorAll(".lg\\:grid-cols-3")).toHaveLength(1);
    const row3 = screen.getByTestId("news-skeleton-row");
    expect(row3.className).toMatch(/\bmd:grid-cols-2\b/);
    expect(row3.className).not.toMatch(/lg:grid-cols-3/);
    expect([...row3.children].every((c) => /\bh-12\b/.test(c.className))).toBe(true);
  });
});

describe("the automatic summary controls (T-235 part 1)", () => {
  it("shown to the owner who has mail access; hidden without mail access (no auto-run without sources) and for a non-owner", async () => {
    m.view = view();
    m.owner = true;
    m.mail = { access: true };
    await draw();
    expect(screen.getByTestId("briefing-menu-button")).toBeTruthy();
    cleanup();
    m.mail = { access: false };
    await draw();
    expect(screen.queryByTestId("briefing-menu-button")).toBeNull();
    cleanup();
    m.owner = false;
    m.mail = { access: true };
    await draw();
    expect(screen.queryByTestId("briefing-menu-button")).toBeNull();
  });
});
