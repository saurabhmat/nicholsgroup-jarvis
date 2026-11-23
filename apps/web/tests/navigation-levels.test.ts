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
  /** The Teams reader (T-283): every call is recorded with the tick it started in, and answers after a pause, so "started together" can be told from "one after the other". */
  reader: { calls: [] as { fn: string; at: number; resolvedBefore: number; args?: unknown[] }[], seq: 0, resolved: 0 },
  /** The features the fake company lists for Teams (T-291: a test turns `channels_read` on). */
  teamsFeatures: ["chat_read"] as string[],
  /** The kind of the one fake channel (T-291 L1: a shared channel is never read). */
  channelKind: "standard" as string,
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
  for (const m of ["select", "eq", "in", "order", "maybeSingle"]) q[m] = () => q;
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
// T-283: the Teams reader and the browser-only parts are stubs here (their own tests are in packages/connectors and components/messages-client.test.tsx). The reader records WHEN each call started.
vi.mock("@nichols/connectors/teams-reader", () => {
  const self = { tenantId: "t", entraObjectId: "00000000-0000-4000-8000-0000000000a1" };
  const started = async <T,>(fn: string, value: T, args: unknown[] = []): Promise<T> => {
    t.reader.calls.push({ fn, at: performance.now(), resolvedBefore: t.reader.resolved, args });
    await new Promise((res) => setTimeout(res, 6));
    t.reader.resolved += 1;
    return value;
  };
  return {
    listChats: () => started("listChats", { chats: [], nextCursor: null, self }),
    listMessages: () => started("listMessages", { messages: [], nextBefore: null, self }),
    openChat: () => started("openChat", { chat: { chatId: "19:abc123def456@thread.v2", chatType: "group", topic: "T", webUrl: null, members: [], membersCapped: false, preview: null, lastReadAt: null, hidden: false }, members: [], membersMore: false }),
    resolveCallTargets: () => started("resolveCallTargets", { ok: false, reason: "no_one" }),
    // T-291: the channel reads, recorded the same way
    listTeams: () => started("listTeams", { teams: [{ teamId: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1", name: "Alpha" }], more: false, self }),
    listChannels: (...a: unknown[]) => started("listChannels", { channels: [{ channelId: "19:general111@thread.tacv2", name: "General", kind: t.channelKind, webUrl: null }], self }, a),
    listChannelPosts: (...a: unknown[]) => started("listChannelPosts", { posts: [], nextCursor: null, self }, a),
    listReplies: (...a: unknown[]) => started("listReplies", { replies: [], more: false, self }, a),
  };
});
vi.mock("@/components/messages-client", () => ({
  MessagesRefresh: () => null,
  ConversationMessages: () => null,
  CallButtons: () => null,
  MarkRead: () => null,
  FocusConversation: () => null,
}));
// T-280: the company's Teams settings come from the lane config through the connectors (a recorded read here; the real reader is tested in packages/connectors).
vi.mock("@nichols/connectors/teams-settings", () => ({
  teamsSettingsOf: async () => {
    await hit("teams.settings");
    return { enabled: true, cloudSupported: true, features: [...t.teamsFeatures], needsAdminConsent: t.teamsFeatures.includes("channels_read") };
  },
}));

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
  // a class component (an error boundary) is not run here: its children are resolved in its place
  if (typeof el.type === "function" && (el.type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) return cloneElement(el, undefined, await resolve(el.props.children));
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
  t.reader.calls = [];
  t.teamsFeatures = ["chat_read"];
  t.channelKind = "standard";
  t.reader.seq = 0;
  t.reader.resolved = 0;
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

const CHAT_KEY = Buffer.from("19:abc123def456@thread.v2").toString("base64url");
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const CHANNEL_KEY = Buffer.from("19:general111@thread.tacv2").toString("base64url");
const TEAMS_ROW = { id: "00000000-0000-4000-8000-0000000000c1", external_account_id: "me@teams.example.test", status: "active", owner_user_id: "u1", features: { teams_chat_read: true, teams_call_links: true } };

const CHANNELS_ROW = { ...TEAMS_ROW, features: { teams_chat_read: true, teams_call_links: true, teams_channels_read: true } };

describe("Messages (T-280, T-283)", () => {
  it("the gate, the lane list and the Teams reads (settings and own rows) start together: no read waits for another beyond the one lane check", async () => {
    t.answers["from:connections"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params() } as never) as ReactNode);
    expect(t.calls.map((c) => c.name).sort()).toEqual(["from:connections", "from:lane_config_current", "lane.check", "lane.list", "teams.settings"]);
    expect(maxLevel()).toBe(2);
    expect(count("lane.check")).toBe(1);
    expect(count("teams.settings")).toBe(1); // read once for the page (spec 11: no repeated lane_config read)
  });

  it("a limited company that does not list `messages` is sent Home before the page draws anything", async () => {
    t.answers["from:lane_config_current"] = HIDE("comms");
    t.rendered = [];
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await expect(resolve(Page({ params: params() } as never) as ReactNode)).rejects.toThrow("REDIRECT /PKG");
    expect(t.rendered).toEqual(["ModuleGate"]);
    for (const r of t.roots) r.clear();
  });

  it("a link prefetch makes no Graph request: the page function is synchronous, starts only the connect-state reads, and the reader is not called until the gate has answered and the workspace renders (T-283)", async () => {
    t.answers["from:connections"] = { data: [TEAMS_ROW], error: null };
    t.answers["rpc:teams_chat_reads_list"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    const tree = Page({ params: params(), searchParams: sp({ chat: CHAT_KEY }) } as never) as ReactNode;
    expect(isValidElement(tree)).toBe(true); // synchronous: the shell, its heading and skeleton are what a prefetch gets
    await new Promise((r) => setTimeout(r, 30)); // let everything started by the page function run to its end
    expect(t.reader.calls).toEqual([]);
    expect(t.calls.filter((c) => c.name === "rpc:teams_chat_reads_list")).toEqual([]);
  });

  it("a connected person: the chat list, the read markers and the open conversation are all STARTED together after the gate (the list and the conversation never wait for each other)", async () => {
    t.answers["from:connections"] = { data: [TEAMS_ROW], error: null };
    t.answers["rpc:teams_chat_reads_list"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params(), searchParams: sp({ chat: CHAT_KEY }) } as never) as ReactNode);
    const fns = t.reader.calls.map((c) => c.fn).sort();
    expect(fns).toEqual(["listChats", "listMessages", "openChat"]);
    // (no clock: every Graph read had STARTED before any of them had answered)
    expect(t.reader.calls.map((c) => c.resolvedBefore)).toEqual([0, 0, 0]);
    const markers = t.calls.find((c) => c.name === "rpc:teams_chat_reads_list");
    expect(markers).toBeTruthy();
    // the markers' level equals the level the Graph reads began in: one level, not a chain
    const graphLevel = t.calls.find((c) => c.name === "teams.settings")?.level ?? 0;
    expect(markers?.level).toBeLessThanOrEqual(graphLevel + 2);
    expect(count("teams.settings")).toBe(1);
    expect(count("lane.check")).toBe(1);
    expect(maxLevel()).toBeLessThanOrEqual(3);
  });

  it("no chat in the address: only the chat list is read (no conversation read, no Graph read for a chat that was not asked for)", async () => {
    t.answers["from:connections"] = { data: [TEAMS_ROW], error: null };
    t.answers["rpc:teams_chat_reads_list"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params(), searchParams: sp() } as never) as ReactNode);
    expect(t.reader.calls.map((c) => c.fn)).toEqual(["listChats"]);
  });

  it("a made-up chat key is 'no chat selected', not a Graph request", async () => {
    t.answers["from:connections"] = { data: [TEAMS_ROW], error: null };
    t.answers["rpc:teams_chat_reads_list"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params(), searchParams: sp({ chat: "../../etc/passwd" }) } as never) as ReactNode);
    expect(t.reader.calls.map((c) => c.fn)).toEqual(["listChats"]);
  });

  it("privacy: when the only Teams row visible is another person's (an admin sees its health), the person is 'not connected' and nothing is read from Teams", async () => {
    t.answers["from:connections"] = { data: [{ ...TEAMS_ROW, owner_user_id: "someone-else" }], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params(), searchParams: sp({ chat: CHAT_KEY }) } as never) as ReactNode);
    expect(t.reader.calls).toEqual([]);
    expect(t.rendered).not.toContain("MessagesWorkspace");
  });

  it("a hidden module redirects before any Graph read, even for a connected person", async () => {
    t.answers["from:lane_config_current"] = HIDE("comms");
    t.answers["from:connections"] = { data: [TEAMS_ROW], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await expect(resolve(Page({ params: params(), searchParams: sp({ chat: CHAT_KEY }) } as never) as ReactNode)).rejects.toThrow("REDIRECT /PKG");
    await new Promise((r) => setTimeout(r, 30));
    expect(t.reader.calls).toEqual([]);
    for (const r of t.roots) r.clear();
  });

  it("T-291: the team list and the open team's channels START together; the posts and replies start as soon as the channel list has answered (it says whether the channel may be read), without waiting for the team list or each other", async () => {
    t.teamsFeatures = ["chat_read", "channels_read"];
    t.answers["from:connections"] = { data: [CHANNELS_ROW], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params(), searchParams: sp({ tab: "channels", team: TEAM, channel: CHANNEL_KEY, post: "1700000000001" }) } as never) as ReactNode);
    const by = (fn: string) => t.reader.calls.find((c) => c.fn === fn);
    expect(t.reader.calls.map((c) => c.fn).sort()).toEqual(["listChannelPosts", "listChannels", "listReplies", "listTeams"]);
    expect([by("listTeams")?.resolvedBefore, by("listChannels")?.resolvedBefore]).toEqual([0, 0]); // both STARTED before either answered
    // the posts and replies start after the channel list answered, and both in the same turn
    expect(by("listChannelPosts")?.resolvedBefore).toBeGreaterThanOrEqual(1);
    expect(by("listReplies")?.resolvedBefore).toBe(by("listChannelPosts")?.resolvedBefore);
    expect(by("listChannels")?.args).toEqual(["PKG", expect.any(String), "u1", TEAM]);
    expect(by("listReplies")?.args).toEqual(["PKG", expect.any(String), "u1", TEAM, "19:general111@thread.tacv2", "1700000000001"]);
    expect(count("teams.settings")).toBe(1);
    expect(count("lane.check")).toBe(1);
    expect(maxLevel()).toBeLessThanOrEqual(3);
  });

  it("T-291 L1: a shared channel (or a channel that is not in the team's list) is never read, even by a made-up address: no posts and no replies request", async () => {
    t.teamsFeatures = ["chat_read", "channels_read"];
    t.answers["from:connections"] = { data: [CHANNELS_ROW], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    t.channelKind = "shared";
    await resolve(Page({ params: params(), searchParams: sp({ tab: "channels", team: TEAM, channel: CHANNEL_KEY, post: "1700000000001" }) } as never) as ReactNode);
    expect(t.reader.calls.map((c) => c.fn).sort()).toEqual(["listChannels", "listTeams"]);
    t.reader.calls = [];
    t.channelKind = "standard";
    const other = Buffer.from("19:other999@thread.tacv2").toString("base64url");
    await resolve(Page({ params: params(), searchParams: sp({ tab: "channels", team: TEAM, channel: other }) } as never) as ReactNode);
    expect(t.reader.calls.map((c) => c.fn).sort()).toEqual(["listChannels", "listTeams"]);
  });

  it("T-291: only what the address names is read: no team means only the team list; a team means its channels; a channel means its posts; a post that is not named means no replies", async () => {
    t.teamsFeatures = ["chat_read", "channels_read"];
    t.answers["from:connections"] = { data: [CHANNELS_ROW], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    const fns = async (q: Record<string, string>) => {
      t.reader.calls = [];
      await resolve(Page({ params: params(), searchParams: sp(q) } as never) as ReactNode);
      return t.reader.calls.map((c) => c.fn).sort();
    };
    expect(await fns({ tab: "channels" })).toEqual(["listTeams"]);
    expect(await fns({ tab: "channels", team: TEAM })).toEqual(["listChannels", "listTeams"]);
    expect(await fns({ tab: "channels", team: TEAM, channel: CHANNEL_KEY })).toEqual(["listChannelPosts", "listChannels", "listTeams"]);
    // made-up ids are "nothing selected", never a request
    expect(await fns({ tab: "channels", team: "../etc", channel: CHANNEL_KEY })).toEqual(["listTeams"]);
    expect(await fns({ tab: "channels", team: TEAM, channel: "nope" })).toEqual(["listChannels", "listTeams"]);
    expect(await fns({ tab: "channels", team: TEAM, channel: CHANNEL_KEY, post: "../x" })).toEqual(["listChannelPosts", "listChannels", "listTeams"]);
    expect(await fns({ tab: "channels", channel: CHANNEL_KEY })).toEqual(["listTeams"]); // a channel without its team is ignored
  });

  it("T-291: a plain chat view makes no team or channel request, even for a company that lists channels", async () => {
    t.teamsFeatures = ["chat_read", "channels_read"];
    t.answers["from:connections"] = { data: [CHANNELS_ROW], error: null };
    t.answers["rpc:teams_chat_reads_list"] = { data: [], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    await resolve(Page({ params: params(), searchParams: sp({ chat: CHAT_KEY, team: TEAM, channel: CHANNEL_KEY }) } as never) as ReactNode);
    expect(t.reader.calls.map((c) => c.fn).sort()).toEqual(["listChats", "listMessages", "openChat"]);
  });

  it("T-291: no Microsoft request for channels unless they can work: the company does not list them, or this connection lacks them (made before, or the administrator's approval was not given)", async () => {
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    t.teamsFeatures = ["chat_read"]; // not switched on
    t.answers["from:connections"] = { data: [CHANNELS_ROW], error: null };
    await resolve(Page({ params: params(), searchParams: sp({ tab: "channels", team: TEAM, channel: CHANNEL_KEY }) } as never) as ReactNode);
    expect(t.reader.calls).toEqual([]);
    t.teamsFeatures = ["chat_read", "channels_read"]; // listed, but the connection has not got the feature
    t.answers["from:connections"] = { data: [TEAMS_ROW], error: null };
    await resolve(Page({ params: params(), searchParams: sp({ tab: "channels", team: TEAM, channel: CHANNEL_KEY }) } as never) as ReactNode);
    expect(t.reader.calls).toEqual([]);
    expect(t.rendered).not.toContain("ChannelsWorkspace");
  });

  it("T-291: a link prefetch of the Channels tab makes no Graph request (the page function stays synchronous)", async () => {
    t.teamsFeatures = ["chat_read", "channels_read"];
    t.answers["from:connections"] = { data: [CHANNELS_ROW], error: null };
    const { default: Page } = await import("@/app/[laneId]/messages/page");
    const tree = Page({ params: params(), searchParams: sp({ tab: "channels", team: TEAM, channel: CHANNEL_KEY }) } as never) as ReactNode;
    expect(isValidElement(tree)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.reader.calls).toEqual([]);
  });

  it("T-291: the page's channel parts read no clock before data and import no Graph client", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../components/messages-channels.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/Date\.now|new Date\(|performance\.now|graph\.microsoft|fetch\(|@nichols\/connectors\/(?!teams-pure)/);
  });

  it("the page reads no Microsoft and makes no external call: its imports hold no Graph client", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../components/messages-page.tsx", import.meta.url), "utf8") + readFileSync(new URL("../lib/teams-messages.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/graph\.microsoft|fetch\(|@nichols\/connectors\/(?!teams-settings)/);
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
