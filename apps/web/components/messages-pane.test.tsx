// @vitest-environment jsdom
// T-297 (backlog; docs/specs/messages.md 11): the tidier conversation pane, at desktop (1280) and iPhone (375) width, for a 1:1 chat, a group chat, a long message, a run of short messages across two days and
// the empty conversation; the grouping rules; the header; the pinned composer place; the accessibility rules (reading order, labels, the time of every message for a screen reader, focus stays on Refresh)
// and the contrast of the own-message tint in both themes. jsdom evaluates no CSS, so layout is checked through the classes that make it (and the attributes the classes read). Synthetic data only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh }), usePathname: () => "/PKG/messages", useSearchParams: () => new URLSearchParams("") }));

import { ConversationPane } from "./messages-chats";
import { MessagesScreen } from "./messages-page";
import { groupMessages, GROUP_GAP_MS, GROUP_SPAN_MS } from "./messages-view";
import { htmlToNodes } from "@nichols/connectors/teams-pure";
import { clockTime, dayKey, fullTime } from "@/lib/teams-format";
import { encodeChatKey } from "@/lib/teams-chat-key";
import type { ConversationView, MessageView } from "@/lib/teams-chats";
import type { MessagesState } from "@/lib/teams-messages";

afterEach(() => {
  cleanup();
  nav.refresh.mockClear();
});
const WIDTHS = [1280, 375];
const at = (w: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  window.dispatchEvent(new Event("resize"));
};
const CONN = "00000000-0000-4000-8000-0000000000c1";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const msg = (id: string, iso: string, over: Partial<MessageView> = {}): MessageView => ({ id, images: null, at: iso, time: clockTime(iso), fullTime: fullTime(iso), day: dayKey(iso), sender: "Pat Example", senderKey: "k-pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: `text ${id}` }], truncated: false, attachments: [], ...over });
const conv = (messages: MessageView[], over: Partial<Extract<ConversationView, { kind: "ok" }>> = {}): ConversationView => ({
  kind: "ok", chatKey: KEY, conn: CONN, account: null, accountName: null, title: "Project chat", subtitle: "2 people", external: false, group: false, openUrl: `https://teams.microsoft.com/l/chat/${CHAT}/conversations`, call: "available",
  messages, nextBefore: null, readThrough: null, ...over,
}) as ConversationView;
const T = (h: number, m: number, day = 23) => `2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("groupMessages (pure)", () => {
  const g = (ms: MessageView[], after: string | null = null) => groupMessages(ms, after).map((i) => (i.kind === "day" ? `day ${i.at.slice(0, 10)}` : `group ${i.messages.map((m) => m.id).join("+")}`));

  it("one sender within five minutes of the message before is one group; the gap is measured to the PREVIOUS message, so a steady talker stays in one group", () => {
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 5)), msg("c", T(15, 10))])).toEqual(["day 2026-11-23", "group a+b+c"]);
    expect(GROUP_GAP_MS).toBe(300_000);
  });

  it("a gap over five minutes, another sender, the other side, or a Teams event starts a new group", () => {
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 5, 23).replace(":00.000Z", ":01.000Z"))])).toEqual(["day 2026-11-23", "group a", "group b"]);
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 1), { sender: "Sam Example", senderKey: "k-sam" })])).toEqual(["day 2026-11-23", "group a", "group b"]);
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 1), { mine: true })])).toEqual(["day 2026-11-23", "group a", "group b"]);
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 1), { system: true }), msg("c", T(15, 2))])).toEqual(["day 2026-11-23", "group a", "group b", "group c"]);
  });

  it("L1: grouped by sender ID, never by display name: two people with one name, or a sender with no ID, are never one group; a deleted note and a Teams event always stand alone", () => {
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 1), { senderKey: "k-other" })])).toEqual(["day 2026-11-23", "group a", "group b"]); // same name "Pat Example", different people
    expect(g([msg("a", T(15, 0), { senderKey: null }), msg("b", T(15, 1), { senderKey: null })])).toEqual(["day 2026-11-23", "group a", "group b"]);
    expect(g([{ ...msg("a", T(15, 0)), senderKey: undefined }, { ...msg("b", T(15, 1)), senderKey: undefined }])).toEqual(["day 2026-11-23", "group a", "group b"]);
    expect(g([msg("a", T(15, 0)), msg("b", T(15, 1), { deleted: true, nodes: [] }), msg("c", T(15, 2))])).toEqual(["day 2026-11-23", "group a", "group b", "group c"]);
  });

  it("L4: a group spans at most 15 minutes from its first message, even when every gap is under five", () => {
    const steady = [0, 4, 8, 12, 16, 20].map((m) => msg(`m${m}`, T(15, m)));
    expect(g(steady)).toEqual(["day 2026-11-23", "group m0+m4+m8+m12", "group m16+m20"]);
    expect(GROUP_SPAN_MS).toBe(900_000);
  });

  it("a day change (New York time) separates groups even a minute apart; a time that does not parse never joins; an older page keeps its day", () => {
    // 11:58 PM and 12:01 AM Eastern, three minutes apart
    expect(g([msg("a", "2026-11-23T04:58:00.000Z"), msg("b", "2026-11-23T05:01:00.000Z")])).toEqual(["day 2026-11-23", "group a", "day 2026-11-23", "group b"]);
    expect(g([msg("a", T(15, 0)), { ...msg("b", T(15, 1)), at: "not a time" }])).toEqual(["day 2026-11-23", "group a", "group b"]);
    expect(g([msg("a", T(15, 0))], dayKey(T(15, 0)))).toEqual(["group a"]); // continuing a day already announced
  });

  it("is linear (a large list is one pass)", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => msg(`m${i}`, new Date(Date.UTC(2026, 10, 23, 15, 0, 0) + i * 60_000).toISOString()));
    const t0 = performance.now();
    const items = groupMessages(many);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(items.length).toBeGreaterThan(1);
  });
});

describe.each(WIDTHS)("the conversation pane at %ipx", (width) => {
  const draw = (view: ConversationView) => {
    at(width);
    return render(<ConversationPane view={view} laneId="PKG" connectionId={CONN} />);
  };

  it("1:1 chat: no sender names; a run of one person's short messages is ONE group with ONE time; mine on the right in its own group; each message keeps its time for a screen reader", () => {
    draw(conv([msg("m1", T(15, 0)), msg("m2", T(15, 1)), msg("m3", T(15, 2)), msg("m4", T(15, 3), { mine: true }), msg("m5", T(15, 4), { mine: true })]));
    const groups = screen.getAllByTestId("message-group");
    expect(groups.map((x) => x.getAttribute("data-mine"))).toEqual(["false", "true"]);
    expect(screen.queryAllByTestId("group-sender")).toHaveLength(0);
    expect(screen.getAllByTestId("group-time").map((t) => t.textContent)).toEqual(["10:02 AM", "10:04 AM"]); // one time per group: its last message
    expect(within(groups[0] as HTMLElement).getAllByTestId("message")).toHaveLength(3);
    // every message has its full time as text for a screen reader (and "You" / the sender), whatever the group shows
    const sr = screen.getAllByTestId("message").map((m) => m.querySelector(".sr-only")?.textContent);
    expect(sr[0]).toContain("Pat Example");
    expect(sr[0]).toContain("Nov 23, 2026, 10:00 AM ET");
    expect(sr[3]).toMatch(/^You,/);
    // the group's visible time is hidden from a screen reader (it would repeat the last message's time)
    expect(screen.getAllByTestId("group-time")[0]?.getAttribute("aria-hidden")).toBe("true");
    // own and incoming differ by position and by surface, not by colour alone: own is right-aligned and carries the primary tint; incoming is left-aligned on the muted surface
    expect(groups[1]?.className).toContain("items-end");
    expect(groups[0]?.className).toContain("items-start");
    const bubbles = screen.getAllByTestId("bubble");
    expect(bubbles[3]?.className).toContain("bg-primary-tint");
    expect(bubbles[0]?.className).toContain("bg-muted");
    expect(bubbles[0]?.className).not.toContain("bg-card");
  });

  it("group chat: the sender is named once per group, not on my own messages; a second sender is a second group", () => {
    draw(conv([msg("m1", T(15, 0)), msg("m2", T(15, 1)), msg("m3", T(15, 2), { sender: "Sam Example", senderKey: "k-sam" }), msg("m4", T(15, 3), { mine: true, sender: "Robert", senderKey: "k-robert" })], { group: true, subtitle: "3 people, includes external people" }));
    expect(screen.getAllByTestId("group-sender").map((s) => s.textContent)).toEqual(["Pat Example", "Sam Example"]);
    expect(screen.getAllByTestId("message-group")).toHaveLength(3);
    // the sender comes BEFORE the group's messages in the document (reading order)
    const first = screen.getAllByTestId("message-group")[0] as HTMLElement;
    expect(first.firstElementChild?.getAttribute("data-testid")).toBe("group-sender");
  });

  it("L5: a screen reader hears the sender once per message in a group chat: the visible group line is hidden from it, each bubble's hidden text carries the name and time", () => {
    draw(conv([msg("m1", T(15, 0)), msg("m2", T(15, 1))], { group: true, subtitle: "3 people" }));
    const group = screen.getAllByTestId("message-group")[0] as HTMLElement;
    expect(within(group).getByTestId("group-sender").getAttribute("aria-hidden")).toBe("true");
    const clone = group.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[aria-hidden=true]").forEach((e) => e.remove());
    expect((clone.textContent ?? "").match(/Pat Example/g)).toHaveLength(2); // once for each of the two messages, not three times
    expect(clone.textContent).toContain("Nov 23, 2026, 10:01 AM ET");
  });

  it("H1: the percentage cap of a bubble has a definite base all the way up: the group's list and every item are full width (alignment comes from items-start / items-end), up to the scrolling log", () => {
    // source-level, because jsdom has no layout: a bubble in a shrink-to-fit parent resolves max-width: calc(100% - 1.5rem) against its OWN content and ends up narrower than its text
    const view = readFileSync(join(__dirname, "messages-view.tsx"), "utf8");
    const client = readFileSync(join(__dirname, "messages-client.tsx"), "utf8");
    const bubble = readFileSync(join(__dirname, "messages-bubble.tsx"), "utf8");
    expect(bubble).toMatch(/max-w-\[min\(calc\(100%-1\.5rem\),65ch\)\]/);
    expect(view).toMatch(/<ul className=\{cn\("flex w-full min-w-0 flex-col gap-0\.5", g\.mine \? "items-end" : "items-start"\)\}>/);
    expect(view).toMatch(/<li key=\{m\.id\} data-testid="message" data-mine=\{m\.mine \? "true" : "false"\} className=\{cn\("flex w-full min-w-0 flex-col", g\.mine \? "items-end" : "items-start"\)\}>/);
    // the group item and the message list stretch (no items-* on the log or its list), so their width is the log's
    expect(client).toMatch(/<ul className="flex flex-col gap-3" data-testid="message-list">/);
    expect(client).toMatch(/role="log"[^>]*className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto/);
    expect(client).not.toMatch(/role="log"[^>]*items-/);
  });

  it("a long message: capped bubble (about 65 characters, never wider than the pane minus a margin), long words wrap, and the empty paragraphs Teams puts at the end are gone", () => {
    const long = "word ".repeat(300) + "x".repeat(400);
    const nodes = htmlToNodes(`<p>${long}</p><p>&nbsp;</p><p><br></p><p>&nbsp;</p><br>`).nodes;
    draw(conv([msg("m1", T(15, 0), { nodes })]));
    const bubble = screen.getByTestId("bubble");
    expect(bubble.className).toContain("max-w-[min(calc(100%-1.5rem),65ch)]");
    expect(bubble.className).toContain("min-w-0");
    const body = screen.getByTestId("message-body");
    expect(body.className).toContain("[overflow-wrap:anywhere]");
    expect(body.querySelectorAll("p")).toHaveLength(1); // no blank paragraph after the text
    expect(body.lastElementChild?.textContent?.trim().length).toBeGreaterThan(0);
    expect(body.querySelector("br")).toBeNull();
    expect(screen.getByTestId("conversation-scroll").className).toContain("overflow-y-auto");
  });

  it("a run of short messages across two days: a day separator for each day, groups never cross midnight (New York)", () => {
    draw(conv([msg("m1", "2026-11-23T04:58:00.000Z"), msg("m2", "2026-11-23T04:59:00.000Z"), msg("m3", "2026-11-23T05:01:00.000Z"), msg("m4", "2026-11-23T05:02:00.000Z")]));
    expect(screen.getAllByRole("separator").map((s) => s.getAttribute("aria-label"))).toEqual(["Sunday, November 22, 2026", "Monday, November 23, 2026"]);
    const groups = screen.getAllByTestId("message-group");
    expect(groups).toHaveLength(2);
    expect(groups.map((x) => within(x).getAllByTestId("message").length)).toEqual([2, 2]);
    // order in the document: separator, group, separator, group
    const kids = [...(screen.getByTestId("message-list").children as HTMLCollectionOf<HTMLElement>)].map((c) => (c.querySelector('[role="separator"]') ? "day" : "group"));
    expect(kids).toEqual(["day", "group", "day", "group"]);
  });

  it("the empty conversation: the start-of-chat line, no groups, and the composer place is still there", () => {
    draw(conv([], { nextBefore: null }));
    expect(screen.getByText("This is the start of the chat.")).toBeTruthy();
    expect(screen.queryAllByTestId("message-group")).toHaveLength(0);
    expect(screen.getByTestId("composer-slot")).toBeTruthy();
    expect(screen.getByRole("log", { name: "Messages in this chat" })).toBeTruthy();
  });

  it("the header is ONE row: name and people on the left, the actions on the right; it wraps under the name on a phone; every action is 44 px high on a phone; labels are the actions' names", () => {
    draw(conv([msg("m1", T(15, 0))], { group: true, subtitle: "2 people, includes external people" }));
    const header = screen.getByTestId("conversation-header");
    expect(header.className).toContain("flex-wrap");
    // the title block first, then the actions, in reading order
    const order = [...header.querySelectorAll("h2, button, a")].map((e) => e.getAttribute("data-testid") ?? e.textContent);
    expect(order).toEqual(["back-to-chats", "conversation-title", "call-button", "video-button", "open-in-teams", "messages-refresh"]);
    for (const name of ["Call", "Video call", "Refresh"]) expect(screen.getByRole("button", { name }).className).toContain("max-lg:min-h-11");
    expect(screen.getByRole("link", { name: "Open in Teams" }).className).toContain("max-lg:min-h-11");
    expect(screen.getByTestId("back-to-chats").className).toContain("min-h-11");
    expect(screen.getByTestId("back-to-chats").className).toContain("min-w-11");
    expect(screen.getByText("2 people, includes external people")).toBeTruthy();
    // no calls note while calls work
    expect(screen.queryByTestId("call-note")).toBeNull();
  });

  it("the calls note is small muted text under the header and only when calls are unavailable for this chat (the call buttons are then absent)", () => {
    draw(conv([msg("m1", T(15, 0))], { call: "external" }));
    const note = screen.getByTestId("call-note");
    expect(note.className).toContain("text-muted-foreground");
    expect(note.className).toContain("basis-full");
    expect(screen.queryByRole("button", { name: "Call" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open in Teams" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("the pane fills its column and the messages scroll above the pinned composer place (reading order: header, the message log, the composer place)", () => {
    draw(conv([msg("m1", T(15, 0))]));
    const section = screen.getByTestId("conversation");
    expect(section.className).toContain("overflow-hidden");
    expect(section.className).toContain("lg:flex-1");
    expect(section.className).toContain("lg:min-h-0");
    expect(section.className).toContain("h-[var(--pane-h,calc(100dvh-8.5rem))]"); // the phone: measured by the scope (see messages-mounted.test.tsx), with the old calc as the fallback
    const slot = screen.getByTestId("composer-slot");
    expect(slot.className).toContain("shrink-0");
    expect(slot.className).not.toContain("safe-area"); // never at the screen edge: on a phone the tab bar below the pane takes the inset
    const log = screen.getByRole("log");
    expect(log.className).toContain("flex-1");
    expect(log.className).toContain("min-h-0");
    const all = [...section.querySelectorAll("header, [role=log], [data-testid=composer-slot]")];
    expect(all.map((e) => e.tagName.toLowerCase() + (e.getAttribute("data-testid") ?? ""))).toEqual(["headerconversation-header", "divconversation-scroll", "divcomposer-slot"]);
    expect(within(slot).getByText("Times are Eastern Time (ET).")).toBeTruthy();
  });

  it("focus stays on Refresh after pressing it (the button is never disabled)", async () => {
    draw(conv([msg("m1", T(15, 0))]));
    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    expect(document.activeElement).toBe(refresh);
    await act(async () => {
      fireEvent.click(refresh);
    });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(refresh);
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
  });

  it("a click on a bubble shows that message's full time under it, another click hides it; a click on a link does not; nothing is read or stored", () => {
    draw(conv([msg("m1", T(15, 0), { nodes: htmlToNodes('<p>see <a href="https://docs.example.test/a">the doc</a></p>').nodes })]));
    const bubble = screen.getByTestId("bubble");
    expect(screen.queryByTestId("bubble-time")).toBeNull();
    fireEvent.click(bubble);
    expect(screen.getByTestId("bubble-time").textContent).toBe("Nov 23, 2026, 10:00 AM ET");
    fireEvent.click(bubble);
    expect(screen.queryByTestId("bubble-time")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "the doc" }));
    expect(screen.queryByTestId("bubble-time")).toBeNull();
  });

  it("hostile text stays text in a group (no element, no handler)", () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    draw(conv([msg("m1", T(15, 0), { nodes: [{ t: "text", v: evil }], sender: evil })], { group: true }));
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
  });
});

describe.each(WIDTHS)("the connection line at %ipx (T-297)", (width) => {
  const ID = "00000000-0000-4000-8000-0000000000c1";
  const ID2 = "00000000-0000-4000-8000-0000000000c2";
  const acct = (id: string, upn: string, label: string, over: Record<string, unknown> = {}) => ({ connectionId: id, account: upn, label, usable: true, degraded: false, missing: [], has: ["chat_read", "call_links"], ...over });
  const connected = (over: Partial<Extract<MessagesState, { kind: "connected" }>> = {}): MessagesState => ({ kind: "connected", connectionId: ID, account: "me@teams.example.test", degraded: false, missing: [], adminConsent: false, laneFeatures: ["chat_read", "call_links"], accounts: [acct(ID, "me@teams.example.test", "teams.example.test")], multi: false, canAddAnother: false, ...over }) as MessagesState;

  it("one account: one slim row (not a card with a heading): the account and the link to Settings", () => {
    at(width);
    render(<MessagesScreen laneId="PKG" state={connected()} />);
    const row = screen.getByTestId("messages-connection-row");
    expect(row.textContent).toContain("Connected as me@teams.example.test");
    expect(within(row).getByRole("link", { name: "Manage it in Settings" }).getAttribute("href")).toBe("/PKG/settings#connections");
    expect(within(row).getByRole("link").className).toContain("min-h-11"); // a touch target
    expect(screen.queryByRole("heading", { name: /Connected as/ })).toBeNull();
    expect(row.className).not.toContain("p-6");
  });

  it("several accounts: their labels in the same row; a state that needs action keeps its full alert", () => {
    at(width);
    const accounts = [acct(ID, "robert@pubkgroup.com", "pubkgroup.com"), acct(ID2, "robert@pub-k.org", "pub-k.org", { usable: false })];
    render(<MessagesScreen laneId="PKG" state={connected({ accounts: accounts as never, multi: false })} />);
    const row = screen.getByTestId("messages-connection-row");
    expect(within(row).getAllByTestId("messages-account")).toHaveLength(2);
    expect(within(row).getAllByTestId("account-badge").map((b) => b.textContent)).toEqual(["pubkgroup.com", "pub-k.org"]);
    expect(screen.getByTestId("messages-account-problems").textContent).toContain("pub-k.org: Your Teams sign-in expired.");
    cleanup();
    render(<MessagesScreen laneId="PKG" state={connected({ degraded: true })} />);
    expect(screen.getByTestId("messages-degraded").textContent).toContain("Teams is having problems");
    cleanup();
    render(<MessagesScreen laneId="PKG" state={connected({ missing: ["call_links"] })} />);
    expect(screen.getByTestId("messages-feature-missing")).toBeTruthy();
  });

  it("the row is hidden on a phone (only) while a chat or channel is open: the class reads the scope's data-open", () => {
    at(width);
    render(<MessagesScreen laneId="PKG" state={connected()} />);
    expect(screen.getByTestId("messages-connection-row").className).toContain("group-data-[open=true]/messages:max-lg:hidden");
    expect(screen.getByTestId("messages-connection-row").className).not.toContain("hidden lg:flex");
  });
});

describe("contrast of the own-message tint (WCAG AA, 4.5:1) in both themes", () => {
  const css = readFileSync(join(__dirname, "../../../packages/ui/src/styles/theme.css"), "utf8");
  const block = (re: RegExp): Map<string, string> => {
    const m = re.exec(css);
    if (!m?.[1]) throw new Error("block not found");
    return new Map([...m[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((x) => [x[1] as string, x[2] as string]));
  };
  const light = block(/:root\s*\{([^}]*)\}/);
  const dark = block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the text on the own bubble (foreground on primary-tint), on an incoming bubble (foreground on muted) and the muted time text on the pane (muted-foreground on card) are at least 4.5:1", (_n, t) => {
    const get = (k: string) => t.get(k) as string;
    expect(ratio(get("--foreground"), get("--primary-tint"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get("--foreground"), get("--muted"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get("--muted-foreground"), get("--card"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get("--primary"), get("--primary-tint"))).toBeGreaterThanOrEqual(4.5); // links inside an own bubble
  });
  it("the own tint is not the incoming surface (they differ in both themes), so the two kinds of message are told apart by more than alignment", () => {
    for (const t of [light, dark]) expect(t.get("--primary-tint")).not.toBe(t.get("--muted"));
  });
});

describe("the page fills the window and each pane scrolls on its own (T-297; classes, since jsdom has no layout)", () => {
  type El = { type?: unknown; props?: Record<string, unknown> };
  const classes = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) node.forEach((n) => classes(n, out));
    else if (typeof node === "object" && node !== null && "props" in node) {
      const p = (node as El).props ?? {};
      if (typeof p.className === "string") out.push(p.className);
      for (const v of Object.values(p)) if (typeof v === "object" && v !== null) classes(v, out);
    }
    return out;
  };
  const all = async () => {
    const { MessagesLayoutShell, ConnectedFrame } = await import("./messages-page");
    const state = { kind: "connected", connectionId: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", degraded: false, missing: [], adminConsent: false, laneFeatures: ["chat_read", "channels_read"], accounts: [{ connectionId: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", label: "teams.example.test", usable: true, degraded: false, missing: [], has: ["chat_read", "channels_read"] }], multi: false, canAddAnother: false } as never;
    const noChats = { ...(state as object), laneFeatures: ["channels_read"] } as never;
    return { shell: classes(MessagesLayoutShell({ params: Promise.resolve({ laneId: "PKG" }), children: null })), frame: classes(ConnectedFrame({ laneId: "PKG", state, children: null })), noChatsFrame: classes(ConnectedFrame({ laneId: "PKG", state: noChats, children: null })) };
  };

  it("on a wide window the page is exactly the window's height (so the page itself does not scroll); the list column and the conversation column each take the rest and scroll alone", async () => {
    const { shell, frame } = await all();
    expect(shell.some((c) => c.includes("lg:h-[calc(100dvh-4rem)]") && c.includes("lg:min-h-[44rem]"))).toBe(true); // M4: a short window scrolls the page instead of squeezing the panes
    expect(frame.some((c) => c.includes("lg:min-h-[24rem]"))).toBe(true);
    expect(frame.some((c) => c.includes("lg:flex-1") && c.includes("lg:grid-rows-[minmax(0,1fr)]") && c.includes("min-h-0"))).toBe(true);
    expect(frame.some((c) => c.includes("lg:overflow-y-auto"))).toBe(true); // the list column
  });

  it("the columns read the address through the scope: on a phone the list OR the conversation, never both; on the Channels tab the list column is hidden and the page takes the width", async () => {
    const { frame } = await all();
    const left = frame.find((c) => c.includes("group-data-[view=channels]/messages:hidden")) ?? "";
    expect(left).toContain("group-data-[view=chat]/messages:max-lg:hidden");
    const right = frame.find((c) => c.includes("group-data-[view=list]/messages:max-lg:hidden")) ?? "";
    expect(right).toContain("lg:flex-col");
    expect(frame.some((c) => c.includes("group-data-[view=channels]/messages:lg:grid-cols-1"))).toBe(true);
  });

  it("a company without chats has no list column: the page takes the whole width and is never hidden by the phone rule", async () => {
    const { noChatsFrame } = await all();
    expect(noChatsFrame.some((c) => c.includes("lg:grid-cols-1") && !c.includes("minmax(300px,380px)"))).toBe(true);
    expect(noChatsFrame.some((c) => c.includes("group-data-[view=list]"))).toBe(false);
    expect(noChatsFrame.some((c) => c.includes("messages-left"))).toBe(false);
  });
});
