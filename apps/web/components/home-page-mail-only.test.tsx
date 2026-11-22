// @vitest-environment jsdom
// T-265: Home of a mail-only company (lane_config limits itself to comms, calendar, briefing). Synthetic. The stored row is read through the
// real gate (lib/lane-modules.ts), so this shows what a company with mail and calendar only sees: its mail and calendar sections, and none
// of the finance tiles, the QuickBooks strip, the approvals banner, the Projects and GovCon news cards, Ask Jarvis or the setup banner.
// The same page with a company that does not limit itself is the control: there the QuickBooks strip, the cards and Ask Jarvis are drawn.
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { HomeView } from "@/lib/home";

const m = vi.hoisted(() => ({
  row: null as unknown,
  waiting: 2,
  financeCalls: 0,
}));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "XX", name: "Synthetic Co", lanes: [], userId: "u1" }) }));
const client = () => ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.row, error: null }) }) }) }) }) });
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ client: client(), session: { userId: "u1" } }), requireRole: async () => ({ client: client(), session: { userId: "u1" } }) }) }));
vi.mock("@/app/[laneId]/briefing-actions", () => ({ ensureFreshBriefing: async () => ({ started: false, gate: "not_stale" }), regenerateBriefing: async () => ({ started: false, gate: "not_stale" }), briefingRunState: async () => null }));
vi.mock("@/lib/briefing-setup", () => ({ aiSetupFailure: () => null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), redirect: () => undefined }));
vi.mock("@/lib/briefing", async (orig) => ({
  ...(await orig<typeof import("@/lib/briefing")>()),
  briefingFor: async () => ({ viewerTz: "America/New_York", coverage: [], coverageLine: "Coverage: test.", calendar: { access: false }, mail: { access: false }, config: { attention: { fresh_hours: 48 } }, mailboxes: [] }),
}));
vi.mock("@/lib/coverage", async (orig) => ({ ...(await orig<typeof import("@/lib/coverage")>()), coverageFor: async () => ({ items: [], unavailable: false }) }));
vi.mock("@/lib/job-failures", async (orig) => ({ ...(await orig<typeof import("@/lib/job-failures")>()), jobFailureBannerFor: async () => null }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(_n: string, f: () => Promise<T>) => f() }));
vi.mock("@/lib/onboarding-progress", () => ({ onboardingFor: async () => ({ done: 1, total: 10 }) }));
vi.mock("@/lib/first-name", async (orig) => ({ ...(await orig<typeof import("@/lib/first-name")>()), firstNameFor: async () => undefined }));
vi.mock("@/lib/approvals", async (orig) => ({ ...(await orig<typeof import("@/lib/approvals")>()), waitingCount: async () => m.waiting }));
vi.mock("@/lib/news", async (orig) => ({ ...(await orig<typeof import("@/lib/news")>()), loadNewsCard: async () => ({ configured: false, isAdmin: true, canRefresh: false }) }));
vi.mock("@/lib/home-finance", async (orig) => ({
  ...(await orig<typeof import("@/lib/home-finance")>()),
  homeFinanceFor: async () => {
    m.financeCalls += 1;
    return { state: "not_connected", asOf: null, lastSyncAt: null, connectionStatus: null, cash: { reason: null, total: null, asOf: null, accounts: [], unmapped: 0 }, ar: { reason: null, over30: null, invoices: 0, unmapped: 0 }, pnl: { reason: null, income: null, expenses: null, net: null, start: null, end: null, method: null, partial: false, asOf: null } };
  },
  hasFinanceView: async () => true,
}));
vi.mock("@/lib/home-finance-detail", async (orig) => ({ ...(await orig<typeof import("@/lib/home-finance-detail")>()), homeFinanceDetailFor: async () => ({ state: "not_connected" }) }));
vi.mock("@/lib/home", async (orig) => ({ ...(await orig<typeof import("@/lib/home")>()), homeFor: async () => ({ calendar: "not_connected", meetings: [], upcoming: [], feeds: [], unreadImportant: null, attention: [] }) satisfies HomeView }));

import { HomePage } from "./home-page";

type El = ReactElement<{ children?: ReactNode; fallback?: ReactNode; actions?: ReactNode; title?: ReactNode }>;
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolve(n)));
  if (!isValidElement(node)) return node;
  const el = node as El;
  if (el.type === Suspense) return resolve(el.props.children);
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  const actions = el.props.actions;
  const title = el.props.title;
  const extra = actions === undefined && title === undefined ? undefined : { ...(actions === undefined ? {} : { actions: await resolve(actions) }), ...(title === undefined ? {} : { title: await resolve(title) }) };
  if (el.props.children === undefined) return extra ? cloneElement(el, extra) : el;
  return cloneElement(el, extra, await resolve(el.props.children));
}
async function draw() {
  render(<>{await resolve(await HomePage({ params: Promise.resolve({ laneId: "XX" }) }))}</>);
}
afterEach(() => {
  cleanup();
  m.financeCalls = 0;
  m.waiting = 2;
});

const MAIL_ONLY = { modules: ["comms", "calendar", "briefing"], limited: true, news: null };
const UNLIMITED = { modules: ["comms"], limited: null, news: null };

describe("Home of a mail-only company (T-265)", () => {
  it("shows mail and calendar and none of the finance, approvals, projects, news, assistant or setup parts", async () => {
    m.row = MAIL_ONLY;
    await draw();
    expect(screen.getByTestId("home-attention-slot")).toBeTruthy();
    expect(screen.getByTestId("home-calendar-slot")).toBeTruthy();
    for (const id of ["home-kpi-slot", "home-finance-slot", "home-news-slot", "home-projects-slot"]) expect(screen.getByTestId(id).childElementCount, id).toBe(0);
    expect(screen.queryByTestId("qb-strip")).toBeNull();
    expect(screen.queryByTestId("home-kpis")).toBeNull();
    expect(screen.queryByText(/QuickBooks/)).toBeNull();
    expect(screen.queryByTestId("approvals-waiting")).toBeNull();
    expect(screen.queryByTestId("projects-notice")).toBeNull();
    expect(screen.queryByTestId("news-empty")).toBeNull();
    expect(screen.queryByRole("link", { name: "Ask Jarvis" })).toBeNull();
    expect(screen.queryByTestId("onboarding-banner")).toBeNull();
    expect(m.financeCalls, "no QuickBooks read at all").toBe(0);
  });

  it("a company that does not limit itself still shows the QuickBooks strip, the cards, Ask Jarvis and the approvals banner (nothing changes for it)", async () => {
    m.row = UNLIMITED;
    await draw();
    expect(screen.getByTestId("qb-strip")).toBeTruthy();
    expect(screen.getByTestId("projects-notice")).toBeTruthy();
    expect(screen.getByTestId("news-empty")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ask Jarvis" })).toBeTruthy();
    expect(screen.getByTestId("approvals-waiting")).toBeTruthy();
    expect(screen.getByTestId("onboarding-banner")).toBeTruthy();
    expect(m.financeCalls).toBeGreaterThan(0);
  });

  it("an unreadable config row never hides anything (it only draws less when the row says so)", async () => {
    m.row = null;
    await draw();
    expect(screen.getByRole("link", { name: "Ask Jarvis" })).toBeTruthy();
    expect(screen.getByTestId("qb-strip")).toBeTruthy();
  });

  it("a limited company that lists approvals, projects and news shows them", async () => {
    m.row = { modules: ["comms", "calendar", "briefing", "approvals", "projects", "assistant"], limited: true, news: { enabled: true } };
    await draw();
    expect(screen.getByTestId("approvals-waiting")).toBeTruthy();
    expect(screen.getByTestId("projects-notice")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ask Jarvis" })).toBeTruthy();
    expect(screen.queryByTestId("qb-strip")).toBeNull();
  });
});
