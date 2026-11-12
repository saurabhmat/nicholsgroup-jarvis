// @vitest-environment jsdom
// T-234 part 5: nothing the owner has done is lost by a refresh or a reload. A "refresh" is a re-render of the Home tree with new
// server props (what router.refresh() produces); a "reload" is an unmount and a fresh mount over the same sessionStorage.
//   * an edited reply draft survives the refresh (fields kept, same drawer instance) and a reload (drawer reopens with the edits);
//   * expanded sections (Next 7 days, More from the briefing, Drafts and deadlines) survive both;
//   * the auto-refresh does not run while the drawer is open and runs again once it is closed; a refresh calls nothing but router.refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReplyContext } from "@/lib/reply-client";
import { noteSignedInUser, openDrawer, replyDrafts } from "@/lib/reply-draft-store";
import { heldKinds, resetRefreshGate } from "@/lib/refresh-gate";
import { AttentionSection } from "./home-briefing";
import { CollapsibleSection } from "./collapsible-section";
import { HomeAutoRefresh } from "./home-auto-refresh";
import { HomeScope, PersistedDetails } from "./home-scope";
import { ReplyAction } from "./reply-action";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const ctx: ReplyContext = {
  messageId: "m1",
  userId: "u1",
  mailbox: "exec@pubkgroup.example.test",
  subject: "Re: Quarterly review",
  replyingTo: "Dana <dana@sender.example.test>",
  defaults: { to: ["dana@sender.example.test"], cc: [] },
  internalDomains: ["pubkgroup.example.test"],
  proposal: null,
  send: { enabled: true, message: null, settingsHref: null },
  storesDrafts: true,
  aiAllowed: false,
  blocked: false,
  alreadySent: null,
  preview: { text: "Please confirm.", truncated: false },
};
const calls: string[] = [];
const MIN = 60_000;

/** The Home tree as a server render would hand it over: `at` is the render time, `subject` the attention row's current data. */
function Home({ at, subject, other = [] as string[] }: { at: string; subject: string; other?: string[] }) {
  return (
    <HomeScope laneId="PKG" userId="u1">
      <HomeAutoRefresh renderedAt={at} />
      <ol>
        {["m1", ...other].map((id) => (
          <li key={id} data-testid="attention-item">
            <span>{id === "m1" ? subject : id}</span>
            <ReplyAction canReply target={{ laneId: "PKG", connectionId: "c1", messageId: id, threadKey: `t-${id}`, proposalId: null }} />
          </li>
        ))}
      </ol>
      <CollapsibleSection title="Next 7 days" testId="next-7-days" persistId="next-7-days">
        <p>Client call</p>
      </CollapsibleSection>
      <PersistedDetails id="briefing-more" testId="briefing-more" summary="More from the briefing">
        <p>Line 4</p>
      </PersistedDetails>
      <PersistedDetails id="attention-extras" testId="attention-extras" summary="Drafts and deadlines">
        <p>A draft</p>
      </PersistedDetails>
    </HomeScope>
  );
}

/** What the browser says about how this page was loaded (jsdom has no navigation entry). */
function navigationType(type: "navigate" | "reload" | "back_forward" | null) {
  vi.spyOn(performance, "getEntriesByType").mockImplementation(((kind: string) => (kind === "navigation" && type ? [{ type }] : [])) as unknown as typeof performance.getEntriesByType);
}

beforeEach(() => {
  calls.length = 0;
  navigationType("reload");
  nav.refresh.mockReset();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/PKG");
  resetRefreshGate();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { action: string };
      calls.push(body.action);
      return { status: 200, json: async () => ({ ok: true, context: ctx }) } as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Click a summary; jsdom does not fire the `toggle` event a browser fires after the click, so it is sent here. */
function toggle(label: string) {
  const summary = screen.getByText(label);
  fireEvent.click(summary);
  fireEvent(summary.closest("details") as HTMLElement, new Event("toggle"));
}
const iso = (ms: number) => new Date(ms).toISOString();
const body = () => screen.getByTestId("reply-body") as HTMLTextAreaElement;
async function openAndType(text: string) {
  fireEvent.click(screen.getByTestId("attention-reply"));
  await screen.findByTestId("sends-as");
  fireEvent.change(body(), { target: { value: text } });
}

describe("a refresh (a re-render with new server data)", () => {
  it("keeps the open drawer and its edited fields", async () => {
    const t = Date.now();
    const { rerender } = render(<Home at={iso(t)} subject="Quarterly review" />);
    await openAndType("My edited reply");
    const before = screen.getByTestId("reply-drawer");
    rerender(<Home at={iso(t + 5 * MIN)} subject="Quarterly review (updated)" />);
    expect(screen.getByText("Quarterly review (updated)")).toBeTruthy();
    expect(screen.getByTestId("reply-drawer")).toBe(before); // the same element: not unmounted
    expect(body().value).toBe("My edited reply");
    expect(calls.filter((a) => a === "reply_context")).toHaveLength(1); // not loaded again
  });

  it("keeps the drawer when the list changes around the item (other rows appear, the item keeps its key)", async () => {
    const t = Date.now();
    const { rerender } = render(<Home at={iso(t)} subject="S" />);
    await openAndType("Still here");
    rerender(<Home at={iso(t + MIN)} subject="S" other={["m2", "m3"]} />);
    expect(body().value).toBe("Still here");
  });

  it("keeps the expanded sections", () => {
    const t = Date.now();
    const { rerender } = render(<Home at={iso(t)} subject="S" />);
    fireEvent.click(screen.getByRole("button", { name: /Next 7 days/ }));
    toggle("More from the briefing");
    toggle("Drafts and deadlines");
    rerender(<Home at={iso(t + 5 * MIN)} subject="S2" />);
    expect(screen.getByTestId("next-7-days").getAttribute("data-open")).toBe("true");
    expect((screen.getByTestId("briefing-more") as HTMLDetailsElement).open).toBe(true);
    expect((screen.getByTestId("attention-extras") as HTMLDetailsElement).open).toBe(true);
  });
});

describe("a full reload", () => {
  it("reopens the drawer with the edited text", async () => {
    const t = Date.now();
    const first = render(<Home at={iso(t)} subject="S" />);
    await openAndType("Typed before the reload");
    await waitFor(() => expect(replyDrafts.read("PKG", "u1", "m1")?.body).toBe("Typed before the reload"), { timeout: 2000 }); // debounced 500 ms
    expect(openDrawer.read("PKG", "u1", "current")).toEqual({ messageId: "m1" });
    // A reload tears the page down: no React cleanup runs, only the tab's sessionStorage remains. A test can only unmount, and
    // the unmount cleanup removes the marker, so the marker is put back by hand to stand for what a real reload leaves behind.
    first.unmount();
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now(), d: { messageId: "m1" } }));
    render(<Home at={iso(t + 1000)} subject="S" />);
    await screen.findByTestId("sends-as");
    expect(body().value).toBe("Typed before the reload");
    expect(screen.getByTestId("reply-source-note").textContent).toMatch(/restored/);
  });

  it("closing the drawer clears the open marker, so a reload does not reopen it", async () => {
    render(<Home at={iso(Date.now())} subject="S" />);
    await openAndType("x");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("reply-drawer")).toBeNull();
    expect(openDrawer.read("PKG", "u1", "current")).toBeNull();
  });

  it("leaving Home (unmount while open) clears the marker as well", async () => {
    const { unmount } = render(<Home at={iso(Date.now())} subject="S" />);
    await openAndType("x");
    unmount();
    expect(openDrawer.read("PKG", "u1", "current")).toBeNull();
  });

  it("a reload never starts an AI draft by itself: it shows 'Draft with AI' and the button asks once", async () => {
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now(), d: { messageId: "m1" } }));
    const ai = { ...ctx, aiAllowed: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { body: string }) => {
        const a = (JSON.parse(init.body) as { action: string }).action;
        calls.push(a);
        return { status: 200, json: async () => (a === "reply_context" ? { ok: true, context: ai } : { ok: true, draft: { status: "ready", text: "AI text" } }) } as Response;
      }),
    );
    render(<Home at={iso(Date.now())} subject="S" />);
    await screen.findByTestId("sends-as");
    expect(calls).toEqual(["reply_context"]); // no draft_reply on a marker restore
    expect(body().value).toBe("");
    const btn = screen.getByTestId("reply-draft-again");
    expect(btn.textContent).toBe("Draft with AI");
    fireEvent.click(btn);
    await waitFor(() => expect(body().value).toBe("AI text"));
    expect(calls).toEqual(["reply_context", "draft_reply"]);
  });

  it("a fresh navigation does not reopen the drawer and removes the marker", async () => {
    navigationType("navigate");
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now(), d: { messageId: "m1" } }));
    render(<Home at={iso(Date.now())} subject="S" />);
    await act(async () => {});
    expect(screen.queryByTestId("reply-drawer")).toBeNull();
    expect(openDrawer.read("PKG", "u1", "current")).toBeNull();
  });

  it("back/forward reopens like a reload; the marker lives 30 minutes", async () => {
    navigationType("back_forward");
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now(), d: { messageId: "m1" } }));
    render(<Home at={iso(Date.now())} subject="S" />);
    await screen.findByTestId("sends-as");
    cleanup();
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now() - 31 * MIN, d: { messageId: "m1" } }));
    expect(openDrawer.read("PKG", "u1", "current")).toBeNull();
  });

  it("the marker is written only when the lane stores drafts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, context: { ...ctx, storesDrafts: false } }) }) as Response));
    render(<Home at={iso(Date.now())} subject="S" />);
    fireEvent.click(screen.getByTestId("attention-reply"));
    await screen.findByTestId("sends-as");
    expect(openDrawer.read("PKG", "u1", "current")).toBeNull();
  });

  it("pending edits are written when the page is hidden or going away", async () => {
    render(<Home at={iso(Date.now())} subject="S" />);
    await openAndType("Written on pagehide");
    expect(replyDrafts.read("PKG", "u1", "m1")).toBeNull(); // still inside the 500 ms debounce
    fireEvent(window, new Event("pagehide"));
    expect(replyDrafts.read("PKG", "u1", "m1")?.body).toBe("Written on pagehide");
    fireEvent.change(body(), { target: { value: "Written when hidden" } });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(replyDrafts.read("PKG", "u1", "m1")?.body).toBe("Written when hidden");
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    }
  });

  it("a different signed-in user clears every stored draft and view-state entry", () => {
    noteSignedInUser("u1");
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now(), d: { messageId: "m1" } }));
    render(<HomeScope laneId="PKG" userId="u2"><p>x</p></HomeScope>);
    expect(openDrawer.read("PKG", "u1", "current")).toBeNull();
  });

  it("does not reopen for a message that is not on the page", async () => {
    window.sessionStorage.setItem(openDrawer.key("PKG", "u1", "current"), JSON.stringify({ v: 1, t: Date.now(), d: { messageId: "gone" } }));
    render(<Home at={iso(Date.now())} subject="S" />);
    await act(async () => {});
    expect(screen.queryByTestId("reply-drawer")).toBeNull();
  });

  it("restores the expanded sections", async () => {
    const first = render(<Home at={iso(Date.now())} subject="S" />);
    fireEvent.click(screen.getByRole("button", { name: /Next 7 days/ }));
    toggle("More from the briefing");
    first.unmount();
    render(<Home at={iso(Date.now())} subject="S" />);
    await waitFor(() => expect(screen.getByTestId("next-7-days").getAttribute("data-open")).toBe("true"));
    await waitFor(() => expect((screen.getByTestId("briefing-more") as HTMLDetailsElement).open).toBe(true));
    expect((screen.getByTestId("attention-extras") as HTMLDetailsElement).open).toBe(false);
  });

  it("a section closed again is not restored open; another user's state is not used", async () => {
    const first = render(<Home at={iso(Date.now())} subject="S" />);
    const btn = screen.getByRole("button", { name: /Next 7 days/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    first.unmount();
    window.sessionStorage.setItem("nichols:home-open:PKG:other-user:briefing-more", JSON.stringify({ v: 1, t: Date.now(), d: true }));
    render(<Home at={iso(Date.now())} subject="S" />);
    await act(async () => {});
    expect(screen.getByTestId("next-7-days").getAttribute("data-open")).toBe("false");
    expect((screen.getByTestId("briefing-more") as HTMLDetailsElement).open).toBe(false);
  });
});

describe("no refresh while the drawer is open", () => {
  it("the 5-minute tick does nothing while the drawer is open, and runs after it is closed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    render(<Home at={iso(Date.now())} subject="S" />);
    fireEvent.click(screen.getByTestId("attention-reply"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * MIN);
    });
    expect(nav.refresh).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(calls.every((a) => a === "reply_context" || a === "draft_reply")).toBe(true); // the only fetches are the drawer's own reads
  });
});

describe("the list keys (the real attention list)", () => {
  const thread = (messageId: string) => ({
    connectionId: "c1", threadKey: "t1", messageId, fromAddress: "boss@pubk.test", fromName: "Boss", subject: "Board deck", receivedAt: "2026-11-12T10:00:00Z",
    sourceUrl: "https://mail.google.com/mail/u/me/#all/t1", labels: ["INBOX"], isImportant: false, lastIsOwner: false, ownerReplied: false, unreadCount: 1, inboundCount: 1,
  });
  const mail = (messageId: string) => ({ access: true as const, attention: [{ key: "c1:t1", kind: "priority" as const, reason: "Priority sender", thread: thread(messageId) }], more: 0, money: [], mailboxOf: { c1: "me@pubk.test" } });
  const list = (messageId: string) => (
    <HomeScope laneId="PKG" userId="u1">
      <AttentionSection laneId="PKG" now={new Date("2026-11-12T13:00:00Z")} mail={mail(messageId)} canReply />
    </HomeScope>
  );

  it("a new latest message in the same thread keeps the item mounted and the open drawer with its edits", async () => {
    const { rerender } = render(list("m1"));
    const item = screen.getByTestId("attention-item");
    await openAndType("Half-written reply");
    const drawer = screen.getByTestId("reply-drawer");
    rerender(list("m2")); // same connection + thread, new latest messageId (what a refresh brings)
    expect(screen.getByTestId("attention-item")).toBe(item); // the key is connectionId:threadKey, not the message id
    expect(screen.getByTestId("reply-drawer")).toBe(drawer);
    expect(body().value).toBe("Half-written reply");
    expect(calls.filter((a) => a === "reply_context")).toHaveLength(1); // still the message it was opened for
  });
});

describe("the drawer's own refresh and the auto-refresh", () => {
  it("a save (refresh on close) followed by the release catch-up refreshes only once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { body: string }) => {
        const a = (JSON.parse(init.body) as { action: string }).action;
        return { status: 200, json: async () => (a === "reply_context" ? { ok: true, context: ctx } : { ok: true, id: "p1", hash: "h".repeat(64) }) } as Response;
      }),
    );
    render(<Home at={iso(Date.now())} subject="S" />);
    fireEvent.click(screen.getByTestId("attention-reply"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.change(body(), { target: { value: "Reply" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * MIN); // the data is stale while the drawer holds the refresh
    });
    expect(nav.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("reply-save"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.click(screen.getByLabelText("Close reply"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the drawer's holds", () => {
  it("holds 'drawer' while open and 'sending' while a send is in flight; both are released on close", async () => {
    let finish: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { body: string }) => {
        const a = (JSON.parse(init.body) as { action: string }).action;
        if (a === "reply_context") return { status: 200, json: async () => ({ ok: true, context: ctx }) } as Response;
        if (a === "propose_reply") return { status: 200, json: async () => ({ ok: true, id: "p1", hash: "h".repeat(64) }) } as Response;
        return new Promise<Response>((r) => {
          finish = r; // approve: stays in flight
        });
      }),
    );
    render(<Home at={iso(Date.now())} subject="S" />);
    await openAndType("Hello");
    expect(heldKinds()).toEqual(["drawer"]);
    fireEvent.click(screen.getByTestId("reply-send"));
    await waitFor(() => expect(heldKinds().sort()).toEqual(["drawer", "sending"]));
    await act(async () => {
      finish({ status: 200, json: async () => ({ ok: true, outcome: "sent" }) } as Response);
    });
    await waitFor(() => expect(heldKinds()).toEqual(["drawer"]));
    cleanup();
    expect(heldKinds()).toEqual([]);
  });
});
