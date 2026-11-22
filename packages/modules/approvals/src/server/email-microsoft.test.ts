// T-262, T-263: the approvals module with BOTH email providers. A lane with a Google and a Microsoft connection executes a Google and a Microsoft proposal each with
// its own writer in the same run; a provider that is no longer enabled for the lane is refused at execute (the body purged, nothing called); the reconciler holds
// only findWrite and verifyWrite and dispatches by the row's provider; the capability message names the provider. In-memory twin of the act.* functions (the SQL is
// pinned by pgTAP 325_approvals_microsoft_email); synthetic data only (rule 10).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// Connections are minted only inside the connectors (lint); a plain object stands for a loaded row and the brand check is stood in for.
vi.mock("@nichols/connectors", async (orig) => ({
  ...(await orig<typeof import("@nichols/connectors")>()),
  assertLaneBound: (laneId: string, c: { lane_id?: string; bound?: boolean }) => {
    if (c.bound !== true || c.lane_id !== laneId) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection was not loaded for this lane" });
  },
}));
import { ConnectorError } from "@nichols/connectors";
import { OUTCOME_UNKNOWN_MESSAGE, VERIFICATION_MISMATCH_MESSAGE, createProviderGate } from "@nichols/connectors/write";
import { createAudit } from "@nichols/core/audit";
import { capabilityOf } from "./capability";
import { createEmailWriteDispatch, type EmailWriteEntry } from "./email-dispatch";
import { executeApproved } from "./email";
import { NOT_ENABLED_MESSAGE, NOT_ENABLED_MICROSOFT_MESSAGE } from "./errors";
import { createEmailReconciler } from "./reconcile-email";
import { hashOfRow } from "./rows";
import type { ApprovalsDeps, CapabilityFacts, Rpc } from "./types";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const G = "00000000-0000-4000-8000-000000000e01";
const M = "00000000-0000-4000-8000-000000000e02";
const CANARY = "BODY-CANARY-microsoft-5d2e-not-real";

const conn = (id: string, provider: string) => ({ bound: true, id, lane_id: "PKG", provider, external_account_id: `${provider}-box@example.test`, status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: OWNER }) as never;

function world(providers: ("google" | "microsoft")[], over: { microsoft?: "ok" | "unknown" | "mismatch" } = {}) {
  /** While true the read-back of that provider answers not_found (the copy is not visible yet). */
  const notFound = { google: false, microsoft: false };
  const rows = new Map<string, Record<string, unknown> & { id: string; status: string; payload: Record<string, unknown> }>();
  const log: string[] = [];
  const purge = (r: { payload: Record<string, unknown> } & Record<string, unknown>) => {
    delete r.payload.bodyText;
    r.payload_purged_at = new Date().toISOString();
  };
  const err = (message: string, code = "P0001") => ({ data: null, error: { code, message } });
  const rpc: Rpc = async (fn, a) => {
    const r = [...rows.values()].find((x) => x.id === a.p_id);
    switch (fn) {
      case "act_claim_execution":
        if (!r || r.status !== "approved") return err("act: not_approved");
        r.status = "executing";
        return { data: structuredClone(r), error: null };
      case "act_claim_sent":
        return { data: null, error: null };
      case "act_mark_verified":
        if (!r) return err("act: not_found", "P0002");
        r.status = "verified";
        purge(r as never);
        return { data: null, error: null };
      case "act_mark_failed":
        if (!r) return err("act: not_found", "P0002");
        r.status = "failed";
        r.failure_code = a.p_code;
        purge(r as never);
        return { data: null, error: null };
      case "act_action_state":
        return { data: r ? [{ status: r.status, failure_code: r.failure_code ?? null }] : [], error: null };
      default:
        return err("unknown function", "42883");
    }
  };
  const spy = (p: string): EmailWriteEntry => ({
    actionTypes: ["email.send", "email.save_draft"],
    ...(p === "microsoft" ? { sentCopyMayLagDeclared: true } : {}),
    async executeWrite(_l, c, action) {
      log.push(`${p}:execute:${c.id}:${action.id}`);
      if (p === "microsoft" && over.microsoft === "unknown") throw new ConnectorError({ kind: "provider_error", message: OUTCOME_UNKNOWN_MESSAGE });
      return { outcome: "accepted", external_id: `${p}-msg`, executed_at: new Date().toISOString(), provider_tid: null };
    },
    async verifyWrite(_l, c) {
      log.push(`${p}:verify:${c.id}`);
      if (notFound[p as "google" | "microsoft"]) throw new ConnectorError({ kind: "not_found", message: "The message was not found in the mailbox" });
      if (p === "microsoft" && over.microsoft === "mismatch") throw new ConnectorError({ kind: "provider_error", message: VERIFICATION_MISMATCH_MESSAGE });
    },
    async findWrite(_l, c) {
      log.push(`${p}:find:${c.id}`);
      return [`${p}-msg`];
    },
  });
  const settings = { providers, microsoft: providers.includes("microsoft") ? { cloud: "commercial" as const, tenantIds: [], allowGcc: false, mailFolders: [], calendarIds: null } : null };
  const gate = createProviderGate({ laneConfig: { mailProviderSettings: async () => settings } as never });
  const dispatch = createEmailWriteDispatch({ loader: { async loadConnection(_l, id) { return conn(id, id === G ? "google" : "microsoft"); } }, gate, entries: { google: spy("google"), microsoft: spy("microsoft") } });
  const audit = createAudit(async () => undefined);
  const deps: ApprovalsDeps = {
    jobRpc: async () => rpc,
    prepareEmailWrite: async () => { throw new Error("not used"); },
    laneMailboxes: async () => [],
    mailboxAllowed: async () => true,
    readFacts: async () => ({ mailbox: null, composeGranted: false, writeActionsAllowed: [], approvalsLive: true, stepUpMaxAgeS: 300 }),
    loadWriteConnection: dispatch.loadWriteConnection,
    writer: dispatch.writer,
    audit,
  };
  const approved = (connectionId: string, type: "email.send" | "email.save_draft" = "email.send") => {
    const id = randomUUID();
    const mailbox = `${connectionId === G ? "google" : "microsoft"}-box@example.test`;
    const base = { laneId: "PKG", actionType: type, connectionId, target: { mailbox }, payload: { fromMailbox: mailbox, to: ["dana@sender.example.test"], cc: [], bcc: [], subject: "Quarterly update", bodyText: `Thanks Dana. ${CANARY}` }, payloadSchemaVersion: 1 };
    const hash = hashOfRow(base as never);
    rows.set(id, { id, lane_id: "PKG", action_type: type, connection_id: connectionId, provider: connectionId === G ? "google" : "microsoft", target: base.target, payload: base.payload, payload_schema_version: 1, payload_sha256: hash, rationale: null, source_refs: [], proposer_kind: "user", proposer_user_id: OWNER, derived_from_retrieved: false, supersedes_id: null, superseded_by_id: null, status: "approved", expires_at: new Date(Date.now() + 3600_000).toISOString(), approved_by: OWNER, approved_at: new Date().toISOString(), approved_hash: hash, executed_at: null, verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return id;
  };
  return { deps, rows, log, dispatch, approved, notFound };
}

describe("two providers in one lane", () => {
  it("a Google and a Microsoft proposal are executed in the same run, each by its own writer, and each body is purged when it is verified", async () => {
    const w = world(["google", "microsoft"]);
    const g = w.approved(G);
    const m = w.approved(M, "email.save_draft");
    const results = await Promise.all([executeApproved(w.deps, "PKG", g), executeApproved(w.deps, "PKG", m)]);
    expect(results).toEqual([{ status: "verified", actionId: g }, { status: "verified", actionId: m }]);
    expect(w.log.filter((x) => x.includes(":execute:")).sort()).toEqual([`google:execute:${G}:${g}`, `microsoft:execute:${M}:${m}`].sort());
    expect(w.log).toContain(`google:verify:${G}`);
    expect(w.log).toContain(`microsoft:verify:${M}`);
    for (const id of [g, m]) {
      expect(w.rows.get(id)?.payload.bodyText).toBeUndefined();
      expect(w.rows.get(id)?.payload_purged_at).not.toBeNull();
    }
  });

  it.each([
    ["Microsoft is no longer enabled (only Google)", ["google"] as const, M],
    ["Google is no longer enabled (only Microsoft)", ["microsoft"] as const, G],
  ])("%s: the action is refused at execute (connection_unavailable family), the body is purged, nothing is called", async (_n, providers, conn) => {
    const w = world([...providers]);
    const id = w.approved(conn);
    const r = await executeApproved(w.deps, "PKG", id);
    expect(r).toMatchObject({ status: "failed", failureCode: "connection_unhealthy" });
    expect(w.log).toEqual([]);
    expect(w.rows.get(id)?.status).toBe("failed");
    expect(w.rows.get(id)?.payload.bodyText).toBeUndefined();
    expect(JSON.stringify(w.rows.get(id))).not.toContain(CANARY);
  });

  it("the body is purged on every terminal state of a Microsoft action: unknown outcome and read-back mismatch too", async () => {
    for (const microsoft of ["unknown", "mismatch"] as const) {
      const w = world(["google", "microsoft"], { microsoft });
      const id = w.approved(M);
      const r = await executeApproved(w.deps, "PKG", id);
      expect(r.status).toBe("failed");
      expect(w.rows.get(id)?.failure_code).toBe(microsoft === "unknown" ? "outcome_unknown" : "verification_mismatch");
      expect(JSON.stringify(w.rows.get(id))).not.toContain(CANARY);
    }
  });
});

describe("an accepted send whose copy is not visible yet (security M2)", () => {
  it("a Microsoft send: the row stays executing with its claim at sent (not failed, not purged), and the reconciler verifies it once the copy shows; sent once", async () => {
    const w = world(["google", "microsoft"]);
    w.notFound.microsoft = true;
    const id = w.approved(M);
    const r = await executeApproved(w.deps, "PKG", id);
    expect(r).toEqual({ status: "sent_unverified", actionId: id });
    expect(w.rows.get(id)?.status).toBe("executing");
    expect(w.rows.get(id)?.failure_code ?? null).toBeNull();
    expect(w.log.filter((x) => x.includes(":execute:"))).toHaveLength(1);
    const handler = createEmailReconciler({ reconciler: { findWrite: w.dispatch.writer.findWrite, verifyWrite: w.dispatch.writer.verifyWrite }, loadWriteConnection: w.dispatch.loadWriteConnection });
    const row = { id, connectionId: M, approvedBy: OWNER, payloadSha256: w.rows.get(id)?.payload_sha256, payloadSchemaVersion: 1, actionType: "email.send", payload: w.rows.get(id)?.payload, target: w.rows.get(id)?.target };
    const still = await handler.decide({ laneId: "PKG", row: row as never, claimOutcome: "sent", claimExternalId: "microsoft-msg" } as never);
    expect(still).toMatchObject({ kind: "undecided", sentUnverified: true }); // the sweep's own give-up then ends it as "sent, not read back"
    w.notFound.microsoft = false;
    const done = await handler.decide({ laneId: "PKG", row: row as never, claimOutcome: "sent", claimExternalId: "microsoft-msg" } as never);
    expect(done).toMatchObject({ kind: "verified", externalId: "microsoft-msg", outcome: "accepted" });
    expect(w.log.filter((x) => x.includes(":execute:"))).toHaveLength(1);
  });

  it("a draft is not a send (not_found at read-back is a failure), and a Google row behaves as before (verification_unavailable, body purged)", async () => {
    const w = world(["google", "microsoft"]);
    w.notFound.microsoft = true;
    w.notFound.google = true;
    const d = w.approved(M, "email.save_draft");
    expect(await executeApproved(w.deps, "PKG", d)).toMatchObject({ status: "failed", failureCode: "verification_unavailable" });
    const g = w.approved(G);
    expect(await executeApproved(w.deps, "PKG", g)).toMatchObject({ status: "failed", failureCode: "verification_unavailable" });
    expect(w.rows.get(g)?.payload.bodyText).toBeUndefined();
  });
});

describe("the reconciler (action.reconcile_stuck) for a Microsoft action", () => {
  it("holds only findWrite and verifyWrite, and dispatches them by the action's connection provider", async () => {
    const w = world(["google", "microsoft"]);
    const reconciler = Object.freeze({ findWrite: w.dispatch.writer.findWrite, verifyWrite: w.dispatch.writer.verifyWrite });
    expect(Object.keys(reconciler).sort()).toEqual(["findWrite", "verifyWrite"]);
    const handler = createEmailReconciler({ reconciler, loadWriteConnection: w.dispatch.loadWriteConnection });
    const id = w.approved(M);
    const row = { ...(w.rows.get(id) as object), connectionId: M, approvedBy: OWNER, payloadSha256: w.rows.get(id)?.payload_sha256, payloadSchemaVersion: 1, actionType: "email.send", payload: w.rows.get(id)?.payload, target: w.rows.get(id)?.target, id };
    const d = await handler.decide({ laneId: "PKG", row: row as never, claimOutcome: null, claimExternalId: null } as never);
    expect(d).toMatchObject({ kind: "verified", externalId: "microsoft-msg", outcome: "already_applied" });
    expect(w.log).toEqual([`microsoft:find:${M}`, `microsoft:verify:${M}`]);
    expect(w.log.some((x) => x.includes("execute"))).toBe(false);
  });
});

describe("capability message names the provider's own reconnect", () => {
  const facts = (over: Partial<CapabilityFacts>): CapabilityFacts => ({ mailbox: "x@example.test", composeGranted: true, writeActionsAllowed: ["email_send", "email_draft"], approvalsLive: true, stepUpMaxAgeS: 300, ...over });
  it("a Microsoft mailbox without the write grant says Reconnect Microsoft; a Google one is unchanged", () => {
    expect(capabilityOf("PKG", facts({ provider: "microsoft", composeGranted: false }), "email.send")).toMatchObject({ enabled: false, reason: "not_enabled", message: NOT_ENABLED_MICROSOFT_MESSAGE });
    expect(capabilityOf("PKG", facts({ provider: "google", composeGranted: false }), "email.send")).toMatchObject({ enabled: false, message: NOT_ENABLED_MESSAGE });
    expect(capabilityOf("PKG", facts({}), "email.send")).toMatchObject({ enabled: true });
    expect(capabilityOf("PKG", facts({ provider: "microsoft" }), "email.save_draft")).toMatchObject({ enabled: true });
    expect(capabilityOf("PKG", facts({ provider: "microsoft", writeActionsAllowed: [] }), "email.send")).toMatchObject({ enabled: false, message: NOT_ENABLED_MICROSOFT_MESSAGE });
  });
});

describe("no Google wording for a Microsoft mailbox", () => {
  it("approving on a Microsoft mailbox that cannot send says Reconnect Microsoft (capability gate and the database's connection_not_enabled); a Google one keeps its text", async () => {
    const mk = (provider: "google" | "microsoft", dbRefuses: boolean) => {
      const w = world(["google", "microsoft"]);
      const id = w.approved(provider === "google" ? G : M);
      const row = w.rows.get(id) as Record<string, unknown>;
      row.status = "proposed";
      const ctxRpc: Rpc = async (fn) => {
        if (fn === "act_get") return { data: [structuredClone(row)], error: null };
        if (fn === "act_approve" && dbRefuses) return { data: null, error: { code: "P0001", message: "act: connection_not_enabled" } };
        return { data: null, error: { code: "42883", message: "unknown" } };
      };
      const deps = { ...w.deps, readFacts: async () => ({ mailbox: "x@example.test", provider, composeGranted: dbRefuses, writeActionsAllowed: ["email_send", "email_draft"], approvalsLive: true, stepUpMaxAgeS: 300 }) as CapabilityFacts };
      return { deps, ctx: { laneId: "PKG", userId: OWNER, rpc: ctxRpc }, id, hash: String(row.payload_sha256) };
    };
    const { approveAndExecute } = await import("./email");
    for (const dbRefuses of [false, true]) {
      const m = mk("microsoft", dbRefuses);
      await expect(approveAndExecute(m.deps as never, m.ctx as never, { actionId: m.id, hashSeen: m.hash })).rejects.toMatchObject({ code: "not_enabled", message: NOT_ENABLED_MICROSOFT_MESSAGE });
    }
    const g = mk("google", false);
    await expect(approveAndExecute(g.deps as never, g.ctx as never, { actionId: g.id, hashSeen: g.hash })).rejects.toMatchObject({ code: "not_enabled", message: NOT_ENABLED_MESSAGE });
  });
});
