// @vitest-environment jsdom
// T-226: Settings drops the "not set up yet" placeholder whenever any real section renders, and the AI brain card is a compact
// status list (chip + Edit into the wizard at that step) with Continue setup.
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GROUPS } from "@nichols/brain/interview";

const m = vi.hoisted(() => ({
  result: null as unknown,
  google: null as unknown,
  microsoft: null as unknown,
  providerReads: 0,
  newsCalls: 0,
  providersView: null as unknown,
  providersSeen: [] as unknown[],
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
  sharedGuards: {} as unknown,
  // T-276: the cheap role answers that decide the sub-navigation (owner and admin_technical; owner alone; the roles that see the mail account rows).
  admin: true,
  owner: false,
  mail: true,
  newsShown: false,
  roleReads: [] as string[],
  // T-271: modules the company hides. The older tests run with Approvals and Assistant hidden, so they keep testing the other sections alone.
  hidden: [] as string[] | null, // null = the real lane gate (the T-265 tests read lane_config through the guards)
}));
const loader = <T,>(name: string, value: () => T) => async (g?: unknown) => {
  m.started.push(name);
  m.seenGuards.push(g);
  await m.gate;
  return value();
};

vi.mock("@/lib/lane-modules", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/lane-modules")>();
  return {
    ...actual,
    laneGate: async (laneId: string) => {
      const hidden = m.hidden;
      return hidden === null ? actual.laneGate(laneId) : { limited: hidden.length > 0, visible: (mod: string) => !hidden.includes(mod), newsShown: m.newsShown };
    },
  };
});
vi.mock("@/lib/lane-page", () => ({ loadLane: async () => ({ laneId: "PKG", name: "Pub K Group", lanes: [] }) }));
vi.mock("@/lib/guards", () => ({ guards: async () => m.sharedGuards }));
const roleGuards = (extra: object = {}) => ({
  requireRole: async (_l: string, roles: string[]) => {
    m.roleReads.push(roles.join(","));
    const ok = roles.includes("viewer") ? m.mail : roles.length === 1 ? m.owner : m.admin;
    if (!ok) throw new Error("not allowed");
    return { client: {}, session: { userId: "u" } };
  },
  ...extra,
});
vi.mock("@/lib/connect-result", () => ({ connectResultFor: (g: unknown) => loader("result", () => m.result)(g) }));
vi.mock("@/lib/quickbooks-connection", () => ({ quickbooksSectionFor: (g: unknown) => loader("quickbooks", () => m.quickbooks)(g) }));
vi.mock("@/lib/google-connection", () => ({ googleSectionFor: (g: unknown) => loader("google", () => m.google)(g) }));
// T-257: not recorded in `m.started` (the loader-list test below is unchanged); the providers read is counted on its own.
vi.mock("@/lib/mail-providers", () => ({ mailProvidersFor: async () => { m.providerReads += 1; return m.providersView ?? { state: "known", google: true, microsoft: null }; } }));
vi.mock("@/lib/microsoft-connection", () => ({ microsoftSectionFor: async (_g: unknown, _l: string, providers: unknown) => { m.providersSeen.push(providers); return m.microsoft; } }));
vi.mock("@/lib/composio-availability", () => ({ availability: () => ({}), missingSettings: () => ({}) }));
vi.mock("@/lib/composio-connection", () => ({ composioSectionFor: (g: unknown) => loader("composio", () => m.composio)(g) }));
vi.mock("@/lib/news-settings", () => ({ newsSectionFor: async () => { m.newsCalls += 1; return m.news; } }));
vi.mock("@/lib/coverage", () => ({ coverageFor: (g: unknown) => loader("coverage", () => m.coverage)(g) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/origin-notice-server", () => ({ currentOriginNotice: async () => m.origin }));
vi.mock("@/lib/onboarding-progress", () => ({ onboardingFor: () => loader("brain", () => m.brain)() }));
vi.mock("./connections-section", () => ({
  ConnectionsSection: ({ google, microsoft, quickbooks, composio, coverage }: { google: unknown; microsoft?: unknown; quickbooks: unknown; composio: unknown; coverage?: unknown }) => (
    <div data-testid="connections-section" data-coverage={String(Boolean(coverage))} data-google={String(Boolean(google))} data-microsoft={String(Boolean(microsoft))} data-quickbooks={String(Boolean(quickbooks))} data-composio={String(Boolean(composio))} />
  ),
}));
// The shared module page is async (a server component); here only whether it is asked to draw the placeholder matters.
vi.mock("./module-page", () => ({
  ModulePage: ({ placeholder }: { placeholder?: boolean }) => <div data-testid="module-page" data-placeholder={String(placeholder)} />,
  ModulePlaceholder: () => <div data-testid="module-placeholder" />,
}));

import { SettingsPage } from "./settings-page";


type El = ReactElement<{ children?: ReactNode; fallback?: ReactNode }>;
/** Server components are async functions, which a client render cannot run: resolve them (and their Suspense children) up front. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolve(n)));
  if (!isValidElement(node)) return node;
  const el = node as El;
  if (el.type === Suspense) return resolve(el.props.children);
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolve(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  if (el.props.children === undefined) return el;
  return cloneElement(el, undefined, await resolve(el.props.children));
}

const props = { params: Promise.resolve({ laneId: "PKG" }), searchParams: Promise.resolve({}) };
const view = (done: number) => ({
  done,
  total: GROUPS.length,
  sections: GROUPS.map((g, i) => ({ id: g.id, title: g.title, done: i < done })),
  nextSectionId: GROUPS[done]?.id ?? null,
});

beforeEach(() => {
  m.microsoft = null;
  m.providerReads = 0;
  m.providersSeen = [];
  m.result = m.google = m.composio = m.brain = m.origin = m.news = null;
  m.quickbooks = null;
  m.coverage = { items: [], unavailable: false };
  m.newsCalls = 0;
  m.providersView = null;
  m.started = [];
  m.seenGuards = [];
  m.gate = null;
  m.hidden = ["approvals", "assistant"];
  m.admin = true;
  m.owner = false;
  m.mail = true;
  m.newsShown = false;
  m.roleReads = [];
  m.sharedGuards = roleGuards();
});
afterEach(cleanup);

async function draw() {
  render(<>{await resolve(await SettingsPage(props))}</>);
  // The header never draws the card (T-276); the "not set up yet" card is its own element, drawn when no section can exist for this viewer.
  return screen.queryByTestId("module-placeholder") ? "true" : "false";
}
const noRoles = () => {
  m.admin = m.owner = m.mail = false;
};

describe("Settings page sections", () => {
  it("keeps the placeholder only when no section can exist for this viewer", async () => {
    noRoles();
    expect(await draw()).toBe("true");
  });

  it.each([
    ["the connect result", () => (m.result = { tone: "success", title: "Google connected", description: "x" })],
    ["the Google section", () => (m.google = { connections: [] })],
    ["the Composio section", () => (m.composio = { toolkits: [] })],
    ["the AI brain card", () => (m.brain = view(3))],
    ["the QuickBooks row", () => (m.quickbooks = { connections: [] })],
  ])("hides the placeholder when %s renders", async (_name, set) => {
    m.owner = true;
    set();
    expect(await draw()).toBe("false");
  });

  it("AI brain is a compact status list: a chip per section, Edit into the wizard at that step, Continue setup", async () => {
    m.owner = true;
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
    m.owner = true;
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
    noRoles();
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
    m.owner = true;
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
    noRoles();
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
    m.newsShown = true;
    m.news = view;
    await draw();
    expect(screen.getByTestId("news-section")).toBeTruthy();
    expect(within(screen.getByTestId("settings-nav")).getByRole("link", { name: "GovCon news" }).getAttribute("href")).toBe("#news");
    cleanup();
    m.news = null;
    m.admin = false;
    await draw();
    expect(screen.queryByTestId("news-section")).toBeNull();
    expect(screen.queryByRole("link", { name: "GovCon news" })).toBeNull();
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
    render(<>{await resolve(await drawing)}</>);
    expect(screen.getByTestId("connections-section").getAttribute("data-quickbooks")).toBe("true");
  });

  it("an outage in one loader is still an error where its section is drawn, never a silently empty section (and never an unhandled rejection)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.gate = Promise.reject(new Error("outage"));
    m.gate.catch(() => undefined);
    await expect(resolve(await SettingsPage(props))).rejects.toThrow("outage");
  });

  it("T-276: the header is returned before any section has answered (the sections stream behind it)", async () => {
    let release = () => {};
    m.gate = new Promise<void>((r) => (release = r));
    m.google = { connections: [] };
    const page = await Promise.race([SettingsPage(props), new Promise<"slow">((r) => setTimeout(() => r("slow"), 200))]);
    expect(page).not.toBe("slow");
    release();
    render(<>{await resolve(page as ReactNode)}</>);
    expect(screen.getByTestId("connections-section")).toBeTruthy();
  });

  it("T-276: the sub-nav is decided from the module list and the role answers, while every slow loader is still pending", async () => {
    m.owner = true;
    m.newsShown = true;
    m.gate = new Promise<void>(() => undefined); // every loader is held open for good
    const page = (await SettingsPage(props)) as ReactElement<{ children?: ReactNode }>;
    // The page's own body (the one child in a Suspense): call it by hand; it must answer although no loader ever does.
    const children = page.props.children as ReactElement[];
    const boundary = children.find((c) => isValidElement(c) && c.type === Suspense) as ReactElement<{ children: ReactElement }>;
    const body = boundary.props.children;
    const out = await (body.type as (p: unknown) => Promise<ReactNode>)(body.props);
    const nav: unknown[] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement(n)) return;
      const e = n as ReactElement<{ children?: ReactNode; items?: unknown }>;
      if (e.props.items !== undefined) nav.push(e.props.items);
      walk(e.props.children);
    };
    walk(out);
    expect(nav).toEqual([[{ id: "connections", label: "Connections" }, { id: "news", label: "GovCon news" }, { id: "ai-brain", label: "AI brain" }]]);
  });
});

describe("Microsoft section (T-257)", () => {
  it("draws Connections for a Microsoft section alone, and hides the placeholder", async () => {
    m.microsoft = { connections: [], adminConsentUrl: null };
    expect(await draw()).toBe("false");
    expect(screen.getByTestId("connections-section").getAttribute("data-microsoft")).toBe("true");
    expect(screen.getByTestId("connections-section").getAttribute("data-google")).toBe("false");
  });
  it("reads the company's providers ONCE per render and hands that one answer to the Microsoft loader", async () => {
    m.google = { connections: [] };
    m.microsoft = { connections: [], adminConsentUrl: null };
    await draw();
    expect(m.providerReads).toBe(1);
    expect(m.providersSeen).toEqual([{ state: "known", google: true, microsoft: null }]);
  });
});


describe("Settings of a mail-only company (T-265)", () => {
  // T-276: the gate reads the shared whole-config row; the {modules, limited, news} rows below are wrapped as the stored config.
  const limitedGuards = (row: { modules?: unknown; limited?: unknown; news?: unknown }) =>
    roleGuards({ requireLane: async () => ({ client: { schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { enabled_modules: row.modules, limit_to_enabled_modules: row.limited, news: row.news } }, error: null }) }) }) }) }) } }) });
  beforeEach(() => {
    m.hidden = null; // the real gate, from the lane_config row the guards return
  });
  afterEach(() => {
    m.sharedGuards = roleGuards();
  });
  const everything = () => {
    m.google = { connections: [] };
    m.microsoft = { connections: [], adminConsentUrl: null };
    m.quickbooks = { connection: null };
    m.composio = { toolkits: [] };
    m.owner = true;
    m.brain = view(1);
  };

  it("shows Connections (Microsoft, coverage) and nothing for QuickBooks, GovCon news or the AI brain, and does not even load them", async () => {
    m.sharedGuards = limitedGuards({ modules: ["comms", "calendar", "briefing"], limited: true, news: null });
    everything();
    await draw();
    const s = screen.getByTestId("connections-section");
    expect(s.getAttribute("data-microsoft")).toBe("true");
    expect(s.getAttribute("data-quickbooks")).toBe("false");
    expect(m.started).not.toContain("quickbooks");
    expect(m.started).not.toContain("brain");
    expect(m.newsCalls).toBe(0);
  });

  it("a company that does not limit itself still draws QuickBooks, GovCon news and the AI brain", async () => {
    m.sharedGuards = limitedGuards({ modules: ["comms"], limited: null, news: null });
    everything();
    await draw();
    expect(screen.getByTestId("connections-section").getAttribute("data-quickbooks")).toBe("true");
    expect(m.started).toContain("quickbooks");
    expect(m.started).toContain("brain");
    expect(m.newsCalls).toBe(1);
  });

  it("shows no Composio (Gmail and Google Calendar) row when Google is not enabled and nothing is connected through it; a connected row stays", async () => {
    m.providersView = { state: "known", google: false, microsoft: { cloud: "commercial", tenantIds: [] } };
    m.microsoft = { connections: [], adminConsentUrl: null };
    m.composio = { toolkits: [{ toolkit: "gmail", label: "Gmail", configured: true, connection: null }] };
    await draw();
    expect(screen.getByTestId("connections-section").getAttribute("data-composio")).toBe("false");
    cleanup();
    m.composio = { toolkits: [{ toolkit: "gmail", label: "Gmail", configured: true, connection: { state: "connected" } }] };
    await draw();
    expect(screen.getByTestId("connections-section").getAttribute("data-composio")).toBe("true");
  });

  it("with Google enabled (PKG's path) the Composio row is shown even with nothing connected through it: unchanged", async () => {
    m.microsoft = null;
    m.composio = { toolkits: [{ toolkit: "gmail", label: "Gmail", configured: true, connection: null }] };
    await draw();
    expect(screen.getByTestId("connections-section").getAttribute("data-composio")).toBe("true");
  });
});

describe("T-271: Approvals and Assistant are opened from Settings", () => {
  it("a company that uses both gets the section first, a sub-nav entry for it, and no placeholder, even with nothing else to show", async () => {
    m.hidden = [];
    noRoles();
    expect(await draw()).toBe("false");
    expect(navLabelsOf()).toEqual(["Approvals and Assistant|#pages"]);
    const links = within(screen.getByRole("region", { name: "Approvals and Assistant" })).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/PKG/approvals", "/PKG/assistant"]);
  });

  it("it comes before Connections and AI brain in the sub-nav", async () => {
    m.hidden = [];
    m.owner = true;
    m.google = { connections: [] };
    m.brain = view(3);
    await draw();
    expect(navLabelsOf()).toEqual(["Approvals and Assistant|#pages", "Connections|#connections", "AI brain|#ai-brain"]);
  });

  it("a company that hides one module shows only the other; hiding both shows no section", async () => {
    m.hidden = ["assistant"];
    noRoles();
    await draw();
    expect(navLabelsOf()).toEqual(["Approvals|#pages"]);
    expect(within(screen.getByRole("region", { name: "Approvals" })).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/PKG/approvals"]);
    cleanup();
    m.hidden = ["approvals", "assistant"];
    expect(await draw()).toBe("true");
    expect(screen.queryByTestId("settings-pages")).toBeNull();
  });
});

describe("link targets and notices while sections stream (T-276 review)", () => {
  /** What the page shows before any Suspense boundary has answered: every boundary replaced by its fallback. */
  function fallbackOf(node: ReactNode): ReactNode {
    if (Array.isArray(node)) return node.map(fallbackOf);
    if (!isValidElement(node)) return node;
    const el = node as ReactElement<{ children?: ReactNode; fallback?: ReactNode }>;
    if (el.type === Suspense) return el.props.fallback ?? null;
    if (el.props.children === undefined) return el;
    return cloneElement(el, undefined, fallbackOf(el.props.children));
  }
  const idCount = (id: string) => document.querySelectorAll(`[id="${id}"]`).length;
  const TARGETS = ["pages", "connections", "news", "ai-brain"];

  it("the hash targets exist from the first paint, and each appears exactly once when the sections have arrived", async () => {
    m.hidden = [];
    m.newsShown = true;
    m.owner = true;
    m.google = { connections: [] };
    m.news = { webAllowed: true, enabled: true, capUsd: 20, monthSpendUsd: 1, monthFetches: 1, lastStatus: "ok", lastFailure: null, lastFetchAt: "2026-11-12T11:00:00Z" };
    m.brain = view(2);
    const page = await SettingsPage(props);
    render(<>{fallbackOf(page)}</>);
    for (const id of TARGETS) expect(idCount(id), `fallback ${id}`).toBe(1);
    cleanup();
    render(<>{await resolve(page)}</>);
    for (const id of TARGETS) expect(idCount(id), `final ${id}`).toBe(1);
    // the wrappers carry the scroll margin
    expect(document.getElementById("connections")?.className).toMatch(/scroll-mt-8/);
    expect(document.getElementById("ai-brain")?.className).toMatch(/scroll-mt-8/);
  });

  it("a section that turns out empty leaves a hidden (empty) wrapper, not a gap", async () => {
    m.owner = true; // the AI brain chip and wrapper exist for the owner; the loader returns nothing
    m.brain = null;
    render(<>{await resolve(await SettingsPage(props))}</>);
    const wrapper = document.getElementById("ai-brain");
    expect(wrapper?.className).toMatch(/empty:hidden/);
    expect(wrapper?.childNodes.length).toBe(0);
  });

  it("a connect result or error in the address reserves the banner's slot (no query text); without one nothing is reserved", async () => {
    const withQuery = { params: props.params, searchParams: Promise.resolve({ connect: "wrong_account", error: "secret-value", provider: "google" }) };
    render(<>{fallbackOf(await SettingsPage(withQuery))}</>);
    expect(screen.getByTestId("notice-slot").textContent).toBe("");
    expect(document.body.innerHTML).not.toContain("secret-value");
    expect(document.body.innerHTML).not.toContain("wrong_account");
    cleanup();
    render(<>{fallbackOf(await SettingsPage(props))}</>);
    expect(screen.queryByTestId("notice-slot")).toBeNull();
  });

  it("a connect result with an empty navigation still hides the 'not set up yet' card (the old rule)", async () => {
    noRoles();
    m.result = { tone: "alert", title: "Google isn't configured on this server.", description: "x" };
    expect(await draw()).toBe("false");
    expect(screen.getByTestId("connect-result")).toBeTruthy();
    cleanup();
    m.result = null;
    expect(await draw()).toBe("true");
  });
});
