// The mock passes the shared comms provider contract (push and polling, both vendors), and the suite's own checks
// catch a provider that has an execute path.
import { describe, expect, it } from "vitest";
import { checkNoExecutePath, describeCommsContract } from "./comms-contract";
import { createMockComms } from "./comms-mock";
import { UntrustedBody } from "../comms/ephemeral";
import { ConnectorError } from "../contract/errors";
import { computePayloadSha256, type ApprovedActionShape, type ConnectorWriter } from "../contract/writer";
import type { MailProvider } from "../comms/provider";
import { checkGuards } from "./comms-contract";

for (const provider of ["google", "microsoft"] as const) {
  for (const watch of ["push", "polling"] as const) {
    describeCommsContract({
      name: `mock ${provider} (${watch})`,
      expect: { mail: true, calendar: true, documents: true },
      setup: () => {
        const m = createMockComms({ provider, watch });
        return { ...m, mail: m.mail, calendar: m.calendar, documents: m.documents, connect: m.connect.bind(m), connectForeignProvider: m.connectForeignProvider.bind(m) };
      },
    });
  }
}

describe("comms contract self-checks", () => {
  it("fails a provider that fetches from the API and then errors for a foreign-provider connection", async () => {
    const m = createMockComms();
    let leaked = 0;
    const leaky: MailProvider = {
      ...m.mail,
      async sync(lane, conn, cursor, opts) {
        if (conn.provider !== m.provider) {
          leaked++; // "fetched" before checking the provider
          throw new ConnectorError({ kind: "provider_error", message: "boom" });
        }
        return m.mail.sync(lane, conn, cursor, opts);
      },
    };
    const harness = { ...m, externalRequestCount: () => m.externalRequestCount() + leaked };
    await expect(checkGuards(harness, [(p, c, l) => (p as MailProvider).sync(l, c, null)], leaky)).rejects.toThrow();
    await expect(checkGuards(m, [(p, c, l) => (p as MailProvider).sync(l, c, null)], m.mail)).resolves.toBeUndefined();
  });

  it("allows underscore helpers but not execute-like members", () => {
    const m = createMockComms();
    expect(() => checkNoExecutePath({ ...m.mail, _helper: () => 1 })).not.toThrow();
    expect(() => checkNoExecutePath({ ...m.mail, createDraft: () => 1 })).toThrow();
  });

  it("a prepareWrite payload fits a ConnectorWriter action for the same provider (T-116 can execute it)", async () => {
    const m = createMockComms();
    const conn = await m.connect();
    const p = await m.mail.prepareWrite(m.laneId, conn, { action_type: "email.send", compose: { fromMailbox: conn.external_account_id, to: ["a@example.test"], cc: [], bcc: [], subject: "s", bodyText: "b" } });
    const action: ApprovedActionShape = {
      id: "00000000-0000-4000-8000-000000000001",
      lane_id: p.lane_id,
      connection_id: p.connection_id,
      action_type: p.action_type,
      target: p.target,
      payload: p.payload,
      payload_schema_version: p.payload_schema_version,
      payload_sha256: computePayloadSha256(p),
    };
    // Type-level: the action is accepted wherever a ConnectorWriter takes its action (the writer's method name is
    // restricted outside approvals, so the shape is checked through the exported action type).
    const writerActionTypes: ConnectorWriter["actionTypes"] = ["email.send", "email.save_draft"];
    expect(writerActionTypes).toContain(action.action_type);
    expect(action.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(action.lane_id).toBe(m.laneId);
  });

  it("rejects a provider with an execute path", () => {
    const m = createMockComms();
    expect(() => checkNoExecutePath({ ...m.mail, sendMessage: async () => 1 })).toThrow();
    expect(() => checkNoExecutePath({ ...m.mail, executeWrite: async () => 1 })).toThrow();
    expect(() => checkNoExecutePath(m.mail)).not.toThrow();
  });

  it("counts a prepareWrite that writes (fault injection)", async () => {
    const m = createMockComms({ faults: { prepareWriteExecutes: true } });
    const conn = await m.connect();
    await m.mail.prepareWrite(m.laneId, conn, { action_type: "email.send", compose: { fromMailbox: conn.external_account_id, to: ["a@example.test"], cc: [], bcc: [], subject: "s", bodyText: "b" } });
    expect(m.externalWriteCount()).toBe(1);
  });

  it("UntrustedBody never serialises its text", () => {
    const b = new UntrustedBody({ origin: "mail", contentType: "text/plain", text: "secret-body" });
    expect(JSON.stringify(b)).not.toContain("secret-body");
    expect(`${String(b)}`).not.toContain("secret-body");
    expect(JSON.stringify({ ...b })).not.toContain("secret-body");
    expect(b.reveal()).toBe("secret-body");
    expect(Object.isFrozen(b)).toBe(true);
  });
});
