// @vitest-environment jsdom
// T-291: the Channels tab, drawn for every state at desktop (1280) and iPhone (390) width. jsdom evaluates no CSS, so the width is set (a component that branched on it would show) and the layout
// is checked through the classes that make the single column on a phone: the list or the posts, never both, no horizontal scroll, a back link, links only (keyboard reachable). Synthetic data only.
// Message content is drawn as text (rule 9). There is no unread marker anywhere in a channel (Microsoft offers none).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const refresh = vi.hoisted(() => vi.fn());
const addr = vi.hoisted(() => ({ q: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/PKG/messages", useSearchParams: () => new URLSearchParams(addr.q) }));

import { ChannelFailureCard, ChannelRows, ChannelsUnavailable, NoChannelSelected, TeamsList, ThreadPane } from "./messages-channels";
import { MessagesScreen } from "./messages-page";
import { MessagesScope, MessagesTabs } from "./messages-scope";
import { WorkspaceLayout } from "./messages-chats";
import { encodeChannelKey } from "@/lib/teams-channel-key";
import { htmlToNodes } from "@nichols/connectors/teams-pure";
import type { ChannelListView, PostView, RepliesView, TeamListView, ThreadView } from "@/lib/teams-channels";
import type { MessagesState } from "@/lib/teams-messages";

afterEach(() => {
  cleanup();
  refresh.mockClear();
});
const WIDTHS = [1280, 390];
const at = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
};
const CONN = "00000000-0000-4000-8000-0000000000c1";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a2";
const CH = "19:general111@thread.tacv2";
const KEY = encodeChannelKey(CH);
// the account's features follow `missing` (an account that lacks channels is one whose `missing` lists them), as the page's state is built
const connected = (over: Partial<Extract<MessagesState, { kind: "connected" }>> = {}): Extract<MessagesState, { kind: "connected" }> => {
  const missing = over.missing ?? [];
  const has = (["chat_read", "call_links", "channels_read"] as const).filter((f) => !missing.includes(f));
  return { kind: "connected", connectionId: CONN, account: "me@teams.example.test", degraded: false, missing: [], adminConsent: false, accounts: [{ connectionId: CONN, account: "me@teams.example.test", label: "teams.example.test", usable: true, degraded: false, missing: [...missing], has: [...has] }], multi: false, canAddAnother: false, laneFeatures: ["chat_read", "channels_read"], ...over };
};
const post = (id: string, over: Partial<PostView> = {}): PostView =>
  ({ id, images: null, at: "2026-11-23T14:00:00.000Z", time: "9:00 AM", fullTime: "Nov 23, 2026, 9:00 AM ET", day: "2026-11-23", sender: "Pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: `post ${id}` }], truncated: false, attachments: [], subject: null, openUrl: "https://teams.microsoft.com/l/message/x/1", ...over }) as PostView;

describe.each(WIDTHS)("channel states at %ipx", (width) => {
  it("the company has not switched channels on: a short neutral line, no button, no error", () => {
    at(width);
    render(<ChannelsUnavailable laneId="PKG" state={connected({ laneFeatures: ["chat_read"] })} />);
    expect(screen.getByText("Channels are not switched on for this company.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the company lists channels and this connection lacks them: Reconnect Teams to add channels, with the administrator's approval text and a Reconnect button for THIS connection", () => {
    at(width);
    render(<ChannelsUnavailable laneId="PKG" state={connected({ missing: ["channels_read"], adminConsent: true })} />);
    const box = screen.getByTestId("channels-reconnect");
    expect(box.textContent).toContain("Reconnect Teams to add channels");
    expect(box.textContent).toContain("admin must approve");
    const form = within(box).getByRole("button", { name: "Reconnect Teams" }).closest("form");
    expect(form?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${CONN}`);
  });

  it("without the admin consent flag the reconnect line stands alone", () => {
    at(width);
    render(<ChannelsUnavailable laneId="PKG" state={connected({ missing: ["channels_read"], adminConsent: false })} />);
    expect(screen.getByTestId("channels-reconnect").textContent).not.toContain("admin must approve");
  });

  it("ready draws nothing here (the workspace does)", () => {
    at(width);
    const { container } = render(<ChannelsUnavailable laneId="PKG" state={connected()} />);
    expect(container.innerHTML).toBe("");
  });

  it("failures are fixed states with Try again: busy with seconds, could not load, not a member; a refused team list is the administrator's approval; reconnect names the connection", () => {
    at(width);
    const cases: [Parameters<typeof ChannelFailureCard>[0]["failure"], "teams" | "channels" | "channel", string][] = [
      [{ kind: "busy", seconds: 7 }, "channel", "Teams is busy. Try again in 7 seconds."],
      [{ kind: "unavailable" }, "teams", "could not read your teams"],
      [{ kind: "forbidden" }, "channel", "A private channel can be read only by its members."],
      [{ kind: "forbidden" }, "teams", "Channels need your Microsoft administrator's approval"],
      [{ kind: "forbidden" }, "teams", "It can also mean this account cannot use Teams channels right now"],
      [{ kind: "forbidden" }, "channels", "Teams did not let the portal list the channels of this team"],
      [{ kind: "not_found" }, "channel", "This channel could not be opened"],
      [{ kind: "not_enabled" }, "teams", "Teams is not switched on for this account or company right now"],
    ];
    for (const [failure, scope, text] of cases) {
      cleanup();
      render(<ChannelFailureCard failure={failure} laneId="PKG" connectionId={CONN} testId="x" scope={scope} />);
      expect(screen.getByTestId("x").textContent).toContain(text);
      const retry = screen.queryByRole("button", { name: "Try again" });
      expect(Boolean(retry), `${failure.kind} ${scope}`).toBe(failure.kind !== "not_found" && failure.kind !== "not_enabled");
      // the refused team list also offers Reconnect Teams (the approval may have been given since)
      expect(Boolean(screen.queryByRole("button", { name: "Reconnect Teams" })), `${failure.kind} ${scope}`).toBe(failure.kind === "forbidden" && scope === "teams");
    }
    cleanup();
    render(<ChannelFailureCard failure={{ kind: "reconnect" }} laneId="PKG" connectionId={CONN} testId="x" scope="teams" />);
    expect(screen.getByRole("button", { name: "Reconnect Teams" }).closest("form")?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${CONN}`);
  });
});

describe.each(WIDTHS)("teams and channels at %ipx", (width) => {
  const teams: TeamListView = { kind: "ok", teams: [{ teamId: T1, name: "Alpha", archived: false }, { teamId: T2, name: "Zed", archived: true }], more: false };
  const channels: ChannelListView = {
    kind: "ok",
    channels: [
      { key: KEY, name: "General", kind: "standard", readable: true, openUrl: "https://teams.microsoft.com" },
      { key: encodeChannelKey("19:priv@thread.tacv2"), name: "Leads", kind: "private", readable: true, openUrl: "https://teams.microsoft.com" },
      { key: encodeChannelKey("19:shared@thread.tacv2"), name: "Partners", kind: "shared", readable: false, openUrl: "https://teams.microsoft.com/l/channel/shared" },
    ],
  };

  it("teams are links to their own address; the open team is marked expanded; no unread dot anywhere", () => {
    at(width);
    render(<TeamsList view={teams} laneId="PKG" connectionId={CONN} teamId={T1} channels={null} selectedKey={null} />);
    const rows = screen.getAllByTestId("team-row");
    expect(rows.map((r) => r.textContent)).toEqual(["▾Alpha", "▸ZedArchived"]);
    expect(rows[0]?.getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}`);
    expect(rows.map((r) => r.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(screen.queryByTestId("unread-dot")).toBeNull();
    expect(screen.queryByText("Unread")).toBeNull();
  });

  it("empty and failed team lists are sentences, never an empty list; more teams than listed is said", () => {
    at(width);
    render(<TeamsList view={{ kind: "ok", teams: [], more: false }} laneId="PKG" connectionId={CONN} teamId={null} channels={null} selectedKey={null} />);
    expect(screen.getByText("No teams")).toBeTruthy();
    cleanup();
    render(<TeamsList view={{ kind: "unavailable" }} laneId="PKG" connectionId={CONN} teamId={null} channels={null} selectedKey={null} />);
    expect(screen.getByTestId("team-list-error")).toBeTruthy();
    cleanup();
    render(<TeamsList view={{ ...teams, more: true }} laneId="PKG" connectionId={CONN} teamId={null} channels={null} selectedKey={null} />);
    expect(screen.getByText("More teams exist than are listed here.")).toBeTruthy();
  });

  it("channels: standard and private ones are links (private labelled), a shared one is not read but opens in Teams; the selected one is marked", () => {
    at(width);
    render(<ChannelRows laneId="PKG" teamId={T1} selectedKey={KEY} view={channels} connectionId={CONN} />);
    const rows = screen.getAllByTestId("channel-row");
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([`/PKG/messages?tab=channels&team=${T1}&channel=${KEY}`, `/PKG/messages?tab=channels&team=${T1}&channel=${encodeChannelKey("19:priv@thread.tacv2")}`]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("page");
    expect(within(rows[1] as HTMLElement).getByText("Private")).toBeTruthy();
    const shared = screen.getByTestId("channel-row-shared");
    expect(within(shared).getByText("Shared")).toBeTruthy();
    const open = within(shared).getByRole("link", { name: "Open in Teams" });
    expect(open.getAttribute("href")).toBe("https://teams.microsoft.com/l/channel/shared");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toMatch(/noopener/);
    expect(within(shared).queryByRole("link", { name: "Partners" })).toBeNull();
  });

  it("a team with no channels and a failed channel list are sentences", () => {
    at(width);
    render(<ChannelRows laneId="PKG" teamId={T1} selectedKey={null} view={{ kind: "ok", channels: [] }} connectionId={CONN} />);
    expect(screen.getByText("This team has no channels you can see.")).toBeTruthy();
    cleanup();
    render(<ChannelRows laneId="PKG" teamId={T1} selectedKey={null} view={{ kind: "unavailable" }} connectionId={CONN} />);
    expect(screen.getByTestId("channel-list-error")).toBeTruthy();
  });

  it("the layout is the existing two panes: on a phone the list is hidden once a channel is open and the posts are the screen; nothing scrolls sideways", () => {
    at(width);
    const { container } = render(<WorkspaceLayout selected list={<p>list</p>} conversation={<p>posts</p>} />);
    expect(screen.getByTestId("chat-list-pane").className).toContain("hidden lg:block");
    expect(screen.getByTestId("conversation-pane").className).toContain("block");
    expect(container.innerHTML).not.toMatch(/overflow-x-scroll|w-\[\d{4,}px\]/);
    cleanup();
    render(<WorkspaceLayout selected={false} list={<p>list</p>} conversation={<NoChannelSelected team={false} />} />);
    expect(screen.getByTestId("chat-list-pane").className).toContain("block");
    expect(screen.getByTestId("conversation-pane").className).toContain("hidden lg:block");
    expect(screen.getByText(/Teams offers no unread marker for channels/)).toBeTruthy();
  });
});

describe.each(WIDTHS)("the posts at %ipx", (width) => {
  const draw = (over: Partial<Parameters<typeof ThreadPane>[0]> = {}) => {
    at(width);
    const thread: ThreadView = { kind: "ok", posts: [post("p1", { subject: "Budget review" }), post("p2", { mine: true })], nextCursor: "cur1" };
    return render(<ThreadPane thread={thread} replies={null} laneId="PKG" connectionId={CONN} teamId={T1} channelKey={KEY} postId={null} more={null} title="General" subtitle="Alpha" openUrl="https://teams.microsoft.com/l/channel/x" {...over} />);
  };

  it("header: the channel and team names as text, a back link to the team's channels (phone only), Open in Teams, Refresh; no composer, no unread", () => {
    draw();
    expect(screen.getByTestId("conversation-title").textContent).toBe("General");
    expect(screen.getByText("Alpha")).toBeTruthy();
    const back = screen.getByTestId("back-to-channels");
    expect(back.getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}`);
    expect(back.className).toContain("lg:hidden");
    expect(screen.getByTestId("open-channel-in-teams").getAttribute("href")).toBe("https://teams.microsoft.com/l/channel/x");
    expect(screen.getByTestId("messages-refresh")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("unread-dot")).toBeNull();
    expect(screen.getByTestId("conversation-scroll").getAttribute("tabindex")).toBe("0"); // reachable by keyboard
  });

  it("each post: subject, sender, text, time, a Replies link to its own address, Open in Teams; More posts is an explicit link with the cursor", () => {
    draw();
    const items = screen.getAllByTestId("message");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByTestId("post-subject").textContent).toBe("Budget review");
    expect(within(items[0] as HTMLElement).getByText("post p1")).toBeTruthy();
    expect(within(items[0] as HTMLElement).getByTestId("replies-link").getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}&channel=${KEY}&post=p1`);
    expect(within(items[0] as HTMLElement).getByTestId("open-post-in-teams").getAttribute("href")).toBe("https://teams.microsoft.com/l/message/x/1");
    expect(screen.getByTestId("more-posts").getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}&channel=${KEY}&more=cur1`);
    expect(screen.queryByTestId("newest-posts")).toBeNull();
  });

  it("on a later page: Back to the newest posts, and the post links keep the page", () => {
    draw({ more: "cur0" });
    expect(screen.getByTestId("newest-posts").getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}&channel=${KEY}`);
    expect(screen.getAllByTestId("replies-link")[0]?.getAttribute("href")).toContain("more=cur0");
  });

  it("an open post shows its replies beneath it (oldest first) and offers Hide replies; the replies list is a list of messages", () => {
    const replies: RepliesView = { kind: "ok", postId: "p1", replies: [post("r1", { nodes: [{ t: "text", v: "first reply" }] }), post("r2", { nodes: [{ t: "text", v: "second reply" }] })], more: false };
    draw({ postId: "p1", replies });
    const first = screen.getAllByTestId("message")[0] as HTMLElement;
    expect(within(first).getByTestId("replies-link").textContent).toBe("Hide replies");
    expect(within(first).getByTestId("replies-link").getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}&channel=${KEY}`);
    const list = within(first).getByTestId("reply-list");
    expect(within(list).getAllByTestId("message-body").map((b) => b.textContent)).toEqual(["first reply", "second reply"]);
    expect(screen.queryByTestId("replies-elsewhere")).toBeNull();
  });

  it("replies: none, more than shown, and could not load are fixed lines", () => {
    draw({ postId: "p1", replies: { kind: "ok", postId: "p1", replies: [], more: true } });
    expect(screen.getByText("No replies.")).toBeTruthy();
    expect(screen.getByText(/There are more replies/)).toBeTruthy();
    cleanup();
    draw({ postId: "p1", replies: { kind: "unavailable" } });
    expect(screen.getByTestId("replies-error").textContent).toContain("could not be read");
    expect(screen.getAllByTestId("message")).toHaveLength(2); // the posts stay
  });

  it("replies of a post that is not on this page are shown at the top with a Close link", () => {
    draw({ postId: "elsewhere", replies: { kind: "ok", postId: "elsewhere", replies: [post("r1")], more: false }, more: "cur0" });
    const box = screen.getByTestId("replies-elsewhere");
    expect(within(box).getByRole("link", { name: "Close" }).getAttribute("href")).toBe(`/PKG/messages?tab=channels&team=${T1}&channel=${KEY}&more=cur0`);
  });

  it("empty channel and failed read: a sentence and an error card, never a blank pane", () => {
    draw({ thread: { kind: "ok", posts: [], nextCursor: null } });
    expect(screen.getByTestId("no-posts").textContent).toBe("No posts in this channel yet.");
    cleanup();
    draw({ thread: { kind: "forbidden" } });
    expect(screen.getByTestId("conversation-error").textContent).toContain("A private channel can be read only by its members.");
    expect(screen.queryByTestId("post-list")).toBeNull();
  });

  it("hostile HTML through the converter is plain text or nothing: no script, handler, style, javascript link or external picture creates an element; a link is https with its host shown", () => {
    const { nodes } = htmlToNodes(`<script>window.pwned=1</script><p onclick="window.pwned=2">Hi <b>there</b> <a href="javascript:window.pwned=3">bad</a> <a href="https://ok.example.test/a">good</a></p><img src="https://tracker.example.test/p.png"><iframe src="https://evil.example.test"></iframe><style>*{display:none}</style>`);
    draw({ thread: { kind: "ok", posts: [post("p1", { nodes })], nextCursor: null } });
    const body = screen.getByTestId("message-body");
    expect(body.querySelector("script,iframe,style,form,svg")).toBeNull();
    expect(body.innerHTML).not.toMatch(/onclick|javascript:|tracker|evil/);
    expect(Array.from(body.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://ok.example.test/a"]);
    expect(body.querySelector("img")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("a canary in the subject, name or text appears only as text", () => {
    draw({ title: "<img src=x onerror=alert(1)>", thread: { kind: "ok", posts: [post("p1", { subject: "<script>x()</script>" })], nextCursor: null } });
    expect(screen.getByTestId("conversation-title").textContent).toBe("<img src=x onerror=alert(1)>");
    expect(screen.getByTestId("post-subject").textContent).toBe("<script>x()</script>");
    expect(document.querySelector("script,img[onerror]")).toBeNull();
  });
});

describe.each(WIDTHS)("dates, order and shared channels at %ipx (T-291 review H1, L1)", (width) => {
  const draw = (over: Partial<Parameters<typeof ThreadPane>[0]> = {}) => {
    at(width);
    const thread: ThreadView = {
      kind: "ok",
      posts: [
        post("p1", { at: "2026-11-02T20:07:00.000Z", time: "3:07 PM", fullTime: "Nov 2, 2026, 3:07 PM ET" }), // three weeks old, but its newest reply is recent: it sits on top
        post("p2", { at: "2026-11-23T14:00:00.000Z", time: "9:00 AM", fullTime: "Nov 23, 2026, 9:00 AM ET" }),
      ],
      nextCursor: null,
    };
    return render(<ThreadPane thread={thread} replies={null} laneId="PKG" connectionId={CONN} teamId={T1} channelKey={KEY} postId={null} more={null} title="General" subtitle="Alpha" openUrl="https://teams.microsoft.com" {...over} />);
  };

  it("every post and reply shows its DATE with the time (a phone has no tooltip), and the pane says the order", () => {
    draw({ postId: "p1", replies: { kind: "ok", postId: "p1", replies: [post("r1", { fullTime: "Nov 22, 2026, 4:30 PM ET", time: "4:30 PM" })], more: false } });
    const times = screen.getAllByRole("time", { hidden: true }).map((t) => t.textContent);
    expect(times).toEqual(["Nov 2, 2026, 3:07 PM ET", "Nov 22, 2026, 4:30 PM ET", "Nov 23, 2026, 9:00 AM ET"]);
    expect(times.join()).not.toMatch(/^(\d+:\d+ [AP]M),/);
    expect(screen.getByTestId("posts-order").textContent).toBe("Posts with the newest replies come first.");
  });

  it("a shared channel is not read: the posts pane says so and offers Open in Teams; no posts, no composer", () => {
    draw({ thread: { kind: "shared", openUrl: "https://teams.microsoft.com/l/channel/shared" } });
    const box = screen.getByTestId("shared-channel");
    expect(box.textContent).toContain("shared channel");
    expect(within(box).getByRole("link", { name: "Open in Teams" }).getAttribute("href")).toBe("https://teams.microsoft.com/l/channel/shared");
    expect(screen.queryByTestId("post-list")).toBeNull();
    expect(screen.queryByTestId("conversation-error")).toBeNull();
  });

  it("end to end for one refused channel: its pane says 'members only' while the channel list stays", () => {
    at(width);
    render(
      <>
        <ChannelRows laneId="PKG" teamId={T1} selectedKey={KEY} connectionId={CONN} view={{ kind: "ok", channels: [{ key: KEY, name: "General", kind: "standard", readable: true, openUrl: "https://teams.microsoft.com" }, { key: encodeChannelKey("19:other@thread.tacv2"), name: "Other", kind: "standard", readable: true, openUrl: "https://teams.microsoft.com" }] }} />
        <ThreadPane thread={{ kind: "forbidden" }} replies={null} laneId="PKG" connectionId={CONN} teamId={T1} channelKey={KEY} postId={null} more={null} title="General" subtitle="Alpha" openUrl="https://teams.microsoft.com" />
      </>,
    );
    expect(screen.getAllByTestId("channel-row")).toHaveLength(2);
    expect(screen.getByTestId("conversation-error").textContent).toContain("A private channel can be read only by its members.");
  });

  it("a picture in a channel post is a placeholder with neutral wording (not 'the chat')", () => {
    at(width);
    render(<ThreadPane thread={{ kind: "ok", posts: [post("p1", { nodes: [{ t: "image" }] })], nextCursor: null }} replies={null} laneId="PKG" connectionId={CONN} teamId={T1} channelKey={KEY} postId={null} more={null} title="General" subtitle="Alpha" openUrl="https://teams.microsoft.com" />);
    expect(screen.getByTestId("image-placeholder").textContent).toBe("Image: open in Teams to see it");
  });
});

describe.each(WIDTHS)("the tabs and the page around them at %ipx", (width) => {
  it("Chats and Channels are two plain links to stable addresses; the open one is marked; hidden on a phone while a conversation has the screen", () => {
    at(width);
    render(<MessagesTabs laneId="PKG" tab="channels" hideOnPhone={false} />);
    expect(screen.getByTestId("tab-chats").getAttribute("href")).toBe("/PKG/messages");
    expect(screen.getByTestId("tab-channels").getAttribute("href")).toBe("/PKG/messages?tab=channels");
    expect(screen.getByTestId("tab-channels").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("tab-chats").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("messages-tabs").className).not.toContain("hidden");
    cleanup();
    render(<MessagesTabs laneId="PKG" tab="chats" hideOnPhone />);
    expect(screen.getByTestId("messages-tabs").className).toContain("hidden lg:flex");
  });

  it("on the Channels tab the page's own feature note leaves channels out (the tab says it once), but another missing feature is still listed", () => {
    at(width);
    const screenFor = (tab: "chats" | "channels", state: Extract<MessagesState, { kind: "connected" }>) => {
      addr.q = tab === "channels" ? "tab=channels" : "";
      return render(
        <MessagesScope chatConns={[CONN]}>
          <MessagesScreen laneId="PKG" state={state} />
        </MessagesScope>,
      );
    };
    screenFor("channels", connected({ missing: ["channels_read"], adminConsent: true }));
    expect(screen.queryByTestId("messages-feature-missing")).toBeNull();
    cleanup();
    screenFor("channels", connected({ missing: ["channels_read", "call_links"], adminConsent: true }));
    const note = screen.getByTestId("messages-feature-missing").textContent ?? "";
    expect(note).toContain("call buttons");
    expect(note).not.toContain("channels");
    cleanup();
    screenFor("chats", connected({ missing: ["channels_read"], adminConsent: true }));
    expect(screen.getByTestId("messages-feature-missing").textContent).toContain("Reconnect Teams to add channels");
  });
});

describe("the Chats | Channels bar (T-291 review M1)", () => {
  it("is drawn only for a company that lists channels_read; a direct Channels address for any other company still gets its neutral state with a way back", async () => {
    const { ConnectedFrame } = await import("./messages-page");
    const { LiveTabs } = await import("./messages-scope");
    const has = (node: unknown, type: unknown): boolean => {
      if (Array.isArray(node)) return node.some((n) => has(n, type));
      if (typeof node !== "object" || node === null) return false;
      const el = node as { type?: unknown; props?: { children?: unknown } };
      return el.type === type || has(el.props?.children, type);
    };
    const off = connected({ laneFeatures: ["chat_read"] });
    const on = connected({ laneFeatures: ["chat_read", "channels_read"] });
    expect(has(ConnectedFrame({ laneId: "PKG", state: off, children: null }), LiveTabs)).toBe(false);
    expect(has(ConnectedFrame({ laneId: "PKG", state: on, children: null }), LiveTabs)).toBe(true);
    at(1280);
    render(<ChannelsUnavailable laneId="PKG" state={off} />);
    expect(screen.getByTestId("back-to-chats-link").getAttribute("href")).toBe("/PKG/messages");
  });
});
