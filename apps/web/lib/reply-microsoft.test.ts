// T-260: replying from a Microsoft mailbox is not built (T-262, T-263). The server refuses every reply path for a Microsoft message before any body read, model call or
// proposal: the message is `not_found` for the reply routes (a fixed code, no error page). The facade's own refusal (`unsupported_op`) is tested in the connectors package.
import { describe, expect, it, vi } from "vitest";
import type { ApprovalsPublicDeps, UserCtx } from "@nichols/approvals/server";
import { draftReply, loadMessageRef, replyContext, saveReply, type ReplyDeps } from "./reply";

const row = { message_id: "AAkALg=", connection_id: "00000000-0000-4000-8000-0000000c2602", provider: "microsoft", from_name: "Dana", from_address: "dana@acme.example.test", to_recipients: [], cc_recipients: [], subject: "Plan", received_at: "2026-11-20T10:00:00Z", thread_id: "conv-1" };
const ctx = { laneId: "PKG", userId: "00000000-0000-4000-8000-0000000000a1", rpc: vi.fn(async () => ({ data: [row], error: null })) } as unknown as UserCtx;
const approvals = { readFacts: vi.fn(), prepareEmailWrite: vi.fn(), jobRpc: vi.fn() } as unknown as ApprovalsPublicDeps;
const deps = { readBody: vi.fn(), llm: vi.fn(), limiter: { wait: () => 0, take: () => true }, now: () => 0 } as unknown as ReplyDeps;
const db = { schema: () => { throw new Error("no database read expected"); } } as never;

describe("reply paths for a Microsoft message", () => {
  it("every one refuses with not_found and touches nothing else", async () => {
    await expect(loadMessageRef(ctx, "AAkALg=")).rejects.toMatchObject({ code: "not_found" });
    await expect(replyContext(ctx, db, approvals, deps, "AAkALg=")).rejects.toMatchObject({ code: "not_found" });
    await expect(draftReply(ctx, db, approvals, deps, "AAkALg=")).rejects.toMatchObject({ code: "not_found" });
    await expect(saveReply(ctx, db, approvals, { now: () => 0 }, { messageId: "AAkALg=", to: ["dana@acme.example.test"], cc: [], bodyText: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(deps.readBody).not.toHaveBeenCalled();
    expect(deps.llm).not.toHaveBeenCalled();
    expect(approvals.readFacts).not.toHaveBeenCalled();
    expect(approvals.prepareEmailWrite).not.toHaveBeenCalled();
  });
});
