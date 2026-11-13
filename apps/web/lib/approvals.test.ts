// Approvals API and page models (T-232): origin, body, role and step-up gating before the module runs, and the view
// models the page draws (capability message, short hash, derived banner). The module and SQL have their own tests.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { NOT_ENABLED_MESSAGE, NOT_LIVE_MESSAGE, QBO_NOT_ENABLED_MESSAGE, ApprovalsError, type ActionRow, type ApprovalsPublicDeps, type CapabilityFacts } from "@nichols/approvals/server";
import { handleApprovals, loadApprovals, recipientFlags, toCard, toDisconnectCard, toHistory } from "./approvals";

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
    requireRole: vi.fn(async (_lane?: string, _roles?: readonly string[]) => {
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

// ---------------------------------------------------------------- T-195: qbo.disconnect
const REALM = "9341450000000001";
const qboRow = (over: Partial<ActionRow> = {}) =>
  row({ actionType: "qbo.disconnect", provider: "quickbooks", target: { realm_id: REALM }, payload: {}, proposerKind: "user", derivedFromRetrieved: false, rationale: null, ...over });
const qboFacts: CapabilityFacts = { mailbox: null, composeGranted: false, writeActionsAllowed: ["qbo_disconnect"], approvalsLive: true, stepUpMaxAgeS: 300, qbo: { realmId: REALM } };

/** setup() with a guard that answers per role list, as requireRole does: `roles` the user holds in the lane. */
function setupRoles(held: string[], opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  s.g.requireRole.mockImplementation(async (_lane?: string, wanted: readonly string[] = []) => {
    if (!wanted.some((r) => held.includes(r))) throw new AuthError("forbidden");
    return { session: { userId: USER }, laneId: "PKG", client: { schema: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { s.calls.push({ fn, args }); if (fn === "has_lane_role") return { data: (args.p_roles as string[]).some((r) => held.includes(r)), error: null };
      return fn === "act_get" || fn === "act_list" ? { data: (opts.rows ?? [row()]).map(snake), error: null } : { data: null, error: null }; } }) } } as never;
  });
  return s;
}

describe("propose_qbo_disconnect (T-195)", () => {
  const body = { action: "propose_qbo_disconnect", connectionId: CONN };
  it("owner and admin_technical may propose; the role list asked of the guard is exactly those two", async () => {
    for (const role of ["owner", "admin_technical"]) {
      const s = setupRoles([role]);
      const proposeDeps = { ...s.deps, approvals: { ...s.deps.approvals, readFacts: async () => qboFacts, jobRpc: async () => async () => ({ data: ID, error: null }) } as never };
      const res = await handleApprovals(post(body), "PKG", proposeDeps);
      expect(res.status).toBe(200);
      expect(s.g.requireRole).toHaveBeenCalledWith("PKG", ["owner", "admin_technical"]);
    }
  });
  it("a finance_operator, a viewer and a non-member get 403 and the module is never reached", async () => {
    for (const held of [["finance_operator"], ["viewer"], []]) {
      const s = setupRoles(held);
      const res = await handleApprovals(post(body), "PKG", s.deps);
      expect(res.status).toBe(403);
      expect(s.calls).toEqual([]);
    }
  });
  it("a connection that is not this lane's QuickBooks connection (another lane's, another provider's) is 404 and proposes nothing", async () => {
    const s = setupRoles(["owner"]);
    const rpcCalls: string[] = [];
    const res = await handleApprovals(post(body), "PKG", { ...s.deps, approvals: { ...s.deps.approvals, readFacts: async () => ({ ...qboFacts, qbo: null }), jobRpc: async () => async (fn: string) => (rpcCalls.push(fn), { data: ID, error: null }) } as never });
    expect(res.status).toBe(404);
    expect(rpcCalls).not.toContain("act_propose");
  });
  it("refuses an invalid body (no connection id, extra fields) before any guard", async () => {
    const s = setupRoles(["owner"]);
    expect((await handleApprovals(post({ action: "propose_qbo_disconnect" }), "PKG", s.deps)).status).toBe(400);
    expect((await handleApprovals(post({ ...body, realm: REALM }), "PKG", s.deps)).status).toBe(400);
    expect(s.g.requireRole).not.toHaveBeenCalled();
  });
  it("a duplicate pending proposal is a 409 with the module's message", async () => {
    const s = setupRoles(["admin_technical"]);
    const res = await handleApprovals(post(body), "PKG", { ...s.deps, approvals: { ...s.deps.approvals, readFacts: async () => qboFacts, jobRpc: async () => async () => ({ data: null, error: { code: "23505", message: "act: disconnect_already_pending" } }) } as never });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "disconnect_pending" });
  });
});

describe("approve and reject by action type (T-195)", () => {
  it("admin_technical approves a qbo.disconnect: step-up first, then the bound approve; the outcome is 'disconnected'", async () => {
    const s = setupRoles(["admin_technical"], { rows: [qboRow()] });
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "verified", outcome: "disconnected" });
    expect(s.requireStepUp).toHaveBeenCalledWith(300);
    expect(s.approve).toHaveBeenCalledTimes(1);
    expect(s.g.requireRole.mock.calls.map((c) => c[1] ?? [])).toEqual([["owner", "admin_technical"]]); // never narrowed to owner
  });
  it("admin_technical cannot approve or reject an EMAIL action (403), and the module is not reached", async () => {
    const s = setupRoles(["admin_technical"], { rows: [row()] });
    const a = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(a.status).toBe(403);
    expect(s.approve).not.toHaveBeenCalled();
    expect(s.requireStepUp).not.toHaveBeenCalled();
    const r = await handleApprovals(post({ action: "reject", id: ID, reason: "No" }), "PKG", s.deps);
    expect(r.status).toBe(403);
    expect(s.calls.map((c) => c.fn)).not.toContain("act_reject");
  });
  it("admin_technical cannot edit an email or use the reply actions (owner only)", async () => {
    const s = setupRoles(["admin_technical"]);
    const res = await handleApprovals(post({ action: "save", id: ID, to: ["a@example.test"], cc: [], bcc: [], subject: "x", bodyText: "y" }), "PKG", s.deps);
    expect(res.status).toBe(403);
  });
  it("a qbo.disconnect approve without a fresh TOTP answers step_up_required and approves nothing", async () => {
    const s = setupRoles(["owner"], { rows: [qboRow()], stepUp: "required" });
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "step_up_required" });
    expect(s.approve).not.toHaveBeenCalled();
  });
  it("finance_operator and viewer cannot approve or reject a disconnect", async () => {
    for (const held of [["finance_operator"], ["viewer"]]) {
      const s = setupRoles(held, { rows: [qboRow()] });
      expect((await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps)).status).toBe(403);
      expect((await handleApprovals(post({ action: "reject", id: ID, reason: "x" }), "PKG", s.deps)).status).toBe(403);
      expect(s.approve).not.toHaveBeenCalled();
    }
  });
  it("another lane's action id (RLS returns nothing) is a 404 for approve", async () => {
    const s = setupRoles(["owner"], { rows: [] });
    expect((await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps)).status).toBe(404);
  });
  it("admin_technical rejects a qbo.disconnect (reason required, no step-up)", async () => {
    const s = setupRoles(["admin_technical"], { rows: [qboRow()] });
    const res = await handleApprovals(post({ action: "reject", id: ID, reason: "Not now" }), "PKG", s.deps);
    expect(res.status).toBe(200);
    expect(s.requireStepUp).not.toHaveBeenCalled();
    expect(s.calls.find((c) => c.fn === "act_reject")?.args).toMatchObject({ p_lane: "PKG", p_id: ID, p_reason: "Not now" });
  });
  it("a failed or unconfirmed disconnect is told apart: nothing changed vs check QuickBooks", async () => {
    const failed = setupRoles(["owner"], { rows: [qboRow()] });
    failed.approve.mockResolvedValueOnce({ status: "failed", actionId: ID, failureCode: "connection_unhealthy" } as never);
    expect(await (await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", failed.deps)).json()).toMatchObject({ outcome: "failed" });
    const unknown = setupRoles(["owner"], { rows: [qboRow()] });
    unknown.approve.mockResolvedValueOnce({ status: "failed", actionId: ID, failureCode: "verification_mismatch" } as never);
    expect(await (await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", unknown.deps)).json()).toMatchObject({ outcome: "unknown" });
  });
  it("the module's refusals keep their status and message (not enabled for this company)", async () => {
    const s = setupRoles(["owner"], { rows: [qboRow()] });
    s.approve.mockRejectedValueOnce(new ApprovalsError("qbo_not_enabled"));
    const res = await handleApprovals(post({ action: "approve", id: ID, hashSeen: HASH }), "PKG", s.deps);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "qbo_not_enabled", message: QBO_NOT_ENABLED_MESSAGE });
  });
});

describe("page view models for qbo.disconnect (T-195)", () => {
  it("the card names the company by its realm id, the short hash, who asked, and whether it can be approved", () => {
    const c = toDisconnectCard(qboRow({ proposerUserId: USER }), qboFacts, "PKG", USER);
    expect(c).toMatchObject({ actionType: "qbo.disconnect", realmId: REALM, shortHash: "aaaaaaaa", proposedByYou: true, capability: { enabled: true, message: null } });
    expect(toDisconnectCard(qboRow({ proposerUserId: "00000000-0000-4000-8000-0000000000b2" }), qboFacts, "PKG", USER).proposedByYou).toBe(false);
  });
  it("not enabled without the lane policy class; not live without approvals_live", () => {
    expect(toDisconnectCard(qboRow(), { ...qboFacts, writeActionsAllowed: ["email_send"] }, "PKG", USER).capability).toMatchObject({ enabled: false, message: QBO_NOT_ENABLED_MESSAGE });
    expect(toDisconnectCard(qboRow(), { ...qboFacts, approvalsLive: false }, "PKG", USER).capability).toMatchObject({ enabled: false, message: NOT_LIVE_MESSAGE });
  });
  it("toCard refuses a qbo row (it has its own card) and history labels it", () => {
    expect(() => toCard(qboRow(), qboFacts, "PKG")).toThrow();
    expect(toHistory(qboRow({ status: "verified" }))).toMatchObject({ actionType: "qbo.disconnect", subject: "Disconnect QuickBooks", to: [], status: "verified" });
    expect(toHistory(qboRow({ status: "failed", failureCode: "verification_unavailable" })).outcomeUnknown).toBe(true);
  });
  it("loadApprovals puts a disconnect in its own list; admin_technical may act on it, a viewer may not", async () => {
    const mk = (held: string[]) => {
      const rpc = async (fn: string) => (fn === "act_list" ? { data: [qboRow(), row({ id: "00000000-0000-4000-8000-0000000000ab" })].map(snake), error: null } : { data: 0, error: null });
      return {
        requireLane: async () => ({ session: { userId: USER }, laneId: "PKG", client: { schema: () => ({ rpc }) } }) as never,
        requireRole: async (_l: string, wanted: readonly string[]) => {
          if (!wanted.some((r) => held.includes(r))) throw new AuthError("forbidden");
          return {} as never;
        },
      };
    };
    const approvals = { jobRpc: async () => async () => ({ data: 0, error: null }), readFacts: async (_l: string, conn: string) => (conn === CONN ? { ...facts, ...qboFacts, mailbox: facts.mailbox, composeGranted: true } : facts), laneMailboxes: async () => [], audit: { log: async () => undefined } } as unknown as ApprovalsPublicDeps;
    const admin = await loadApprovals(mk(["admin_technical"]), approvals, "PKG");
    expect(admin).toMatchObject({ isOwner: false, canActDisconnect: true });
    expect(admin.disconnects).toHaveLength(1);
    expect(admin.pending).toHaveLength(1);
    const viewer = await loadApprovals(mk(["viewer"]), approvals, "PKG");
    expect(viewer).toMatchObject({ isOwner: false, canActDisconnect: false });
    const owner = await loadApprovals(mk(["owner"]), approvals, "PKG");
    expect(owner).toMatchObject({ isOwner: true, canActDisconnect: true });
  });
});
