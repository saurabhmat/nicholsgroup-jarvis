// T-234 part 3: the approvals route's reply actions. Guard order (origin, body, owner, step-up only for approve), the strict
// schema that keeps the client's thread/subject/mailbox out, the hash that is approved = the hash that was saved, the fixed
// refusals (sending not enabled, drafts off), and the result mapping. The module's functions are faked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import type { ApprovalsPublicDeps, CapabilityFacts } from "@nichols/approvals/server";

const mod = vi.hoisted(() => ({ propose: vi.fn(), edit: vi.fn(), list: vi.fn() }));
vi.mock("@nichols/approvals/server", async (orig) => ({
  ...(await orig<typeof import("@nichols/approvals/server")>()),
  proposeEmailAction: mod.propose,
  editEmailProposal: mod.edit,
  listApprovals: mod.list,
}));

import { ApprovalsError, NOT_ENABLED_MESSAGE } from "@nichols/approvals/server";
import { handleApprovals } from "./approvals";
import { createLimiter } from "./reply";
import { createMockProvider, textResult } from "@nichols/ai/testing";
import { DRAFTS_OFF_MESSAGE, resultMessage, UNKNOWN_MESSAGE } from "./reply-messages";

const USER = "00000000-0000-4000-8000-0000000000a1";
const ID = "00000000-0000-4000-8000-0000000000aa";
const CONN = "00000000-0000-4000-8000-000000002901";
const SAVED_HASH = "c".repeat(64);
const facts: CapabilityFacts = { mailbox: "exec@pubkgroup.example.test", composeGranted: true, writeActionsAllowed: ["email_send"], approvalsLive: true, stepUpMaxAgeS: 300 };

function setup(opts: { role?: "ok" | "forbidden"; stepUp?: "ok" | "required"; policy?: Record<string, unknown> | null; approve?: () => Promise<never> | Promise<unknown> } = {}) {
  const calls: string[] = [];
  const rpc = async (fn: string) => {
    calls.push(fn);
    if (fn === "inbox_message_ref") return { data: [{ message_id: "m1", connection_id: CONN, provider: "google", from_name: "Dana", from_address: "dana@sender.example.test", subject: "Quarterly review", received_at: "2026-11-12T10:00:00Z", thread_id: "t-100" }], error: null };
    if (fn === "act_get") return { data: [{ connection_id: CONN }], error: null };
    return { data: null, error: null };
  };
  const policy = opts.policy === undefined ? { llm_allowed_categories: ["email"], store_outbound_drafts: true } : opts.policy;
  const client = { schema: () => ({ rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: policy, error: null }) }) }) }) }) };
  const requireStepUp = vi.fn(async () => {
    if (opts.stepUp === "required") throw new AuthError("step_up_required");
    return {} as never;
  });
  const requireRole = vi.fn(async () => {
    if (opts.role === "forbidden") throw new AuthError("forbidden");
    return { session: { userId: USER }, laneId: "PKG", client } as never;
  });
  const approve = vi.fn(opts.approve ?? (async () => ({ status: "verified" as const, actionId: ID })));
  const provider = createMockProvider([textResult(JSON.stringify({ text: "Thanks, noted." }))]);
  const readBody = vi.fn(async () => ({ text: "Please confirm.", truncated: false }));
  const approvals = { jobRpc: async () => async () => ({ data: 0, error: null }), readFacts: async () => facts, laneMailboxes: async () => ["exec@pubkgroup.example.test"], audit: { log: async () => undefined } } as unknown as ApprovalsPublicDeps;
  return {
    calls,
    requireRole,
    requireStepUp,
    approve,
    provider,
    readBody,
    deps: {
      guards: async () => ({ requireRole, requireStepUp }),
      approvals,
      approve: approve as never,
      reply: { readBody, llm: () => ({ configured: true as const, provider }), limiter: createLimiter({ windowMs: 60_000, max: 1 }), now: Date.now },
    },
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/lanes/PKG/approvals", { method: "POST", headers: { "content-type": "application/json", "content-length": String(text.length), ...headers }, body: text });
};
const SAVE = { action: "propose_reply", messageId: "m1", to: ["dana@sender.example.test"], cc: [], bodyText: "Hello" };

beforeEach(() => {
  mod.propose.mockReset().mockResolvedValue({ id: ID, hash: SAVED_HASH });
  mod.edit.mockReset().mockResolvedValue({ id: ID, hash: SAVED_HASH, unchanged: false });
  mod.list.mockReset().mockResolvedValue([]);
});

describe("guard order", () => {
  it("origin, content type and body schema are refused before any guard", async () => {
    const s = setup();
    for (const action of ["reply_context", "draft_reply"]) {
      expect((await handleApprovals(post({ action, messageId: "m1" }, { "sec-fetch-site": "cross-site" }), "PKG", s.deps)).status).toBe(403);
      expect((await handleApprovals(post({ action, messageId: "bad id!" }), "PKG", s.deps)).status).toBe(400);
    }
    expect((await handleApprovals(post(SAVE, { "sec-fetch-site": "cross-site" }), "PKG", s.deps)).status).toBe(403);
    expect((await handleApprovals(post({ ...SAVE, to: [] }), "PKG", s.deps)).status).toBe(400);
    expect((await handleApprovals(post({ ...SAVE, to: ["nope"] }), "PKG", s.deps)).status).toBe(400);
    expect((await handleApprovals(post({ ...SAVE, bodyText: "" }), "PKG", s.deps)).status).toBe(400);
    expect(s.requireRole).not.toHaveBeenCalled();
  });

  it("client-supplied thread, subject, mailbox, connection or bcc are refused by the strict schema", async () => {
    const s = setup();
    for (const extra of [{ threadId: "t-evil" }, { subject: "Re: evil" }, { fromMailbox: "ceo@evil.example.test" }, { connectionId: CONN }, { bcc: ["x@y.example.test"] }, { inReplyTo: { threadId: "t", messageId: "m" } }]) {
      const res = await handleApprovals(post({ ...SAVE, ...extra }), "PKG", s.deps);
      expect(res.status).toBe(400);
    }
    expect(mod.propose).not.toHaveBeenCalled();
    expect(s.requireRole).not.toHaveBeenCalled();
  });

  it("only the owner: a non-owner reaches nothing", async () => {
    const s = setup({ role: "forbidden" });
    for (const body of [{ action: "reply_context", messageId: "m1" }, { action: "draft_reply", messageId: "m1" }, SAVE]) {
      expect((await handleApprovals(post(body), "PKG", s.deps)).status).toBe(403);
    }
    expect(s.requireRole).toHaveBeenCalledWith("PKG", ["owner"]);
    expect(s.calls).toEqual([]);
    expect(s.readBody).not.toHaveBeenCalled();
    expect(s.provider.calls).toHaveLength(0);
  });

  it("step-up is required only for approve: context, draft and save work without a fresh code", async () => {
    const s = setup({ stepUp: "required" });
    expect((await handleApprovals(post({ action: "reply_context", messageId: "m1" }), "PKG", s.deps)).status).toBe(200);
    expect((await handleApprovals(post({ action: "draft_reply", messageId: "m1" }), "PKG", s.deps)).status).toBe(200);
    expect((await handleApprovals(post(SAVE), "PKG", s.deps)).status).toBe(200);
    expect(s.requireStepUp).not.toHaveBeenCalled();
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: SAVED_HASH }), "PKG", s.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "step_up_required" });
    expect(s.approve).not.toHaveBeenCalled();
  });
});

describe("save and approve use the same hash", () => {
  it("the id and hash returned by the save are what approve is called with (edited payload = approved payload)", async () => {
    const s = setup();
    mod.list.mockResolvedValue([]);
    const saved = await (await handleApprovals(post(SAVE), "PKG", s.deps)).json();
    expect(saved).toMatchObject({ ok: true, id: ID, hash: SAVED_HASH });
    const res = await handleApprovals(post({ action: "approve", id: saved.id, hashSeen: saved.hash }), "PKG", s.deps);
    expect(res.status).toBe(200);
    expect(s.requireStepUp).toHaveBeenCalledWith(300);
    expect(s.approve).toHaveBeenCalledWith(expect.objectContaining({ laneId: "PKG", userId: USER }), { actionId: ID, hashSeen: SAVED_HASH });
  });

  it("an edit of a pending proposal returns the NEW hash from the edit", async () => {
    const s = setup();
    mod.list.mockResolvedValue([
      {
        id: ID, laneId: "PKG", actionType: "email.send", connectionId: CONN, provider: "google", target: {}, payloadSchemaVersion: 1, payloadSha256: "a".repeat(64), rationale: null, sourceRefs: [],
        proposerKind: "job", proposerUserId: USER, derivedFromRetrieved: true, supersedesId: null, supersededById: null, status: "proposed", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        approvedBy: null, approvedAt: null, approvedHash: null, executedAt: null, verifiedAt: null, result: {}, failureCode: null, payloadPurgedAt: null, createdAt: "", updatedAt: "",
        payload: { to: ["dana@sender.example.test"], cc: [], bcc: [], subject: "Re: Quarterly review", bodyText: "old", inReplyTo: { threadId: "t-100", messageId: "m1" } },
      },
    ]);
    mod.edit.mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000ab", hash: "d".repeat(64), unchanged: false });
    const saved = await (await handleApprovals(post(SAVE), "PKG", s.deps)).json();
    expect(saved).toMatchObject({ id: "00000000-0000-4000-8000-0000000000ab", hash: "d".repeat(64) });
    expect(mod.propose).not.toHaveBeenCalled();
  });
});

describe("fixed refusals", () => {
  it("drafts off: save is refused with drafts_not_allowed and the module's fixed message", async () => {
    const s = setup({ policy: { llm_allowed_categories: ["email"], store_outbound_drafts: false } });
    const res = await handleApprovals(post(SAVE), "PKG", s.deps);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("drafts_not_allowed");
    expect(body.message).toMatch(/^This company does not store outbound drafts/);
    expect(DRAFTS_OFF_MESSAGE).toMatch(/^This company does not store outbound drafts/);
    expect(mod.propose).not.toHaveBeenCalled();
  });

  it("sending not enabled: approve is refused with the exact message", async () => {
    const s = setup({ approve: async () => { throw new ApprovalsError("not_enabled"); } });
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: SAVED_HASH }), "PKG", s.deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_enabled", message: NOT_ENABLED_MESSAGE });
  });

  it("the AI refusals are fixed codes, never provider or row text", async () => {
    const s = setup({ policy: { llm_allowed_categories: [], store_outbound_drafts: true } });
    const res = await handleApprovals(post({ action: "draft_reply", messageId: "m1" }), "PKG", s.deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "ai_not_allowed" });
    const limited = setup();
    expect((await handleApprovals(post({ action: "draft_reply", messageId: "m1" }), "PKG", limited.deps)).status).toBe(200);
    const again = await handleApprovals(post({ action: "draft_reply", messageId: "m1" }), "PKG", limited.deps);
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: "rate_limited" });
  });

  it("without the reply dependencies the reply actions answer unavailable", async () => {
    const s = setup();
    const res = await handleApprovals(post({ action: "reply_context", messageId: "m1" }), "PKG", { ...s.deps, reply: undefined });
    expect(res.status).toBe(503);
  });
});

describe("result mapping", () => {
  const approveWith = async (result: unknown) => {
    const s = setup({ approve: async () => result as never });
    return (await handleApprovals(post({ action: "approve", id: ID, hashSeen: SAVED_HASH }), "PKG", s.deps)).json();
  };
  it("verified -> sent", async () => {
    expect(await approveWith({ status: "verified", actionId: ID })).toMatchObject({ ok: true, outcome: "sent" });
  });
  it("failed with a definite code -> failed (it did not go out)", async () => {
    expect(await approveWith({ status: "failed", actionId: ID, failureCode: "execution_error" })).toMatchObject({ outcome: "failed", failureCode: "execution_error" });
  });
  it("failed with a verification, unknown or reconcile code -> unknown (it may have gone out)", async () => {
    for (const code of ["verification_mismatch", "verification_unavailable", "outcome_unknown", "marker_not_found", "ambiguous_match", "reconcile_timeout"]) {
      expect(await approveWith({ status: "failed", actionId: ID, failureCode: code })).toMatchObject({ outcome: "unknown" });
    }
  });
  it("already in progress -> unknown", async () => {
    expect(await approveWith({ status: "already_in_progress", actionId: ID })).toMatchObject({ outcome: "unknown" });
  });
  it("the owner-facing text: never 'failed' for verification_*, never a blind retry after unknown", () => {
    expect(resultMessage("sent", null)).toMatch(/^Sent/);
    expect(resultMessage("unknown", "verification_mismatch")).toMatch(/Check your Sent folder before trying again/);
    expect(resultMessage("unknown", "verification_mismatch")).not.toMatch(/fail/i);
    expect(resultMessage("unknown", "outcome_unknown")).toBe(UNKNOWN_MESSAGE);
    expect(resultMessage("unknown", null)).toBe(UNKNOWN_MESSAGE);
    expect(UNKNOWN_MESSAGE).toBe("Sending status unknown: check Sent before retrying.");
    expect(resultMessage("failed", "connection_unhealthy")).toMatch(/reconnected/);
    expect(resultMessage("failed", "something_new")).toMatch(/was not sent/);
  });
});
