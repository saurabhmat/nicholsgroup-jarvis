// T-260: the capability facts behind Reply ask the provider gate, so Reply is not offered on a connection whose provider the lane has paused (D-57, found in the T-255
// review), and an unreadable lane config fails closed (not usable), never an error. Everything the wiring imports from the connectors and the lane router is replaced.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  conn: { provider: "google", external_account_id: "Robert@Pubk.Example.Test", status: "active", features: { gmail_compose: true } } as Record<string, unknown> | null,
  gate: vi.fn<(lane: string, provider: string) => Promise<boolean>>(),
}));
vi.mock("@nichols/connectors/facade", () => ({ prepareEmailWrite: vi.fn(), laneMailboxes: vi.fn(), mailboxAllowed: vi.fn(), providerGate: { enabled: m.gate } }));
vi.mock("@nichols/connectors/write", () => ({
  GRAPH_MAIL_WRITE_FEATURE: "graph_mail_write", emailWriteGate: {}, googleEmailReconciler: {}, googleEmailWriter: { actionTypes: [] }, microsoftEmailReconciler: {}, microsoftEmailWriter: { actionTypes: [], sentCopyMayLag: true }, loadEmailWriteConnection: vi.fn(), loadQuickbooksWriteConnection: vi.fn(), quickbooksDisconnectVerifier: {}, quickbooksWriter: {},
}));
vi.mock("@nichols/core/lane-router", () => ({
  getAudit: () => ({ log: vi.fn() }),
  getLaneJobClient: async () => ({
    schema: () => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: m.conn, error: null }) }),
            maybeSingle: async () => ({ data: table === "lane_policies" ? { write_actions_allowed: ["email_send", "email_draft"] } : { config: { approvals: { approvals_live: true } } }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

import { approvalsDeps } from "./wire";

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
