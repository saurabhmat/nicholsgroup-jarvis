// The approvals module over an in-memory twin of the act.* functions and a fake Gmail writer (T-232). The SQL itself is
// pinned by pgTAP (290_approvals_email); here: the module's own rules. Synthetic data only (rule 10).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@nichols/connectors";
import { OUTCOME_UNKNOWN_MESSAGE, VERIFICATION_MISMATCH_MESSAGE } from "@nichols/connectors/write";
import type { AuditEntry } from "@nichols/core/audit";
import { createAudit } from "@nichols/core/audit";
import { emailWriteCapability } from "./capability";
import { approveAndExecute, editEmailProposal, executeApproved, listApprovals, pendingApprovalCount, proposeEmailAction, rejectAction } from "./email";
import { ApprovalsError, NOT_ENABLED_MESSAGE, NOT_LIVE_MESSAGE } from "./errors";
import { hashOfRow } from "./rows";
import type { ApprovalsDeps, CapabilityFacts, Rpc } from "./types";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const CONN = "00000000-0000-4000-8000-000000002901";
const MAILBOX = "exec@pubkgroup.example.test";
const CANARY = "BODY-CANARY-7f3a-not-real";

type Row = Record<string, unknown> & { id: string; status: string; payload: Record<string, unknown> };

function world(over: { facts?: Partial<CapabilityFacts>; mailboxes?: string[]; writer?: "ok" | "unknown" | "mismatch" | "refused"; auditFailOnce?: string; markVerifiedThrows?: boolean } = {}) {
  let auditFailPending = over.auditFailOnce;
  const rows = new Map<string, Row>();
  const audits: AuditEntry[] = [];
  const calls = { writes: 0, verifies: 0, claims: 0 };
  const facts: CapabilityFacts = { mailbox: MAILBOX, composeGranted: true, writeActionsAllowed: ["email_send", "email_draft"], approvalsLive: true, stepUpMaxAgeS: 300, ...over.facts };
  const err = (message: string, code = "P0001") => ({ data: null, error: { code, message } });
  const purge = (r: Row) => {
    delete r.payload.bodyText;
    r.rationale = null;
    r.payload_purged_at = new Date().toISOString();
  };

  const impl = (fn: string, a: Record<string, unknown>): { data: unknown; error: { code?: string; message?: string } | null } => {
    const get = (id: unknown) => [...rows.values()].find((r) => r.id === id && r.lane_id === a.p_lane);
    switch (fn) {
      case "act_propose":
      case "act_supersede": {
        const isSup = fn === "act_supersede";
        const old = isSup ? get(a.p_old) : undefined;
        if (isSup && !old) return err("act: not_found", "P0002");
        const id = randomUUID();
        const now = new Date().toISOString();
        const row: Row = {
          id,
          lane_id: a.p_lane,
          action_type: isSup ? old?.action_type : a.p_type,
          connection_id: isSup ? old?.connection_id : a.p_connection,
          provider: "google",
          target: structuredClone(a.p_target),
          payload: structuredClone(a.p_payload) as Record<string, unknown>,
          payload_schema_version: a.p_version,
          payload_sha256: a.p_hash,
          rationale: a.p_rationale ?? null,
          source_refs: a.p_source_refs ?? [],
          proposer_kind: isSup ? "user" : a.p_proposer_kind,
          proposer_user_id: (isSup ? a.p_proposer_user : a.p_proposer_user) ?? null,
          derived_from_retrieved: a.p_derived,
          supersedes_id: old?.id ?? null,
          superseded_by_id: null,
          status: "proposed",
          expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
          approved_by: null,
          approved_at: null,
          approved_hash: null,
          executed_at: null,
          verified_at: null,
          result: {},
          failure_code: null,
          payload_purged_at: null,
          created_at: now,
          updated_at: now,
        };
        rows.set(id, row);
        if (old) {
          old.status = "invalidated";
          old.superseded_by_id = id;
          purge(old);
        }
        return { data: id, error: null };
      }
      case "act_get":
        return { data: [get(a.p_id)].filter(Boolean), error: null };
      case "act_list":
        return { data: [...rows.values()].filter((r) => r.lane_id === a.p_lane), error: null };
      case "act_pending_count":
        return { data: [...rows.values()].filter((r) => r.lane_id === a.p_lane && r.status === "proposed").length, error: null };
      case "act_expire_stale":
        return { data: 0, error: null };
      case "act_withdraw_proposed": {
        // twin of act.withdraw_proposed: only a pending JOB proposal; body purged
        const r = get(a.p_id);
        if (!r || r.status !== "proposed" || r.proposer_kind !== "job") return { data: false, error: null };
        r.status = "invalidated";
        r.withdraw_reason = a.p_reason;
        purge(r);
        return { data: true, error: null };
      }
      case "act_approve": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status === "approved") return err("act: already_approved");
        if (r.status !== "proposed") return err("act: not_pending");
        if (a.p_hash_seen !== r.payload_sha256) return err("act: hash_mismatch");
        r.status = "approved";
        r.approved_by = OWNER;
        r.approved_at = new Date().toISOString();
        r.approved_hash = r.payload_sha256;
        return { data: r.payload_sha256, error: null };
      }
      case "act_reject": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status !== "proposed") return err("act: not_pending");
        r.status = "rejected";
        purge(r);
        return { data: null, error: null };
      }
      case "act_claim_execution": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status !== "approved") return err("act: not_approved");
        calls.claims += 1;
        r.status = "executing";
        return { data: structuredClone(r), error: null };
      }
      case "act_claim_sent":
        return { data: null, error: null };
      case "act_mark_verified": {
        if (over.markVerifiedThrows) throw new Error("network down");
        const r = get(a.p_id);
        if (!r || r.status !== "executing") return err("act: not_executing");
        r.status = "verified";
        r.result = { external_id: a.p_external_id, outcome: a.p_outcome };
        purge(r);
        return { data: null, error: null };
      }
      case "act_mark_failed": {
        const r = get(a.p_id);
        if (!r || r.status !== "executing") return err("act: not_executing");
        r.status = "failed";
        r.failure_code = a.p_code as string;
        purge(r);
        return { data: null, error: null };
      }
      case "act_action_state": {
        const r = get(a.p_id);
        return { data: r ? [{ status: r.status, failure_code: r.failure_code ?? null }] : [], error: null };
      }
      case "has_lane_role":
        return { data: a.p_uid === OWNER, error: null };
      default:
        return err("unknown function", "42883");
    }
  };
  const rpc: Rpc = async (fn, args) => impl(fn, args);

  const writer = {
    provider: "google" as const,
    actionTypes: ["email.send", "email.save_draft"],
    async executeWrite() {
      calls.writes += 1;
      if (over.writer === "unknown") throw new ConnectorError({ kind: "provider_error", message: OUTCOME_UNKNOWN_MESSAGE });
      if (over.writer === "refused") throw new ConnectorError({ kind: "forbidden", message: "no" });
      return { outcome: "accepted" as const, external_id: "gmail-msg-1", executed_at: new Date().toISOString(), provider_tid: null };
    },
    async verifyWrite() {
      calls.verifies += 1;
      if (over.writer === "mismatch") throw new ConnectorError({ kind: "provider_error", message: VERIFICATION_MISMATCH_MESSAGE });
    },
  };
  const audit = createAudit(async (row) => {
    if (auditFailPending && row.p_action === auditFailPending) {
      auditFailPending = undefined;
      throw new Error("audit down");
    }
    audits.push({ laneId: row.p_lane_id, actor: row.p_actor_kind === "user" ? { kind: "user", userId: row.p_actor_id ?? "" } : { kind: row.p_actor_kind as "service" }, action: row.p_action, ...(row.p_target ? { target: row.p_target } : {}), metadata: row.p_metadata });
  });
  const deps: ApprovalsDeps = {
    jobRpc: async () => rpc,
    async prepareEmailWrite(laneId, connectionId, intent) {
      const compose = intent.compose as Record<string, unknown>;
      if (String(compose.fromMailbox).toLowerCase() !== MAILBOX) throw new ConnectorError({ kind: "forbidden", message: "fromMailbox is not this connection's mailbox" });
      return {
        connection: { id: connectionId } as never,
        proposed: {
          target: { mailbox: MAILBOX, ...((compose.inReplyTo as { threadId?: string } | undefined)?.threadId ? { thread_id: (compose.inReplyTo as { threadId: string }).threadId } : {}) },
          payload: compose,
          payload_schema_version: 1,
        },
      };
    },
    laneMailboxes: async () => over.mailboxes ?? [MAILBOX],
    readFacts: async () => facts,
    loadWriteConnection: async () => ({ id: CONN }) as never,
    writer: writer as never,
    audit,
  };
  const ctx = { laneId: "PKG", userId: OWNER, rpc };
  return { rows, audits, calls, deps, ctx, rpc, facts };
}

const compose = { to: ["dana@sender.example.test"], subject: "Quarterly update", bodyText: `Thanks Dana. ${CANARY}` };
const input = { actionType: "email.send" as const, connectionId: CONN, compose, proposerKind: "job" as const, proposerUserId: OWNER, derivedFromRetrieved: true };

describe("proposeEmailAction", () => {
  it("stores the canonical hash of the exact content and audits ids, type and hash only", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    const row = w.rows.get(id);
    expect(row?.payload_sha256).toBe(hash);
    expect(hash).toBe(hashOfRow({ laneId: "PKG", actionType: "email.send", connectionId: CONN, target: row?.target as never, payload: row?.payload as never, payloadSchemaVersion: 1 }));
    expect(row).toMatchObject({ proposer_kind: "job", derived_from_retrieved: true, status: "proposed" });
    expect((row?.payload as Record<string, unknown>).fromMailbox).toBe(MAILBOX);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ action: "action.proposed", target: `action:${id}`, metadata: { action_type: "email.send", hash, derived_from_retrieved: true } });
    expect(JSON.stringify(w.audits)).not.toContain(CANARY);
    expect(JSON.stringify(w.audits)).not.toContain("Quarterly update");
    expect(w.calls.writes).toBe(0);
  });

  it("a cutoff before the insert creates nothing", async () => {
    const w = world();
    const c = new AbortController();
    c.abort();
    await expect(proposeEmailAction(w.deps, "PKG", { ...input, signal: c.signal })).rejects.toMatchObject({ code: "unavailable" });
    expect(w.rows.size).toBe(0);
  });

  it("a cutoff during the insert withdraws the new job proposal (audited as the service) and throws", async () => {
    const w = world();
    const c = new AbortController();
    const slow: ApprovalsDeps = { ...w.deps, jobRpc: async () => async (fn, a) => (fn === "act_propose" ? (c.abort(), w.rpc(fn, a)) : w.rpc(fn, a)) };
    await expect(proposeEmailAction(slow, "PKG", { ...input, signal: c.signal })).rejects.toMatchObject({ code: "unavailable" });
    const rows = [...w.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "invalidated", withdraw_reason: "briefing run timed out" });
    expect(rows.filter((r) => r.status === "proposed")).toHaveLength(0);
    expect(rows[0]?.payload.bodyText).toBeUndefined();
    expect(w.audits.map((x) => x.action)).toEqual(["action.withdrawn"]);
    expect(w.audits[0]).toMatchObject({ actor: { kind: "service" }, metadata: { reason: "briefing run timed out" } });
    expect(JSON.stringify(w.audits)).not.toContain(CANARY);
  });

  it("refuses a sender other than the connection's mailbox, and a mailbox that is not the lane's", async () => {
    const w = world();
    await expect(proposeEmailAction(w.deps, "PKG", { ...input, compose: { ...compose, fromMailbox: "someone@else.example.test" } })).rejects.toMatchObject({ code: "sender_mismatch" });
    const w2 = world({ mailboxes: ["other@pubkgroup.example.test"] });
    await expect(proposeEmailAction(w2.deps, "PKG", input)).rejects.toMatchObject({ code: "sender_mismatch" });
    expect(w.rows.size + w2.rows.size).toBe(0);
  });

  it("refuses a connection that is not a usable Google connection of the lane", async () => {
    const w = world({ facts: { mailbox: null } });
    await expect(proposeEmailAction(w.deps, "PKG", input)).rejects.toMatchObject({ code: "invalid" });
  });

  it("maps the database's drafts-not-allowed refusal", async () => {
    const w = world();
    const failing: ApprovalsDeps = { ...w.deps, jobRpc: async () => async () => ({ data: null, error: { code: "42501", message: "act: this lane does not allow storing outbound drafts" } }) };
    await expect(proposeEmailAction(failing, "PKG", input)).rejects.toMatchObject({ code: "drafts_not_allowed" });
  });

  it("requires a user for a user proposal and valid ids", async () => {
    const w = world();
    await expect(proposeEmailAction(w.deps, "PKG", { ...input, proposerKind: "user", proposerUserId: undefined as never })).rejects.toBeInstanceOf(ApprovalsError);
    await expect(proposeEmailAction(w.deps, "PKG", { ...input, connectionId: "nope" })).rejects.toBeInstanceOf(ApprovalsError);
    await expect(proposeEmailAction(w.deps, "pkg" as never, input)).rejects.toBeInstanceOf(ApprovalsError);
  });
});

describe("editEmailProposal", () => {
  it("creates a new proposal and invalidates the old one, whose body is gone", async () => {
    const w = world();
    const first = await proposeEmailAction(w.deps, "PKG", input);
    const edited = await editEmailProposal(w.deps, w.ctx, first.id, { subject: "Edited subject" });
    expect(edited.unchanged).toBe(false);
    expect(edited.id).not.toBe(first.id);
    expect(edited.hash).not.toBe(first.hash);
    expect(w.rows.get(first.id)).toMatchObject({ status: "invalidated", superseded_by_id: edited.id });
    expect(w.rows.get(first.id)?.payload.bodyText).toBeUndefined();
    expect(w.rows.get(edited.id)).toMatchObject({ status: "proposed", supersedes_id: first.id });
    expect(w.rows.get(edited.id)?.payload.subject).toBe("Edited subject");
    expect(w.audits.map((a) => a.action)).toEqual(["action.proposed", "action.edited"]);
  });

  it("keeps 'derived from retrieved' only while the recipients are unchanged", async () => {
    const w = world();
    const a = await proposeEmailAction(w.deps, "PKG", input);
    const same = await editEmailProposal(w.deps, w.ctx, a.id, { bodyText: "New text" });
    expect(w.rows.get(same.id)?.derived_from_retrieved).toBe(true);
    const changed = await editEmailProposal(w.deps, w.ctx, same.id, { to: ["new@sender.example.test"] });
    expect(w.rows.get(changed.id)?.derived_from_retrieved).toBe(false);
  });

  it("does nothing when nothing changed, and refuses a non-owner or a non-pending action", async () => {
    const w = world();
    const a = await proposeEmailAction(w.deps, "PKG", input);
    expect(await editEmailProposal(w.deps, w.ctx, a.id, {})).toMatchObject({ id: a.id, unchanged: true });
    await expect(editEmailProposal(w.deps, { ...w.ctx, userId: "00000000-0000-4000-8000-0000000000b2" }, a.id, { subject: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await rejectAction(w.deps, w.ctx, a.id, "no thanks");
    await expect(editEmailProposal(w.deps, w.ctx, a.id, { subject: "x" })).rejects.toMatchObject({ code: "not_editable" });
  });
});

describe("approveAndExecute", () => {
  it("approves the exact hash, sends once, verifies, and audits each step without the body", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    const res = await approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash });
    expect(res).toEqual({ status: "verified", actionId: id });
    expect(w.calls).toEqual({ writes: 1, verifies: 1, claims: 1 });
    expect(w.rows.get(id)).toMatchObject({ status: "verified", result: { external_id: "gmail-msg-1", outcome: "accepted" } });
    expect(w.rows.get(id)?.payload.bodyText).toBeUndefined();
    expect(w.audits.map((a) => a.action)).toEqual(["action.proposed", "action.approved", "action.execute_started", "action.verified"]);
    expect(JSON.stringify(w.audits)).not.toContain(CANARY);
  });

  it("a second approve does not send again", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash });
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "not_pending" });
    expect(w.calls.writes).toBe(1);
  });

  it("a duplicate execution (second worker) finds the claim taken and does not send", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    // Approved but not yet executed, then two executions race: only one claim exists.
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    const [a, b] = await Promise.all([executeApproved(w.deps, "PKG", id), executeApproved(w.deps, "PKG", id)]);
    expect([a.status, b.status].sort()).toEqual(["already_in_progress", "verified"]);
    expect(w.calls.writes).toBe(1);
  });

  it("refuses an approval of a hash the approver did not see, before anything else", async () => {
    const w = world();
    const { id } = await proposeEmailAction(w.deps, "PKG", input);
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: "a".repeat(64) })).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(w.rows.get(id)?.status).toBe("proposed");
    expect(w.calls.writes).toBe(0);
    expect(w.audits.at(-1)).toMatchObject({ action: "action.gate_blocked", metadata: { reason: "hash_mismatch" } });
  });

  it("refuses when the edited proposal replaced the one the approver loaded (old hash)", async () => {
    const w = world();
    const first = await proposeEmailAction(w.deps, "PKG", input);
    const edited = await editEmailProposal(w.deps, w.ctx, first.id, { subject: "Changed" });
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: edited.id, hashSeen: first.hash })).rejects.toMatchObject({ code: "hash_mismatch" });
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: first.id, hashSeen: first.hash })).rejects.toMatchObject({ code: "not_pending" });
    expect(w.calls.writes).toBe(0);
  });

  it("a stored payload changed in the database is caught before any Gmail call", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    // Tamper after the proposal: the content no longer hashes to the stored hash.
    (w.rows.get(id)?.payload as Record<string, unknown>).to = ["attacker@evil.example.test"];
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(w.calls.writes).toBe(0);

    // Tamper between approval and claim (a forged payload after approval): the executor refuses and marks it failed.
    const w2 = world();
    const p = await proposeEmailAction(w2.deps, "PKG", input);
    await w2.rpc("act_approve", { p_lane: "PKG", p_id: p.id, p_hash_seen: p.hash });
    (w2.rows.get(p.id)?.payload as Record<string, unknown>).subject = "Forged";
    const res = await executeApproved(w2.deps, "PKG", p.id);
    expect(res).toEqual({ status: "failed", actionId: p.id, failureCode: "payload_changed" });
    expect(w2.calls.writes).toBe(0);
  });

  it("refuses with the exact capability message when the mailbox cannot send or approvals are not live", async () => {
    const noScope = world({ facts: { composeGranted: false } });
    const a = await proposeEmailAction(noScope.deps, "PKG", input);
    await expect(approveAndExecute(noScope.deps, noScope.ctx, { actionId: a.id, hashSeen: a.hash })).rejects.toMatchObject({ code: "not_enabled", message: NOT_ENABLED_MESSAGE });

    const noPolicy = world({ facts: { writeActionsAllowed: ["email_draft"] } });
    const b = await proposeEmailAction(noPolicy.deps, "PKG", input);
    await expect(approveAndExecute(noPolicy.deps, noPolicy.ctx, { actionId: b.id, hashSeen: b.hash })).rejects.toMatchObject({ code: "not_enabled" });

    const notLive = world({ facts: { approvalsLive: false } });
    const c = await proposeEmailAction(notLive.deps, "PKG", input);
    await expect(approveAndExecute(notLive.deps, notLive.ctx, { actionId: c.id, hashSeen: c.hash })).rejects.toMatchObject({ code: "not_live", message: NOT_LIVE_MESSAGE });
    expect(noScope.calls.writes + noPolicy.calls.writes + notLive.calls.writes).toBe(0);
  });

  it("an unknown send outcome ends failed/outcome_unknown and is not retried", async () => {
    const w = world({ writer: "unknown" });
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    const res = await approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash });
    expect(res).toEqual({ status: "failed", actionId: id, failureCode: "outcome_unknown" });
    expect(w.calls.writes).toBe(1);
    expect(w.rows.get(id)?.payload.bodyText).toBeUndefined();
  });

  it("a read-back mismatch ends failed/verification_mismatch; a refusal ends failed/execution_refused", async () => {
    const m = world({ writer: "mismatch" });
    const a = await proposeEmailAction(m.deps, "PKG", input);
    expect(await approveAndExecute(m.deps, m.ctx, { actionId: a.id, hashSeen: a.hash })).toMatchObject({ status: "failed", failureCode: "verification_mismatch" });
    const r = world({ writer: "refused" });
    const b = await proposeEmailAction(r.deps, "PKG", input);
    expect(await approveAndExecute(r.deps, r.ctx, { actionId: b.id, hashSeen: b.hash })).toMatchObject({ status: "failed", failureCode: "execution_refused" });
  });

  it("another lane's action is not found (RLS hides it)", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await expect(approveAndExecute(w.deps, { ...w.ctx, laneId: "APK" }, { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "not_found" });
    expect(w.calls.writes).toBe(0);
  });
});

describe("rejectAction, lists and counts", () => {
  it("rejects with a reason, purges the body and audits without the reason", async () => {
    const w = world();
    const { id } = await proposeEmailAction(w.deps, "PKG", input);
    await expect(rejectAction(w.deps, w.ctx, id, "  ")).rejects.toMatchObject({ code: "invalid" });
    await rejectAction(w.deps, w.ctx, id, "Not now");
    expect(w.rows.get(id)).toMatchObject({ status: "rejected" });
    expect(w.rows.get(id)?.payload.bodyText).toBeUndefined();
    expect(JSON.stringify(w.audits)).not.toContain("Not now");
    await expect(rejectAction(w.deps, w.ctx, id, "again")).rejects.toMatchObject({ code: "not_pending" });
  });

  it("lists the lane's actions and counts pending ones", async () => {
    const w = world();
    const a = await proposeEmailAction(w.deps, "PKG", input);
    await proposeEmailAction(w.deps, "PKG", { ...input, actionType: "email.save_draft" });
    expect((await listApprovals(w.deps, w.ctx)).map((r) => r.actionType).sort()).toEqual(["email.save_draft", "email.send"]);
    expect(await pendingApprovalCount(w.ctx)).toBe(2);
    await rejectAction(w.deps, w.ctx, a.id, "no");
    expect(await pendingApprovalCount(w.ctx)).toBe(1);
  });
});

describe("emailWriteCapability", () => {
  const cap = async (facts: Partial<CapabilityFacts>) => {
    const w = world({ facts });
    return emailWriteCapability(w.deps, "PKG", CONN);
  };
  it("enabled when the scope is granted, the type is allowed and approvals are live", async () => {
    expect(await cap({})).toMatchObject({ mailbox: MAILBOX, "email.send": { enabled: true }, "email.save_draft": { enabled: true } });
  });
  it("without the compose scope: the exact reconnect message and the settings link", async () => {
    const c = await cap({ composeGranted: false });
    expect(c["email.send"]).toEqual({ enabled: false, reason: "not_enabled", message: "Sending isn't enabled for this mailbox yet. Reconnect Google with send permission in Settings", settingsHref: "/PKG/settings#connections" });
  });
  it("per type: a lane policy without email_send disables only send", async () => {
    const c = await cap({ writeActionsAllowed: ["email_draft"] });
    expect(c["email.send"]).toMatchObject({ enabled: false, reason: "not_enabled" });
    expect(c["email.save_draft"]).toMatchObject({ enabled: true });
  });
  it("enabled but not live: the not-live message, and the not-enabled one wins when both apply", async () => {
    expect((await cap({ approvalsLive: false }))["email.send"]).toMatchObject({ enabled: false, reason: "not_live", message: "Approvals are not live for this company yet." });
    expect((await cap({ approvalsLive: false, composeGranted: false }))["email.send"]).toMatchObject({ reason: "not_enabled" });
  });
  it("an unusable connection is not enabled", async () => {
    expect((await cap({ mailbox: null }))["email.send"]).toMatchObject({ reason: "not_enabled" });
  });
});

describe("audit redaction", () => {
  it("the audit layer would drop a body even if one were passed (defence in depth)", async () => {
    const seen: unknown[] = [];
    const a = createAudit(async (row) => {
      seen.push(row.p_metadata);
    });
    await a.log({ laneId: "PKG", actor: { kind: "service" }, action: "action.proposed", target: "action:x", metadata: { hash: "a".repeat(64), bodyText: CANARY, subject: "S" } });
    expect(JSON.stringify(seen)).not.toContain(CANARY);
  });
});

describe("review fixes (T-232 code review H1, H2, M1, M4)", () => {
  const reply = { ...input, compose: { ...compose, subject: "Re: Quarterly update", inReplyTo: { threadId: "t-1", messageId: "m-1" } } };

  it("a reply's subject cannot be edited (it would leave the thread and fail the read-back after sending)", async () => {
    const w = world();
    const { id } = await proposeEmailAction(w.deps, "PKG", reply);
    await expect(editEmailProposal(w.deps, w.ctx, id, { subject: "Something else" })).rejects.toMatchObject({ code: "reply_subject_fixed" });
    // The same subject (or a body edit) is fine.
    await expect(editEmailProposal(w.deps, w.ctx, id, { subject: "Re: Quarterly update", bodyText: "New text" })).resolves.toMatchObject({ unchanged: false });
  });

  it("an approval stranded by an audit outage is resumed by the same owner and sends exactly once", async () => {
    const w = world({ auditFailOnce: "action.approved" });
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).rejects.toThrow();
    expect(w.rows.get(id)?.status).toBe("approved");
    expect(w.calls.writes).toBe(0);
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).resolves.toMatchObject({ status: "verified" });
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "not_pending" });
    expect(w.calls.writes).toBe(1);
    expect(w.audits.some((a) => a.action === "action.resumed")).toBe(true);
  });

  it("another user cannot resume someone else's approval", async () => {
    const w = world({ auditFailOnce: "action.approved" });
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash }).catch(() => undefined);
    const other = { ...w.ctx, userId: "00000000-0000-4000-8000-0000000000ff" };
    await expect(approveAndExecute(w.deps, other, { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "already_approved" });
    expect(w.calls.writes).toBe(0);
  });

  it("a send that was verified but could not be recorded is reported as sent, never as failed", async () => {
    const w = world({ markVerifiedThrows: true });
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).resolves.toMatchObject({ status: "verified" });
    expect(w.rows.get(id)?.status).toBe("executing");
    expect(w.audits.some((a) => a.action === "action.record_failed")).toBe(true);
    expect(w.calls.writes).toBe(1);
  });

  it("a failed execute keeps its failure code in the action.failed audit entry (T-192 security L4)", async () => {
    const w = world({ writer: "unknown" });
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).resolves.toMatchObject({ status: "failed", failureCode: "outcome_unknown" });
    expect(w.audits.find((x) => x.action === "action.failed")?.metadata).toMatchObject({ failure: "outcome_unknown", outcome: "outcome_unknown" });
  });

  it("an execute that loses the race to the reconciler reports the row's real status and writes no contradicting failure audit (T-192 code review M1)", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    const inner = w.rpc;
    // The reconciler verified the action while the late execute was still reading back.
    w.deps.jobRpc = async () => async (fn, args) => {
      if (fn === "act_claim_sent") {
        const r = w.rows.get(id);
        if (r) r.status = "verified";
        return { data: null, error: { code: "P0001", message: "act: no open claim" } };
      }
      return inner(fn, args);
    };
    const res = await approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash });
    expect(res).toEqual({ status: "verified", actionId: id });
    expect(w.audits.some((x) => x.action === "action.failed")).toBe(false);
    expect(w.calls.writes).toBe(1);
  });

  it("an execute that loses the race to a reconciler failure reports that failure", async () => {
    const w = world();
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    const inner = w.rpc;
    w.deps.jobRpc = async () => async (fn, args) => {
      if (fn === "act_mark_verified") {
        const r = w.rows.get(id);
        if (r) {
          r.status = "failed";
          r.failure_code = "marker_not_found";
        }
        return { data: null, error: { code: "P0001", message: "act: not_executing" } };
      }
      return inner(fn, args);
    };
    await expect(approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash })).resolves.toEqual({ status: "failed", actionId: id, failureCode: "marker_not_found" });
    expect(w.audits.some((x) => x.action === "action.failed" || x.action === "action.record_failed")).toBe(false);
  });

  it("the executor uses the approver recorded in the database", async () => {
    const w = world();
    const seen: string[] = [];
    const orig = w.deps.writer.executeWrite.bind(w.deps.writer);
    (w.deps.writer as { executeWrite: typeof orig }).executeWrite = async (l, c, a) => {
      seen.push(a.approved_by);
      return orig(l, c, a);
    };
    const { id, hash } = await proposeEmailAction(w.deps, "PKG", input);
    await approveAndExecute(w.deps, w.ctx, { actionId: id, hashSeen: hash });
    expect(seen).toEqual([OWNER]);
  });
});

describe("job proposals (T-231d security review L3, L4)", () => {
  it("a job's proposal is audited as the service, for the owner", async () => {
    const w = world();
    await proposeEmailAction(w.deps, "PKG", input);
    expect(w.audits[0]).toMatchObject({ action: "action.proposed", actor: { kind: "service" }, metadata: { for_user: OWNER } });
  });
  it("a job never addresses one of the lane's own mailboxes", async () => {
    const w = world();
    await expect(proposeEmailAction(w.deps, "PKG", { ...input, compose: { ...compose, to: [MAILBOX] } })).rejects.toMatchObject({ code: "invalid" });
  });
});
