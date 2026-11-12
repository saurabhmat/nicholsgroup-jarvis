// @vitest-environment jsdom
// T-234 part 3: the Reply drawer. Dialog behaviour (focus in, trap, Esc, focus back), what is editable (To, Cc, Body; never the
// subject), "Sends as", the thread preview as plain text, the disabled Send with the exact message while Save and Copy work,
// the step-up redirect with sessionStorage, and the sent / failed / unknown results. fetch is a fake of the approvals route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReplyContext } from "@/lib/reply-client";
import { loadReplyDraft, saveReplyDraft } from "@/lib/reply-draft-store";
import { ReplyAction, type ReplyTarget } from "./reply-action";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const NOT_ENABLED = "Sending isn't enabled for this mailbox yet. Reconnect Google with send permission in Settings";
const PID = "00000000-0000-4000-8000-0000000000aa";
const HASH = "c".repeat(64);
const target: ReplyTarget = { laneId: "PKG", connectionId: "c1", messageId: "m1", threadKey: "t-100", proposalId: null };

const baseContext = (over: Partial<ReplyContext> = {}): ReplyContext => ({
  messageId: "m1",
  mailbox: "exec@pubkgroup.example.test",
  subject: "Re: Quarterly review",
  replyingTo: "Dana <dana@sender.example.test>",
  defaults: { to: ["dana@sender.example.test"], cc: [] },
  internalDomains: ["pubkgroup.example.test"],
  proposal: null,
  send: { enabled: true, message: null, settingsHref: null },
  storesDrafts: true,
  aiAllowed: true,
  blocked: false,
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
    fireEvent.keyDown(dialog, { key: "Escape" });
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
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("is a full-screen sheet below md and a 480 px right drawer from md", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    const cls = screen.getByRole("dialog").className;
    expect(cls).toContain("inset-0");
    expect(cls).toContain("md:w-[480px]");
    expect(cls).toContain("md:right-0");
  });
});

describe("what the owner sees and may edit", () => {
  it("shows Sends as, the recipients, a read-only subject, and the thread preview as plain text", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext({ aiAllowed: false }) }) });
    open();
    expect((await ready()).textContent).toBe("Sends as exec@pubkgroup.example.test");
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
      reply_context: () => ok({ context: baseContext({ proposal: { id: PID, hash: HASH, to: ["dana@sender.example.test"], cc: [], bcc: ["spy@elsewhere.example.test"], bodyText: "Prepared draft", origin: "briefing", derivedFromRetrieved: true, rationale: "note" } }) }),
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
    expect(loadReplyDraft("PKG", "m1")).toBeNull(); // not stored
  });

  it("an awaiting-input draft is shown as such with an empty body; a refused draft shows the fixed message and the owner writes it", async () => {
    fakeServer({ reply_context: () => ok({ context: baseContext() }), draft_reply: () => ok({ draft: { status: "awaiting_input", text: "" } }) });
    open();
    await ready();
    expect(screen.getByTestId("reply-awaiting").textContent).toMatch(/^Awaiting your input/);
    expect(field("reply-body").value).toBe("");
    cleanup();
    fakeServer({ reply_context: () => ok({ context: baseContext() }), draft_reply: () => ({ status: 429, data: { error: "rate_limited", message: "A draft was just made for this thread. Wait a minute before asking for another." } }) });
    open();
    await ready();
    expect((await screen.findByTestId("reply-ai-message")).textContent).toMatch(/Wait a minute/);
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
    expect(screen.getByTestId("reply-refused").textContent).toMatch(/Check the Sent folder/);
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

  it("saves the exact edited text, approves the hash that save returned, shows Sent, clears the stored edits and refreshes", async () => {
    const calls = sendable();
    await fillAndSend();
    const result = await screen.findByTestId("reply-result");
    expect(result.getAttribute("data-outcome")).toBe("sent");
    expect(result.textContent).toMatch(/^Sent/);
    expect(calls.filter((c) => c.action !== "reply_context")).toEqual([
      { action: "propose_reply", messageId: "m1", to: ["dana@sender.example.test"], cc: [], bodyText: "Hello Dana" },
      { action: "approve", id: PID, hashSeen: HASH },
    ]);
    expect(loadReplyDraft("PKG", "m1")).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
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
    expect(loadReplyDraft("PKG", "m1")).toEqual({ to: "dana@sender.example.test", cc: "", body: "Typed before the code" });
    cleanup();
    // back from /mfa: /PKG?reply=m1 reopens the drawer for that message with the fields restored, and no new AI draft
    window.history.replaceState(null, "", "/PKG?reply=m1");
    const calls = sendable();
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

  it("an edit is autosaved per message in sessionStorage", async () => {
    sendable();
    open();
    await ready();
    fireEvent.change(field("reply-body"), { target: { value: "Half written" } });
    expect(loadReplyDraft("PKG", "m1")?.body).toBe("Half written");
    expect(loadReplyDraft("PKG", "m2")).toBeNull();
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
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
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

describe("reply-draft-store", () => {
  it("survives a blocked sessionStorage without throwing", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(saveReplyDraft("PKG", "m1", { to: "a", cc: "", body: "b" })).toBe(false);
    spy.mockRestore();
    expect(loadReplyDraft("PKG", "m1")).toBeNull();
    window.sessionStorage.setItem("nichols:reply-draft:PKG:m1", "{not json");
    expect(loadReplyDraft("PKG", "m1")).toBeNull();
  });
});
