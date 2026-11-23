/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// The approvals module for Teams messages (T-286, T-287) over an in-memory twin of the act.* functions and a fake Teams writer. The SQL is pinned by pgTAP (330_approvals_teams) and the writer by
// connectors/src/teams/writer.test.ts; here: the module's own rules (what is proposed, hashed, audited, executed once, how each outcome ends, what is reconciled). Synthetic data (rule 10).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@nichols/connectors";
import { TEAMS_SEND_FAILURES } from "@nichols/connectors/write";
import type { AuditEntry } from "@nichols/core/audit";
import { createAudit } from "@nichols/core/audit";
import { capabilityOf } from "./capability";
import { rejectAction } from "./email";
import { createTeamsReconciler } from "./reconcile-teams";
import { reconcileStuckActions } from "./reconcile";
import { hashOfRow } from "./rows";
import { approveAndExecuteTeams, buildTeamsSend, executeApprovedTeams, proposeTeamsAction, type ProposeTeamsInput, type TeamsExecDeps } from "./teams";
import type { CapabilityFacts, Rpc } from "./types";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const VIEWER = "00000000-0000-4000-8000-0000000000a3";
const CONN = "00000000-0000-4000-8000-0000000c3001";
const CHAT = "19:abc123def456@thread.v2";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHANNEL = "19:chan123@thread.tacv2";
const CANARY = "CANARY-teams-text-91c3";
const REQ = "5e11d0c0-0000-4000-8000-000000000001";

type Row = Record<string, unknown> & { id: string; status: string; payload: Record<string, unknown>; target: Record<string, unknown> };
type WriterMode =
  | "ok" | "already_applied" | "send_rejected" | "not_a_member" | "target_not_found" | "message_too_large" | "throttled" | "outcome_pending" | "ambiguous_match"
  | "invalid_input" | "reconnect" | "timeout" | "plain_throw" | "no_id";
type VerifyMode = "ok" | "mismatch" | "not_found" | "timeout" | "claim_sent_fails";

const fixed = (code: keyof typeof TEAMS_SEND_FAILURES, kind: ConstructorParameters<typeof ConnectorError>[0]["kind"]) => new ConnectorError({ kind, message: TEAMS_SEND_FAILURES[code] });

function world(over: { facts?: Partial<CapabilityFacts> | null; writer?: WriterMode; verify?: VerifyMode; markVerifiedThrows?: boolean; executeDelayMs?: number } = {}) {
  const rows = new Map<string, Row>();
  const claims = new Map<string, { outcome: string | null; external_id: string | null }>();
  const audits: AuditEntry[] = [];
  const calls = { writes: 0, verifies: 0, finds: 0, actions: [] as Record<string, unknown>[], windows: [] as unknown[] };
  const facts: CapabilityFacts = {
    mailbox: null,
    composeGranted: false,
    writeActionsAllowed: ["teams_send"],
    approvalsLive: true,
    stepUpMaxAgeS: 300,
    teams: { ownerUserId: OWNER, chatSend: true, channelsSend: true },
    ...over.facts,
  };
  const err = (message: string, code = "P0001") => ({ data: null, error: { code, message } });
  const purge = (r: Row) => {
    delete r.payload.text;
    r.payload_purged_at = new Date().toISOString();
  };
  const impl = (fn: string, a: Record<string, unknown>): { data: unknown; error: { code?: string; message?: string } | null } => {
    const get = (id: unknown) => [...rows.values()].find((r) => r.id === id && r.lane_id === a.p_lane);
    switch (fn) {
      case "act_propose": {
        const dup = [...rows.values()].find((r) => r.connection_id === a.p_connection && (r.target as Record<string, unknown>).client_request_id === (a.p_target as Record<string, unknown>).client_request_id);
        if (dup) return dup.payload_sha256 === a.p_hash ? { data: dup.id, error: null } : err("act: client_request_id_reused", "23505");
        const id = randomUUID();
        const now = new Date().toISOString();
        rows.set(id, {
          id, lane_id: a.p_lane, action_type: a.p_type, connection_id: a.p_connection, provider: "microsoft_teams", target: structuredClone(a.p_target) as Record<string, unknown>,
          payload: structuredClone(a.p_payload) as Record<string, unknown>, payload_schema_version: a.p_version, payload_sha256: a.p_hash, rationale: null, source_refs: [],
          proposer_kind: a.p_proposer_kind, proposer_user_id: a.p_proposer_user ?? null, derived_from_retrieved: a.p_derived, supersedes_id: null, superseded_by_id: null,
          status: "proposed", expires_at: new Date(Date.now() + 3600_000).toISOString(), approved_by: null, approved_at: null, approved_hash: null, executing_at: null, executed_at: null,
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
        r.approved_by = OWNER;
        r.approved_at = new Date().toISOString();
        r.approved_hash = r.payload_sha256;
        return { data: r.payload_sha256, error: null };
      }
      case "act_claim_execution": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (claims.has(r.id)) return err("act: already_claimed");
        if (r.status !== "approved") return err("act: not_approved");
        claims.set(r.id, { outcome: null, external_id: null });
        r.status = "executing";
        r.executing_at = new Date().toISOString();
        return { data: structuredClone(r), error: null };
      }
      case "act_claim_sent": {
        if (over.verify === "claim_sent_fails") return err("act: no open claim");
        const c = claims.get(a.p_id as string);
        if (c) {
          c.outcome = "sent";
          c.external_id = a.p_external_id as string;
        }
        return { data: null, error: null };
      }
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
        r.failure_outcome = a.p_outcome;
        purge(r);
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
        purge(r);
        return { data: null, error: null };
      }
      case "act_stuck_actions":
        return { data: [...rows.values()].filter((r) => r.status === "executing").map((r) => ({ action: structuredClone(r), claim_outcome: claims.get(r.id)?.outcome ?? null, claim_external_id: claims.get(r.id)?.external_id ?? null, give_up: false })), error: null };
      case "act_reconcile_verified": {
        const r = get(a.p_id);
        if (!r || r.status !== "executing") return { data: false, error: null };
        r.status = "verified";
        purge(r);
        return { data: true, error: null };
      }
      case "act_reconcile_failed": {
        const r = get(a.p_id);
        if (!r || r.status !== "executing") return { data: false, error: null };
        r.status = "failed";
        r.failure_code = a.p_code as string;
        purge(r);
        return { data: true, error: null };
      }
      case "has_lane_role": {
        const roles = a.p_roles as string[];
        const mine = a.p_uid === OWNER ? "owner" : a.p_uid === OTHER ? "admin_technical" : a.p_uid === VIEWER ? "viewer" : "";
        return { data: roles.includes(mine), error: null };
      }
      default:
        return err("unknown function", "42883");
    }
  };
  const rpc: Rpc = async (fn, args) => impl(fn, args);
  const audit = createAudit(async (row) => {
    audits.push({ laneId: row.p_lane_id, actor: row.p_actor_kind === "user" ? { kind: "user", userId: row.p_actor_id ?? "" } : { kind: row.p_actor_kind as "service" }, action: row.p_action, ...(row.p_target ? { target: row.p_target } : {}), metadata: row.p_metadata as Record<string, unknown> } as AuditEntry);
    return { data: null, error: null } as never;
  });
  const throwFor = (mode: WriterMode): never => {
    switch (mode) {
      case "send_rejected": throw fixed("send_rejected", "invalid_input");
      case "not_a_member": throw fixed("not_a_member", "forbidden");
      case "target_not_found": throw fixed("target_not_found", "not_found");
      case "message_too_large": throw fixed("message_too_large", "invalid_input");
      case "throttled": throw fixed("throttled", "rate_limited");
      case "outcome_pending": throw fixed("outcome_pending", "timeout");
      case "ambiguous_match": throw fixed("ambiguous_match", "provider_error");
      case "invalid_input": throw new ConnectorError({ kind: "invalid_input", message: "The approved message is not valid" });
      case "reconnect": throw new ConnectorError({ kind: "reconnect_required", message: "Reconnect Teams" });
      case "timeout": throw new ConnectorError({ kind: "timeout", message: "timed out" });
      default: throw new Error("socket reset");
    }
  };
  const deps: TeamsExecDeps = {
    jobRpc: async () => rpc,
    prepareEmailWrite: async () => { throw new Error("not used"); },
    laneMailboxes: async () => [],
    mailboxAllowed: async () => false,
    readFacts: async () => (over.facts === null ? { ...facts, teams: null } : facts),
    audit,
    loadWriteConnection: async () => ({ id: CONN }) as never,
    writer: {
      async executeWrite(_l, _c, action) {
        calls.writes += 1;
        calls.actions.push({ ...action });
        if (over.executeDelayMs) await new Promise((r) => setTimeout(r, over.executeDelayMs));
        const mode = over.writer ?? "ok";
        if (mode === "ok" || mode === "already_applied") return { outcome: mode === "ok" ? "accepted" : "already_applied", external_id: "synthetic-message-1", executed_at: new Date().toISOString(), provider_tid: null };
        if (mode === "no_id") return { outcome: "accepted", external_id: null, executed_at: new Date().toISOString(), provider_tid: null };
        return throwFor(mode);
      },
      async verifyWrite(_l, _c, _a, _id, window) {
        calls.verifies += 1;
        calls.windows.push(window);
        if (over.verify === "mismatch") throw fixed("verification_mismatch", "provider_error");
        if (over.verify === "not_found") throw new ConnectorError({ kind: "not_found", message: "The message was not found in Teams" });
        if (over.verify === "timeout") throw new ConnectorError({ kind: "timeout", message: "timed out" });
      },
    },
  };
  const ctx = (userId = OWNER) => ({ laneId: "PKG", userId, rpc });
  return { rows, claims, audits, calls, deps, ctx, rpc, facts };
}

const input = (over: Partial<ProposeTeamsInput> = {}): ProposeTeamsInput => ({ connectionId: CONN, place: { type: "teams.chat.send", chatId: CHAT }, text: CANARY, clientRequestId: REQ, aiDrafted: false, ...over });
async function proposed(w: ReturnType<typeof world>, over: Partial<ProposeTeamsInput> = {}, userId = OWNER) {
  return proposeTeamsAction(w.deps, w.ctx(userId), input(over));
}
const noText = (w: ReturnType<typeof world>) => expect(JSON.stringify(w.audits)).not.toContain("CANARY-teams-text");

describe("proposeTeamsAction", () => {
  it("stores exactly the target and the plain-text payload, the canonical hash, a person's proposal; audits ids, type and hash, never the text", async () => {
    const w = world();
    const { id, hash } = await proposed(w, { aiDrafted: true });
    const row = w.rows.get(id)!;
    expect(row).toMatchObject({ action_type: "teams.chat.send", target: { chat_id: CHAT, client_request_id: REQ }, payload: { content_type: "text", text: CANARY }, proposer_kind: "user", proposer_user_id: OWNER, derived_from_retrieved: true, status: "proposed" });
    expect(Object.keys(row.target).sort()).toEqual(["chat_id", "client_request_id"]);
    expect(Object.keys(row.payload).sort()).toEqual(["content_type", "text"]);
    expect(hash).toBe(hashOfRow({ laneId: "PKG", actionType: "teams.chat.send", connectionId: CONN, target: { chat_id: CHAT, client_request_id: REQ }, payload: { content_type: "text", text: CANARY }, payloadSchemaVersion: 1 }));
    expect(row.payload_sha256).toBe(hash);
    expect(w.audits).toHaveLength(1);
    expect(w.audits[0]).toMatchObject({ action: "action.proposed", actor: { kind: "user", userId: OWNER }, target: `action:${id}`, metadata: { action_type: "teams.chat.send", connection_id: CONN, hash, proposer_kind: "user", derived_from_retrieved: true } });
    noText(w);
    expect(w.calls.writes).toBe(0);
  });

  it("a channel post and a channel reply carry their own target keys", async () => {
    const w = world();
    const post = await proposed(w, { place: { type: "teams.channel.post", teamId: TEAM, channelId: CHANNEL }, clientRequestId: "5e11d0c0-0000-4000-8000-000000000002" });
    const reply = await proposed(w, { place: { type: "teams.channel.reply", teamId: TEAM, channelId: CHANNEL, replyToId: "1700000000001" }, clientRequestId: "5e11d0c0-0000-4000-8000-000000000003" });
    expect(Object.keys(w.rows.get(post.id)!.target).sort()).toEqual(["channel_id", "client_request_id", "team_id"]);
    expect(Object.keys(w.rows.get(reply.id)!.target).sort()).toEqual(["channel_id", "client_request_id", "reply_to_id", "team_id"]);
  });

  it("normalises what was typed (CRLF to newline, NFC, trimmed) and the hash is over the normalised text", async () => {
    const w = world();
    const { id } = await proposed(w, { text: `  a\r\nb\re${String.fromCharCode(769)} \t` });
    expect(w.rows.get(id)!.payload.text).toBe("a\nb\né");
    expect(buildTeamsSend(input({ text: "  x  " })).text).toBe("x");
  });

  it("refuses text and ids that are not valid, before anything is stored", async () => {
    const w = world();
    const bad: Partial<ProposeTeamsInput>[] = [
      { text: "" }, { text: " \n\t " }, { text: "x".repeat(10_001) }, { text: "bell\u0007" }, { text: "zero\u0000" }, { text: "lone\ud800" },
      { place: { type: "teams.chat.send", chatId: "not-a-chat" } }, { place: { type: "teams.chat.send", chatId: "19:a/b" } }, { clientRequestId: "not-a-uuid" },
      { place: { type: "teams.channel.post", teamId: "nope", channelId: CHANNEL } }, { place: { type: "teams.channel.reply", teamId: TEAM, channelId: CHANNEL, replyToId: "../x" } },
      { place: { type: "teams.chat.delete" } as never }, { aiDrafted: "yes" as never }, { connectionId: "nope" },
    ];
    for (const b of bad) await expect(proposed(w, b), JSON.stringify(b).slice(0, 60)).rejects.toMatchObject({ code: "invalid" });
    expect(w.rows.size).toBe(0);
    expect(w.audits).toHaveLength(0);
  });

  it("owner and admin_technical may propose from their own connection; a viewer may not (D-68 default); another person's connection is not_found", async () => {
    const w = world();
    await expect(proposed(w, {}, VIEWER)).rejects.toMatchObject({ code: "forbidden" });
    await expect(proposed(w, { clientRequestId: "5e11d0c0-0000-4000-8000-000000000004" }, OTHER)).rejects.toMatchObject({ code: "not_found" }); // the connection is the owner's
    const mine = world({ facts: { teams: { ownerUserId: OTHER, chatSend: true, channelsSend: true } } });
    await expect(proposed(mine, {}, OTHER)).resolves.toMatchObject({ id: expect.any(String) });
    expect(w.rows.size).toBe(0);
  });

  it("each gate refuses with its own reason: lane policy, the connection's or lane's feature, no usable connection, approvals_live", async () => {
    await expect(proposed(world({ facts: { writeActionsAllowed: ["email_send"] } }))).rejects.toMatchObject({ code: "not_enabled" });
    await expect(proposed(world({ facts: { teams: { ownerUserId: OWNER, chatSend: false, channelsSend: true } } }))).rejects.toMatchObject({ code: "not_enabled" });
    await expect(proposed(world({ facts: { teams: { ownerUserId: OWNER, chatSend: true, channelsSend: false } } }), { place: { type: "teams.channel.post", teamId: TEAM, channelId: CHANNEL } })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(proposed(world({ facts: null }))).rejects.toMatchObject({ code: "not_found" });
    await expect(proposed(world({ facts: { approvalsLive: false } }))).rejects.toMatchObject({ code: "not_live" });
    const w = world({ facts: { writeActionsAllowed: [] } });
    await expect(proposed(w)).rejects.toMatchObject({ code: "not_enabled" });
    expect(w.rows.size).toBe(0);
  });

  it("maps the database's refusals: outbound drafts not stored, a reused request id, a gate off in SQL", async () => {
    const w = world();
    const failing = (message: string, code: string): TeamsExecDeps => ({ ...w.deps, jobRpc: async () => async () => ({ data: null, error: { code, message } }) });
    await expect(proposeTeamsAction(failing("act: this lane does not allow storing outbound drafts", "42501"), w.ctx(), input())).rejects.toMatchObject({ code: "drafts_not_allowed" });
    await expect(proposeTeamsAction(failing("act: client_request_id_reused", "23505"), w.ctx(), input())).rejects.toMatchObject({ code: "request_reused" });
    await expect(proposeTeamsAction(failing("act: connection_not_enabled", "P0001"), w.ctx(), input())).rejects.toMatchObject({ code: "teams_not_enabled" });
  });

  it("the same client request id is one action (a double click), the same id with another text is refused", async () => {
    const w = world();
    const a = await proposed(w);
    const b = await proposed(w);
    expect(b.id).toBe(a.id);
    expect(w.rows.size).toBe(1);
    await expect(proposed(w, { text: "something else" })).rejects.toMatchObject({ code: "request_reused" });
  });

  it("capabilityOf for the Teams types: not enabled before not live, with the settings link", () => {
    const base: CapabilityFacts = { mailbox: null, composeGranted: false, writeActionsAllowed: ["teams_send"], approvalsLive: true, stepUpMaxAgeS: 300, teams: { ownerUserId: OWNER, chatSend: true, channelsSend: false } };
    expect(capabilityOf("PKG" as never, base, "teams.chat.send")).toMatchObject({ enabled: true });
    expect(capabilityOf("PKG" as never, base, "teams.channel.post")).toMatchObject({ enabled: false, reason: "not_enabled", settingsHref: "/PKG/settings#connections" });
    expect(capabilityOf("PKG" as never, { ...base, approvalsLive: false }, "teams.chat.send")).toMatchObject({ enabled: false, reason: "not_live" });
    expect(capabilityOf("PKG" as never, { ...base, approvalsLive: false, writeActionsAllowed: [] }, "teams.chat.send")).toMatchObject({ enabled: false, reason: "not_enabled" });
    expect(capabilityOf("PKG" as never, { ...base, teams: null }, "teams.chat.send")).toMatchObject({ enabled: false, reason: "not_enabled" });
  });
});

describe("approveAndExecuteTeams: the one send", () => {
  it("approves the exact hash and sends ONCE: one write with the recorded approver and hash, the claim records the message id, the read-back runs with the claim window, the text is purged, the audit has no text", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    const r = await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash });
    expect(r).toEqual({ status: "verified", actionId: id });
    expect(w.calls.writes).toBe(1);
    expect(w.calls.actions[0]).toMatchObject({ id, lane_id: "PKG", connection_id: CONN, action_type: "teams.chat.send", payload_sha256: hash, approved_by: OWNER });
    expect(w.claims.get(id)).toEqual({ outcome: "sent", external_id: "synthetic-message-1" });
    expect(w.calls.verifies).toBe(1);
    expect((w.calls.windows[0] as { since: string }).since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const row = w.rows.get(id)!;
    expect(row).toMatchObject({ status: "verified", result: { external_id: "synthetic-message-1", outcome: "accepted" } });
    expect(row.payload.text).toBeUndefined();
    expect(row.payload_purged_at).not.toBeNull();
    expect(w.audits.map((a) => a.action)).toEqual(["action.proposed", "action.approved", "action.execute_started", "action.verified"]);
    noText(w);
  });

  it("a hash the person did not see, a changed stored text and a type that is not Teams are refused before the database approves anything", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await expect(approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: "0".repeat(64) })).rejects.toMatchObject({ code: "hash_mismatch" });
    w.rows.get(id)!.payload.text = "changed in storage";
    await expect(approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(w.rows.get(id)!.status).toBe("proposed");
    expect(w.calls.writes).toBe(0);
    const email = w.rows.set("e", { ...w.rows.get(id)!, id: "e", action_type: "email.send" } as Row).get("e")!;
    await expect(approveAndExecuteTeams(w.deps, w.ctx(), { actionId: email.id, hashSeen: hash })).rejects.toMatchObject({ code: "invalid" });
  });

  it("the gates run again before approval: approvals_live off, the policy removed, the feature off, someone else's connection", async () => {
    for (const [facts, code] of [
      [{ approvalsLive: false }, "not_live"],
      [{ writeActionsAllowed: [] as string[] }, "teams_not_enabled"],
      [{ teams: { ownerUserId: OWNER, chatSend: false, channelsSend: true } }, "teams_not_enabled"],
      [{ teams: { ownerUserId: OTHER, chatSend: true, channelsSend: true } }, "not_found"],
    ] as const) {
      const w = world();
      const { id, hash } = await proposed(w);
      Object.assign(w.facts, facts);
      await expect(approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash }), JSON.stringify(facts)).rejects.toMatchObject({ code });
      expect(w.rows.get(id)!.status).toBe("proposed");
      expect(w.calls.writes).toBe(0);
    }
  });

  it("a viewer cannot approve; nothing is executed", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await expect(approveAndExecuteTeams(w.deps, w.ctx(VIEWER), { actionId: id, hashSeen: hash })).rejects.toMatchObject({ code: "forbidden" });
    expect(w.calls.writes).toBe(0);
  });

  it("two concurrent executions of one approved action make ONE write: the second finds the claim taken", async () => {
    const w = world({ executeDelayMs: 20 });
    const { id, hash } = await proposed(w);
    expect(await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash })).toMatchObject({ error: null });
    const results = await Promise.all([executeApprovedTeams(w.deps, "PKG" as never, id), executeApprovedTeams(w.deps, "PKG" as never, id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_in_progress", "verified"]);
    expect(w.calls.writes).toBe(1);
  });

  it("a double click (two requests with the same client request id, the second after the first finished) is one action, one write, and the second gets the settled state", async () => {
    const w = world();
    const a = await proposed(w);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: a.id, hashSeen: a.hash })).toMatchObject({ status: "verified" });
    const b = await proposed(w);
    expect(b.id).toBe(a.id);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: b.id, hashSeen: b.hash })).toEqual({ status: "verified", actionId: a.id });
    expect(w.calls.writes).toBe(1);
    expect(w.rows.size).toBe(1);
  });

  it("a request that arrives while the action is executing gets already_in_progress and writes nothing", async () => {
    const w = world();
    const a = await proposed(w);
    w.rows.get(a.id)!.status = "executing";
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: a.id, hashSeen: a.hash })).toEqual({ status: "already_in_progress", actionId: a.id });
    expect(w.calls.writes).toBe(0);
  });

  it("an action approved earlier but never carried out is resumed once for the same person and hash, and refused for another hash", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    await expect(approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: "1".repeat(64) })).rejects.toMatchObject({ code: "already_approved" });
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "verified", actionId: id });
    expect(w.calls.writes).toBe(1);
    expect(w.audits.map((a) => a.action)).toContain("action.resumed");
  });

  it("content that no longer hashes to the approved hash is never sent: failed / payload_changed, the text purged, the writer not called", async () => {
    const w = world();
    const { id, hash } = await proposed(w);
    await w.rpc("act_approve", { p_lane: "PKG", p_id: id, p_hash_seen: hash });
    w.rows.get(id)!.payload.text = "tampered";
    const r = await executeApprovedTeams(w.deps, "PKG" as never, id);
    expect(r).toEqual({ status: "failed", actionId: id, failureCode: "payload_changed" });
    expect(w.calls.writes).toBe(0);
    expect(w.rows.get(id)!.payload.text).toBeUndefined();
  });
});

describe("how each outcome ends", () => {
  const definite: [WriterMode, string][] = [
    ["send_rejected", "send_rejected"], ["not_a_member", "not_a_member"], ["target_not_found", "target_not_found"], ["message_too_large", "message_too_large"],
    ["throttled", "throttled"], ["invalid_input", "execution_refused"], ["reconnect", "connection_unhealthy"],
  ];
  for (const [mode, expected] of definite) {
    it(`${mode}: failed / ${expected}, nothing sent so no read-back, one write, the text purged`, async () => {
      const w = world({ writer: mode });
      const { id, hash } = await proposed(w);
      const r = await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash });
      expect(r).toEqual({ status: "failed", actionId: id, failureCode: expected });
      expect(w.rows.get(id)).toMatchObject({ status: "failed", failure_code: expected, failure_outcome: "error" });
      expect(w.rows.get(id)!.payload.text).toBeUndefined();
      expect(w.calls.writes).toBe(1);
      expect(w.calls.verifies).toBe(0);
      noText(w);
    });
  }

  it("an ambiguous lookup (two matching messages): failed / ambiguous_match with an unknown outcome", async () => {
    const w = world({ writer: "ambiguous_match" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "failed", actionId: id, failureCode: "ambiguous_match" });
    expect(w.rows.get(id)).toMatchObject({ failure_outcome: "outcome_unknown" });
  });

  for (const mode of ["outcome_pending", "timeout", "plain_throw"] as const) {
    it(`${mode}: the outcome is unknown, so the action stays executing for the sweep: not failed, text still held, no second write`, async () => {
      const w = world({ writer: mode });
      const { id, hash } = await proposed(w);
      const r = await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash });
      expect(r).toEqual({ status: "outcome_pending", actionId: id });
      expect(w.rows.get(id)!.status).toBe("executing");
      expect(w.rows.get(id)!.payload.text).toBe(CANARY); // the sweep needs it for the lookup
      expect(w.calls.writes).toBe(1);
      // a second request never writes again: the claim is taken
      expect(await executeApprovedTeams(w.deps, "PKG" as never, id)).toEqual({ status: "already_in_progress", actionId: id });
      expect(w.calls.writes).toBe(1);
      noText(w);
    });
  }

  it("already applied (the lookup found the message): verified with outcome already_applied", async () => {
    const w = world({ writer: "already_applied" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "verified", actionId: id });
    expect(w.rows.get(id)).toMatchObject({ result: { outcome: "already_applied" } });
  });

  it("the read-back shows different text: failed / verification_mismatch (the person is told to check the chat); the claim kept the message id", async () => {
    const w = world({ verify: "mismatch" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "failed", actionId: id, failureCode: "verification_mismatch" });
    expect(w.rows.get(id)).toMatchObject({ failure_outcome: "mismatch" });
    expect(w.claims.get(id)!.external_id).toBe("synthetic-message-1");
  });

  for (const verify of ["not_found", "timeout"] as const) {
    it(`the read-back is not possible yet (${verify}): sent_unverified, the action stays executing with its claim at "sent"; never failed, never a second write`, async () => {
      const w = world({ verify });
      const { id, hash } = await proposed(w);
      expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "sent_unverified", actionId: id });
      expect(w.rows.get(id)!.status).toBe("executing");
      expect(w.claims.get(id)).toEqual({ outcome: "sent", external_id: "synthetic-message-1" });
      expect(w.calls.writes).toBe(1);
      expect(w.audits.map((a) => a.action)).toContain("action.verification_pending");
    });
  }

  it("the claim could not record the message id: outcome_pending (the sweep looks it up), never a failure", async () => {
    const w = world({ verify: "claim_sent_fails" });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "outcome_pending", actionId: id });
    expect(w.rows.get(id)!.status).toBe("executing");
  });

  it("a verified message whose result could not be recorded is still reported as verified (never turned into failed)", async () => {
    const w = world({ markVerifiedThrows: true });
    const { id, hash } = await proposed(w);
    expect(await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash })).toEqual({ status: "verified", actionId: id });
    expect(w.rows.get(id)!.status).toBe("executing");
  });

  it("the person rejecting a proposal purges its text and sends nothing", async () => {
    const w = world();
    const { id } = await proposed(w);
    await rejectAction(w.deps, w.ctx(), id, "no thanks");
    expect(w.rows.get(id)).toMatchObject({ status: "rejected" });
    expect(w.rows.get(id)!.payload.text).toBeUndefined();
    expect(w.calls.writes).toBe(0);
  });
});

describe("the reconcile sweep for Teams", () => {
  function sweepWorld(over: Parameters<typeof world>[0] & { found?: string[]; findThrows?: ConnectorError; verifyThrows?: ConnectorError } = {}) {
    const w = world(over);
    const finds: unknown[] = [];
    const reconciler = createTeamsReconciler({
      loadWriteConnection: async () => ({ id: CONN }) as never,
      reconciler: {
        async findWrite(_l, _c, _a, window) {
          finds.push(window);
          if (over.findThrows) throw over.findThrows;
          return over.found ?? [];
        },
        async verifyWrite(...args) {
          if (over.verifyThrows) throw over.verifyThrows;
          return w.deps.writer.verifyWrite(...args);
        },
      },
    });
    const sweep = () => reconcileStuckActions({ jobRpc: w.deps.jobRpc, audit: w.deps.audit, reconcilers: [reconciler] }, "PKG" as never);
    return { w, finds, sweep };
  }
  async function stuck(w: ReturnType<typeof world>, writer: "timeout") {
    void writer;
    const { id, hash } = await proposed(w);
    await approveAndExecuteTeams(w.deps, w.ctx(), { actionId: id, hashSeen: hash });
    return id;
  }

  it("a stuck action whose lookup finds exactly one message is verified as already_applied; the lookup window starts before the claim; the text is purged", async () => {
    const s = sweepWorld({ writer: "timeout", found: ["synthetic-message-7"] });
    const id = await stuck(s.w, "timeout");
    const summary = await s.sweep();
    expect(summary).toMatchObject({ checked: 1, verified: 1, failed: 0 });
    expect(s.w.rows.get(id)).toMatchObject({ status: "verified" });
    expect(s.w.rows.get(id)!.payload.text).toBeUndefined();
    const since = Date.parse((s.finds[0] as { since: string }).since);
    expect(since).toBeLessThan(Date.parse(s.w.rows.get(id)!.executing_at as string));
    expect(s.w.calls.writes).toBe(1); // the sweep never posts
  });

  it("two matches: failed / ambiguous_match; none: stays undecided (the text stays held)", async () => {
    const two = sweepWorld({ writer: "timeout", found: ["a", "b"] });
    const id = await stuck(two.w, "timeout");
    expect(await two.sweep()).toMatchObject({ failed: 1 });
    expect(two.w.rows.get(id)).toMatchObject({ status: "failed", failure_code: "ambiguous_match" });
    const none = sweepWorld({ writer: "timeout", found: [] });
    const id2 = await stuck(none.w, "timeout");
    expect(await none.sweep()).toMatchObject({ checked: 1, undecided: 1, verified: 0, failed: 0 });
    expect(none.w.rows.get(id2)).toMatchObject({ status: "executing" });
    expect(none.w.rows.get(id2)!.payload.text).toBe(CANARY);
  });

  it("an accepted message whose read-back later works is verified by id; a mismatch fails it; an unreadable one stays undecided", async () => {
    const ok = sweepWorld({ verify: "not_found" });
    const id = await stuck(ok.w, "timeout" as never);
    ok.w.deps.writer.verifyWrite = async () => undefined;
    expect(await ok.sweep()).toMatchObject({ verified: 1 });
    expect(ok.w.rows.get(id)!.status).toBe("verified");
    const bad = sweepWorld({ verify: "not_found", verifyThrows: new ConnectorError({ kind: "provider_error", message: TEAMS_SEND_FAILURES.verification_mismatch }) });
    const id2 = await stuck(bad.w, "timeout" as never);
    expect(await bad.sweep()).toMatchObject({ failed: 1 });
    expect(bad.w.rows.get(id2)).toMatchObject({ status: "failed", failure_code: "verification_mismatch" });
    const down = sweepWorld({ verify: "not_found", verifyThrows: new ConnectorError({ kind: "timeout", message: "timed out" }) });
    const id3 = await stuck(down.w, "timeout" as never);
    expect(await down.sweep()).toMatchObject({ undecided: 1 });
    expect(down.w.rows.get(id3)!.status).toBe("executing");
  });

  it("a lookup that cannot run (a limit, the connection needing a reconnect) is undecided, never failed", async () => {
    for (const e of [new ConnectorError({ kind: "rate_limited", message: "busy" }), new ConnectorError({ kind: "reconnect_required", message: "Reconnect Teams" }), new ConnectorError({ kind: "timeout", message: "timed out" })]) {
      const s = sweepWorld({ writer: "timeout", findThrows: e });
      const id = await stuck(s.w, "timeout");
      expect(await s.sweep()).toMatchObject({ undecided: 1, failed: 0 });
      expect(s.w.rows.get(id)!.status).toBe("executing");
    }
  });

  it("content that no longer hashes to the approved hash is not looked up: failed / reconcile_payload_changed", async () => {
    const s = sweepWorld({ writer: "timeout", found: ["x"] });
    const id = await stuck(s.w, "timeout");
    s.w.rows.get(id)!.payload.text = "tampered";
    expect(await s.sweep()).toMatchObject({ failed: 1 });
    expect(s.w.rows.get(id)).toMatchObject({ failure_code: "reconcile_payload_changed" });
    expect(s.finds).toHaveLength(0);
  });

  it("the reconciler holds find and verify only: it has no way to execute", () => {
    const r = createTeamsReconciler({ loadWriteConnection: async () => ({}) as never, reconciler: { findWrite: async () => [], verifyWrite: async () => undefined } });
    expect(Object.keys(r).sort()).toEqual(["actionTypes", "decide"]);
    expect(r.actionTypes).toEqual(["teams.chat.send", "teams.channel.post", "teams.channel.reply"]);
  });
});
