// Approvals API and page models (T-232): origin, body, role and step-up gating before the module runs, and the view
// models the page draws (capability message, short hash, derived banner). The module and SQL have their own tests.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { NOT_ENABLED_MESSAGE, NOT_LIVE_MESSAGE, type ActionRow, type ApprovalsPublicDeps, type CapabilityFacts } from "@nichols/approvals/server";
import { handleApprovals, recipientFlags, toCard, toHistory } from "./approvals";

const USER = "00000000-0000-4000-8000-0000000000a1";
const ID = "00000000-0000-4000-8000-0000000000aa";
const CONN = "00000000-0000-4000-8000-000000002901";
const HASH = "a".repeat(64);

function row(over: Partial<ActionRow> = {}): ActionRow {
  return {
    id: ID,
    laneId: "PKG",
    actionType: "email.send",
    connectionId: CONN,
    provider: "google",
    target: { mailbox: "exec@pubkgroup.example.test" },
    payload: { fromMailbox: "exec@pubkgroup.example.test", to: ["dana@sender.example.test"], cc: [], bcc: [], subject: "Update", bodyText: "Hello" },
    payloadSchemaVersion: 1,
    payloadSha256: HASH,
    rationale: null,
    sourceRefs: [],
    proposerKind: "job",
    proposerUserId: USER,
    derivedFromRetrieved: true,
    supersedesId: null,
    supersededById: null,
    status: "proposed",
    expiresAt: "2026-11-14T12:00:00Z",
    approvedBy: null,
    approvedAt: null,
    approvedHash: null,
    executedAt: null,
    verifiedAt: null,
    result: {},
    failureCode: null,
    payloadPurgedAt: null,
    createdAt: "2026-11-11T12:00:00Z",
    updatedAt: "2026-11-11T12:00:00Z",
    ...over,
  } as ActionRow;
}
const facts: CapabilityFacts = { mailbox: "exec@pubkgroup.example.test", composeGranted: true, writeActionsAllowed: ["email_send", "email_draft"], approvalsLive: true, stepUpMaxAgeS: 300 };

function setup(opts: { role?: "ok" | "forbidden"; stepUp?: "ok" | "required"; rows?: ActionRow[] } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "act_list" || fn === "act_get") return { data: (opts.rows ?? [row()]).map(snake), error: null };
    return { data: null, error: null };
  };
  const requireStepUp = vi.fn(async () => {
    if (opts.stepUp === "required") throw new AuthError("step_up_required");
    return {} as never;
  });
  const g = {
    requireRole: vi.fn(async () => {
      if (opts.role === "forbidden") throw new AuthError("forbidden");
      return { session: { userId: USER }, laneId: "PKG", client: { schema: () => ({ rpc }) } } as never;
    }),
    requireStepUp,
  };
  const approvals = {
    jobRpc: async () => async () => ({ data: 0, error: null }),
    readFacts: async () => facts,
    audit: { log: async () => undefined },
  } as unknown as ApprovalsPublicDeps;
  const approve = vi.fn(async () => ({ status: "verified" as const, actionId: ID }));
  return { g, requireStepUp, calls, approve, deps: { guards: async () => g, approvals, approve } };
}

function snake(r: ActionRow) {
  return {
    id: r.id, lane_id: r.laneId, action_type: r.actionType, connection_id: r.connectionId, provider: r.provider, target: r.target, payload: r.payload,
    payload_schema_version: r.payloadSchemaVersion, payload_sha256: r.payloadSha256, rationale: r.rationale, source_refs: r.sourceRefs, proposer_kind: r.proposerKind,
    proposer_user_id: r.proposerUserId, derived_from_retrieved: r.derivedFromRetrieved, supersedes_id: r.supersedesId, superseded_by_id: r.supersededById, status: r.status,
    expires_at: r.expiresAt, approved_by: r.approvedBy, approved_at: r.approvedAt, approved_hash: r.approvedHash, executed_at: r.executedAt, verified_at: r.verifiedAt,
    result: r.result, failure_code: r.failureCode, payload_purged_at: r.payloadPurgedAt, created_at: r.createdAt, updated_at: r.updatedAt,
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/lanes/PKG/approvals", { method: "POST", headers: { "content-type": "application/json", "content-length": String(text.length), ...headers }, body: text });
};

describe("handleApprovals gating", () => {
  it("refuses a cross-site request, a non-JSON body and an invalid body before any guard", async () => {
    const s = setup();
    expect((await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }, { "sec-fetch-site": "cross-site" }), "PKG", s.deps)).status).toBe(403);
    expect((await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }, { "content-type": "text/plain" }), "PKG", s.deps)).status).toBe(415);
    expect((await handleApprovals(post({ action: "approve", id: "nope", hashSeen: HASH }), "PKG", s.deps)).status).toBe(400);
    expect((await handleApprovals(post({ action: "send_everything" }), "PKG", s.deps)).status).toBe(400);
    expect((await handleApprovals(post({ action: "save", id: ID, to: ["not an address"], cc: [], bcc: [], subject: "x", bodyText: "y" }), "PKG", s.deps)).status).toBe(400);
    expect(s.g.requireRole).not.toHaveBeenCalled();
  });

  it("a non-owner is refused and the module is never reached", async () => {
    const s = setup({ role: "forbidden" });
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(403);
    expect(s.requireStepUp).not.toHaveBeenCalled();
    expect(s.calls).toEqual([]);
  });

  it("approve without a fresh TOTP answers step_up_required and does not call approve", async () => {
    const s = setup({ stepUp: "required" });
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "step_up_required" });
    expect(s.requireStepUp).toHaveBeenCalledWith(300); // the lane's step_up_max_age_s
    expect(s.calls.map((c) => c.fn)).not.toContain("act_approve");
    expect(s.approve).not.toHaveBeenCalled();
  });

  it("approve after the step-up goes through the bound approve (the route never holds the writer)", async () => {
    const s = setup();
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(200);
    expect(s.approve).toHaveBeenCalledWith(expect.objectContaining({ laneId: "PKG", userId: USER }), { actionId: ID, hashSeen: HASH });
  });

  it("approve for an action the user cannot see is a 404 (RLS returns nothing)", async () => {
    const s = setup({ rows: [] });
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(404);
  });

  it("reject requires only the owner role (no step-up)", async () => {
    const s = setup();
    const res = await handleApprovals(post({ action: "reject", id: ID, reason: "No" }), "PKG", s.deps);
    expect(res.status).toBe(200);
    expect(s.requireStepUp).not.toHaveBeenCalled();
    expect(s.calls.find((c) => c.fn === "act_reject")?.args).toMatchObject({ p_lane: "PKG", p_id: ID, p_reason: "No" });
  });
});

describe("page view models", () => {
  it("a pending card shows the sender, a short hash and the derived flag; enabled when everything allows", () => {
    const card = toCard(row(), facts, "PKG");
    expect(card).toMatchObject({ mailbox: "exec@pubkgroup.example.test", shortHash: "aaaaaaaa", derivedFromRetrieved: true, bodyText: "Hello", capability: { enabled: true, message: null } });
  });
  it("the capability message and settings link when the mailbox cannot send, then the not-live text", () => {
    expect(toCard(row(), { ...facts, composeGranted: false }, "PKG").capability).toEqual({ enabled: false, message: NOT_ENABLED_MESSAGE, settingsHref: "/PKG/settings#connections" });
    expect(toCard(row(), { ...facts, approvalsLive: false }, "PKG").capability).toMatchObject({ enabled: false, message: NOT_LIVE_MESSAGE });
  });
  it("a card whose email still holds a placeholder carries the edit-first message (T-237); a clean one carries none", () => {
    expect(toCard(row(), facts, "PKG").placeholder).toBeNull();
    const gap = row({ payload: { ...row().payload, bodyText: "The total is [amount]." } });
    expect(toCard(gap, facts, "PKG").placeholder).toMatch(/still contains a placeholder such as \[amount\]/);
    // A reply: the sender's subject is not ours and can't be edited, so only the body counts.
    const reply = row({ target: { mailbox: "exec@pubkgroup.example.test", thread_id: "t-1" }, payload: { ...row().payload, subject: "Re: [TBD] plan" } });
    expect(toCard(reply, facts, "PKG").placeholder).toBeNull();
  });
  it("history keeps recipients and subject and says the content was purged", () => {
    const h = toHistory(row({ status: "verified", payloadPurgedAt: "2026-11-11T13:00:00Z", payload: { to: ["dana@sender.example.test"], subject: "Update" }, verifiedAt: "2026-11-11T13:00:00Z" }));
    expect(h).toMatchObject({ status: "verified", to: ["dana@sender.example.test"], subject: "Update", contentPurged: true });
    expect(JSON.stringify(h)).not.toContain("bodyText");
    expect(h.outcomeUnknown).toBe(false);
  });
  it("a failed action whose outcome is unknown (reconciler or execute) is flagged: check the mailbox before asking again (T-192)", () => {
    for (const failureCode of ["outcome_unknown", "marker_not_found", "ambiguous_match", "verification_mismatch", "reconcile_sent_unverified", "reconcile_lookup_failed", "reconcile_connection_unhealthy", "verification_unavailable"]) {
      expect(toHistory(row({ status: "failed", failureCode })).outcomeUnknown, failureCode).toBe(true);
    }
    for (const failureCode of ["connection_unhealthy", "execution_refused", "payload_changed"]) {
      expect(toHistory(row({ status: "failed", failureCode })).outcomeUnknown, failureCode).toBe(false);
    }
    expect(toHistory(row({ status: "verified", failureCode: "marker_not_found" })).outcomeUnknown).toBe(false);
  });
});

describe("recipientFlags (T-232 security review M1)", () => {
  it("flags external domains and every bcc; internal to/cc are not listed", () => {
    const flags = recipientFlags({ to: ["dana@sender.example.test", "me@pubkgroup.example.test"], cc: [], bcc: ["boss@pubkgroup.example.test"] }, ["pubkgroup.example.test"]);
    expect(flags).toEqual([
      { address: "dana@sender.example.test", field: "to", flags: ["external"] },
      { address: "boss@pubkgroup.example.test", field: "bcc", flags: ["bcc"] },
    ]);
  });
  it("toCard counts the sending mailbox's domain as internal", () => {
    expect(toCard(row(), facts, "PKG").recipientFlags).toEqual([{ address: "dana@sender.example.test", field: "to", flags: ["external"] }]);
  });
});
