// @vitest-environment jsdom
// T-226: Settings drops the "not set up yet" placeholder whenever any real section renders, and the AI brain card is a compact
// status list (chip + Edit into the wizard at that step) with Continue setup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GROUPS } from "@nichols/brain/interview";

const m = vi.hoisted(() => ({
  result: null as unknown,
  google: null as unknown,
  composio: null as unknown,
  quickbooks: null as unknown,
  brain: null as unknown,
  news: null as unknown,
  origin: null as unknown,
  coverage: { items: [], unavailable: false } as unknown,
  // T-230 A: records when each loader starts, the guards it got, and lets a test hold every loader open.
  started: [] as string[],
  seenGuards: [] as unknown[],
  gate: null as Promise<void> | null,
  sharedGuards: {},
}));
const loader = <T,>(name: string, value: () => T) => async (g?: unknown) => {
  m.started.push(name);
  m.seenGuards.push(g);
  await m.gate;
  return value();
};

vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => m.sharedGuards }));
vi.mock("@/lib/connect-result", () => ({ connectResultFor: (g: unknown) => loader("result", () => m.result)(g) }));
vi.mock("@/lib/quickbooks-connection", () => ({ quickbooksSectionFor: (g: unknown) => loader("quickbooks", () => m.quickbooks)(g) }));
vi.mock("@/lib/google-connection", () => ({ googleSectionFor: (g: unknown) => loader("google", () => m.google)(g) }));
vi.mock("@/lib/composio-availability", () => ({ availability: () => ({}), missingSettings: () => ({}) }));
vi.mock("@/lib/composio-connection", () => ({ composioSectionFor: (g: unknown) => loader("composio", () => m.composio)(g) }));
vi.mock("@/lib/news-settings", () => ({ newsSectionFor: async () => m.news }));
vi.mock("@/lib/coverage", () => ({ coverageFor: (g: unknown) => loader("coverage", () => m.coverage)(g) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/origin-notice-server", () => ({ currentOriginNotice: async () => m.origin }));
vi.mock("@/lib/onboarding-progress", () => ({ onboardingFor: () => loader("brain", () => m.brain)() }));
vi.mock("./connections-section", () => ({
  ConnectionsSection: ({ google, quickbooks, composio, coverage }: { google: unknown; quickbooks: unknown; composio: unknown; coverage?: unknown }) => (
    <div data-testid="connections-section" data-coverage={String(Boolean(coverage))} data-google={String(Boolean(google))} data-quickbooks={String(Boolean(quickbooks))} data-composio={String(Boolean(composio))} />
  ),
}));
// The shared module page is async (a server component); here only whether it is asked to draw the placeholder matters.
vi.mock("./module-page", () => ({ ModulePage: ({ placeholder }: { placeholder?: boolean }) => <div data-testid="module-page" data-placeholder={String(placeholder)} /> }));

import { SettingsPage } from "./settings-page";

const props = { params: Promise.resolve({ laneId: "PKG" }), searchParams: Promise.resolve({}) };
const view = (done: number) => ({
  done,
  total: GROUPS.length,
  sections: GROUPS.map((g, i) => ({ id: g.id, title: g.title, done: i < done })),
  nextSectionId: GROUPS[done]?.id ?? null,
});

beforeEach(() => {
  m.result = m.google = m.composio = m.brain = m.origin = m.news = null;
  m.quickbooks = null;
  m.coverage = { items: [], unavailable: false };
  m.started = [];
  m.seenGuards = [];
  m.gate = null;
});
afterEach(cleanup);

async function draw() {
  render(await SettingsPage(props));
  return screen.getByTestId("module-page").getAttribute("data-placeholder");
}

describe("Settings page sections", () => {
  it("keeps the placeholder only when nothing real renders", async () => {
    expect(await draw()).toBe("true");
  });

  it.each([
    ["the connect result", () => (m.result = { tone: "success", title: "Google connected", description: "x" })],
    ["the Google section", () => (m.google = { connections: [] })],
    ["the Composio section", () => (m.composio = { toolkits: [] })],
    ["the AI brain card", () => (m.brain = view(3))],
    ["the QuickBooks row", () => (m.quickbooks = { connections: [] })],
  ])("hides the placeholder when %s renders", async (_name, set) => {
    set();
    expect(await draw()).toBe("false");
  });

  it("AI brain is a compact status list: a chip per section, Edit into the wizard at that step, Continue setup", async () => {
    m.brain = view(3);
    await draw();
    const list = screen.getByTestId("brain-status-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(GROUPS.length);
    expect(within(rows[0] as HTMLElement).getByText("Done")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Not done")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByRole("link", { name: /Edit/ }).getAttribute("href")).toBe(`/PKG/onboarding?step=${GROUPS[3]?.id ?? ""}`);
    expect(screen.getByRole("link", { name: "Continue setup" }).getAttribute("href")).toBe("/PKG/onboarding");
    expect(screen.getByRole("link", { name: "Import memories" }).getAttribute("href")).toBe("/PKG/onboarding/import"); // T-220
    expect(screen.getByText(/3 of 10 sections done/)).toBeTruthy();
    // the full interview is not embedded any more
    expect(screen.queryByTestId("brain-interview")).toBeNull();
  });

  it("with an unreadable status the list shows no chips (never a guess)", async () => {
    m.brain = { ...view(0), done: null };
    await draw();
    expect(screen.queryByText("Not done")).toBeNull();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
  });

  it("shows the fixed 'not configured' banner from the connect result, once, with the names written on the page", async () => {
    m.result = { tone: "alert", title: "Google isn't configured on this server.", description: "Check GOOGLE_REDIRECT_URI and NEXT_PUBLIC_APP_URL (same https domain) and redeploy." };
    await draw();
    expect(screen.getByTestId("connect-result").textContent).toBe("Google isn't configured on this server.Check GOOGLE_REDIRECT_URI and NEXT_PUBLIC_APP_URL (same https domain) and redeploy.");
  });

  it("shows the origin notice (hosts only) to users who can connect, and nothing when the hosts match", async () => {
    m.google = { connections: [] };
    m.origin = { currentHost: "preview.example.test", appHost: "portal.example.test", appUrl: "https://portal.example.test" };
    await draw();
    const n = screen.getByTestId("origin-notice");
    expect(n.textContent).toBe("You're on preview.example.test. Open portal.example.test to connect accounts.");
    expect(within(n).getByRole("link").getAttribute("href")).toBe("https://portal.example.test");
    cleanup();
    m.origin = null;
    await draw();
    expect(screen.queryByTestId("origin-notice")).toBeNull();
  });

  it("does not look at the origin for users who cannot connect (no Google or Composio section)", async () => {
    m.origin = { currentHost: "preview.example.test", appHost: "portal.example.test", appUrl: "https://portal.example.test" };
    await draw();
    expect(screen.queryByTestId("origin-notice")).toBeNull();
  });
});

describe("layout (T-230 B)", () => {
  const navLabels = () => within(screen.getByTestId("settings-nav")).getAllByRole("link").map((a) => `${a.textContent ?? ""}|${a.getAttribute("href") ?? ""}`);

  it("two columns: a sub-nav with anchors to exactly the sections drawn", async () => {
    m.google = { connections: [] };
    m.composio = { toolkits: [] };
    m.brain = view(2);
    await draw();
    expect(navLabels()).toEqual(["Connections|#connections", "AI brain|#ai-brain"]);
    // one Connections section carries every provider
    const c = screen.getByTestId("connections-section");
    expect(c.getAttribute("data-google")).toBe("true");
    expect(c.getAttribute("data-composio")).toBe("true");
    expect(screen.getAllByTestId("connections-section")).toHaveLength(1);
    expect(screen.getByTestId("settings-nav").parentElement?.className).toMatch(/lg:grid-cols-\[200px_minmax\(0,1fr\)\]/);
  });

  it("the nav follows the visibility rules: a viewer with nothing gets no nav and no sections", async () => {
    await draw();
    expect(screen.queryByTestId("settings-nav")).toBeNull();
    expect(screen.queryByTestId("connections-section")).toBeNull();
  });

  it("only Composio visible: Connections is still one entry; there is no Developer tools section any more (T-233)", async () => {
    m.composio = { toolkits: [] };
    await draw();
    expect(navLabels()).toEqual(["Connections|#connections"]);
    expect(screen.getByTestId("connections-section").getAttribute("data-google")).toBe("false");
    expect(screen.getByTestId("connections-section").getAttribute("data-quickbooks")).toBe("false");
    expect(screen.queryByText("Developer tools")).toBeNull();
  });

  it("only the QuickBooks row visible: Connections is drawn with it", async () => {
    m.quickbooks = { connections: [] };
    await draw();
    expect(navLabels()).toEqual(["Connections|#connections"]);
    expect(screen.getByTestId("connections-section").getAttribute("data-quickbooks")).toBe("true");
  });
});

describe("Coverage (T-234 part 1: moved here from Home)", () => {
  const item = { stream: "mail", account: "a@pubk.test", connectionId: "c", provider: "google", status: "active", configured: true, lastSyncAt: null, errorKind: null, state: "ok", reason: null };
  it("a viewer with coverage rows gets Connections (with Coverage) and the sub-nav entry, and no placeholder", async () => {
    m.coverage = { items: [item], unavailable: false };
    expect(await draw()).toBe("false");
    expect(screen.getByTestId("connections-section").getAttribute("data-coverage")).toBe("true");
    expect(navLabelsOf()).toEqual(["Connections|#connections"]);
  });
  it("an outage is shown in Coverage, not hidden", async () => {
    m.coverage = { items: [], unavailable: true };
    await draw();
    expect(screen.getByTestId("connections-section").getAttribute("data-coverage")).toBe("true");
  });
  it("no coverage rows and no providers: no Connections section", async () => {
    await draw();
    expect(screen.queryByTestId("connections-section")).toBeNull();
  });
});
describe("GovCon news status (T-234 part 4)", () => {
  const view = { webAllowed: true, enabled: true, capUsd: 20, monthSpendUsd: 1.5, monthFetches: 3, lastStatus: "ok", lastFailure: null, lastFetchAt: "2026-11-12T11:00:00Z" };
  it("owner / admin_technical: a News section with its own nav entry; nobody else gets one", async () => {
    m.news = view;
    await draw();
    expect(screen.getByTestId("news-section")).toBeTruthy();
    expect(within(screen.getByTestId("settings-nav")).getByRole("link", { name: "GovCon news" }).getAttribute("href")).toBe("#news");
    cleanup();
    m.news = null;
    await draw();
    expect(screen.queryByTestId("news-section")).toBeNull();
  });
});
const navLabelsOf = () => within(screen.getByTestId("settings-nav")).getAllByRole("link").map((a) => `${a.textContent ?? ""}|${a.getAttribute("href") ?? ""}`);

describe("loading (T-230 A)", () => {
  it("starts every independent loader at once, with the one guards object, instead of one after the other", async () => {
    let release = () => {};
    m.gate = new Promise<void>((r) => (release = r));
    m.quickbooks = { connections: [] };
    const drawing = SettingsPage(props);
    await new Promise((r) => setTimeout(r, 10));
    expect(m.started.sort()).toEqual(["brain", "composio", "coverage", "google", "quickbooks", "result"]); // all six under way before any answers
    expect(m.seenGuards.filter((g) => g !== undefined).every((g) => g === m.sharedGuards)).toBe(true);
    release();
    render(await drawing);
    expect(screen.getByTestId("connections-section").getAttribute("data-quickbooks")).toBe("true");
  });

  it("an outage in one loader is still an error, never a half-drawn page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.gate = Promise.reject(new Error("outage"));
    m.gate.catch(() => undefined);
    await expect(SettingsPage(props)).rejects.toThrow("outage");
  });
});
