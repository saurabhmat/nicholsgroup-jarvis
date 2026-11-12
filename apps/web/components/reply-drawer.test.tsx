// @vitest-environment jsdom
// T-234 part 3: the Reply drawer. Dialog behaviour (focus in, trap, Esc, focus back), what is editable (To, Cc, Body; never the
// subject), "Sends as", the thread preview as plain text, the disabled Send with the exact message while Save and Copy work,
// the step-up redirect with sessionStorage, and the sent / failed / unknown results. fetch is a fake of the approvals route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReplyContext } from "@/lib/reply-client";
import { aiDrafts, clearAllDrafts, debounced, draftNamespace, replyDrafts } from "@/lib/reply-draft-store";
import { ReplyAction, type ReplyTarget } from "./reply-action";
import { STALE_NOTE } from "./reply-drawer";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const NOT_ENABLED = "Sending isn't enabled for this mailbox yet. Reconnect Google with send permission in Settings";
const PID = "00000000-0000-4000-8000-0000000000aa";
const HASH = "c".repeat(64);
const target: ReplyTarget = { laneId: "PKG", connectionId: "c1", messageId: "m1", threadKey: "t-100", proposalId: null };

const baseContext = (over: Partial<ReplyContext> = {}): ReplyContext => ({
  messageId: "m1",
  userId: "u1",
  mailbox: "exec@pubkgroup.example.test",
  subject: "Re: Quarterly review",
  replyingTo: "Dana <dana@sender.example.test>",
  receivedAt: "2026-11-10T21:12:00Z",
  defaults: { to: ["dana@sender.example.test"], cc: [] },
  internalDomains: ["pubkgroup.example.test"],
  proposal: null,
  send: { enabled: true, message: null, settingsHref: null },
  storesDrafts: true,
  aiAllowed: true,
  blocked: false,
  alreadySent: null,
  preview: { text: "Please confirm. <img src=x onerror=alert(1)>", truncated: false },
  ...over,
});

type Reply = { status?: number; data: Record<string, unknown> } | "network";
type Handler = (body: Record<string, unknown>) => Reply | Promise<Reply>;
function fakeServer(handlers: Partial<Record<string, Handler>>) {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push(body);
      const h = handlers[String(body.action)];
      const r = h ? await h(body) : { status: 500, data: {} };
      if (r === "network") throw new TypeError("network");
      return { status: r.status ?? 200, json: async () => r.data } as Response;
    }),
  );
  return calls;
}
const ok = (data: Record<string, unknown>) => ({ data: { ok: true, ...data } });

function open() {
  render(<ReplyAction target={target} canReply />);
  fireEvent.click(screen.getByTestId("attention-reply"));
}
const stored = () => replyDrafts.read("PKG", "u1", "m1");
const field = (id: string) => screen.getByTestId(id) as HTMLInputElement & HTMLTextAreaElement;
const ready = () => screen.findByTestId("sends-as");

beforeEach(() => {
  nav.push.mockReset();
  nav.refresh.mockReset();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/PKG");
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dialog behaviour", () => {
  it("is an accessible modal dialog with a title, moves focus in, closes on Esc and returns focus to Reply", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    render(<ReplyAction target={target} canReply />);
    const trigger = screen.getByTestId("attention-reply");
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Reply");
    await ready();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" }); // the listener is on the document, not on the dialog
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("traps Tab inside the dialog", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    const dialog = screen.getByRole("dialog");
    const items = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled])')];
    const last = items[items.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("is a full-screen sheet below md and a 560 px right drawer from md", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("inset-0");
    expect(cls).toContain("md:w-[560px]");
    expect(cls).toContain("md:right-0");
  });
});

describe("what the owner sees and may edit", () => {
  it("shows Sends as, the recipients, a read-only subject, and the thread preview as plain text", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    expect((await ready()).textContent).toBe("Sends as exec@pubkgroup.example.test · nothing is sent until you click Send");
    expect(field("reply-to").value).toBe("dana@sender.example.test");
    const subject = field("reply-subject");
    expect(subject.value).toBe("Re: Quarterly review");
    expect(subject.readOnly).toBe(true);
    fireEvent.change(subject, { target: { value: "Re: changed" } });
    expect(field("reply-subject").value).toBe("Re: Quarterly review");
    fireEvent.change(field("reply-to"), { target: { value: "x@sender.example.test" } });
    fireEvent.change(field("reply-cc"), { target: { value: "y@pubkgroup.example.test" } });
    fireEvent.change(field("reply-body"), { target: { value: "Hello" } });
    expect(field("reply-to").value).toBe("x@sender.example.test");
    expect(field("reply-body").value).toBe("Hello");
    const preview = screen.getByTestId("reply-preview");
    expect(preview.textContent).toContain("<img src=x onerror=alert(1)>"); // text, not markup
    expect(preview.querySelector("img")).toBeNull();
    expect(preview.tagName).toBe("PRE");
  });

  it("flags recipients outside the company as the owner edits", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    const flags = screen.getByTestId("recipient-flags");
    expect(flags.textContent).toContain("dana@sender.example.test");
    expect(flags.textContent).toContain("Outside your company");
    fireEvent.change(field("reply-to"), { target: { value: "boss@pubkgroup.example.test" } });
    expect(screen.queryByTestId("recipient-flags")).toBeNull();
  });

  it("loads the pending proposal (the T-231d draft) and does not draft with the AI", async () => {
    const calls = fakeServer({
      reply_context: () => ok({ context: baseContext({ proposal: { id: PID, hash: HASH, expiresAt: "2026-11-14T12:00:00Z", to: ["dana@sender.example.test"], cc: [], bcc: ["spy@elsewhere.example.test"], bodyText: "Prepared draft", origin: "briefing", derivedFromRetrieved: true, rationale: "note" } }) }),
    });
    open();
    await ready();
    expect(field("reply-body").value).toBe("Prepared draft");
    expect(screen.getByTestId("reply-source-note").textContent).toMatch(/AI briefing/);
    expect(screen.getByTestId("recipient-flags").textContent).toContain("Hidden copy (Bcc)");
    expect(calls.map((c) => c.action)).toEqual(["reply_context"]);
  });

  it("with no proposal it drafts on demand; the draft is not saved until Save draft or Send", async () => {
    const calls = fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: "Thanks, noted." } }),
    });
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Thanks, noted."));
    expect(screen.getByTestId("reply-source-note").textContent).toMatch(/Drafted by AI/);
    expect(calls.map((c) => c.action)).toEqual(["reply_context", "draft_reply"]);
    expect(stored()).toBeNull(); // the edits are not stored
  });

  it("an awaiting-input draft is shown as such with an empty body; a refused draft shows the fixed message and the owner writes it", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext() }), draft_reply: () => ok({ draft: { status: "awaiting_input", text: "" } }) });
    open();
    await ready();
    expect(screen.getByTestId("reply-awaiting").textContent).toMatch(/^Awaiting your input/);
    expect(field("reply-body").value).toBe("");
    cleanup();
    window.sessionStorage.clear(); // the first draft was kept; this is a fresh open
    fakeServer({ reply_context: () => ok({ context: baseContext() }), draft_reply: () => ({ status: 429, data: { error: "rate_limited", message: "A draft was just made for this thread. Wait a moment before asking for another.", retryAfterS: 42 } }) });
    open();
    await ready();
    expect((await screen.findByTestId("reply-ai-message")).textContent).toMatch(/Wait a moment.*Try again in 42 seconds/);
    expect(field("reply-body").disabled).toBe(false);
  });

  it("shows the fixed message when the message cannot be loaded", async () => {
    fakeServer({ reply_context: () => ({ status: 404, data: { error: "not_found", message: "That approval no longer exists." } }) });
    open();
    expect((await screen.findByRole("alert")).textContent).toBe("That approval no longer exists.");
  });
});

describe("while sending is not enabled", () => {
  it("Send is off with the exact message; Save draft and Copy still work", async () => {
    const calls = fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false, send: { enabled: false, message: NOT_ENABLED, settingsHref: "/PKG/settings#connections" } }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
    });
    open();
    await ready();
    expect((screen.getByTestId("reply-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("send-disabled-reason").textContent).toBe(NOT_ENABLED);
    fireEvent.change(field("reply-body"), { target: { value: "Hello Dana" } });
    const save = screen.getByTestId("reply-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const saved = await screen.findByTestId("reply-saved");
    expect(saved.querySelector("a")?.getAttribute("href")).toBe(`/PKG/approvals#action-${PID}`);
    expect(calls.find((c) => c.action === "propose_reply")).toEqual({ action: "propose_reply", messageId: "m1", to: ["dana@sender.example.test"], cc: [], bodyText: "Hello Dana" });
    expect(calls.some((c) => c.action === "approve")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("Hello Dana"));
  });

  it("drafts off: Save draft and Send are off with the fixed message, Copy still works", async () => {
    const calls = fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, storesDrafts: false }) }) });
    open();
    await ready();
    expect((screen.getByTestId("reply-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("reply-save") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("reply-refused").textContent).toMatch(/^This company does not store outbound drafts/);
    fireEvent.change(field("reply-body"), { target: { value: "Text" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("Text"));
    expect(calls.map((c) => c.action)).toEqual(["reply_context"]);
  });

  it("an earlier send that may have gone out turns Send and Save off with 'check Sent'", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, blocked: true }) }) });
    open();
    await ready();
    expect((screen.getByTestId("reply-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("reply-refused").textContent).toBe("An earlier reply to this conversation may already have gone out. Check your Sent folder first.");
  });
});

describe("Send", () => {
  const sendable = (extra: Partial<Record<string, Handler>> = {}) =>
    fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => ok({ status: "verified", actionId: PID, outcome: "sent" }),
      ...extra,
    });
  async function fillAndSend(body = "Hello Dana") {
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: body } });
    fireEvent.click(screen.getByTestId("reply-send"));
  }

  it("saves the exact edited text, approves the hash that save returned, shows Sent and clears the stored edits", async () => {
    const calls = sendable();
    await fillAndSend();
    const result = await screen.findByTestId("reply-result");
    expect(result.getAttribute("data-outcome")).toBe("sent");
    expect(result.textContent).toMatch(/^Sent/);
    expect(calls.filter((c) => c.action !== "reply_context")).toEqual([
      { action: "propose_reply", messageId: "m1", to: ["dana@sender.example.test"], cc: [], bodyText: "Hello Dana" },
      { action: "approve", id: PID, hashSeen: HASH },
    ]);
    expect(stored()).toBeNull();
    expect((screen.getByTestId("reply-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates before sending: a recipient and text are required", async () => {
    const calls = sendable();
    open();
    await ready();
    fireEvent.click(screen.getByTestId("reply-send"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Write the reply/);
    fireEvent.change(field("reply-to"), { target: { value: "not-an-address" } });
    fireEvent.change(field("reply-body"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not valid/));
    expect(calls.map((c) => c.action)).toEqual(["reply_context"]);
  });

  it("step-up: keeps the fields in sessionStorage, sends the owner to /mfa and back to this message; reopening restores them", async () => {
    sendable({ approve: () => ({ status: 403, data: { error: "step_up_required", message: "Enter a fresh authenticator code to approve." } }) });
    await fillAndSend("Typed before the code");
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
    expect(nav.push).toHaveBeenCalledWith(`/mfa?reauth=1&next=${encodeURIComponent("/PKG?reply=m1")}`);
    expect(stored()).toEqual({ to: "dana@sender.example.test", cc: "", body: "Typed before the code", serverVersion: HASH }); // the version the server now holds
    cleanup();
    // back from /mfa: /PKG?reply=m1 reopens the drawer for that message with the fields restored, and no new AI draft
    window.history.replaceState(null, "", "/PKG?reply=m1");
    const calls = fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false, proposal: { id: PID, hash: HASH, expiresAt: "2026-11-14T12:00:00Z", to: ["dana@sender.example.test"], cc: [], bcc: [], bodyText: "Typed before the code", origin: "owner", derivedFromRetrieved: true, rationale: null } }) }),
    });
    render(<ReplyAction target={target} canReply />);
    await ready();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(field("reply-body").value).toBe("Typed before the code");
    expect(screen.getByTestId("reply-source-note").textContent).toMatch(/restored/);
    expect(window.location.search).toBe(""); // the parameter is consumed
    expect(calls.map((c) => c.action)).toEqual(["reply_context"]);
  });

  it("does not reopen for another message's ?reply=", async () => {
    window.history.replaceState(null, "", "/PKG?reply=other");
    sendable();
    render(<ReplyAction target={target} canReply />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an edit is autosaved per lane + user + message, 500 ms after the last keystroke", async () => {
    sendable();
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Half written" } });
    expect(stored()).toBeNull(); // debounced
    await waitFor(() => expect(stored()?.body).toBe("Half written"), { timeout: 2000 });
    expect(stored()?.serverVersion).toBe("none");
    expect(replyDrafts.read("PKG", "u1", "m2")).toBeNull();
    expect(replyDrafts.read("PKG", "other-user", "m1")).toBeNull(); // the key carries the user
    expect(Object.keys(window.sessionStorage)).toEqual(["nichols:reply-draft:PKG:u1:m1"]);
  });

  it("a pending edit is written when the drawer is closed (not lost to the debounce)", async () => {
    sendable();
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Typed then closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Close reply" }));
    expect(stored()?.body).toBe("Typed then closed");
  });

  it("a failure that did not send says so and allows trying again; a verification problem never says 'failed'", async () => {
    sendable({ approve: () => ok({ status: "failed", actionId: PID, failureCode: "execution_error", outcome: "failed" }) });
    await fillAndSend();
    const r = await screen.findByTestId("reply-result");
    expect(r.getAttribute("data-outcome")).toBe("failed");
    expect(r.textContent).toMatch(/was not sent/);
    expect((screen.getByTestId("reply-send") as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    sendable({ approve: () => ok({ status: "failed", actionId: PID, failureCode: "verification_mismatch", outcome: "unknown" }) });
    await fillAndSend();
    const u = await screen.findByTestId("reply-result");
    expect(u.getAttribute("data-outcome")).toBe("unknown");
    expect(u.textContent).toMatch(/Check your Sent folder before trying again/);
    expect(u.textContent).not.toMatch(/fail/i);
  });

  it("unknown (already in progress, outcome unknown, no answer) offers no second send", async () => {
    for (const approve of [() => ok({ status: "already_in_progress", actionId: PID, outcome: "unknown" }), () => "network" as const, () => ({ status: 504, data: {} })]) {
      cleanup();
      sendable({ approve });
      await fillAndSend();
      const r = await screen.findByTestId("reply-result");
      expect(r.getAttribute("data-outcome")).toBe("unknown");
      expect(r.textContent).toBe("Sending status unknown: check Sent before retrying.");
      expect((screen.getByTestId("reply-send") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("reply-save") as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("a refusal (hash changed, not enabled, not live) shows the server's fixed message and sends nothing more", async () => {
    sendable({ approve: () => ({ status: 409, data: { error: "not_live", message: "Approvals are not live for this company yet." } }) });
    await fillAndSend();
    expect((await screen.findByRole("alert")).textContent).toBe("Approvals are not live for this company yet.");
    expect(screen.queryByTestId("reply-result")).toBeNull();
  });

  it("a save that is refused stops before approve", async () => {
    const calls = sendable({ propose_reply: () => ({ status: 409, data: { error: "drafts_not_allowed", message: "This company does not store outbound drafts, so email proposals are off." } }) });
    await fillAndSend();
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not store outbound drafts/);
    expect(calls.some((c) => c.action === "approve")).toBe(false);
  });

  it("Esc does not close the drawer while a send is in progress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => gate.then(() => ok({ status: "verified", actionId: PID, outcome: "sent" })),
    });
    await fillAndSend();
    await waitFor(() => expect(screen.getByTestId("reply-send").textContent).toBe("Sending..."));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });
    expect((await screen.findByTestId("reply-result")).getAttribute("data-outcome")).toBe("sent");
  });
});

describe("non-owners", () => {
  it("get Reply as a plain link to the thread, never the drawer", () => {
    render(<ReplyAction target={target} />);
    const a = screen.getByTestId("attention-reply");
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("/PKG/inbox/m1");
    fireEvent.click(a);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

const proposalCtx = (over: Record<string, unknown> = {}) =>
  baseContext({
    aiAllowed: false,
    proposal: { id: PID, hash: HASH, expiresAt: "2026-11-14T12:00:00Z", to: ["dana@sender.example.test"], cc: [], bcc: [], bodyText: "Prepared draft", origin: "briefing", derivedFromRetrieved: true, rationale: null, ...over },
  });

describe("recipients came from an email (same banner as the approval card)", () => {
  it("shows while To is still the sender's address, and goes away as To is changed; comes back when it is restored", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    const banner = screen.getByTestId("reply-derived-banner");
    expect(banner.textContent).toContain("Recipients came from an email");
    expect(banner.textContent).toContain("Text inside an email never approves anything.");
    fireEvent.change(field("reply-to"), { target: { value: "boss@pubkgroup.example.test" } });
    expect(screen.queryByTestId("reply-derived-banner")).toBeNull();
    fireEvent.change(field("reply-to"), { target: { value: "Dana@Sender.Example.Test" } });
    expect(screen.getByTestId("reply-derived-banner")).toBeTruthy();
  });

  it("for an existing proposal it follows the proposal's flag while To is unchanged; shows the expiry and the short hash", async () => {
    fakeServer({ reply_context: () => ok({ context: proposalCtx() }) });
    open();
    await ready();
    expect(screen.getByTestId("reply-derived-banner")).toBeTruthy();
    expect(screen.getByTestId("reply-proposal-meta").textContent).toContain(`Version ${HASH.slice(0, 8)}`);
    expect(screen.getByTestId("reply-proposal-meta").textContent).toContain("Expires");
    fireEvent.change(field("reply-to"), { target: { value: "other@elsewhere.example.test" } });
    expect(screen.queryByTestId("reply-derived-banner")).toBeNull();
    cleanup();
    fakeServer({ reply_context: () => ok({ context: proposalCtx({ derivedFromRetrieved: false }) }) });
    open();
    await ready();
    expect(screen.queryByTestId("reply-derived-banner")).toBeNull();
  });

  it("is not shown when there is no recipient to come from an email", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, defaults: { to: [], cc: [] } }) }) });
    open();
    await ready();
    expect(screen.queryByTestId("reply-derived-banner")).toBeNull();
  });
});

describe("focus and the live region", () => {
  it("after the load the cursor is in the message; in To when there is no recipient yet", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(field("reply-body")));
    cleanup();
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, defaults: { to: [], cc: [] } }) }) });
    open();
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(field("reply-to")));
  });

  it("when a result appears focus moves to the result message; Esc and Tab still work in the sent state", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => ok({ status: "verified", actionId: PID, outcome: "sent" }),
    });
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    const result = await screen.findByTestId("reply-result");
    await waitFor(() => expect(document.activeElement).toBe(result));
    expect(result.getAttribute("tabindex")).toBe("-1");
    // the fields are off now, so focus could be nowhere: the document-level listener still traps Tab
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("one persistent role=status region whose text changes (loading, ready, sent)", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => ok({ status: "verified", actionId: PID, outcome: "sent" }),
    });
    open();
    const live = screen.getByTestId("reply-live");
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("Loading the message.");
    await ready();
    expect(screen.getByTestId("reply-live")).toBe(live); // the same element
    expect(live.textContent).toBe("The reply is ready to edit.");
    fireEvent.change(field("reply-body"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    await screen.findByTestId("reply-result");
    expect(live.textContent).toMatch(/^Sent/);
  });
});

describe("the AI draft is kept and can be asked for again", () => {
  const ai = () => {
    let n = 0;
    return fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: `Draft number ${++n}` } }),
    });
  };

  it("reopening the drawer reuses the draft of the last 30 minutes instead of asking the AI again", async () => {
    const calls = ai();
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Draft number 1"));
    expect(aiDrafts.read("PKG", "u1", "m1")).toEqual({ text: "Draft number 1", awaiting: false });
    fireEvent.click(screen.getByRole("button", { name: "Close reply" }));
    cleanup();
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Draft number 1"));
    expect(calls.filter((c) => c.action === "draft_reply")).toHaveLength(1);
    expect(screen.getByTestId("reply-source-note").textContent).toMatch(/Drafted by AI/);
  });

  it("an expired kept draft is not reused (30 minutes)", async () => {
    const calls = ai();
    const key = aiDrafts.key("PKG", "u1", "m1");
    window.sessionStorage.setItem(key, JSON.stringify({ v: 1, t: Date.now() - 31 * 60_000, d: { text: "Old draft", awaiting: false } }));
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Draft number 1"));
    expect(calls.filter((c) => c.action === "draft_reply")).toHaveLength(1);
  });

  it("'Draft again' asks the AI again and replaces the text; the button is only there when an AI draft is shown", async () => {
    const calls = ai();
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Draft number 1"));
    fireEvent.click(screen.getByTestId("reply-draft-again"));
    await waitFor(() => expect(field("reply-body").value).toBe("Draft number 2"));
    expect(calls.filter((c) => c.action === "draft_reply")).toHaveLength(2);
    expect(aiDrafts.read("PKG", "u1", "m1")?.text).toBe("Draft number 2");
    cleanup();
    fakeServer({ reply_context: () => ok({ context: proposalCtx() }) });
    open();
    await ready();
    expect(screen.queryByTestId("reply-draft-again")).toBeNull(); // a pending proposal: edit it, no AI draft
  });

  it("'Draft again' respects the limiter: it shows the remaining wait and keeps the text", async () => {
    let n = 0;
    fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => (++n === 1 ? ok({ draft: { status: "ready", text: "First" } }) : { status: 429, data: { error: "rate_limited", message: "A draft was just made for this thread. Wait a moment before asking for another.", retryAfterS: 37 } }),
    });
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("First"));
    fireEvent.click(screen.getByTestId("reply-draft-again"));
    expect((await screen.findByTestId("reply-ai-message")).textContent).toContain("Try again in 37 seconds.");
    expect(field("reply-body").value).toBe("First");
    expect(screen.getByTestId("reply-draft-again")).toBeTruthy(); // still available for later
  });
});

describe("nothing is kept when the company does not store drafts (D-19)", () => {
  it("typing and the AI draft write nothing to sessionStorage, and anything already there is removed", async () => {
    window.sessionStorage.setItem(replyDrafts.key("PKG", "u1", "m1"), JSON.stringify({ v: 1, t: Date.now(), d: { to: "a@b.example.test", cc: "", body: "old text", serverVersion: "none" } }));
    window.sessionStorage.setItem(aiDrafts.key("PKG", "u1", "m1"), JSON.stringify({ v: 1, t: Date.now(), d: { text: "old ai", awaiting: false } }));
    fakeServer({
      reply_context: () => ok({ context: baseContext({ storesDrafts: false }) }),
      draft_reply: () => ok({ draft: { status: "ready", text: "Generated" } }),
    });
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Generated")); // the old stored text was not restored
    fireEvent.change(field("reply-body"), { target: { value: "Typed text" } });
    await new Promise((r) => setTimeout(r, 700)); // past the 500 ms debounce
    fireEvent.click(screen.getByRole("button", { name: "Close reply" }));
    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });
});

describe("unsent edits and the server's version", () => {
  it("edits made against an older draft are discarded with a note, and the server's draft is shown", async () => {
    window.sessionStorage.setItem(replyDrafts.key("PKG", "u1", "m1"), JSON.stringify({ v: 1, t: Date.now(), d: { to: "a@b.example.test", cc: "", body: "My old edits", serverVersion: "d".repeat(64) } }));
    fakeServer({ reply_context: () => ok({ context: proposalCtx() }) });
    open();
    await ready();
    expect(field("reply-body").value).toBe("Prepared draft");
    expect(screen.getByTestId("reply-stale-note").textContent).toBe(STALE_NOTE);
    expect(stored()).toBeNull();
  });

  it("edits made against the same version are restored", async () => {
    window.sessionStorage.setItem(replyDrafts.key("PKG", "u1", "m1"), JSON.stringify({ v: 1, t: Date.now(), d: { to: "dana@sender.example.test", cc: "", body: "My edits", serverVersion: HASH } }));
    fakeServer({ reply_context: () => ok({ context: proposalCtx() }) });
    open();
    await ready();
    expect(field("reply-body").value).toBe("My edits");
    expect(screen.queryByTestId("reply-stale-note")).toBeNull();
  });

  it("another user's stored edits (same message) are never offered", async () => {
    window.sessionStorage.setItem(replyDrafts.key("PKG", "someone-else", "m1"), JSON.stringify({ v: 1, t: Date.now(), d: { to: "x@y.example.test", cc: "", body: "Not yours", serverVersion: "none" } }));
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    expect(field("reply-body").value).toBe("");
  });

  it("'Discard my edits' puts the server's draft back and removes the local copy", async () => {
    fakeServer({ reply_context: () => ok({ context: proposalCtx() }) });
    open();
    await ready();
    expect(screen.queryByTestId("reply-discard")).toBeNull(); // nothing changed yet
    fireEvent.change(field("reply-body"), { target: { value: "Changed" } });
    fireEvent.change(field("reply-to"), { target: { value: "x@y.example.test" } });
    fireEvent.click(screen.getByTestId("reply-discard"));
    expect(field("reply-body").value).toBe("Prepared draft");
    expect(field("reply-to").value).toBe("dana@sender.example.test");
    await new Promise((r) => setTimeout(r, 700));
    expect(stored()).toBeNull(); // the debounced write was cancelled too
    expect(screen.queryByTestId("reply-discard")).toBeNull();
  });
});

describe("refresh and double clicks", () => {
  const sendable = () =>
    fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => ok({ status: "verified", actionId: PID, outcome: "sent" }),
    });

  it("router.refresh() waits until the drawer is closed, so the result message is never unmounted", async () => {
    sendable();
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    await screen.findByTestId("reply-result");
    expect(nav.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close reply" }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("the same holds for Save draft", async () => {
    sendable();
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("reply-save"));
    await screen.findByTestId("reply-saved");
    expect(nav.refresh).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("a double click on Send saves and approves once", async () => {
    const calls = sendable();
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Hello" } });
    const send = screen.getByTestId("reply-send");
    fireEvent.click(send);
    fireEvent.click(send);
    await screen.findByTestId("reply-result");
    expect(calls.filter((c) => c.action === "propose_reply")).toHaveLength(1);
    expect(calls.filter((c) => c.action === "approve")).toHaveLength(1);
  });
});

describe("a reply was already sent to this conversation", () => {
  it("says so with the date; Send needs a second click ('Send another reply') that sends confirmResend", async () => {
    const calls = fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false, alreadySent: { at: "2026-11-10T09:00:00Z" } }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => ok({ status: "verified", actionId: PID, outcome: "sent" }),
    });
    open();
    await ready();
    expect(screen.getByTestId("reply-already-sent").textContent).toContain("You already replied to this conversation on");
    fireEvent.change(field("reply-body"), { target: { value: "One more thing" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    expect(calls.some((c) => c.action === "propose_reply")).toBe(false); // the first click only asks
    fireEvent.click(await screen.findByTestId("reply-confirm-resend-button"));
    await screen.findByTestId("reply-result");
    expect(calls.find((c) => c.action === "propose_reply")).toMatchObject({ confirmResend: true, bodyText: "One more thing" });
  });

  it("without the confirmation no confirmResend is ever sent", async () => {
    const calls = fakeServer({
      reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }),
      propose_reply: () => ok({ id: PID, hash: HASH, unchanged: false }),
      approve: () => ok({ status: "verified", actionId: PID, outcome: "sent" }),
    });
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "First reply" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    await screen.findByTestId("reply-result");
    expect(calls.find((c) => c.action === "propose_reply")).not.toHaveProperty("confirmResend");
  });
});

describe("reply-draft-store", () => {
  it("survives a blocked sessionStorage without throwing", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(replyDrafts.write("PKG", "u1", "m1", { to: "a", cc: "", body: "b", serverVersion: "none" })).toBe(false);
    spy.mockRestore();
    expect(replyDrafts.read("PKG", "u1", "m1")).toBeNull();
    window.sessionStorage.setItem(replyDrafts.key("PKG", "u1", "m1"), "{not json");
    expect(replyDrafts.read("PKG", "u1", "m1")).toBeNull();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(replyDrafts.read("PKG", "u1", "m1")).toBeNull();
    get.mockRestore();
  });

  it("expires after its time to live and ignores entries of the wrong shape", () => {
    let t = 1_000_000;
    const ns = draftNamespace<{ x: string }>("test-ns", { ttlMs: 1000, now: () => t, validate: (v) => (typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "string" ? { x: (v as { x: string }).x } : null) });
    expect(ns.write("PKG", "u", "i", { x: "a" })).toBe(true);
    expect(ns.read("PKG", "u", "i")).toEqual({ x: "a" });
    t += 1001;
    expect(ns.read("PKG", "u", "i")).toBeNull();
    expect(window.sessionStorage.getItem(ns.key("PKG", "u", "i"))).toBeNull(); // removed when found expired
    window.sessionStorage.setItem(ns.key("PKG", "u", "j"), JSON.stringify({ v: 1, t, d: { y: 1 } }));
    expect(ns.read("PKG", "u", "j")).toBeNull();
  });

  it("clearAllDrafts (sign-out) removes every draft namespace and nothing else", () => {
    replyDrafts.write("PKG", "u1", "m1", { to: "a", cc: "", body: "b", serverVersion: "none" });
    aiDrafts.write("PKG", "u1", "m1", { text: "t", awaiting: false });
    window.sessionStorage.setItem("unrelated", "keep");
    clearAllDrafts();
    expect(Object.keys(window.sessionStorage)).toEqual(["unrelated"]);
  });

  it("debounced: one call after the delay with the last arguments; flush runs it now; cancel drops it", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounced(fn, 500);
    d.call("a");
    d.call("b");
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(fn.mock.calls).toEqual([["b"]]);
    d.call("c");
    d.flush();
    expect(fn.mock.calls).toEqual([["b"], ["c"]]);
    d.call("d");
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("the redesigned drawer (T-237 part E)", () => {
  it("shows Reply to <name>, the subject, the thread meta in Eastern time with ET, and a Full thread link", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    expect(screen.getByRole("dialog", { name: "Reply to Dana" })).toBeTruthy();
    expect(screen.getByTestId("reply-header-subject").textContent).toBe("Re: Quarterly review");
    const meta = screen.getByTestId("reply-thread-meta").textContent ?? "";
    expect(meta).toBe("Dana · Tue, Nov 10, 4:12 PM ET");
    expect(meta).not.toMatch(/Z|T\d\d:/);
    expect(screen.getByTestId("reply-full-thread").getAttribute("href")).toBe("/PKG/inbox/m1");
    expect(screen.getByTestId("reply-draft-label").textContent).toBe("Your reply");
  });

  it("with no readable body it still opens and is editable: Thread preview unavailable", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, preview: null, receivedAt: null }) }) });
    open();
    await ready();
    expect(screen.getByTestId("reply-preview-missing").textContent).toMatch(/^Thread preview unavailable/);
    fireEvent.change(field("reply-body"), { target: { value: "typed" } });
    expect(field("reply-body").value).toBe("typed");
  });

  it("an AI draft with figure placeholders: those sentences never reach the textarea, and a muted note says so", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: "Hi,\nThe fee is [amount] a month.\nTalk soon." } }),
    });
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Hi,\nTalk soon."));
    expect(field("reply-body").value).not.toMatch(/\[(amount|number)\]/);
    expect(screen.getByTestId("reply-removed-note").textContent).toBe("Jarvis left out 1 line with figures; add them yourself if needed.");
    expect(screen.getByTestId("reply-draft-label").textContent).toBe("Draft by Jarvis · edit freely");
  });

  it("a briefing draft with a placeholder is cleaned the same way", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext({ proposal: { id: PID, hash: HASH, expiresAt: "2026-11-14T12:00:00Z", to: ["dana@sender.example.test"], cc: [], bcc: [], bodyText: "Hello.\nInvoice [number] is open.\nBest", origin: "briefing", derivedFromRetrieved: true, rationale: null } }) }),
    });
    open();
    await ready();
    expect(field("reply-body").value).toBe("Hello.\nBest");
    expect(screen.getByTestId("reply-removed-note")).toBeTruthy();
  });

  it("warns once about a commitment from the AI draft, and hides it when the owner removes the phrase or types their own", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: "We will confirm by Thursday noon ET." } }),
    });
    open();
    await ready();
    const warn = await screen.findByTestId("reply-commitment");
    expect(warn.textContent).toBe('Check before sending: "Thursday noon ET", "We will confirm" are commitments Jarvis suggested.');
    fireEvent.change(field("reply-body"), { target: { value: "We will look into it. I can call tomorrow." } });
    expect(screen.queryByTestId("reply-commitment")).toBeNull();
  });

  it("two commitments: one notice that lists both, and one is dropped when the owner removes it", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: "Reply by Friday noon ET and within 2 days." } }),
    });
    open();
    await ready();
    const warn = await screen.findByTestId("reply-commitment");
    expect(warn.textContent).toBe('Check before sending: "Friday noon ET", "within 2 days" are commitments Jarvis suggested.');
    expect(screen.getAllByTestId("reply-commitment")).toHaveLength(1);
    fireEvent.change(field("reply-body"), { target: { value: "Reply within 2 days." } });
    expect(screen.getByTestId("reply-commitment").textContent).toBe('Check before sending: "within 2 days" is a commitment Jarvis suggested.');
  });

  it("a draft with CRLF line endings is checked the same way", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: "Hi,\r\nThe fee is [amount].\r\nBy Friday noon ET.\r\nBest" } }),
    });
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toBe("Hi,\nBy Friday noon ET.\nBest")); // a textarea normalises line endings to LF
    expect((await screen.findByTestId("reply-commitment")).textContent).toBe('Check before sending: "Friday noon ET" is a commitment Jarvis suggested.');
  });

  it("the warning survives a reload that restores the unsent edits, even after the 30-minute draft cache expired", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext() }),
      draft_reply: () => ok({ draft: { status: "ready", text: "We will confirm by Thursday noon ET." } }),
    });
    open();
    await ready();
    await screen.findByTestId("reply-commitment");
    fireEvent.change(field("reply-body"), { target: { value: "We will confirm by Thursday noon ET. Thanks, Sam." } });
    await waitFor(() => expect(stored()?.body).toMatch(/Thanks, Sam/));
    cleanup();
    window.sessionStorage.removeItem(aiDrafts.key("PKG", "u1", "m1")); // the cache is gone
    open();
    await ready();
    await waitFor(() => expect(field("reply-body").value).toMatch(/Thanks, Sam/));
    expect(screen.getByTestId("reply-source-note").textContent).toBe("Your unsent edits were restored.");
    expect((await screen.findByTestId("reply-commitment")).textContent).toContain('"Thursday noon ET"');
  });

  it("the warning survives Save draft: the saved proposal reopens with it; a proposal with no recorded origin shows none", async () => {
    const saved = { id: PID, hash: HASH, expiresAt: "2026-11-14T12:00:00Z", to: ["dana@sender.example.test"], cc: [] as string[], bcc: [] as string[], bodyText: "We will confirm by Thursday noon ET.", origin: "owner" as const, derivedFromRetrieved: true, rationale: null };
    let proposal: typeof saved | null = null;
    fakeServer({
      reply_context: () => ok({ context: baseContext({ proposal }) }),
      draft_reply: () => ok({ draft: { status: "ready", text: "We will confirm by Thursday noon ET." } }),
      propose_reply: () => {
        proposal = saved;
        return ok({ id: PID, hash: HASH, unchanged: false });
      },
    });
    open();
    await ready();
    await screen.findByTestId("reply-commitment");
    fireEvent.click(screen.getByTestId("reply-save"));
    await screen.findByTestId("reply-saved");
    cleanup();
    window.sessionStorage.removeItem(aiDrafts.key("PKG", "u1", "m1"));
    open();
    await ready();
    expect(field("reply-body").value).toBe("We will confirm by Thursday noon ET.");
    expect(screen.getByTestId("reply-source-note").textContent).toBe("Your saved draft.");
    expect((await screen.findByTestId("reply-commitment")).textContent).toContain('"Thursday noon ET"');
    // A new session (nothing recorded): no warning. Documented limit.
    cleanup();
    window.sessionStorage.clear();
    open();
    await ready();
    expect(field("reply-body").value).toBe("We will confirm by Thursday noon ET.");
    expect(screen.queryByTestId("reply-commitment")).toBeNull();
  });

  it("nothing about the AI text is kept when the company does not store drafts", async () => {
    fakeServer({
      reply_context: () => ok({ context: baseContext({ storesDrafts: false }) }),
      draft_reply: () => ok({ draft: { status: "ready", text: "We will confirm by Thursday noon ET." } }),
    });
    open();
    await ready();
    await screen.findByTestId("reply-commitment");
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("nichols:reply-"))).toEqual([]);
  });

  it("the autosave label is not a live region and explains itself", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "x" } });
    const label = await screen.findByTestId("reply-autosave");
    expect(label.getAttribute("role")).toBeNull();
    expect(label.getAttribute("aria-live")).toBeNull();
    expect(label.getAttribute("title")).toBe("Kept on this device until you send or save");
    expect(document.getElementById(label.getAttribute("aria-describedby") ?? "")?.textContent).toMatch(/Kept on this device until you send or save/);
    expect(label.textContent).toMatch(/^Saved just now/);
  });

  it("the caption describes the textarea, and the already-replied date is Eastern with ET", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, alreadySent: { at: "2026-11-10T03:30:00Z" } }) }) });
    open();
    await ready();
    const cap = document.getElementById(field("reply-body").getAttribute("aria-describedby") ?? "");
    expect(cap?.getAttribute("data-testid")).toBe("reply-draft-label");
    expect(screen.getByTestId("reply-already-sent").textContent).toContain("Nov 9, 2026 ET");
  });

  it("autosave status: nothing until a write succeeds, then Saved just now; nothing at all when drafts are not stored", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
      open();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.queryByTestId("reply-autosave")).toBeNull();
      fireEvent.change(field("reply-body"), { target: { value: "draft text" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(screen.getByTestId("reply-autosave").textContent).toMatch(/^Saved just now/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 60_000);
      });
      expect(screen.getByTestId("reply-autosave").textContent).toMatch(/^Saved 3 min ago/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never claims a save when the company does not store drafts", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false, storesDrafts: false }) }) });
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "x" } });
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByTestId("reply-autosave")).toBeNull();
  });
});
