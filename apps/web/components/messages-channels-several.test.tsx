// @vitest-environment jsdom
// T-296 (docs/specs/messages.md 22.4, 22.9, 22.12): channels for several accounts. The teams of each account that can read channels are listed under that account's label (a team both accounts belong
// to appears under each, D-70 default); the open team's channels, posts, replies and pictures are read only through the account named in the address (`conn`), re-checked like every route; an account
// that lacks channels is said so for itself. Synthetic data only; the Teams reads are recorded fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/PKG/messages", useSearchParams: () => new URLSearchParams(nav.search) }));

const rec = vi.hoisted(() => ({ calls: [] as { fn: string; conn: string; args: unknown[] }[] }));
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireLane: async () => ({ session: { userId: "u1" }, client: {} }) }) }));
vi.mock("@/lib/teams-channels", async (orig) => {
  const actual = await orig<typeof import("@/lib/teams-channels")>();
  type P = { connectionId: string };
  return {
    ...actual,
    loadTeams: async (p: P) => {
      rec.calls.push({ fn: "loadTeams", conn: p.connectionId, args: [] });
      return { kind: "ok", teams: [{ teamId: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1", name: "Alpha", archived: false }], more: false };
    },
    loadChannels: async (p: P, ...args: unknown[]) => {
      rec.calls.push({ fn: "loadChannels", conn: p.connectionId, args });
      return { kind: "ok", channels: [{ key: (await import("@/lib/teams-channel-key")).encodeChannelKey("19:general111@thread.tacv2"), name: "General", kind: "standard", readable: true, openUrl: "https://teams.microsoft.com/l/channel/x" }] };
    },
    loadThread: async (p: P, ...args: unknown[]) => {
      rec.calls.push({ fn: "loadThread", conn: p.connectionId, args });
      return { kind: "ok", posts: [], nextCursor: null };
    },
    loadReplies: async (p: P, ...args: unknown[]) => {
      rec.calls.push({ fn: "loadReplies", conn: p.connectionId, args });
      return { kind: "ok", postId: "1", replies: [], more: false };
    },
  };
});
vi.mock("@/components/messages-client", () => ({ MessagesRefresh: () => null, FocusConversation: () => null }));

import { ChannelAccountNotes, ChannelRows, ChannelsUnavailable, ChannelsWorkspace, TeamsList } from "./messages-channels";
import { encodeChannelKey } from "@/lib/teams-channel-key";
import type { MessagesAccount, MessagesState } from "@/lib/teams-messages";
import type { ChannelListView, TeamListView } from "@/lib/teams-channels";

const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";
const OTHER = "00000000-0000-4000-8000-0000000000d1";
const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const CH = "19:general111@thread.tacv2";
const KEY = encodeChannelKey(CH);
type Connected = Extract<MessagesState, { kind: "connected" }>;
const acct = (id: string, upn: string, label: string, over: Partial<MessagesAccount> = {}): MessagesAccount => ({ connectionId: id, account: upn, label, usable: true, degraded: false, missing: [], has: ["chat_read", "call_links", "channels_read"], ...over });
const connected = (accounts: MessagesAccount[], over: Partial<Connected> = {}): Connected => ({
  kind: "connected", connectionId: accounts[0]?.connectionId ?? A, account: accounts[0]?.account ?? "", degraded: false, missing: [], adminConsent: false, needsAdminConsent: true, laneFeatures: ["chat_read", "channels_read"], accounts, multi: accounts.filter((a) => a.usable).length >= 2, canAddAnother: false, ...over,
});
const TWO = () => connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com"), acct(B, "robert@pub-k.org", "pub-k.org")]);
const WIDTHS = [1280, 375];
const at = (w: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  window.dispatchEvent(new Event("resize"));
};

/** Every element of a server tree that carries a prop, without running function components (the async sections stay unrun). */
function walk(node: unknown, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (Array.isArray(node)) return void node.forEach((n) => walk(n, visit));
  if (typeof node !== "object" || node === null || !("props" in node)) return;
  const el = node as ReactElement<Record<string, unknown>>;
  visit(el);
  for (const v of Object.values(el.props)) if (typeof v === "object" && v !== null) walk(v, visit);
}
const has = (tree: unknown, testId: string): boolean => {
  let found = false;
  walk(tree, (el) => {
    if (el.props["data-testid"] === testId) found = true;
  });
  return found;
};
const reads = () => rec.calls.map((c) => `${c.fn}:${c.conn === A ? "A" : c.conn === B ? "B" : c.conn}`).sort();

beforeEach(() => {
  rec.calls = [];
});
afterEach(cleanup);

describe("ChannelsWorkspace: one team list per account that can read channels; the open team through its own account only", () => {
  const run = async (state: Connected, query: Record<string, string>): Promise<ReactNode> => (await ChannelsWorkspace({ laneId: "PKG", state, searchParams: Promise.resolve(query) })) as ReactNode;

  it("both accounts' team lists start together; nothing else is read until a team is named", async () => {
    await run(TWO(), { tab: "channels" });
    expect(reads()).toEqual(["loadTeams:A", "loadTeams:B"]);
  });

  it("the team, its channels, posts and replies are read as the account `conn` names, never as the other one", async () => {
    const tree = await run(TWO(), { tab: "channels", conn: B, team: TEAM, channel: KEY, post: "1700000000001" });
    expect(reads()).toEqual(["loadChannels:B", "loadTeams:A", "loadTeams:B"]);
    expect(has(tree, "pick-account")).toBe(false);
    // the posts and replies start when the channel list has answered, and only as B
    await new Promise((r) => setTimeout(r, 10));
    expect(reads()).toEqual(["loadChannels:B", "loadReplies:B", "loadTeams:A", "loadTeams:B", "loadThread:B"]);
  });

  it.each([
    ["no conn with two accounts", {}],
    ["another person's account", { conn: OTHER }],
    ["an unknown account", { conn: "00000000-0000-4000-8000-0000000000ff" }],
    ["a malformed id", { conn: "../x" }],
    ["an upper-case id", { conn: A.toUpperCase() }],
  ])("%s: nothing opens (said plainly), no channel, post or reply is read, and nothing falls back to another account", async (_n, extra) => {
    const tree = await run(TWO(), { tab: "channels", ...extra, team: TEAM, channel: KEY, post: "1700000000001" });
    await new Promise((r) => setTimeout(r, 10));
    expect(reads()).toEqual(["loadTeams:A", "loadTeams:B"]); // the lists are still drawn; nothing about the named team
    expect(has(tree, "pick-account")).toBe(true);
  });

  it("an account whose sign-in expired, or one without channels, does not open a team either (and is not listed)", async () => {
    const expired = connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com"), acct(B, "robert@pub-k.org", "pub-k.org", { usable: false })]);
    await run(expired, { tab: "channels", conn: B, team: TEAM, channel: KEY });
    await new Promise((r) => setTimeout(r, 10));
    expect(reads()).toEqual(["loadTeams:A"]);
    rec.calls = [];
    const lacking = connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com"), acct(B, "robert@pub-k.org", "pub-k.org", { has: ["chat_read"], missing: ["channels_read"] })]);
    const tree = await run(lacking, { tab: "channels", conn: B, team: TEAM });
    expect(reads()).toEqual(["loadTeams:A"]);
    expect(has(tree, "pick-account")).toBe(true);
  });

  it("one account: the address is what it always was (no conn needed), and the team list is not grouped", async () => {
    const one = connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com")]);
    const tree = await run(one, { tab: "channels", team: TEAM });
    expect(reads()).toEqual(["loadChannels:A", "loadTeams:A"]);
    expect(has(tree, "team-groups")).toBe(false);
  });
});

describe.each(WIDTHS)("two accounts' teams at %ipx", (width) => {
  beforeEach(() => at(width));
  const view: TeamListView = { kind: "ok", teams: [{ teamId: TEAM, name: "Alpha", archived: false }], more: false };

  it("a team both accounts belong to is listed under each account; each link names its own account, so it reads and posts as that account", () => {
    render(
      <>
        <TeamsList view={view} laneId="PKG" connectionId={A} teamId={null} channels={null} selectedKey={null} conn={A} />
        <TeamsList view={view} laneId="PKG" connectionId={B} teamId={null} channels={null} selectedKey={null} conn={B} />
      </>,
    );
    const hrefs = screen.getAllByTestId("team-row").map((r) => r.getAttribute("href"));
    expect(hrefs).toEqual([`/PKG/messages?tab=channels&conn=${A}&team=${TEAM}`, `/PKG/messages?tab=channels&conn=${B}&team=${TEAM}`]);
  });

  it("a channel link carries the account too; with one account the address has no conn", () => {
    const channels: ChannelListView = { kind: "ok", channels: [{ key: KEY, name: "General", kind: "standard", readable: true, openUrl: "https://teams.microsoft.com/l/channel/x" }] };
    render(<ChannelRows laneId="PKG" teamId={TEAM} selectedKey={null} view={channels} connectionId={B} conn={B} />);
    expect(screen.getByTestId("channel-row").getAttribute("href")).toBe(`/PKG/messages?tab=channels&conn=${B}&team=${TEAM}&channel=${KEY}`);
    cleanup();
    render(<ChannelRows laneId="PKG" teamId={TEAM} selectedKey={null} view={channels} connectionId={A} />);
    expect(screen.getByTestId("channel-row").getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${TEAM}&channel=${KEY}`);
  });

  it("an account without channels is said for that account only, with its own Reconnect; with none able, the Channels state names every account", () => {
    const lacking = connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com"), acct(B, "robert@pub-k.org", "pub-k.org", { has: ["chat_read"], missing: ["channels_read"] })]);
    render(<ChannelAccountNotes laneId="PKG" state={lacking} />);
    const note = screen.getByTestId("channel-account-note");
    expect(note.textContent).toContain("pub-k.org: Reconnect Teams to add channels");
    expect(note.textContent).toContain("admin must approve");
    expect(within(note).getByRole("button", { name: "Reconnect pub-k.org" }).closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${B}`);
    cleanup();
    const none = connected([acct(A, "robert@pubkgroup.com", "pubkgroup.com", { has: ["chat_read"] }), acct(B, "robert@pub-k.org", "pub-k.org", { has: ["chat_read"] })]);
    render(<ChannelsUnavailable laneId="PKG" state={none} />);
    const box = screen.getByTestId("channels-reconnect");
    expect(within(box).getByRole("button", { name: "Reconnect pubkgroup.com" })).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Reconnect pub-k.org" })).toBeTruthy();
  });

  it("nothing from a team or a channel name is drawn as HTML", () => {
    const evil = "<img src=x onerror=alert(1)>";
    render(<TeamsList view={{ kind: "ok", teams: [{ teamId: TEAM, name: evil, archived: false }], more: false }} laneId="PKG" connectionId={A} teamId={null} channels={null} selectedKey={null} conn={A} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(evil)).toBeTruthy();
  });
});
