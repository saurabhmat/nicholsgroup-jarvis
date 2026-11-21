// T-255: the email writer and the reconciler's read side dispatch by the connection row's provider; a provider not enabled for the lane is
// refused before any call (no token read); Microsoft answers unsupported_op. Synthetic data only (rule 10).
import { describe, expect, it, vi } from "vitest";
// Connections are minted only inside the connectors (lint); here a plain object stands for a loaded row and the brand check is stood in for.
vi.mock("@nichols/connectors", async (orig) => ({
  ...(await orig<typeof import("@nichols/connectors")>()),
  assertLaneBound: (laneId: string, c: { lane_id?: string; bound?: boolean }) => {
    if (c.bound !== true || c.lane_id !== laneId) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection was not loaded for this lane" });
  },
}));
import { ConnectorError } from "@nichols/connectors";
import { createProviderGate, isProviderDisabledError } from "@nichols/connectors/write";
import { createEmailWriteDispatch, microsoftEmailWriteEntry, type EmailApprovedAction, type EmailWriteEntry } from "./email-dispatch";

const G = "00000000-0000-4000-8000-000000000e01";
const M = "00000000-0000-4000-8000-000000000e02";
const row = (id: string, provider: string) => ({ bound: true, id, lane_id: "PKG", provider, external_account_id: "a@example.test", status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: null }) as never;
const loader = { async loadConnection(_l: string, id: string) { return row(id, id === G ? "google" : id === M ? "microsoft" : "quickbooks"); } };
const action = { id: "a", lane_id: "PKG", connection_id: G, action_type: "email.send", target: {}, payload: {}, payload_schema_version: 1, payload_sha256: "x", approved_by: "u" } as unknown as EmailApprovedAction;

function setup(providers: ("google" | "microsoft")[], microsoftReal = false) {
  const log: string[] = [];
  const spy = (p: string): EmailWriteEntry => ({
    actionTypes: ["email.send"],
    async executeWrite(_l, c) { log.push(`${p}:execute:${c.id}`); return { outcome: "accepted", external_id: "x" } as never; },
    async verifyWrite(_l, c) { log.push(`${p}:verify:${c.id}`); },
    async findWrite(_l, c) { log.push(`${p}:find:${c.id}`); return []; },
  });
  const settings = { providers, microsoft: providers.includes("microsoft") ? { cloud: "commercial" as const, tenantIds: [], allowGcc: false, mailFolders: [], calendarIds: null } : null };
  const gate = createProviderGate({ laneConfig: { mailProviderSettings: async () => settings } as never });
  const d = createEmailWriteDispatch({ loader, gate, entries: { google: spy("google"), microsoft: microsoftReal ? microsoftEmailWriteEntry : spy("microsoft") } });
  return { log, d };
}

describe("email write dispatch", () => {
  it("executes, finds and verifies on the entry of the row's own provider", async () => {
    const { log, d } = setup(["google", "microsoft"]);
    for (const id of [G, M]) {
      const c = await d.loadWriteConnection("PKG", id);
      await d.writer.executeWrite("PKG", c, action);
      await d.writer.findWrite("PKG", c, action);
      await d.writer.verifyWrite("PKG", c, action, "ext");
    }
    expect(log).toEqual([`google:execute:${G}`, `google:find:${G}`, `google:verify:${G}`, `microsoft:execute:${M}`, `microsoft:find:${M}`, `microsoft:verify:${M}`]);
  });

  it("refuses a connection whose provider is not enabled for the lane before any call, in each direction", async () => {
    const onlyGoogle = setup(["google"]);
    const m = await onlyGoogle.d.loadWriteConnection("PKG", M);
    expect(isProviderDisabledError(await onlyGoogle.d.writer.executeWrite("PKG", m, action).catch((e: unknown) => e))).toBe(true);
    expect(isProviderDisabledError(await onlyGoogle.d.writer.findWrite("PKG", m, action).catch((e: unknown) => e))).toBe(true);
    const onlyMs = setup(["microsoft"]);
    const g = await onlyMs.d.loadWriteConnection("PKG", G);
    expect(isProviderDisabledError(await onlyMs.d.writer.verifyWrite("PKG", g, action, "x").catch((e: unknown) => e))).toBe(true);
    expect([...onlyGoogle.log, ...onlyMs.log]).toEqual([]);
  });

  it("the Microsoft write entry answers unsupported_op; a QuickBooks row is not an email connection; a copied connection is refused", async () => {
    const { d } = setup(["google", "microsoft"], true);
    const m = await d.loadWriteConnection("PKG", M);
    await expect(d.writer.executeWrite("PKG", m, action)).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(d.loadWriteConnection("PKG", "00000000-0000-4000-8000-000000000e09")).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(d.writer.executeWrite("PKG", { ...m, bound: false } as never, action)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });
});
