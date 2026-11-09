// @vitest-environment jsdom
// T-230 B: the Home grid. Briefing full width; the four figure cards in one row (2 x 2 on a phone); "Needs your attention" takes
// two thirds and "Today's meetings" one third; "Projects at a glance" is one line while no board is connected; the phone-only
// setup banner has a reserved slot while it loads. Data comes from lib/home (mocked here); only the structure is checked.
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { HomeView } from "@/lib/home";

const m = vi.hoisted(() => ({ view: null as unknown, progress: null as unknown }));
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));
vi.mock("@/lib/timed", () => ({ timed: async <T,>(_n: string, f: () => Promise<T>) => f() }));
vi.mock("@/lib/onboarding-progress", () => ({
  onboardingFor: async () => m.progress,
}));
vi.mock("@/lib/home", async (orig) => ({ ...(await orig<typeof import("@/lib/home")>()), homeFor: async () => m.view }));

import { HomePage } from "./home-page";

const view = (over: Partial<HomeView> = {}): HomeView => ({ calendar: "not_connected", meetings: [], upcoming: [], feeds: [], unreadImportant: null, attention: [], ...over });

type El = ReactElement<{ children?: ReactNode; fallback?: ReactNode }>;
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
  if (el.props.children === undefined) return el;
  return cloneElement(el, undefined, await resolve(el.props.children, fallbacks));
}

async function draw() {
  const fallbacks: ReactNode[] = [];
  render(<>{await resolve(await HomePage({ params: Promise.resolve({ laneId: "PKG" }) }), fallbacks)}</>);
  return fallbacks;
}
afterEach(() => {
  cleanup();
  m.progress = null;
});

describe("Home layout", () => {
  it("briefing, then four figure cards in one row (2 x 2 below lg), then 2/3 + 1/3, then the one-line projects notice", async () => {
    m.view = view();
    await draw();
    const kpis = screen.getByTestId("home-kpis");
    expect(kpis.className).toMatch(/grid-cols-2/);
    expect(kpis.className).toMatch(/lg:grid-cols-4/);
    expect(kpis.querySelectorAll("[data-slot=kpi-card]")).toHaveLength(4);

    const grid = screen.getByTestId("home-main-grid");
    expect(grid.className).toMatch(/lg:grid-cols-3/);
    const attention = within(grid).getByRole("region", { name: "Needs your attention" });
    const meetings = within(grid).getByRole("region", { name: "Today's meetings" });
    expect(attention.className).toMatch(/lg:col-span-2/);
    expect(meetings.className).not.toMatch(/col-span/);

    // order in the page: briefing, KPIs, grid, notice
    const order = [screen.getByRole("region", { name: "Today's briefing" }), kpis, grid, screen.getByTestId("projects-notice")];
    order.forEach((el, i) => {
      const prev = order[i - 1];
      if (prev) expect(prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("'Projects at a glance' is one line (a heading and a sentence), not an empty-state card", async () => {
    m.view = view();
    await draw();
    const notice = screen.getByTestId("projects-notice");
    expect(within(notice).getByRole("heading", { level: 2, name: "Projects at a glance" })).toBeTruthy();
    expect(notice.querySelectorAll("p")).toHaveLength(1);
    expect(notice.textContent).toMatch(/No project board connected/);
    expect(notice.querySelector("[data-slot=empty-state]")).toBeNull();
  });

  it("cards use the shared card look: 12px radius token, subtle shadow", async () => {
    m.view = view();
    await draw();
    for (const el of [screen.getByRole("region", { name: "Today's briefing" }), screen.getByRole("region", { name: "Needs your attention" })]) {
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

  it("the streaming fallback of the cards has the same grid as the page (briefing, 4 figures, 2/3 + 1/3)", async () => {
    m.view = view();
    const fallbacks = await draw();
    cleanup();
    const skeleton = fallbacks.find((f) => isValidElement(f) && (f.type as { name?: string }).name === "HomeSkeleton");
    expect(skeleton).toBeTruthy();
    render(<>{skeleton}</>);
    const root = screen.getByTestId("card-skeleton");
    expect(root.querySelector(".lg\\:grid-cols-4")?.children).toHaveLength(4);
    expect(root.querySelector(".lg\\:grid-cols-3")?.children).toHaveLength(2);
  });
});
