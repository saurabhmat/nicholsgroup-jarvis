// @vitest-environment jsdom
// T-285: inline pictures as the page draws them. The browser may load ONLY the portal's own image route: an <img> with fixed alt text, lazy, in a fixed-size box, whose click target is the same
// route; any failure turns it into the neutral placeholder; a node without a hosted id, or a message without an image address, or an id that is not valid, is a placeholder; nothing points at
// Microsoft or any other host. Synthetic nodes only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { bodyToNodes, type MessageNode } from "@nichols/connectors/teams-pure";
import { MessageItem, renderNodes } from "./messages-view";
import { HostedImage } from "./messages-image";
import type { MessageView } from "@/lib/teams-chats";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const BASE = "/api/lanes/PKG/messages/image?chat=MTk6YWJj&message=1700000000001";
const draw = (nodes: MessageNode[], images: string | null = BASE) => render(<div>{renderNodes(nodes, images)}</div>);
const srcs = () => screen.queryAllByTestId("hosted-image").map((i) => i.getAttribute("src"));

describe("the picture", () => {
  it("a hosted picture is one <img> from the portal's own route: fixed alt, lazy, no referrer, a fixed-size box, and the click target is the same route in a new tab", () => {
    draw([{ t: "text", v: "see " }, { t: "image", hosted: "aWQ9eF8w" }]);
    const img = screen.getByTestId("hosted-image");
    expect(img.getAttribute("src")).toBe(`${BASE}&hosted=aWQ9eF8w`);
    expect(img.getAttribute("alt")).toBe("Image");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.parentElement?.className).toMatch(/\bh-48\b.*\bw-64\b|\bw-64\b.*\bh-48\b/); // explicit size: no layout jump
    expect(img.parentElement?.className).toContain("max-w-full");
    const link = screen.getByTestId("hosted-image-link");
    expect(link.getAttribute("href")).toBe(`${BASE}&hosted=aWQ9eF8w`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(screen.queryByTestId("image-placeholder")).toBeNull();
  });

  it("the id is URL-encoded in the address", () => {
    draw([{ t: "image", hosted: "a=b:c@d.e-f_g" }]);
    expect(srcs()).toEqual([`${BASE}&hosted=${encodeURIComponent("a=b:c@d.e-f_g")}`]);
  });

  it("no hosted id, no message address, or an id that is not valid: the neutral placeholder, no <img>", () => {
    draw([{ t: "image" }, { t: "image", hosted: "aWQ9" }], null);
    draw([{ t: "image", hosted: "a/b" }, { t: "image", hosted: "a b" }, { t: "image", hosted: "x".repeat(300) }, { t: "image", hosted: "https://evil.example.test/a.png" }]);
    draw([{ t: "image" }]);
    expect(screen.queryAllByTestId("hosted-image")).toHaveLength(0);
    expect(screen.queryAllByTestId("image-placeholder")).toHaveLength(2 + 4 + 1);
  });

  it("an address that is not the portal's own route is never used as a picture source (a made-up base)", () => {
    for (const base of ["https://evil.example.test/x?a=1", "//evil.example.test/api/lanes/PKG/messages/image?x=1", "/other/path?x=1", "javascript:alert(1)"]) {
      cleanup();
      draw([{ t: "image", hosted: "aWQ9" }], base);
      expect(screen.queryAllByTestId("hosted-image"), base).toHaveLength(0);
      expect(screen.getAllByTestId("image-placeholder")).toHaveLength(1);
    }
  });

  const answer = (status: number, headers: Record<string, string> = {}) => vi.fn(async () => new Response(status === 200 ? new Uint8Array([1]) : "{}", { status, headers }));

  it("a failed picture becomes the 'tap to load' button; a tap loads the SAME route again (no new parameter), once per tap", async () => {
    const probe = answer(503);
    vi.stubGlobal("fetch", probe);
    draw([{ t: "image", hosted: "aWQ9" }]);
    await act(async () => void fireEvent.error(screen.getByTestId("hosted-image")));
    const button = screen.getByTestId("image-retry");
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toBe("Image: tap to load");
    expect(screen.queryByTestId("hosted-image")).toBeNull();
    fireEvent.click(button);
    const again = screen.getByTestId("hosted-image");
    expect(again.getAttribute("src")).toBe(`${BASE}&hosted=aWQ9`);
    // it fails again: the button comes back, and nothing retries by itself (the one automatic retry is spent)
    const calls = probe.mock.calls.length;
    await act(async () => void fireEvent.error(again));
    expect(screen.getByTestId("image-retry")).toBeTruthy();
    expect(probe.mock.calls.length).toBe(calls);
  });

  it("after a 429 the page waits the Retry-After (at most 10 s) and loads the picture again ONCE by itself, then leaves the button", async () => {
    vi.useFakeTimers();
    const probe = answer(429, { "retry-after": "60" });
    vi.stubGlobal("fetch", probe);
    draw([{ t: "image", hosted: "aWQ9" }]);
    await act(async () => void fireEvent.error(screen.getByTestId("hosted-image")));
    expect(screen.getByTestId("image-waiting")).toBeTruthy();
    expect(screen.queryByTestId("hosted-image")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(9_000)));
    expect(screen.queryByTestId("hosted-image")).toBeNull(); // 60 s asked, capped at 10 s: not yet
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_500)));
    const retried = screen.getByTestId("hosted-image");
    expect(retried.getAttribute("src")).toBe(`${BASE}&hosted=aWQ9`);
    expect(probe.mock.calls).toHaveLength(1); // one status probe, no loop
    await act(async () => void fireEvent.error(retried));
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(screen.getByTestId("image-retry")).toBeTruthy();
    expect(probe.mock.calls).toHaveLength(1); // nothing more by itself
  });

  it("a failed probe (offline) leaves the button at once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    draw([{ t: "image", hosted: "aWQ9" }]);
    await act(async () => void fireEvent.error(screen.getByTestId("hosted-image")));
    expect(screen.getByTestId("image-retry")).toBeTruthy();
  });

  it("the picture is shown whole and never scaled up, and its link has an accessible name", () => {
    draw([{ t: "image", hosted: "aWQ9" }]);
    const img = screen.getByTestId("hosted-image");
    expect(img.className).toContain("max-h-full");
    expect(img.className).toContain("max-w-full");
    expect(img.className).not.toMatch(/(^| )(h|w)-full/);
    expect(screen.getByTestId("hosted-image-link").getAttribute("aria-label")).toBe("Image (opens in a new tab)");
  });

  it("a picture inside a link is a placeholder (no clickable thing inside another)", () => {
    draw([{ t: "link", href: "https://ok.example.test/a", host: "ok.example.test", c: [{ t: "image", hosted: "aWQ9" }] }]);
    expect(screen.queryAllByTestId("hosted-image")).toHaveLength(0);
    expect(screen.getAllByTestId("image-placeholder")).toHaveLength(1);
  });

  it("nothing on the page points at Microsoft or any other host: every src and href that is not a text link is a same-site path", () => {
    const html = `<p>hi</p><img src="https://graph.microsoft.com/v1.0/chats/19:x@thread.v2/messages/1700000000001/hostedContents/aWQ9/$value"><img src="https://tracker.example.test/p.png">`;
    const { nodes } = bodyToNodes("html", html, { scope: { kind: "chat", chatId: "19:x@thread.v2" }, messageId: "1700000000001" });
    const { container } = draw(nodes);
    for (const el of container.querySelectorAll("[src],[href]")) {
      const v = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      expect(v.startsWith("/api/lanes/PKG/messages/image?"), v).toBe(true);
    }
    expect(container.innerHTML).not.toMatch(/graph\.microsoft|tracker|evil/);
    expect(srcs()).toHaveLength(1); // the tracker became a placeholder
  });

  it("HostedImage given anything but the own route draws the placeholder", () => {
    render(<HostedImage src="https://graph.microsoft.com/v1.0/x" />);
    expect(screen.queryByTestId("hosted-image")).toBeNull();
    expect(screen.getByTestId("image-placeholder")).toBeTruthy();
  });
});

describe("in a message", () => {
  const view = (over: Partial<MessageView> = {}): MessageView =>
    ({ id: "1700000000001", images: BASE, at: "2026-11-23T14:00:00.000Z", time: "9:00 AM", fullTime: "Nov 23, 2026, 9:00 AM ET", day: "2026-11-23", sender: "Pat", mine: false, edited: false, deleted: false, system: false, nodes: [{ t: "image", hosted: "aWQ9" }], truncated: false, attachments: [], ...over }) as MessageView;

  it("an image-only message shows its picture, not '(no text)'; a deleted message shows no picture", () => {
    render(<ul><MessageItem m={view()} showSender={false} /></ul>);
    expect(screen.getByTestId("hosted-image")).toBeTruthy();
    expect(screen.queryByText("(no text)")).toBeNull();
    cleanup();
    render(<ul><MessageItem m={view({ deleted: true })} showSender={false} /></ul>);
    expect(screen.queryByTestId("hosted-image")).toBeNull();
  });

  it("a message without an image address (an id that did not validate) draws every picture as a placeholder", () => {
    render(<ul><MessageItem m={view({ images: null })} showSender={false} /></ul>);
    expect(screen.queryByTestId("hosted-image")).toBeNull();
    expect(screen.getByTestId("image-placeholder")).toBeTruthy();
  });
});
