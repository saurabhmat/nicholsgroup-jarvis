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
  test: false,
  brain: null as unknown,
  origin: null as unknown,
}));

vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({}) }));
vi.mock("@/lib/connect-result", () => ({ connectResultFor: async () => m.result }));
vi.mock("@/lib/connection-test", () => ({ connectionTestVisible: async () => m.test }));
vi.mock("@/lib/google-connection", () => ({ googleSectionFor: async () => m.google }));
vi.mock("@/lib/composio-availability", () => ({ availability: () => ({}), missingSettings: () => ({}) }));
vi.mock("@/lib/composio-connection", () => ({ composioSectionFor: async () => m.composio }));
vi.mock("@/lib/origin-notice-server", () => ({ currentOriginNotice: async () => m.origin }));
vi.mock("@/lib/onboarding-progress", () => ({ onboardingFor: async () => m.brain }));
vi.mock("./google-connection-section", () => ({ GoogleConnectionSection: () => <div data-testid="google-section" /> }));
vi.mock("./composio-connection-section", () => ({ ComposioConnectionSection: () => <div data-testid="composio-section" /> }));
vi.mock("./connection-test-section", () => ({ ConnectionTestSection: () => <div data-testid="test-section" /> }));
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
  m.result = m.google = m.composio = m.brain = m.origin = null;
  m.test = false;
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
    ["the connection test", () => (m.test = true)],
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
