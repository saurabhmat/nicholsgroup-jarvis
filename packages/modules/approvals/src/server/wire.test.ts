// T-260: the capability facts behind Reply ask the provider gate, so Reply is not offered on a connection whose provider the lane has paused (D-57, found in the T-255
// review), and an unreadable lane config fails closed (not usable), never an error. Everything the wiring imports from the connectors and the lane router is replaced.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  conn: { provider: "google", external_account_id: "Robert@Pubk.Example.Test", status: "active", features: { gmail_compose: true } } as Record<string, unknown> | null,
  gate: vi.fn<(lane: string, provider: string) => Promise<boolean>>(),
  approvals: { approvals_live: true } as Record<string, unknown>,
  storeDrafts: true,
}));
vi.mock("@nichols/connectors/facade", () => ({ prepareEmailWrite: vi.fn(), laneMailboxes: vi.fn(), mailboxAllowed: vi.fn(), providerGate: { enabled: m.gate } }));
vi.mock("@nichols/connectors/write", () => ({
  GRAPH_MAIL_WRITE_FEATURE: "graph_mail_write", emailWriteGate: {}, googleEmailReconciler: {}, googleEmailWriter: { actionTypes: [] }, microsoftEmailReconciler: {}, microsoftEmailWriter: { actionTypes: [], sentCopyMayLag: true }, loadEmailWriteConnection: vi.fn(), loadQuickbooksWriteConnection: vi.fn(), quickbooksDisconnectVerifier: {}, quickbooksWriter: {},
  loadTeamsWriteConnection: vi.fn(), teamsMessageReconciler: { findWrite: vi.fn(), verifyWrite: vi.fn() }, teamsMessageWriter: { executeWrite: vi.fn() },
}));
vi.mock("@nichols/core/lane-router", () => ({
  getAudit: () => ({ log: vi.fn() }),
  getLaneJobClient: async () => ({
    schema: () => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: m.conn, error: null }) }),
            maybeSingle: async () => ({ data: table === "lane_policies" ? { write_actions_allowed: ["email_send", "email_draft"], store_outbound_drafts: m.storeDrafts } : { config: { approvals: m.approvals } }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import { approvalsDeps, approveAndExecuteAction } from "./wire";

beforeEach(() => {
  m.gate.mockReset();
  m.conn = { provider: "google", external_account_id: "Robert@Pubk.Example.Test", status: "active", features: { gmail_compose: true } };
});

describe("readFacts and the provider gate", () => {
  it("a Google connection of a lane that has Google enabled is usable (unchanged)", async () => {
    m.gate.mockResolvedValue(true);
    const f = await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601");
    expect(f).toMatchObject({ mailbox: "robert@pubk.example.test", composeGranted: true });
    expect(m.gate).toHaveBeenCalledWith("PKG", "google");
  });
  it("a connection whose provider the lane has paused is not usable: no mailbox, no compose grant, so no Reply is offered", async () => {
    m.gate.mockResolvedValue(false);
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601")).toMatchObject({ mailbox: null, composeGranted: false });
  });
  it("an unreadable lane config fails closed (not usable), without an error", async () => {
    m.gate.mockRejectedValue(new Error("config unreadable"));
    await expect(approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601")).resolves.toMatchObject({ mailbox: null, composeGranted: false });
  });
  it("T-263: a Microsoft connection is usable when the lane has Microsoft enabled: the gate is asked for ITS provider and the grant is graph_mail_write (not gmail_compose)", async () => {
    m.conn = { provider: "microsoft", external_account_id: "robert@pubkgroup.example.test", status: "active", features: { graph_mail_write: true } };
    m.gate.mockResolvedValue(true);
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2602")).toMatchObject({ mailbox: "robert@pubkgroup.example.test", provider: "microsoft", composeGranted: true });
    expect(m.gate).toHaveBeenCalledWith("PKG", "microsoft");
    m.conn = { provider: "microsoft", external_account_id: "robert@pubkgroup.example.test", status: "active", features: { gmail_compose: true } };
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2602")).toMatchObject({ mailbox: "robert@pubkgroup.example.test", provider: "microsoft", composeGranted: false });
    m.conn = { provider: "google", external_account_id: "robert@pubk.example.test", status: "active", features: { graph_mail_write: true } };
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601")).toMatchObject({ provider: "google", composeGranted: false });
  });
  it("a Microsoft connection of a lane that paused Microsoft, or a status that is not usable, has no mailbox and no grant; any other provider is never an email connection", async () => {
    m.conn = { provider: "microsoft", external_account_id: "robert@pubkgroup.example.test", status: "active", features: { graph_mail_write: true } };
    m.gate.mockResolvedValue(false);
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2602")).toMatchObject({ mailbox: null, composeGranted: false });
    m.gate.mockResolvedValue(true);
    m.conn = { provider: "microsoft", external_account_id: "robert@pubkgroup.example.test", status: "reconnect_required", features: { graph_mail_write: true } };
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2602")).toMatchObject({ mailbox: null, composeGranted: false });
    m.conn = { provider: "quickbooks", external_account_id: "123", status: "active", features: { graph_mail_write: true, gmail_compose: true } };
    expect(await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2603")).toMatchObject({ mailbox: null, composeGranted: false });
  });
});

describe("T-286 review: the Teams step-up window and the stored-text rule are facts", () => {
  it("teamsStepUpMaxAgeS is clamped 300..43,200 exactly like act.approve, and 300 when unset or not a whole number; the email window is untouched", async () => {
    m.gate.mockResolvedValue(true);
    const read = async (v: unknown) => {
      m.approvals = { approvals_live: true, ...(v === undefined ? {} : { teams_step_up_max_age_s: v }) };
      return approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601");
    };
    expect((await read(undefined)).teamsStepUpMaxAgeS).toBe(300);
    expect((await read(100)).teamsStepUpMaxAgeS).toBe(300);
    expect((await read(28800)).teamsStepUpMaxAgeS).toBe(28800);
    expect((await read(999999)).teamsStepUpMaxAgeS).toBe(43200);
    expect((await read("3600")).teamsStepUpMaxAgeS).toBe(300);
    expect((await read(1.5)).teamsStepUpMaxAgeS).toBe(300);
    expect((await read(28800)).stepUpMaxAgeS).toBe(300);
    m.approvals = { approvals_live: true };
  });
  it("storeOutboundDrafts is the lane policy's flag", async () => {
    m.gate.mockResolvedValue(true);
    m.storeDrafts = false;
    expect((await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601")).storeOutboundDrafts).toBe(false);
    m.storeDrafts = true;
    expect((await approvalsDeps.readFacts("PKG" as never, "00000000-0000-4000-8000-0000000c2601")).storeOutboundDrafts).toBe(true);
  });
});

describe("T-286: Teams facts", () => {
  const TEAMS_CONN = "00000000-0000-4000-8000-0000000c3001";
  it("a usable Teams connection reports its owner and, per send feature, the lane's teams block AND the connection's own permission; it is never a mailbox", async () => {
    m.conn = { provider: "microsoft_teams", external_account_id: "robert@teams.example.test", status: "active", features: { teams_chat_send: true, teams_channels_send: false }, owner_user_id: "00000000-0000-4000-8000-0000000000a1" };
    m.gate.mockResolvedValue(true);
    const f = await approvalsDeps.readFacts("PKG" as never, TEAMS_CONN);
    expect(f).toMatchObject({ mailbox: null, provider: null, composeGranted: false, qbo: null });
    // the mocked lane config has no teams block: both are off
    expect(f.teams).toEqual({ ownerUserId: "00000000-0000-4000-8000-0000000000a1", chatSend: false, channelsSend: false });
  });
  it("a Teams connection that needs a reconnect, or a mail connection, has no Teams facts", async () => {
    m.gate.mockResolvedValue(true);
    m.conn = { provider: "microsoft_teams", external_account_id: "robert@teams.example.test", status: "reconnect_required", features: { teams_chat_send: true }, owner_user_id: "00000000-0000-4000-8000-0000000000a1" };
    expect((await approvalsDeps.readFacts("PKG" as never, TEAMS_CONN)).teams).toBeNull();
    m.conn = { provider: "microsoft", external_account_id: "robert@example.test", status: "active", features: { teams_chat_send: true, graph_mail_write: true }, owner_user_id: "00000000-0000-4000-8000-0000000000a1" };
    expect((await approvalsDeps.readFacts("PKG" as never, TEAMS_CONN)).teams).toBeNull();
  });
  it("the generic approvals entry never approves or sends a Teams message (its own entry has its own step-up window)", async () => {
    const row = { id: "00000000-0000-4000-8000-0000000000e1", lane_id: "PKG", action_type: "teams.chat.send", connection_id: TEAMS_CONN, provider: "microsoft_teams", target: { chat_id: "19:abc@thread.v2", client_request_id: "5e11d0c0-0000-4000-8000-000000000001" }, payload: { content_type: "text", text: "x" }, payload_schema_version: 1, payload_sha256: "a".repeat(64), rationale: null, source_refs: [], proposer_kind: "user", proposer_user_id: null, derived_from_retrieved: false, supersedes_id: null, superseded_by_id: null, status: "proposed", expires_at: new Date().toISOString(), approved_by: null, approved_at: null, approved_hash: null, executed_at: null, verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const calls: string[] = [];
    const rpc = async (fn: string) => {
      calls.push(fn);
      return { data: fn === "act_get" ? [row] : null, error: null };
    };
    await expect(approveAndExecuteAction({ laneId: "PKG" as never, userId: "00000000-0000-4000-8000-0000000000a1", rpc }, { actionId: row.id, hashSeen: "a".repeat(64) })).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toEqual(["act_get"]);
  });
});
