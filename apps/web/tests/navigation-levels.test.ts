// T-276: round trips and SEQUENTIAL LEVELS one menu click makes, per gated page, from a recording fake client. A level is a group of calls that start together; the next level
// starts when an earlier answer has come back. The fake counts the lane check, the lane list, every client read and every role check, the way the audit did (the session
// read is not counted: it is memoised once per request and does not differ between the old and the new code).
// Also the gate's safety: a hidden module still redirects before any of the page's output is drawn, a refused lane is still a 404 and an MFA step is still a redirect, whatever was
// started early, and nothing started early can surface as an unhandled rejection (vitest fails the run on one).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneElement, isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { AuthError } from "@nichols/core/auth";

const t = vi.hoisted(() => ({
  done: 0,
  calls: [] as { name: string; level: number }[],
  roots: [] as Map<unknown, unknown>[],
  answers: {} as Record<string, unknown>,
  laneError: null as unknown,
  config: null as unknown,
  rendered: [] as string[],
}));

// React cache() memoises per render; a test is one render, so this memo is identity-keyed and cleared before every test.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <A extends unknown[], R>(fn: (...a: A) => R) => {
    const root = new Map<unknown, unknown>();
    t.roots.push(root);
    const RES = Symbol("result");
    return (...a: A): R => {
      let node = root;
      for (const x of a) {
        let next = node.get(x) as Map<unknown, unknown> | undefined;
        if (!next) node.set(x, (next = new Map()));
        node = next;
      }
      if (!node.has(RES)) node.set(RES, fn(...a));
      return node.get(RES) as R;
    };
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], get: () => undefined }), headers: async () => new Headers({ "user-agent": "test" }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

async function hit(name: string): Promise<void> {
  const level = t.done + 1;
  t.calls.push({ name, level });
  await new Promise((r) => setTimeout(r, 4));
  t.done = Math.max(t.done, level);
}

const once = <T>(fn: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
};

const answer = (name: string, fallback: unknown = { data: null, error: null }) => (name in t.answers ? t.answers[name] : fallback);

function builder(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "maybeSingle"]) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => hit(`from:${table}`).then(() => res(answer(`from:${table}`)), rej);
  return q;
}
const client = {
  schema: () => ({
    rpc: (fn: string) => ({ then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => hit(`rpc:${fn}`).then(() => res(answer(`rpc:${fn}`)), rej) }),
    from: (table: string) => builder(table),
  }),
};

function makeGuards() {
  const lane = once(async () => {
    await hit("lane.check");
    if (t.laneError) throw t.laneError;
    return { client, session: { userId: "u1" } };
  });
  const list = once(async () => {
    await hit("lane.list");
    return [{ laneId: "PKG", name: "Pub K Group" }];
  });
  const roles = new Map<string, Promise<unknown>>();
  return {
    requireLane: () => lane(),
    listLanes: () => list(),
    requireRole: (_l: string, wanted: string[]) => {
      const key = [...wanted].sort().join(",");
      if (!roles.has(key)) roles.set(key, lane());
      return roles.get(key);
    },
  };
}
let guardsObj = makeGuards();
vi.mock("@/lib/guards", () => ({ guards: async () => guardsObj }));

type El = ReactElement<{ children?: ReactNode }>;
/** Resolves a server component tree the way a render does: a parent before its children, siblings together, Suspense children included. Records each async component it runs. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolve(n)));
  if (!isValidElement(node)) return node;
  const el = node as El;
  if (el.type === Suspense) return resolve(el.props.children);
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    t.rendered.push((el.type as { name: string }).name);
    return resolve(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  }
  if (typeof el.type === "function") {
    t.rendered.push((el.type as { name: string }).name);
    return resolve((el.type as (p: unknown) => ReactNode)(el.props));
  }
  if (el.props.children === undefined) return el;
  return cloneElement(el, undefined, await resolve(el.props.children));
}

const PAGES: Record<string, () => Promise<{ default: (p: never) => unknown }>> = {
  inbox: () => import("@/app/[laneId]/inbox/page"),
  calendar: () => import("@/app/[laneId]/calendar/page"),
  finance: () => import("@/app/[laneId]/finance/page"),
  projects: () => import("@/app/[laneId]/projects/page"),
  claude: () => import("@/app/[laneId]/claude/page"),
  chatgpt: () => import("@/app/[laneId]/chatgpt/page"),
  contacts: () => import("@/app/[laneId]/contacts/page"),
  messages: () => import("@/app/[laneId]/messages/page"),
};
const params = () => Promise.resolve({ laneId: "PKG" });
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const maxLevel = () => Math.max(0, ...t.calls.map((c) => c.level));
const count = (name: string) => t.calls.filter((c) => c.name === name).length;

const OPEN = { data: { config: {} }, error: null };
const HIDE = (...visible: string[]) => ({ data: { config: { limit_to_enabled_modules: true, enabled_modules: visible } }, error: null });

beforeEach(() => {
  t.done = 0;
  t.calls = [];
  t.rendered = [];
  t.laneError = null;
  t.answers = { "from:lane_config_current": OPEN };
  for (const r of t.roots) r.clear();
  guardsObj = makeGuards();
});

describe("round trips and sequential levels per menu page (T-276)", () => {
  it("Inbox: the gate, the lane list and the mail list run together (audit: 5 reads in 5 levels; now 5 reads in 2 levels)", async () => {
    t.answers["rpc:inbox_messages"] = { data: [{ message_id: "m1", received_at: "2026-11-20T12:00:00Z", connection_id: "c1" }], error: null };
    t.answers["rpc:briefing_coverage"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/inbox/page");
    await resolve(Page({ params: params(), searchParams: sp() } as never) as ReactNode);
    expect(t.calls.map((c) => c.name).sort()).toEqual(["from:lane_config_current", "lane.check", "lane.list", "rpc:briefing_coverage", "rpc:inbox_messages"]);
    expect(maxLevel()).toBe(2);
    // The mail list and its labels start together (one level), after the one lane check.
    expect(t.calls.filter((c) => c.name.startsWith("rpc:")).map((c) => c.level)).toEqual([2, 2]);
  });

  it("Calendar: status, accounts and events start together with the gate (audit: 6 reads in 5 levels; now 6 in 2)", async () => {
    t.answers["rpc:home_calendar_status"] = { data: "connected", error: null };
    t.answers["rpc:calendar_events"] = { data: [], error: null };
    t.answers["from:connections"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/calendar/page");
    await resolve(Page({ params: params(), searchParams: sp({ view: "week", date: "2026-11-20" }) } as never) as ReactNode);
    expect(t.calls.map((c) => c.name).sort()).toEqual(["from:connections", "from:lane_config_current", "lane.check", "lane.list", "rpc:calendar_events", "rpc:home_calendar_status"]);
    expect(maxLevel()).toBe(2);
  });

  it("Finance: the four figure reads start with the gate (audit: 7 reads in 4 levels; now 7 in 2)", async () => {
    const { default: Page } = await import("@/app/[laneId]/finance/page");
    await resolve(Page({ params: params(), searchParams: sp() } as never) as ReactNode);
    expect(maxLevel()).toBe(2);
    expect(count("lane.check")).toBe(1);
    expect(count("lane.list")).toBe(1);
    expect(count("from:lane_config_current")).toBe(1);
  });

  it("Tasks (Projects): the lane list and the gate's config read run together (audit: 3 reads in 3 levels; now 3 in 2)", async () => {
    const { default: Page } = await import("@/app/[laneId]/projects/page");
    await resolve(Page({ params: params() } as never) as ReactNode);
    expect(t.calls.map((c) => c.name).sort()).toEqual(["from:lane_config_current", "lane.check", "lane.list"]);
    expect(maxLevel()).toBe(2);
  });

  it.each([
    ["claude", "claude"],
    ["chatgpt", "chatgpt"],
    ["contacts", "contacts"],
    ["messages", "messages"],
  ])("%s: no gate, the lane check and the list in one level (audit: 2 reads in 1 level; unchanged), and the heading is drawn without any read", async (_n, dir) => {
    const { default: Page } = await (PAGES[dir] as NonNullable<(typeof PAGES)[string]>)();
    const tree = Page({ params: params() } as never) as ReactNode;
    // Synchronous: the page itself is not async and starts no read, so heading and card are part of the prefetched shell.
    expect(isValidElement(tree)).toBe(true);
    expect(t.calls).toEqual([]);
    await resolve(tree);
    expect(t.calls.map((c) => c.name).sort()).toEqual(["lane.check", "lane.list"]);
    expect(maxLevel()).toBe(1);
  });
});

describe("the gate stays in charge (T-276)", () => {
  it("a hidden module redirects to the company's Home and none of the page's output is drawn (Inbox, Calendar, Finance, Tasks)", async () => {
    t.answers["from:lane_config_current"] = HIDE("approvals");
    for (const [dir, rendered] of [["inbox", "InboxPage"], ["calendar", "CalendarPage"], ["finance", "FinancePage"], ["projects", "ModulePage"]] as const) {
      t.rendered = [];
      const { default: Page } = await (PAGES[dir] as NonNullable<(typeof PAGES)[string]>)();
      await expect(resolve(Page({ params: params(), searchParams: sp() } as never) as ReactNode)).rejects.toThrow("REDIRECT /PKG");
      expect(t.rendered, dir).toEqual(["ModuleGate"]);
      expect(t.rendered, dir).not.toContain(rendered);
      for (const r of t.roots) r.clear();
      t.calls = [];
      t.done = 0;
      guardsObj = makeGuards();
    }
  });

  it("a refused lane is a 404 on every page, and nothing but the lane check is asked of the database", async () => {
    t.laneError = new AuthError("forbidden");
    for (const dir of ["inbox", "calendar", "finance", "projects", "claude", "contacts"]) {
      for (const r of t.roots) r.clear();
      t.calls = [];
      guardsObj = makeGuards();
      const { default: Page } = await (PAGES[dir] as NonNullable<(typeof PAGES)[string]>)();
      await expect(resolve(Page({ params: params(), searchParams: sp() } as never) as ReactNode), dir).rejects.toThrow("NOT_FOUND");
      expect(t.calls.filter((c) => c.name.startsWith("rpc:") || (c.name.startsWith("from:") && c.name !== "from:lane_config_current")), dir).toEqual([]);
      // None of the page's body components ran: the lane check refused before anything data-bearing was drawn.
      for (const body of ["InboxList", "CalendarBody", "CalendarScreen", "FinanceView"]) expect(t.rendered, `${dir} ${body}`).not.toContain(body);
    }
  });

  it("an MFA step or a missing session is still a redirect (the early lane check does not swallow it)", async () => {
    for (const [reason, to] of [["mfa_required", "/mfa"], ["no_session", "/sign-in"]] as const) {
      for (const r of t.roots) r.clear();
      t.calls = [];
      guardsObj = makeGuards();
      t.laneError = new AuthError(reason);
      const { default: Page } = await import("@/app/[laneId]/inbox/page");
      await expect(resolve(Page({ params: params(), searchParams: sp() } as never) as ReactNode)).rejects.toThrow(`REDIRECT ${to}`);
    }
  });
});

describe("Home with a refused lane (T-276 review)", () => {
  it("is a 404 and the early Finance start asks the database for nothing beyond the lane check (real loaders, recording client)", async () => {
    t.laneError = new AuthError("forbidden");
    const { HomePage } = await import("@/components/home-page");
    await expect(resolve(HomePage({ params: params() }) as unknown as ReactNode)).rejects.toThrow("NOT_FOUND");
    await new Promise((r) => setTimeout(r, 40)); // let the early finance start run to its end
    const other = t.calls.filter((c) => c.name !== "lane.check" && c.name !== "lane.list");
    expect(other).toEqual([]);
    expect(t.rendered).not.toContain("HomeSections");
  });
});
