// @vitest-environment jsdom
// T-283, T-284: the chat list and the conversation, drawn for every state at desktop (1280) and iPhone (390) width. jsdom evaluates no CSS, so the width is set (a component that branched on
// it would show) and the layout is checked through the classes that make the single column on a phone: the list or the conversation, never both, no horizontal scroll, the back link.
// Synthetic chats only. Message content is drawn as text (rule 9): every hostile string below must appear as text and create no element.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/PKG/messages" }));

import { ChatListSkeleton, ChatListView, ConversationPane, ConversationSkeleton, NoChatSelected, TeamsFailureCard, WorkspaceLayout } from "./messages-chats";
import { htmlToNodes } from "@nichols/connectors/teams-pure";
import type { ChatListView as ChatListData, ConversationView, MessageView } from "@/lib/teams-chats";
import { encodeChatKey } from "@/lib/teams-chat-key";

afterEach(() => {
  cleanup();
  refresh.mockClear();
});
const WIDTHS = [1280, 390];
const at = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
};
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const CONN = "00000000-0000-4000-8000-0000000000c1";
const row = (over: Partial<Extract<ChatListData, { kind: "ok" }>["rows"][number]> = {}) => ({ key: encodeChatKey("19:x1@thread.v2"), title: "Pat Example", preview: "see you at 3", time: "9:05 AM", unread: false, external: false, ...over });
const msg = (id: string, at: string, over: Record<string, unknown> = {}): MessageView => ({ id, at, time: "9:05 AM", fullTime: "Nov 23, 2026, 9:05 AM ET", day: at.slice(0, 10), sender: "Pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: `text ${id}` }], truncated: false, attachments: [], ...over }) as unknown as MessageView;
const conv = (over: Partial<Extract<ConversationView, { kind: "ok" }>> = {}): ConversationView => ({
  kind: "ok", chatKey: KEY, title: "Team chat", subtitle: "3 people", external: false, group: true, openUrl: `https://teams.microsoft.com/l/chat/${CHAT}/conversations`, call: "available",
  messages: [msg("m1", "2026-11-22T14:00:00.000Z"), msg("m2", "2026-11-23T14:00:00.000Z", { mine: true })], nextBefore: "2026-11-22T14:00:00.000Z", readThrough: "2026-11-23T14:00:00.000Z", ...over,
}) as ConversationView;

describe.each(WIDTHS)("the chat list at %ipx", (width) => {
  const draw = (view: ChatListData, selected: string | null = null, more: string | null = null) => {
    at(width);
    return render(<ChatListView view={view} laneId="PKG" connectionId={CONN} selectedKey={selected} more={more} />);
  };

  it("rows: title, preview, time, an unread dot only where unread, External only where external; the selected row is marked", () => {
    const sel = encodeChatKey("19:x2@thread.v2");
    draw({ kind: "ok", rows: [row({ unread: true }), row({ key: sel, title: "Second", external: true }), row({ key: encodeChatKey("19:x3@thread.v2"), title: "Third" })], moreCursor: null }, sel);
    const rows = screen.getAllByTestId("chat-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-unread"))).toEqual(["true", "false", "false"]);
    expect(screen.getAllByTestId("unread-dot")).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText("Pat Example")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("see you at 3")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("9:05 AM")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Unread")).toBeTruthy(); // for a screen reader
    expect(within(rows[1] as HTMLElement).getByText("External")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByText("External")).toBeNull();
    expect(rows[1]?.getAttribute("aria-current")).toBe("page");
    expect(rows[0]?.getAttribute("aria-current")).toBeNull();
    expect(rows[0]?.getAttribute("href")).toBe(`/PKG/messages?chat=${encodeChatKey("19:x1@thread.v2")}`);
  });

  it("More chats and Back to the newest chats are explicit links that keep the selected chat", () => {
    const sel = encodeChatKey("19:x2@thread.v2");
    draw({ kind: "ok", rows: [row()], moreCursor: "cursor-abc" }, sel, "cur0");
    expect(screen.getByTestId("more-chats").getAttribute("href")).toBe(`/PKG/messages?chat=${sel}&more=cursor-abc`);
    expect(screen.getByTestId("newest-chats").getAttribute("href")).toBe(`/PKG/messages?chat=${sel}`);
    // rows keep the page the person is on
    expect(screen.getByTestId("chat-row").getAttribute("href")).toContain("more=cur0");
  });

  it("no more chats: no More link", () => {
    draw({ kind: "ok", rows: [row()], moreCursor: null });
    expect(screen.queryByTestId("more-chats")).toBeNull();
    expect(screen.queryByTestId("newest-chats")).toBeNull();
  });

  it("empty: a sentence, no sample rows", () => {
    draw({ kind: "ok", rows: [], moreCursor: null });
    expect(screen.getByText("No chats")).toBeTruthy();
    expect(screen.queryByTestId("chat-list")).toBeNull();
  });

  it("could not load: an error card with Try again, never an empty list", () => {
    draw({ kind: "unavailable" });
    expect(screen.getByTestId("chat-list-error").textContent).toContain("Teams could not be reached");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByTestId("chat-list")).toBeNull();
    expect(screen.queryByText("No chats")).toBeNull();
  });

  it("Teams busy: 'try again in N seconds' and no automatic retry (a button; no timer)", () => {
    vi.useFakeTimers();
    draw({ kind: "busy", seconds: 7 });
    expect(screen.getByTestId("chat-list-error").textContent).toContain("Teams is busy. Try again in 7 seconds.");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    cleanup();
    draw({ kind: "busy", seconds: null });
    expect(screen.getByTestId("chat-list-error").textContent).toContain("Teams is busy. Try again in a moment.");
    cleanup();
    draw({ kind: "busy", seconds: 1 });
    expect(screen.getByTestId("chat-list-error").textContent).toContain("1 second.");
  });

  it("needs reconnect: Reconnect Teams posts to the Teams connect route for this connection", () => {
    draw({ kind: "reconnect" });
    const form = within(screen.getByTestId("chat-list-error")).getByRole("button", { name: "Reconnect Teams" }).closest("form");
    expect(form?.getAttribute("action")).toBe(`/api/connect/teams/start?lane=PKG&connection=${CONN}`);
  });

  it("forbidden says so; the loading skeleton is a status with no text from Teams", () => {
    draw({ kind: "forbidden" });
    expect(screen.getByTestId("chat-list-error").textContent).toContain("Teams did not allow the portal to read this");
    cleanup();
    at(width);
    render(<ChatListSkeleton />);
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  });

  it("a hostile title, preview and member label are text, never elements", () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    draw({ kind: "ok", rows: [row({ title: evil, preview: evil })], moreCursor: null });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
  });
});

describe.each(WIDTHS)("the conversation at %ipx", (width) => {
  const draw = (view: ConversationView) => {
    at(width);
    return render(<ConversationPane view={view} laneId="PKG" connectionId={CONN} />);
  };

  it("header: title, subtitle, Refresh, Call, Video call and Open in Teams (a new-tab https link); a back link for the phone; times are ET", () => {
    draw(conv());
    expect(screen.getByTestId("conversation-title").textContent).toBe("Team chat");
    expect(screen.getByText("3 people")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Call" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Video call" })).toBeTruthy();
    const open = screen.getByTestId("open-in-teams") as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe(`https://teams.microsoft.com/l/chat/${CHAT}/conversations`);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    const back = screen.getByTestId("back-to-chats");
    expect(back.getAttribute("href")).toBe("/PKG/messages");
    expect(back.className).toContain("lg:hidden"); // phone only
    expect(screen.getByText("Times are Eastern Time (ET).")).toBeTruthy();
  });

  it("messages: oldest first, a separator for each New York day, mine on the right, sender names in a group, Edited and deleted markers", () => {
    draw(conv({ messages: [msg("m1", "2026-11-22T14:00:00.000Z", { edited: true }), msg("m2", "2026-11-22T15:00:00.000Z", { deleted: true, nodes: [] }), msg("m3", "2026-11-23T14:00:00.000Z", { mine: true }), msg("m4", "2026-11-23T14:05:00.000Z", { system: true, nodes: [] })] }));
    const items = screen.getAllByTestId("message");
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.getAttribute("data-mine"))).toEqual(["false", "false", "true", "false"]);
    expect(screen.getAllByRole("separator").map((s) => s.getAttribute("aria-label"))).toEqual(["Sunday, November 22, 2026", "Monday, November 23, 2026"]);
    expect(within(items[0] as HTMLElement).getByText("Pat")).toBeTruthy(); // sender name in a group
    expect(within(items[2] as HTMLElement).queryByText("Pat")).toBeNull(); // not on my own
    expect(within(items[0] as HTMLElement).getByText(/Edited/)).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText("This message was deleted")).toBeTruthy();
    expect(within(items[3] as HTMLElement).getByText("Teams event")).toBeTruthy();
    expect(screen.getAllByText("9:05 AM")[0]?.getAttribute("title")).toBe("Nov 23, 2026, 9:05 AM ET");
  });

  it("a 1:1 chat draws no sender names", () => {
    draw(conv({ group: false, subtitle: "2 people" }));
    expect(screen.queryByText("Pat")).toBeNull();
  });

  it("Load older messages is there while there is more, and 'the start of the chat' when there is not", () => {
    draw(conv());
    expect(screen.getByTestId("load-older")).toBeTruthy();
    cleanup();
    draw(conv({ nextBefore: null }));
    expect(screen.queryByTestId("load-older")).toBeNull();
    expect(screen.getByText("This is the start of the chat.")).toBeTruthy();
  });

  it("rich messages: links (https, new tab, host shown), mentions, emoji, an image placeholder, attachments, long messages", () => {
    const nodes = htmlToNodes('<p>see <a href="https://docs.example.test/a">the doc</a> <at id="0">Pat</at> <emoji alt="😀"></emoji></p><img src="https://graph.microsoft.com/v1.0/chats/x/messages/1/hostedContents/2/$value"><blockquote>quoted</blockquote>').nodes;
    draw(
      conv({
        messages: [
          msg("m1", "2026-11-23T14:00:00.000Z", {
            nodes,
            truncated: true,
            attachments: [
              { kind: "file", name: "Plan.docx", href: "https://contoso.sharepoint.com/f/a.docx", host: "contoso.sharepoint.com" },
              { kind: "file", name: "No link.docx", href: null, host: null },
              { kind: "card", name: "A card", href: null, host: null },
              { kind: "reply", name: "", href: null, host: null },
              { kind: "other", name: "thing", href: null, host: null },
            ],
          }),
        ],
      }),
    );
    const body = screen.getByTestId("message-body");
    const link = within(body).getByRole("link", { name: "the doc" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://docs.example.test/a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(body.textContent).toContain("(docs.example.test)");
    expect(body.textContent).toContain("@Pat");
    expect(body.textContent).toContain("😀");
    expect(body.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(within(body).getByTestId("image-placeholder").textContent).toContain("Image");
    expect(body.querySelector("img")).toBeNull(); // nothing is loaded
    expect(screen.getByText(/This message is long/)).toBeTruthy();
    const atts = screen.getAllByTestId("attachment");
    expect(atts).toHaveLength(5);
    const file = within(atts[0] as HTMLElement).getByRole("link") as HTMLAnchorElement;
    expect(file.getAttribute("href")).toBe("https://contoso.sharepoint.com/f/a.docx");
    expect(file.textContent).toContain("(contoso.sharepoint.com)"); // the host is shown (SM1)
    expect(within(atts[1] as HTMLElement).queryByRole("link")).toBeNull();
    expect(atts[2]?.textContent).toBe("Card: A card: open in Teams");
    expect(atts[3]?.textContent).toBe("Replied to an earlier message");
    expect(atts[4]?.textContent).toBe("thing: open in Teams");
  });

  it("hostile message content is drawn as text: no script, image, iframe, handler or javascript link exists in the page", () => {
    const hostile = [
      "<script>alert(1)</script><img src=https://tracker.example.test/p.gif onerror=alert(2)><iframe src=https://evil.example.test></iframe>",
      '<a href="javascript:alert(3)" onclick="alert(4)">click</a><svg onload=alert(5)></svg><style>*{display:none}</style>',
      '<p style="x" onmouseover="alert(6)">hi <at id="0"><script>alert(7)</script></at></p><a href="data:text/html,x">d</a><form action=x><input></form>',
    ];
    const messages = hostile.map((h, i) => msg(`h${String(i)}`, `2026-11-23T14:0${String(i)}:00.000Z`, { nodes: htmlToNodes(h).nodes }));
    // a mention whose name looks like markup is text
    messages.push(msg("t0", "2026-11-23T14:08:00.000Z", { nodes: htmlToNodes("<at id='1'>&lt;script&gt;alert(7)&lt;/script&gt;</at>").nodes }));
    // and a text body that looks like markup stays text
    messages.push(msg("t1", "2026-11-23T14:09:00.000Z", { nodes: [{ t: "text", v: "<script>alert(8)</script><img src=x onerror=alert(9)>" }] }));
    // and a node that somehow carried a bad link is not clickable
    messages.push(msg("t2", "2026-11-23T14:10:00.000Z", { nodes: [{ t: "link", href: "javascript:alert(10)", host: "x", c: [{ t: "text", v: "bad link" }] }] }));
    draw(conv({ messages }));
    const root = screen.getByTestId("message-list");
    for (const sel of ["script", "img", "iframe", "svg", "style", "form", "input", "object", "embed", "[onclick]", "[onerror]", "[onload]", "[onmouseover]", "[style]"]) expect(root.querySelector(sel), sel).toBeNull();
    for (const a of Array.from(root.querySelectorAll("a"))) expect(a.getAttribute("href")?.startsWith("https://")).toBe(true);
    expect(root.textContent).toContain("<script>alert(8)</script><img src=x onerror=alert(9)>");
    expect(root.textContent).toContain("bad link");
    expect(root.innerHTML).not.toMatch(/javascript:|data:text/i);
    expect(root.textContent).toContain("@<script>alert(7)</script>"); // a mention that looks like markup is text
  });

  it("call states: unavailable reasons are said in words; Open in Teams is always there; no Call buttons", () => {
    for (const [call, text] of [
      ["external", "Calls from here are for chats with people in your own organisation"],
      ["too_many", "limited to ten people"],
      ["needs_reconnect", "Reconnect Teams to add call buttons."],
    ] as const) {
      draw(conv({ call }));
      expect(screen.queryByRole("button", { name: "Call" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Video call" })).toBeNull();
      expect(screen.getByTestId("call-note").textContent).toContain(text);
      expect(screen.getByTestId("open-in-teams")).toBeTruthy();
      cleanup();
    }
    for (const call of ["no_one", "off_lane"] as const) {
      draw(conv({ call }));
      expect(screen.queryByTestId("call-note")).toBeNull();
      expect(screen.queryByRole("button", { name: "Call" })).toBeNull();
      expect(screen.getByTestId("open-in-teams")).toBeTruthy();
      cleanup();
    }
  });

  it("failures are a card: not found has no retry button; busy, unavailable and reconnect keep theirs", () => {
    draw({ kind: "not_found" });
    expect(screen.getByTestId("conversation-error").textContent).toContain("This chat could not be opened");
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    draw({ kind: "busy", seconds: 3 });
    expect(screen.getByTestId("conversation-error").textContent).toContain("Try again in 3 seconds");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();
    draw({ kind: "reconnect" });
    expect(screen.getByRole("button", { name: "Reconnect Teams" })).toBeTruthy();
    cleanup();
    draw({ kind: "unavailable" });
    expect(screen.getByTestId("conversation-error").textContent).toContain("Teams could not be reached");
  });

  it("the skeleton has the shape of a conversation and no text from Teams", () => {
    at(width);
    render(<ConversationSkeleton />);
    expect(screen.getByTestId("conversation-skeleton").getAttribute("aria-busy")).toBe("true");
  });
});

describe("the phone layout: the list, then the conversation (never both); desktop shows both", () => {
  const layout = (selected: boolean) => render(<WorkspaceLayout selected={selected} list={<p>LIST</p>} conversation={selected ? <p>CONVERSATION</p> : <NoChatSelected />} />);

  it("nothing selected: the list is shown on a phone and the 'Select a chat' placeholder is wide-screen only", () => {
    layout(false);
    expect(screen.getByTestId("chat-list-pane").className).toContain("block");
    expect(screen.getByTestId("chat-list-pane").className).not.toContain("hidden");
    expect(screen.getByTestId("conversation-pane").className).toContain("hidden lg:block");
    expect(screen.getByText("Select a chat")).toBeTruthy();
  });

  it("a chat selected: the conversation fills the phone and the list is wide-screen only", () => {
    layout(true);
    expect(screen.getByTestId("chat-list-pane").className).toContain("hidden lg:block");
    expect(screen.getByTestId("conversation-pane").className).not.toContain("hidden");
    expect(screen.getByTestId("messages-workspace").getAttribute("data-selected")).toBe("true");
  });

  it("no horizontal page scroll: every pane can shrink (min-w-0), long words wrap, the grid is one column below lg", () => {
    layout(true);
    const grid = screen.getByTestId("messages-workspace");
    expect(grid.className).toContain("min-w-0");
    expect(grid.className).toContain("lg:grid-cols-");
    expect(grid.className).not.toMatch(/(^| )grid-cols-/); // single column until lg
    expect(screen.getByTestId("chat-list-pane").className).toContain("min-w-0");
    expect(screen.getByTestId("conversation-pane").className).toContain("min-w-0");
  });

  it("a failure card names no content and offers Try again", () => {
    render(<TeamsFailureCard failure={{ kind: "unavailable" }} laneId="PKG" testId="x" />);
    screen.getByRole("button", { name: "Try again" }).click();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("T-281 review follow-ups (view)", () => {
  it("C7h: the Back link keeps the page of chats the person was on", () => {
    render(<ConversationPane view={conv()} laneId="PKG" connectionId={CONN} more="cur0" />);
    expect(screen.getByTestId("back-to-chats").getAttribute("href")).toBe("/PKG/messages?more=cur0");
  });

  it("C7e: the host is not repeated when the link text already holds it; it is shown when it does not", () => {
    const nodes = htmlToNodes('<a href="https://docs.example.test/a">see docs.example.test now</a> <a href="https://other.example.test/">click here</a>').nodes;
    render(<ConversationPane view={conv({ messages: [msg("m1", "2026-11-23T14:00:00.000Z", { nodes })] })} laneId="PKG" connectionId={CONN} />);
    const body = screen.getByTestId("message-body").textContent ?? "";
    expect(body).not.toContain("(docs.example.test)");
    expect(body).toContain("(other.example.test)");
  });

  it("C7f: the heading can take focus, the day separator is not an li, and C7g: the conversation sizes itself for a phone", () => {
    render(<ConversationPane view={conv()} laneId="PKG" connectionId={CONN} />);
    expect(screen.getByTestId("conversation-title").getAttribute("tabindex")).toBe("-1");
    for (const s of screen.getAllByRole("separator")) expect(s.tagName).not.toBe("LI");
    expect(screen.getByTestId("conversation").className).toContain("h-[calc(100dvh-8.5rem)]");
  });

  it("C7i: an image-only message is the placeholder, not '(no text)'", () => {
    render(<ConversationPane view={conv({ messages: [msg("m1", "2026-11-23T14:00:00.000Z", { nodes: htmlToNodes('<img src="https://eu-api.asm.skype.com/v1/objects/0-x/views/imgo">').nodes })] })} laneId="PKG" connectionId={CONN} />);
    expect(screen.getByTestId("image-placeholder")).toBeTruthy();
    expect(screen.queryByText("(no text)")).toBeNull();
  });

  it("C7k: a chat with no messages shows the start-of-chat note and no list items", () => {
    render(<ConversationPane view={conv({ messages: [], nextBefore: null })} laneId="PKG" connectionId={CONN} />);
    expect(screen.getByText("This is the start of the chat.")).toBeTruthy();
    expect(screen.queryAllByTestId("message")).toHaveLength(0);
  });

  it("C4: a chat page whose only items are events draws no rows (they are filtered before the page)", () => {
    render(<ConversationPane view={conv({ messages: [] })} laneId="PKG" connectionId={CONN} />);
    expect(screen.queryByText("Teams event")).toBeNull();
  });
});
