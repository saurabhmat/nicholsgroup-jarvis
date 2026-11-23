// @vitest-environment jsdom
// T-283, T-284: the browser parts of Messages. Each acts on a click, or once when a chat opens; there is no timer (Microsoft's terms: no polling); nothing is stored in the browser; every request goes
// to this portal's own routes. fetch and window.open are faked; synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { CallButtons, ConversationMessages, MarkRead, MessagesRefresh } from "./messages-client";
import { encodeChatKey } from "@/lib/teams-chat-key";
import type { MessageView } from "@/lib/teams-chats";

const KEY = encodeChatKey("19:abc123def456@thread.v2");
const msg = (id: string, at: string, over: Record<string, unknown> = {}): MessageView => ({ id, at, time: "9:05 AM", fullTime: "x", day: at.slice(0, 10), sender: "Pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "text", v: `text ${id}` }], truncated: false, attachments: [], ...over }) as unknown as MessageView;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockImplementation(() => ({}) as Window);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refresh.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("MessagesRefresh", () => {
  it("re-reads the page on click and nothing else (no fetch)", async () => {
    render(<MessagesRefresh />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ConversationMessages: Load older messages", () => {
  const initial = [msg("m3", "2026-11-23T14:00:00.000Z"), msg("m4", "2026-11-23T14:05:00.000Z")];

  it("one request per click, to this portal's route, for the chat and the time; older messages appear above, the next time replaces the old", async () => {
    fetchMock.mockImplementation(() => reply(200, { messages: [msg("m1", "2026-11-22T14:00:00.000Z"), msg("m2", "2026-11-22T14:05:00.000Z")], nextBefore: null }));
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore="2026-11-23T14:00:00.000Z" group />);
    expect(fetchMock).not.toHaveBeenCalled(); // nothing is fetched on its own
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getAllByTestId("message")).toHaveLength(4));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/lanes/PKG/messages/older?chat=${KEY}&before=${encodeURIComponent("2026-11-23T14:00:00.000Z")}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(screen.getAllByTestId("message").map((m) => m.textContent?.match(/text m\d/)?.[0])).toEqual(["text m1", "text m2", "text m3", "text m4"]);
    // no more: the button is replaced by the note, and one separator per day
    expect(screen.queryByTestId("load-older")).toBeNull();
    expect(screen.getByText("This is the start of the chat.")).toBeTruthy();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("the same day on both sides of the join has one separator", async () => {
    fetchMock.mockImplementation(() => reply(200, { messages: [msg("m2", "2026-11-23T10:00:00.000Z")], nextBefore: null }));
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore="x" group />);
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getAllByTestId("message")).toHaveLength(3));
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("Teams busy: the wait Microsoft asked for is shown, the button stays, and nothing is retried", async () => {
    fetchMock.mockImplementation(() => reply(429, { error: "busy", seconds: 6 }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore="2026-11-23T14:00:00.000Z" group />);
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getByTestId("older-error").textContent).toBe("Teams is busy. Try again in 6 seconds."));
    expect(screen.getByTestId("load-older")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("other failures: a fixed line; a network error too; the messages already shown stay", async () => {
    fetchMock.mockImplementationOnce(() => reply(503, { error: "unavailable" }));
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore="x" group />);
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getByTestId("older-error").textContent).toBe("Teams could not be reached. Try again."));
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("canary secret chat text")));
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("older-error").textContent).toBe("Teams could not be reached. Try again."));
    expect(document.body.textContent).not.toContain("canary");
    expect(screen.getAllByTestId("message")).toHaveLength(2);
  });

  it("a reconnect answer says so; the route's own text is never shown", async () => {
    fetchMock.mockImplementation(() => reply(409, { error: "reconnect", message: "canary secret chat text" }));
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore="x" group />);
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getByTestId("older-error").textContent).toContain("Reconnect Teams in Settings"));
    expect(document.body.textContent).not.toContain("canary");
  });

  it("nothing is kept in the browser: no storage, no cookie", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    fetchMock.mockImplementation(() => reply(200, { messages: [msg("m2", "2026-11-22T10:00:00.000Z")], nextBefore: null }));
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore="x" group />);
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getAllByTestId("message")).toHaveLength(3));
    expect(set).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
  });

  it("the page opens at the newest message (the list is scrolled to its end)", () => {
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore={null} group />);
    const box = screen.getByTestId("conversation-scroll");
    Object.defineProperty(box, "scrollHeight", { configurable: true, value: 900 });
    cleanup();
    // scrollTop is assigned from scrollHeight in a layout effect: a fresh render with the property defined up front
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
    render(<ConversationMessages laneId="PKG" chatKey={KEY} initial={initial} nextBefore={null} group />);
    expect(screen.getByTestId("conversation-scroll").scrollTop).toBe(900);
    if (proto) Object.defineProperty(Element.prototype, "scrollHeight", proto);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  });
});

describe("CallButtons", () => {
  const OPEN = "https://teams.microsoft.com/l/chat/19:abc123def456@thread.v2/conversations";

  it("Call asks this portal's route, then opens the returned https Teams link in a new tab (noopener); Video call asks for video", async () => {
    fetchMock.mockImplementationOnce(() => reply(200, { url: "https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test" }));
    render(<CallButtons laneId="PKG" chatKey={KEY} call="available" openUrl={OPEN} />);
    expect(window.open).not.toHaveBeenCalled(); // never opened on its own
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(1));
    expect(window.open).toHaveBeenCalledWith("https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test", "_blank", "noopener,noreferrer");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/lanes/PKG/messages/call-link");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ chat: KEY, video: false }) });
    fetchMock.mockImplementationOnce(() => reply(200, { url: "https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test&withVideo=true" }));
    fireEvent.click(screen.getByRole("button", { name: "Video call" }));
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ chat: KEY, video: true }) });
  });

  it("a blocked new tab shows the link to click instead", async () => {
    (window.open as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => null);
    fetchMock.mockImplementation(() => reply(200, { url: "https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test" }));
    render(<CallButtons laneId="PKG" chatKey={KEY} call="available" openUrl={OPEN} />);
    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    const a = (await screen.findByTestId("call-link")) as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://teams.microsoft.com/l/call/0/0?users=pat@teams.example.test");
    expect([a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
  });

  it("a link that is not an https Teams call link is never opened, whatever the route says", async () => {
    for (const url of ["javascript:alert(1)", "http://teams.microsoft.com/l/call/0/0?users=a@b.test", "https://evil.example.test/l/call/0/0?users=a@b.test", "https://teams.microsoft.com.evil.example.test/l/call/0/0?users=x", "https://teams.microsoft.com/l/chat/0/0?users=x", 5, null]) {
      fetchMock.mockImplementationOnce(() => reply(200, { url }));
      render(<CallButtons laneId="PKG" chatKey={KEY} call="available" openUrl={OPEN} />);
      fireEvent.click(screen.getByRole("button", { name: "Call" }));
      await waitFor(() => expect(screen.getByTestId("call-error")).toBeTruthy());
      expect(window.open).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("route refusals are said in fixed words: not allowed, feature missing, busy, reconnect, unavailable", async () => {
    const cases: [number, unknown, string][] = [
      [409, { error: "not_allowed", reason: "external" }, "A call link is not available for this chat. Use Open in Teams."],
      [409, { error: "feature_missing" }, "Reconnect Teams to add call buttons."],
      [429, { error: "busy", seconds: 4 }, "Teams is busy. Try again in 4 seconds."],
      [409, { error: "reconnect" }, "Your Teams sign-in expired. Reconnect Teams in Settings."],
      [503, { error: "unavailable" }, "Teams could not be reached. Try again."],
    ];
    for (const [status, body, text] of cases) {
      fetchMock.mockImplementationOnce(() => reply(status, body));
      render(<CallButtons laneId="PKG" chatKey={KEY} call="available" openUrl={OPEN} />);
      fireEvent.click(screen.getByRole("button", { name: "Video call" }));
      await waitFor(() => expect(screen.getByTestId("call-error").textContent).toBe(text));
      cleanup();
    }
    expect(window.open).not.toHaveBeenCalled();
  });

  it("Open in Teams is a plain new-tab link; without call permission there are no Call buttons and the reason is shown", () => {
    render(<CallButtons laneId="PKG" chatKey={KEY} call="needs_reconnect" openUrl={OPEN} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("call-note").textContent).toBe("Reconnect Teams to add call buttons.");
    const a = screen.getByTestId("open-in-teams") as HTMLAnchorElement;
    expect([a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]).toEqual([OPEN, "_blank", "noopener noreferrer"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a double click is one request", async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (release = r)));
    render(<CallButtons laneId="PKG" chatKey={KEY} call="available" openUrl={OPEN} />);
    const b = screen.getByRole("button", { name: "Call" });
    fireEvent.click(b);
    fireEvent.click(b);
    fireEvent.click(screen.getByRole("button", { name: "Video call" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    await waitFor(() => expect(screen.getByTestId("call-error")).toBeTruthy());
  });
});

describe("MarkRead", () => {
  it("opening a chat records the marker once, for the newest message shown; no UI", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const { container, rerender } = render(<MarkRead laneId="PKG" chatKey={KEY} readThrough="2026-11-23T14:05:00.000Z" />);
    expect(container.innerHTML).toBe("");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/lanes/PKG/messages/read");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ chat: KEY, readThrough: "2026-11-23T14:05:00.000Z" }) });
    rerender(<MarkRead laneId="PKG" chatKey={KEY} readThrough="2026-11-23T14:05:00.000Z" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("an empty chat records nothing; a network failure is silent", async () => {
    render(<MarkRead laneId="PKG" chatKey={KEY} readThrough={null} />);
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    render(<MarkRead laneId="PKG" chatKey={KEY} readThrough="2026-11-23T14:05:00.000Z" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
