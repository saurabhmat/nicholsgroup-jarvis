// T-262: Reply from a Microsoft row. The provider comes from the ROW's own connection, never from the lane. A Microsoft row is replyable only where its connection holds
// `graph_mail_write` and the lane policy allows an email write; otherwise every reply path refuses with `not_found` before any body read, model call or proposal
// (fail closed, as before T-262). A Google row is unchanged (it never needs the Microsoft grant).
import { describe, expect, it, vi } from "vitest";
import type { ApprovalsPublicDeps, CapabilityFacts, UserCtx } from "@nichols/approvals/server";
import { assertReplyAllowed, draftReply, loadMessageRef, replyContext, saveReply, type ReplyDeps } from "./reply";

const MS = "00000000-0000-4000-8000-0000000c2602";
const GG = "00000000-0000-4000-8000-0000000c2601";
const row = (provider: string, connection: string) => ({ message_id: "AAkALg=", connection_id: connection, provider, from_name: "Dana", from_address: "dana@acme.example.test", to_recipients: [], cc_recipients: [], subject: "Plan", received_at: "2026-11-20T10:00:00Z", thread_id: "conv-1" });
const ctxFor = (r: unknown) => ({ laneId: "PKG", userId: "00000000-0000-4000-8000-0000000000a1", rpc: vi.fn(async () => ({ data: [r], error: null })) }) as unknown as UserCtx;
const facts = (over: Partial<CapabilityFacts>): CapabilityFacts => ({ mailbox: "robert@pubkgroup.example.test", provider: "microsoft", composeGranted: true, writeActionsAllowed: ["email_send", "email_draft"], approvalsLive: true, stepUpMaxAgeS: 300, ...over });
const approvalsWith = (f: CapabilityFacts) => ({ readFacts: vi.fn(async () => f), prepareEmailWrite: vi.fn(), jobRpc: vi.fn() }) as unknown as ApprovalsPublicDeps;
const deps = () => ({ readBody: vi.fn(), llm: vi.fn(), limiter: { wait: () => 0, take: () => true }, now: () => 0 }) as unknown as ReplyDeps;
const db = { schema: () => { throw new Error("no database read expected"); } } as never;

describe("the provider is the row's own", () => {
  it("loadMessageRef carries the provider of the message's connection", async () => {
    expect((await loadMessageRef(ctxFor(row("microsoft", MS)), "AAkALg=")).provider).toBe("microsoft");
    expect((await loadMessageRef(ctxFor(row("google", GG)), "AAkALg=")).provider).toBe("google");
    await expect(loadMessageRef(ctxFor(row("quickbooks", GG)), "AAkALg=")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("a Microsoft row is replyable only with the write grant and a lane that allows an email write", () => {
  const refusals: [string, Partial<CapabilityFacts>][] = [
    ["no graph_mail_write", { composeGranted: false }],
    ["the lane policy allows no email write", { writeActionsAllowed: [] }],
    ["the connection is not usable (no mailbox)", { mailbox: null }],
    ["the facts name another provider", { provider: "google" }],
    ["the provider is unknown", { provider: null }],
  ];
  it.each(refusals)("%s: every reply path refuses with not_found before any body read, model call or proposal", async (_n, over) => {
    const approvals = approvalsWith(facts(over));
    const d = deps();
    const ctx = ctxFor(row("microsoft", MS));
    await expect(replyContext(ctx, db, approvals, d, "AAkALg=")).rejects.toMatchObject({ code: "not_found" });
    await expect(draftReply(ctx, db, approvals, d, "AAkALg=")).rejects.toMatchObject({ code: "not_found" });
    await expect(saveReply(ctx, db, approvals, { now: () => 0 }, { messageId: "AAkALg=", to: ["dana@acme.example.test"], cc: [], bodyText: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(d.readBody).not.toHaveBeenCalled();
    expect(d.llm).not.toHaveBeenCalled();
    expect(approvals.prepareEmailWrite).not.toHaveBeenCalled();
  });

  it("with the grant and an email_send or email_draft policy it is allowed; a Google row never needs the Microsoft grant", async () => {
    await expect(assertReplyAllowed(approvalsWith(facts({})), "PKG" as never, { provider: "microsoft", connectionId: MS })).resolves.toMatchObject({ provider: "microsoft" });
    await expect(assertReplyAllowed(approvalsWith(facts({ writeActionsAllowed: ["email_draft"] })), "PKG" as never, { provider: "microsoft", connectionId: MS })).resolves.toBeDefined();
    await expect(assertReplyAllowed(approvalsWith(facts({ provider: "google", composeGranted: false })), "PKG" as never, { provider: "google", connectionId: GG })).resolves.toMatchObject({ provider: "google" });
  });
});
