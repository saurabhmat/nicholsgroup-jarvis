// action.reconcile_stuck (T-192) over an in-memory twin of the three act.* functions it may call (the SQL itself is pinned by
// pgTAP 291_approvals_reconcile) and a fake mailbox. Synthetic data only (rule 10).
// The crash scenario: the send was accepted by the provider and the process died before recording anything. The sweep must
// find the message by its marker and verify it, never send again (the fake mailbox counts every write; the reconciler's
// interface has no write method at all) and never take a second claim.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@nichols/connectors";
import { VERIFICATION_MISMATCH_MESSAGE, type GoogleEmailReconciler } from "@nichols/connectors/write";
import { createAudit, type AuditEntry } from "@nichols/core/audit";
import { RECONCILE_BATCH, reconcileStuckActions, type ActionReconciler, type ReconcileDeps } from "./reconcile";
import { createEmailReconciler } from "./reconcile-email";
import { hashOfRow } from "./rows";
import type { Rpc } from "./types";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const CONN = "00000000-0000-4000-8000-000000002901";
const MAILBOX = "exec@pubkgroup.example.test";
const MIN = 60_000;

type Claim = { outcome: string | null; external_id: string | null };
type Row = Record<string, unknown> & { id: string; lane_id: string; status: string; payload: Record<string, unknown> };

function build(over: { after?: number; giveUp?: number } = {}) {
  const after = over.after ?? 10;
  const giveUp = over.giveUp ?? 60;
  const rows = new Map<string, Row>();
  const claims = new Map<string, Claim>();
  const started = new Map<string, number>(); // executing since (ms)
  const rpcCalls: string[] = [];
  const audits: AuditEntry[] = [];
  const history: { id: string; reason: string }[] = [];
  const spy = { beforeApply: undefined as undefined | ((fn: string, id: string) => void) };

  /** A mailbox with a write counter: only a (simulated) execute may call `send`. */
  const mailbox = {
    sends: 0,
    messages: new Map<string, { marker: string; matches: boolean }>(),
    send(actionId: string, matches = true) {
      this.sends += 1;
      const id = `gmail-${String(this.sends)}`;
      this.messages.set(id, { marker: actionId, matches });
      return id;
    },
  };
  const finder = { error: null as unknown, lag: false, dup: false, verifyError: null as unknown };
  const reconciler: GoogleEmailReconciler = {
    async findWrite(_lane, _conn, action) {
      if (finder.error) throw finder.error;
      if (finder.lag) return [];
      const ids = [...mailbox.messages.entries()].filter(([, m]) => m.marker === action.id).map(([id]) => id);
      return finder.dup && ids[0] ? [ids[0], `${ids[0]}-copy`] : ids;
    },
    async verifyWrite(_lane, _conn, action, externalId) {
      if (finder.verifyError) throw finder.verifyError;
      const m = mailbox.messages.get(externalId) ?? (externalId.endsWith("-copy") ? mailbox.messages.get(externalId.slice(0, -5)) : undefined);
      if (!m) throw new ConnectorError({ kind: "not_found", message: "no" });
      if (m.marker !== action.id || !m.matches) throw new ConnectorError({ kind: "provider_error", message: VERIFICATION_MISMATCH_MESSAGE });
    },
  };

  const addExecuting = (o: { lane?: string; ageMin: number; claim?: Claim; type?: string; tamper?: boolean } ): Row => {
    const lane = o.lane ?? "PKG";
    const id = randomUUID();
    const payload = { fromMailbox: MAILBOX, to: ["dana@sender.example.test"], cc: [], bcc: [], subject: "Quarterly update", bodyText: "BODY-CANARY-not-real" };
    const target = { mailbox: MAILBOX };
    const type = (o.type ?? "email.send") as "email.send";
    const hash = hashOfRow({ laneId: lane, actionType: type, connectionId: CONN, target, payload, payloadSchemaVersion: 1 });
    const now = new Date().toISOString();
    const row: Row = {
      id, lane_id: lane, action_type: type, connection_id: CONN, provider: "google", target, payload: o.tamper ? { ...payload, subject: "Changed" } : payload,
      payload_schema_version: 1, payload_sha256: hash, rationale: null, source_refs: [], proposer_kind: "job", proposer_user_id: OWNER,
      derived_from_retrieved: true, supersedes_id: null, superseded_by_id: null, status: "executing", expires_at: now, approved_by: OWNER,
      approved_at: now, approved_hash: hash, executed_at: null, verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: now, updated_at: now,
    };
    rows.set(id, row);
    claims.set(id, o.claim ?? { outcome: null, external_id: null });
    started.set(id, Date.now() - o.ageMin * MIN);
    return row;
  };

  const purge = (r: Row) => {
    delete r.payload.bodyText;
    r.payload_purged_at = new Date().toISOString();
  };
  const due = (id: string) => Date.now() - (started.get(id) ?? Date.now()) >= after * MIN;

  const impl = (fn: string, a: Record<string, unknown>) => {
    rpcCalls.push(fn);
    switch (fn) {
      case "act_stuck_actions": {
        const list = [...rows.values()]
          .filter((r) => r.lane_id === a.p_lane && r.status === "executing" && due(r.id))
          .sort((x, y) => (started.get(x.id) ?? 0) - (started.get(y.id) ?? 0))
          .slice(0, Number(a.p_limit))
          .map((r) => ({
            action: structuredClone(r),
            claim_outcome: claims.get(r.id)?.outcome ?? null,
            claim_external_id: claims.get(r.id)?.external_id ?? null,
            age_s: Math.floor((Date.now() - (started.get(r.id) ?? 0)) / 1000),
            give_up: Date.now() - (started.get(r.id) ?? 0) >= giveUp * MIN,
          }));
        return { data: list, error: null };
      }
      case "act_reconcile_verified":
      case "act_reconcile_failed": {
        spy.beforeApply?.(fn, String(a.p_id));
        const r = rows.get(String(a.p_id));
        if (!r || r.lane_id !== a.p_lane || r.status !== "executing" || !due(r.id)) return { data: false, error: null };
        const claim = claims.get(r.id);
        if (!claim) return { data: null, error: { code: "P0001", message: "act: no claim" } };
        if (fn === "act_reconcile_verified") {
          r.status = "verified";
          r.result = { external_id: a.p_external_id, outcome: a.p_outcome, reconciled: true };
          claim.outcome = "verified";
          claim.external_id = claim.external_id ?? (a.p_external_id as string);
          history.push({ id: r.id, reason: "reconciler: verified by read-back" });
        } else {
          r.status = "failed";
          r.failure_code = a.p_code as string;
          claim.outcome = a.p_outcome as string;
          history.push({ id: r.id, reason: `reconciler: failed: ${String(a.p_code)}` });
        }
        purge(r);
        return { data: true, error: null };
      }
      default:
        return { data: null, error: { code: "42883", message: "unknown function" } };
    }
  };
  const rpc: Rpc = async (fn, args) => impl(fn, args);
  const audit = createAudit(async (row) => {
    audits.push({ laneId: row.p_lane_id, actor: { kind: row.p_actor_kind as "service" }, action: row.p_action, ...(row.p_target ? { target: row.p_target } : {}), metadata: row.p_metadata });
  });
  const loadWriteConnection = vi.fn(async () => ({ id: CONN }) as never);
  const deps: ReconcileDeps = { jobRpc: async () => rpc, audit, reconcilers: [createEmailReconciler({ reconciler, loadWriteConnection })] };
  return { rows, claims, mailbox, finder, deps, audits, history, rpcCalls, addExecuting, spy, loadWriteConnection, impl, started };
}

describe("action.reconcile_stuck: verify, never re-send", () => {
  it("crash after the provider accepted the send: the marker is found, the action is verified, nothing is sent again, no second claim", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 30 }); // claim taken, send accepted, process died: the claim never recorded the id
    w.mailbox.send(row.id);
    expect(w.mailbox.sends).toBe(1);
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum).toMatchObject({ checked: 1, verified: 1, failed: 0, errors: 0 });
    expect(row.status).toBe("verified");
    expect(row.result).toEqual({ external_id: "gmail-1", outcome: "already_applied", reconciled: true });
    expect(w.mailbox.sends).toBe(1); // zero writes by the reconciler
    expect(w.claims.size).toBe(1);
    expect(w.rpcCalls.filter((f) => !["act_stuck_actions", "act_reconcile_verified", "act_reconcile_failed"].includes(f))).toEqual([]); // never act_claim_execution
    expect(row.payload.bodyText).toBeUndefined(); // D-19: purged with the terminal transition
    expect(w.history).toEqual([{ id: row.id, reason: "reconciler: verified by read-back" }]);
    expect(w.audits.map((a) => [a.action, a.actor.kind, a.metadata?.by, a.target])).toEqual([["action.verified", "service", "reconciler", `action:${row.id}`]]);
    expect(JSON.stringify(w.audits)).not.toContain("BODY-CANARY");
  });

  it("the id was recorded (sent) but recording the result failed: read back by that id, verified as accepted", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 15 });
    const id = w.mailbox.send(row.id);
    w.claims.set(row.id, { outcome: "sent", external_id: id });
    w.finder.lag = true; // the search is not consulted at all when the id is known
    await reconcileStuckActions(w.deps, "PKG");
    expect(row.status).toBe("verified");
    expect(row.result).toMatchObject({ external_id: id, outcome: "accepted" });
  });

  it("the threshold: an action executing for less than N minutes is not touched (an execute may still be running)", async () => {
    const w = build({ after: 10 });
    const young = w.addExecuting({ ageMin: 9 });
    w.mailbox.send(young.id);
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum.checked).toBe(0);
    expect(young.status).toBe("executing");
    expect(w.loadWriteConnection).not.toHaveBeenCalled();
    const w2 = build({ after: 5 });
    const r = w2.addExecuting({ ageMin: 6 });
    w2.mailbox.send(r.id);
    await reconcileStuckActions(w2.deps, "PKG");
    expect(r.status).toBe("verified");
  });

  it("not found, before the give-up time: nothing is concluded (Gmail search can lag); the action stays executing and is not audited", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 20 });
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum).toMatchObject({ checked: 1, undecided: 1, verified: 0, failed: 0 });
    expect(row.status).toBe("executing");
    expect(row.payload.bodyText).toBeDefined();
    expect(w.rpcCalls).toEqual(["act_stuck_actions"]);
    expect(w.audits).toEqual([]);
    // The message shows up (search lag over): the next sweep verifies it.
    w.mailbox.send(row.id);
    await reconcileStuckActions(w.deps, "PKG");
    expect(row.status).toBe("verified");
  });

  it("not found after the give-up time: failed / outcome_unknown for a human, never a send", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 90 });
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum).toMatchObject({ failed: 1 });
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe("marker_not_found");
    expect(w.claims.get(row.id)?.outcome).toBe("outcome_unknown");
    expect(w.mailbox.sends).toBe(0);
    expect(row.payload.bodyText).toBeUndefined();
    expect(w.audits.map((a) => [a.action, a.metadata?.failure, a.metadata?.outcome, a.metadata?.by])).toEqual([["action.failed", "marker_not_found", "outcome_unknown", "reconciler"]]);
    expect(w.history[0]?.reason).toBe("reconciler: failed: marker_not_found");
  });

  it.each([
    ["a lookup error", new ConnectorError({ kind: "timeout", message: "t" }), "reconcile_lookup_failed"],
    ["an unhealthy connection", new ConnectorError({ kind: "reconnect_required", message: "r" }), "reconcile_connection_unhealthy"],
    ["a missing scope", new ConnectorError({ kind: "forbidden", message: "f" }), "reconcile_scope_missing"],
  ])("%s is undecided, then failed / outcome_unknown after the give-up time", async (_n, error, code) => {
    const w = build();
    const early = w.addExecuting({ ageMin: 20 });
    const late = w.addExecuting({ ageMin: 80 });
    w.mailbox.send(early.id);
    w.mailbox.send(late.id);
    w.finder.error = error;
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum).toMatchObject({ checked: 2, undecided: 1, failed: 1 });
    expect(early.status).toBe("executing");
    expect(late.status).toBe("failed");
    expect(late.failure_code).toBe(code);
    expect(w.claims.get(late.id)?.outcome).toBe("outcome_unknown");
    expect(w.mailbox.sends).toBe(2);
  });

  it("a connection that cannot be loaded is undecided (never a failure of the send)", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 20 });
    w.loadWriteConnection.mockRejectedValueOnce(new ConnectorError({ kind: "connection_unavailable", message: "gone" }));
    await reconcileStuckActions(w.deps, "PKG");
    expect(row.status).toBe("executing");
  });

  it("a message that does not match the approved payload ends failed / verification_mismatch at once", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 12 });
    w.mailbox.send(row.id, false);
    await reconcileStuckActions(w.deps, "PKG");
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe("verification_mismatch");
    expect(w.claims.get(row.id)?.outcome).toBe("mismatch");
  });

  it("two matching messages are ambiguous: failed / outcome_unknown at once", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 12 });
    w.mailbox.send(row.id);
    w.finder.dup = true;
    await reconcileStuckActions(w.deps, "PKG");
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe("ambiguous_match");
    expect(w.claims.get(row.id)?.outcome).toBe("outcome_unknown");
  });

  it("stored content that no longer hashes to the approved hash is failed (reconcile_payload_changed) without any provider call", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 12, tamper: true });
    await reconcileStuckActions(w.deps, "PKG");
    expect(row.failure_code).toBe("reconcile_payload_changed");
    expect(w.loadWriteConnection).not.toHaveBeenCalled();
  });

  it("an action type with no handler is never concluded 'not sent'", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 20 });
    const deps: ReconcileDeps = { ...w.deps, reconcilers: [] };
    await reconcileStuckActions(deps, "PKG");
    expect(row.status).toBe("executing");
    const late = w.addExecuting({ ageMin: 90 });
    await reconcileStuckActions(deps, "PKG");
    expect(late.failure_code).toBe("reconcile_unsupported");
    expect(w.claims.get(late.id)?.outcome).toBe("outcome_unknown");
  });

  it("dispatches by action type (another handler plugs in beside email)", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 20 });
    const other: ActionReconciler = { actionTypes: ["email.send"], decide: vi.fn(async () => ({ kind: "verified" as const, externalId: "x-1", outcome: "already_applied" as const })) };
    await reconcileStuckActions({ ...w.deps, reconcilers: [other] }, "PKG");
    expect(other.decide).toHaveBeenCalledOnce();
    expect(row.status).toBe("verified");
  });
});

describe("action.reconcile_stuck: idempotent and concurrency-safe", () => {
  it("a rerun after the work is done changes nothing and audits nothing more", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 30 });
    w.mailbox.send(row.id);
    await reconcileStuckActions(w.deps, "PKG");
    const auditCount = w.audits.length;
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum.checked).toBe(0);
    expect(w.audits).toHaveLength(auditCount);
    expect(w.history).toHaveLength(1);
    expect(w.mailbox.sends).toBe(1);
  });

  it("two sweeps at the same time make exactly one transition and one audit entry", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 30 });
    w.mailbox.send(row.id);
    const [a, b] = await Promise.all([reconcileStuckActions(w.deps, "PKG"), reconcileStuckActions(w.deps, "PKG")]);
    expect(a.verified + b.verified).toBe(1);
    expect(a.unchanged + b.unchanged).toBe(1);
    expect(w.history).toHaveLength(1);
    expect(w.audits.filter((x) => x.action === "action.verified")).toHaveLength(1);
  });

  it("a late-finishing execute that wins the race: the sweep's transition is refused (false) and nothing is audited", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 30 });
    w.mailbox.send(row.id);
    w.spy.beforeApply = (_fn, id) => {
      const r = w.rows.get(id);
      if (r) {
        r.status = "verified"; // the original execute recorded its result between the lookup and the transition
        r.result = { external_id: "gmail-1", outcome: "accepted" };
      }
    };
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum).toMatchObject({ verified: 0, unchanged: 1 });
    expect(row.result).toEqual({ external_id: "gmail-1", outcome: "accepted" });
    expect(w.audits).toEqual([]);
    expect(w.history).toEqual([]);
  });

  it("one action failing never stops the others; the error names ids only", async () => {
    const w = build();
    const bad = w.addExecuting({ ageMin: 40 });
    const good = w.addExecuting({ ageMin: 30 });
    w.mailbox.send(good.id);
    const orig = w.impl;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps: ReconcileDeps = {
      ...w.deps,
      jobRpc: async () => async (fn, args) => (fn === "act_reconcile_failed" || (fn === "act_reconcile_verified" && args.p_id === bad.id) ? { data: null, error: { code: "XX000", message: "db hiccup BODY-CANARY" } } : orig(fn, args)),
    };
    const sum = await reconcileStuckActions({ ...deps, reconcilers: [{ actionTypes: ["email.send"], decide: async ({ row }) => (row.id === bad.id ? { kind: "verified", externalId: "x", outcome: "accepted" } : { kind: "verified", externalId: "gmail-1", outcome: "already_applied" }) }] }, "PKG");
    expect(sum).toMatchObject({ checked: 2, errors: 1, verified: 1 });
    expect(good.status).toBe("verified");
    expect(bad.status).toBe("executing");
    expect(JSON.stringify(err.mock.calls)).not.toContain("BODY-CANARY");
    err.mockRestore();
  });

  it("a failing audit write is logged and does not undo or repeat the transition", async () => {
    const w = build();
    const row = w.addExecuting({ ageMin: 30 });
    w.mailbox.send(row.id);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps: ReconcileDeps = { ...w.deps, audit: createAudit(async () => { throw new Error("audit down"); }) };
    const sum = await reconcileStuckActions(deps, "PKG");
    expect(sum.verified).toBe(1);
    expect(row.status).toBe("verified");
    err.mockRestore();
  });

  it("batches (at most RECONCILE_BATCH per sweep and lane); the rest wait for the next run", async () => {
    const w = build();
    for (let i = 0; i < RECONCILE_BATCH + 5; i += 1) w.mailbox.send(w.addExecuting({ ageMin: 30 + i }).id);
    const first = await reconcileStuckActions(w.deps, "PKG");
    expect(first.checked).toBe(RECONCILE_BATCH);
    const second = await reconcileStuckActions(w.deps, "PKG");
    expect(second.checked).toBe(5);
    expect(w.mailbox.sends).toBe(RECONCILE_BATCH + 5);
  });
});

describe("action.reconcile_stuck: lanes", () => {
  it("a sweep of one lane never touches another lane's action, and passes only its own lane", async () => {
    const w = build();
    const pkg = w.addExecuting({ ageMin: 30 });
    const apk = w.addExecuting({ lane: "APK", ageMin: 30 });
    w.mailbox.send(pkg.id);
    w.mailbox.send(apk.id);
    const sum = await reconcileStuckActions(w.deps, "PKG");
    expect(sum).toMatchObject({ lane: "PKG", checked: 1, verified: 1 });
    expect(apk.status).toBe("executing");
    expect(w.loadWriteConnection).toHaveBeenCalledWith("PKG", CONN);
  });

  it("a row of another lane in the list is skipped (defence in depth)", async () => {
    const w = build();
    const apk = w.addExecuting({ lane: "APK", ageMin: 30 });
    w.mailbox.send(apk.id);
    const deps: ReconcileDeps = { ...w.deps, jobRpc: async () => async (fn, args) => w.impl(fn, fn === "act_stuck_actions" ? { ...args, p_lane: "APK" } : args) };
    const sum = await reconcileStuckActions(deps, "PKG");
    expect(sum).toMatchObject({ checked: 1, unchanged: 1, verified: 0 });
    expect(apk.status).toBe("executing");
  });

  it("refuses an invalid lane id", async () => {
    const w = build();
    await expect(reconcileStuckActions(w.deps, "pkg' or 1=1" as never)).rejects.toThrow("invalid lane");
  });

  it("an unreadable list is an error (nothing concluded)", async () => {
    const w = build();
    await expect(reconcileStuckActions({ ...w.deps, jobRpc: async () => async () => ({ data: null, error: { message: "down" } }) }, "PKG")).rejects.toThrow("list unavailable");
  });
});
