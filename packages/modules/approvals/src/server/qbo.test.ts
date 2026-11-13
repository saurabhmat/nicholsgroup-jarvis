/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// The approvals module for `qbo.disconnect` (T-195) over an in-memory twin of the act.* functions and a fake QuickBooks writer
// and verifier. The SQL is pinned by pgTAP (308_approvals_qbo_disconnect); here: the module's own rules. Synthetic data (rule 10).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@nichols/connectors";
import { QBO_REVOKED_NOT_RECORDED_MESSAGE, QBO_VERIFICATION_MISMATCH_MESSAGE as QBO_VERIFICATION_MESSAGE_FOR_TESTS } from "@nichols/connectors/write";
import type { AuditEntry } from "@nichols/core/audit";
import { createAudit } from "@nichols/core/audit";
import { capabilityOf, isQboDisconnectable } from "./capability";
import { approveAndExecute, editEmailProposal, rejectAction } from "./email";
import { ApprovalsError, QBO_NOT_ENABLED_MESSAGE } from "./errors";
import { approveAndExecuteQbo, executeApprovedQbo, proposeQboDisconnect, qboExternalId, type QboExecDeps } from "./qbo";
import { createQboReconciler } from "./reconcile-qbo";
import { hashOfRow } from "./rows";
import type { CapabilityFacts, Rpc } from "./types";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const ADMIN = "00000000-0000-4000-8000-0000000000a2";
const FINANCE = "00000000-0000-4000-8000-0000000000a3";
const CONN = "00000000-0000-4000-8000-0000000c1951";
const REALM = "9341450000000001";
const TOKEN_CANARY = "synthetic-refresh-token-CANARY";

type Row = Record<string, unknown> & { id: string; status: string; payload: Record<string, unknown>; target: Record<string, unknown> };
type Writer = "ok" | "already_applied" | "unhealthy" | "refused" | "transient" | "plain_throw" | "not_recorded";
type Verifier = "ok" | "mismatch" | "down";

function world(over: { facts?: Partial<CapabilityFacts> | null; writer?: Writer; verifier?: Verifier; markVerifiedThrows?: boolean; claimedApprover?: string } = {}) {
  const rows = new Map<string, Row>();
  const audits: AuditEntry[] = [];
  const calls = { writes: 0, verifies: 0, claims: 0, actions: [] as Record<string, unknown>[] };
  const facts: CapabilityFacts = {
    mailbox: null,
    composeGranted: false,
    writeActionsAllowed: ["qbo_disconnect"],
    approvalsLive: true,
    stepUpMaxAgeS: 300,
    qbo: { realmId: REALM },
    ...over.facts,
  };
  const err = (message: string, code = "P0001") => ({ data: null, error: { code, message } });
  const impl = (fn: string, a: Record<string, unknown>): { data: unknown; error: { code?: string; message?: string } | null } => {
    const get = (id: unknown) => [...rows.values()].find((r) => r.id === id && r.lane_id === a.p_lane);
    switch (fn) {
      case "act_propose": {
        const id = randomUUID();
        const now = new Date().toISOString();
        rows.set(id, {
          id, lane_id: a.p_lane, action_type: a.p_type, connection_id: a.p_connection, provider: "quickbooks", target: structuredClone(a.p_target) as Record<string, unknown>,
          payload: structuredClone(a.p_payload) as Record<string, unknown>, payload_schema_version: a.p_version, payload_sha256: a.p_hash, rationale: null, source_refs: [],
          proposer_kind: a.p_proposer_kind, proposer_user_id: a.p_proposer_user ?? null, derived_from_retrieved: false, supersedes_id: null, superseded_by_id: null,
          status: "proposed", expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(), approved_by: null, approved_at: null, approved_hash: null, executed_at: null,
          verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: now, updated_at: now,
        });
        return { data: id, error: null };
      }
      case "act_get":
        return { data: [get(a.p_id)].filter(Boolean), error: null };
      case "act_approve": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status === "approved") return err("act: already_approved");
        if (r.status !== "proposed") return err("act: not_pending");
        if (a.p_hash_seen !== r.payload_sha256) return err("act: hash_mismatch");
        r.status = "approved";
        r.approved_by = over.claimedApprover ?? ADMIN;
        r.approved_at = new Date().toISOString();
        r.approved_hash = r.payload_sha256;
        return { data: r.payload_sha256, error: null };
      }
      case "act_claim_execution": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status === "executing") return err("act: already_claimed");
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
        return { data: null, error: null };
      }
      case "act_mark_failed": {
        const r = get(a.p_id);
        if (!r || r.status !== "executing") return err("act: not_executing");
        r.status = "failed";
        r.failure_code = a.p_code as string;
        r.failure_outcome = a.p_outcome;
        return { data: null, error: null };
      }
      case "act_action_state": {
        const r = get(a.p_id);
        return { data: r ? [{ status: r.status, failure_code: r.failure_code ?? null }] : [], error: null };
      }
      case "act_reject": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status !== "proposed") return err("act: not_pending");
        r.status = "rejected";
        return { data: null, error: null };
      }
      case "has_lane_role": {
        const roles = a.p_roles as string[];
        const mine = a.p_uid === OWNER ? "owner" : a.p_uid === ADMIN ? "admin_technical" : a.p_uid === FINANCE ? "finance_operator" : "";
        return { data: roles.includes(mine), error: null };
      }
      default:
        return err("unknown function", "42883");
    }
  };
  const rpc: Rpc = async (fn, args) => impl(fn, args);
  const audit = createAudit(async (row) => {
    audits.push({ laneId: row.p_lane_id, actor: row.p_actor_kind === "user" ? { kind: "user", userId: row.p_actor_id ?? "" } : { kind: row.p_actor_kind as "service" }, action: row.p_action, ...(row.p_target ? { target: row.p_target } : {}), metadata: row.p_metadata });
  });
  const deps: QboExecDeps = {
    jobRpc: async () => rpc,
    prepareEmailWrite: async () => { throw new Error("not used"); },
    laneMailboxes: async () => [],
    readFacts: async () => (over.facts === null ? { ...facts, qbo: null } : facts),
    audit,
    loadWriteConnection: async () => ({ id: CONN }) as never,
    writer: {
      async executeWrite(_l, _c, action) {
        calls.writes += 1;
        calls.actions.push({ ...action });
        if (over.writer === "unhealthy") throw new ConnectorError({ kind: "connection_unavailable", message: "QuickBooks did not confirm the revocation; the connection was not disconnected" });
        if (over.writer === "refused") throw new ConnectorError({ kind: "invalid_input", message: "The approved action does not match its approval" });
        if (over.writer === "transient") throw new ConnectorError({ kind: "timeout", message: "timed out" });
        if (over.writer === "plain_throw") throw new Error("socket reset");
        if (over.writer === "not_recorded") throw new ConnectorError({ kind: "transient", message: QBO_REVOKED_NOT_RECORDED_MESSAGE });
        return { outcome: over.writer === "already_applied" ? "already_applied" : "accepted", external_id: null };
      },
    },
    verifier: {
      async verify() {
        calls.verifies += 1;
        if (over.verifier === "mismatch") throw new ConnectorError({ kind: "provider_error", message: QBO_VERIFICATION_MESSAGE_FOR_TESTS });
        if (over.verifier === "down") throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      },
    },
  };
  const ctx = (userId = ADMIN) => ({ laneId: "PKG", userId, rpc });
  return { rows, audits, calls, deps, ctx, rpc, facts };
}

async function proposed(w: ReturnType<typeof world>, userId = ADMIN) {
  const { id, hash } = await proposeQboDisconnect(w.deps, w.ctx(userId), { connectionId: CONN });
  return { id, hash };
}

describe("proposeQboDisconnect", () => {
  it("stores the exact minimal content: target = the realm, payload = {}, a person's proposal, the canonical hash; audits ids and the hash only", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    const row = w.rows.get(id)!;
    expect(row).toMatchObject({ action_type: "qbo.disconnect", target: { realm_id: REALM }, payload: {}, proposer_kind: "user", proposer_user_id: ADMIN, derived_from_retrieved: false, status: "proposed" });
    expect(Object.keys(row.target)).toEqual(["realm_id"]);
    expect(hash).toBe(hashOfRow({ laneId: "PKG", actionType: "qbo.disconnect", connectionId: CONN, target: { realm_id: REALM }, payload: {}, payloadSchemaVersion: 1 }));
    expect(row.payload_sha256).toBe(hash);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ action: "action.proposed", actor: { kind: "user", userId: ADMIN }, target: `action:${id}`, metadata: { action_type: "qbo.disconnect", connection_id: CONN, hash, proposer_kind: "user" } });
    expect(JSON.stringify(w.audits)).not.toContain(REALM);
    expect(w.calls.writes).toBe(0);
  });

  it("owner and admin_technical may propose; a finance_operator and a stranger may not", async () => {
    const w = world();
    await expect(proposeQboDisconnect(w.deps, w.ctx(OWNER), { connectionId: CONN })).resolves.toMatchObject({ id: expect.any(String) });
    await expect(proposeQboDisconnect(w.deps, w.ctx(ADMIN), { connectionId: CONN })).resolves.toMatchObject({ id: expect.any(String) });
    await expect(proposeQboDisconnect(w.deps, w.ctx(FINANCE), { connectionId: CONN })).rejects.toMatchObject({ code: "forbidden" });
    await expect(proposeQboDisconnect(w.deps, w.ctx("00000000-0000-4000-8000-0000000000ff"), { connectionId: CONN })).rejects.toMatchObject({ code: "forbidden" });
    expect(w.rows.size).toBe(2);
  });

  it("a connection that is not this lane's QuickBooks connection (another lane, another provider, disconnected) is not_found and creates nothing", async () => {
    const w = world({ facts: null });
    await expect(proposeQboDisconnect(w.deps, w.ctx(), { connectionId: CONN })).rejects.toMatchObject({ code: "not_found" });
    expect(w.rows.size).toBe(0);
  });

  it("refuses a malformed lane, user or connection id", async () => {
    const w = world();
    await expect(proposeQboDisconnect(w.deps, { ...w.ctx(), laneId: "pkg" }, { connectionId: CONN })).rejects.toMatchObject({ code: "invalid" });
    await expect(proposeQboDisconnect(w.deps, w.ctx(), { connectionId: "not-a-uuid" })).rejects.toMatchObject({ code: "invalid" });
    await expect(proposeQboDisconnect(w.deps, w.ctx("nope"), { connectionId: CONN })).rejects.toMatchObject({ code: "invalid" });
  });

  it("maps the database's refusals (a duplicate pending proposal)", async () => {
    const w = world();
    const failing: QboExecDeps = { ...w.deps, jobRpc: async () => async () => ({ data: null, error: { code: "23505", message: "act: disconnect_already_pending" } }) };
    await expect(proposeQboDisconnect(failing, w.ctx(), { connectionId: CONN })).rejects.toMatchObject({ code: "disconnect_pending" });
  });
});

describe("capability (same gate as email: lane policy class + approvals_live)", () => {
  const cap = (f: Partial<CapabilityFacts>) => capabilityOf("PKG", { mailbox: null, composeGranted: false, writeActionsAllowed: ["qbo_disconnect"], approvalsLive: true, stepUpMaxAgeS: 300, qbo: { realmId: REALM }, ...f }, "qbo.disconnect");
  it("enabled only with a QuickBooks connection, the policy class and approvals_live; not_enabled comes before not_live", () => {
    expect(cap({})).toMatchObject({ enabled: true });
    expect(cap({ writeActionsAllowed: ["email_send"] })).toMatchObject({ enabled: false, reason: "not_enabled", message: QBO_NOT_ENABLED_MESSAGE });
    expect(cap({ qbo: null })).toMatchObject({ enabled: false, reason: "not_enabled" });
    expect(cap({ approvalsLive: false })).toMatchObject({ enabled: false, reason: "not_live" });
    expect(cap({ approvalsLive: false, writeActionsAllowed: [] })).toMatchObject({ reason: "not_enabled" });
    expect(cap({ qbo: undefined as never })).toMatchObject({ enabled: false });
  });
  it("an email policy class does not enable the disconnect", () => {
    expect(cap({ writeActionsAllowed: ["email_send", "email_draft"] }).enabled).toBe(false);
  });
});

describe("the one status list for a disconnect (review L4)", () => {
  it("active, degraded and reconnect_required only", () => {
    for (const ok of ["active", "degraded", "reconnect_required"]) expect(isQboDisconnectable(ok)).toBe(true);
    for (const no of ["pending", "disconnected", "error", ""]) expect(isQboDisconnectable(no)).toBe(false);
  });
});

describe("approveAndExecuteQbo", () => {
  it("approves the exact hash and carries it out once: claim, one revoke, read-back, verified; audits every step", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    const res = await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash });
    expect(res).toEqual({ status: "verified", actionId: id });
    expect(w.calls).toMatchObject({ writes: 1, verifies: 1, claims: 1 });
    const row = w.rows.get(id)!;
    expect(row).toMatchObject({ status: "verified", result: { external_id: qboExternalId(CONN), outcome: "accepted" } });
    expect(w.audits.map((a) => a.action)).toEqual(["action.proposed", "action.approved", "action.execute_started", "action.verified"]);
    expect(JSON.stringify(w.audits)).not.toContain(TOKEN_CANARY);
  });

  it("the writer gets the hash and approver from the claimed row, never from the caller", async () => {
    const w = world({ claimedApprover: OWNER });
    const { id, hash } = await proposed(w, ADMIN);
    await approveAndExecuteQbo(w.deps, w.ctx(ADMIN), { actionId: id, hashSeen: hash });
    const a = w.calls.actions[0]!;
    expect(a.approved_by).toBe(OWNER); // what the database recorded, not the caller (ADMIN)
    expect(a.payload_sha256).toBe(w.rows.get(id)?.payload_sha256);
    expect(a).toMatchObject({ lane_id: "PKG", connection_id: CONN, action_type: "qbo.disconnect", target: { realm_id: REALM }, payload: {}, payload_schema_version: 1 });
  });

  it("an already-applied revoke (Intuit had already dropped the grant) is verified as already_applied", async () => {
    const w = world({ writer: "already_applied" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "verified", actionId: id });
    expect(w.rows.get(id)?.result).toMatchObject({ outcome: "already_applied" });
  });

  it("refuses a hash other than the stored one, before anything is approved or revoked", async () => {
    const w = world();
    const { id } = await proposed(w);
    await expect(approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: "f".repeat(64) })).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(w.rows.get(id)?.status).toBe("proposed");
    expect(w.calls.writes).toBe(0);
    expect(w.audits.at(-1)).toMatchObject({ action: "action.gate_blocked", metadata: { reason: "hash_mismatch" } });
  });

  it("refuses stored content that no longer hashes to the stored hash", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    w.rows.get(id)!.target = { realm_id: "1111111111111111" };
    await expect(approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(w.calls.writes).toBe(0);
  });

  it("a finance_operator cannot approve (role)", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await expect(approveAndExecuteQbo(w.deps, w.ctx(FINANCE), { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "forbidden" });
    expect(w.rows.get(id)?.status).toBe("proposed");
  });

  it("is refused while the lane policy lacks qbo_disconnect (qbo_not_enabled, with the disconnect wording) and while approvals are not live", async () => {
    const a = world({ facts: { writeActionsAllowed: ["email_send"] } });
    const p = await proposed(a);
    const err = await approveAndExecuteQbo(a.deps, a.ctx(), { actionId: p.id, hashSeen: p.hash }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalsError);
    expect(err).toMatchObject({ code: "qbo_not_enabled", message: QBO_NOT_ENABLED_MESSAGE });
    expect(a.rows.get(p.id)?.status).toBe("proposed");
    const b = world({ facts: { approvalsLive: false } });
    const q = await proposed(b);
    await expect(approveAndExecuteQbo(b.deps, b.ctx(), { actionId: q.id, hashSeen: q.hash })).rejects.toMatchObject({ code: "not_live" });
    expect(a.calls.writes + b.calls.writes).toBe(0);
  });

  it("an email row is not handled here, and a qbo row is not handled by the email executor or editor", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    const emailRow = [...w.rows.values()][0]!;
    emailRow.action_type = "email.send";
    await expect(approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "invalid" });
    emailRow.action_type = "qbo.disconnect";
    await expect(approveAndExecute(w.deps as never, w.ctx(), { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "invalid" });
    await expect(editEmailProposal(w.deps, w.ctx(OWNER), id, { subject: "x" })).rejects.toMatchObject({ code: "not_editable" });
    expect(w.calls.writes).toBe(0);
  });

  it("reject works through the shared function", async () => {
    const w = world();
    const { id } = await proposed(w);
    await rejectAction(w.deps, w.ctx(), id, "not now");
    expect(w.rows.get(id)?.status).toBe("rejected");
  });

  it("resumes an approved-but-never-executed action for the same approver and hash, once", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    expect(await approveAndExecuteQbo(w.deps, w.ctx(ADMIN), { actionId: id, hashSeen: hash })).toEqual({ status: "verified", actionId: id });
    expect(w.calls.writes).toBe(1);
    expect(w.audits.map((a) => a.action)).toContain("action.resumed");
    // a different person cannot resume it
    const v = world();
    const q = await proposed(v);
    await v.rpc("act_approve", { p_lane: "PKG", p_id: q.id, p_hash_seen: q.hash });
    await expect(approveAndExecuteQbo(v.deps, v.ctx(OWNER), { actionId: q.id, hashSeen: q.hash })).rejects.toMatchObject({ code: "already_approved" });
    expect(v.calls.writes).toBe(0);
  });
});

describe("executeApprovedQbo: exactly once, and every failure is a terminal, honest state", () => {
  it("a second execute finds the claim taken and does not touch Intuit", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    const [a, b] = await Promise.all([executeApprovedQbo(w.deps, "PKG", id), executeApprovedQbo(w.deps, "PKG", id)]);
    expect([a.status, b.status].sort()).toEqual(["already_in_progress", "verified"]);
    expect(w.calls.writes).toBe(1);
    expect(w.calls.claims).toBe(1);
  });

  it("content changed after approval: failed / payload_changed, no revoke", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    w.rows.get(id)!.target = { realm_id: "1111111111111111" };
    expect(await executeApprovedQbo(w.deps, "PKG", id)).toEqual({ status: "failed", actionId: id, failureCode: "payload_changed" });
    expect(w.calls.writes).toBe(0);
  });

  it("an approved row without a recorded approver is not executed", async () => {
    const w = world({ claimedApprover: "not-a-uuid" });
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    expect(await executeApprovedQbo(w.deps, "PKG", id)).toMatchObject({ status: "failed", failureCode: "payload_changed" });
    expect(w.calls.writes).toBe(0);
  });

  it.each([
    ["unhealthy", "connection_unhealthy", "error"],
    ["refused", "execution_refused", "error"],
    ["transient", "execution_error", "error"],
    ["plain_throw", "execution_error", "error"],
  ] as const)("the revoke fails (%s): failed / %s, outcome %s, the connection stays as it was", async (writer, code, outcome) => {
    const w = world({ writer });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "failed", actionId: id, failureCode: code });
    expect(w.rows.get(id)).toMatchObject({ status: "failed", failure_code: code, failure_outcome: outcome });
    expect(w.calls.verifies).toBe(0);
    expect(w.audits.at(-1)).toMatchObject({ action: "action.failed", metadata: { failure: code, outcome } });
  });

  it("Intuit ended the grant but recording it failed: failed / revoked_not_recorded, outcome unknown (never 'nothing changed')", async () => {
    const w = world({ writer: "not_recorded" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "failed", actionId: id, failureCode: "revoked_not_recorded" });
    expect(w.rows.get(id)?.failure_outcome).toBe("outcome_unknown");
  });

  it("a read-back that finds the connection still connected is failed / verification_mismatch (outcome unknown)", async () => {
    const w = world({ verifier: "mismatch" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "failed", actionId: id, failureCode: "verification_mismatch" });
    expect(w.rows.get(id)?.failure_outcome).toBe("outcome_unknown");
  });

  it("a read-back that cannot run is failed / verification_unavailable (outcome unknown), never a plain failure", async () => {
    const w = world({ verifier: "down" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "failed", actionId: id, failureCode: "verification_unavailable" });
    expect(w.rows.get(id)?.failure_outcome).toBe("outcome_unknown");
  });

  it("a disconnect that was done and read back but could not be recorded is reported as done, never as failed", async () => {
    const w = world({ markVerifiedThrows: true });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "verified", actionId: id });
    expect(w.rows.get(id)?.status).toBe("executing"); // the reconcile sweep finishes it
    expect(w.audits.map((a) => a.action)).toContain("action.record_failed");
  });

  it("the failure audit carries the code only (no provider text, no token)", async () => {
    const w = world({ writer: "unhealthy" });
    const { id, hash } = await proposed(w);
    await approveAndExecuteQbo(w.deps, w.ctx(), { actionId: id, hashSeen: hash });
    expect(JSON.stringify(w.audits)).not.toContain("did not confirm");
  });
});

describe("the reconcile handler (read-only)", () => {
  async function stuck(verifier: Verifier) {
    const w = world({ verifier });
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    await w.rpc("act_claim_execution", { p_lane: "PKG", p_id: id });
    const { toRow } = await import("./rows");
    return { w, row: toRow(w.rows.get(id)) };
  }
  const handler = (w: ReturnType<typeof world>) => createQboReconciler({ verifier: w.deps.verifier, loadWriteConnection: w.deps.loadWriteConnection });

  it("verifies a stuck disconnect once the connection is disconnected", async () => {
    const { w, row } = await stuck("ok");
    expect(await handler(w).decide({ laneId: "PKG", row, claimOutcome: null, claimExternalId: null })).toEqual({ kind: "verified", externalId: qboExternalId(CONN), outcome: "accepted" });
    expect(w.calls.writes).toBe(0);
  });
  it("leaves it undecided while the connection is still connected, or the lookup fails", async () => {
    const a = await stuck("mismatch");
    expect(await handler(a.w).decide({ laneId: "PKG", row: a.row, claimOutcome: null, claimExternalId: null })).toEqual({ kind: "undecided", code: "reconcile_not_disconnected" });
    const b = await stuck("down");
    expect(await handler(b.w).decide({ laneId: "PKG", row: b.row, claimOutcome: null, claimExternalId: null })).toEqual({ kind: "undecided", code: "reconcile_lookup_failed" });
  });
});
