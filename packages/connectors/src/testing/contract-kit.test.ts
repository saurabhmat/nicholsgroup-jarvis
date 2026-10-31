import { describe, expect, it } from "vitest";
import { contractChecks, describeConnectorContract, runContractCheck, type ContractHarness } from "./contract-kit";
import { createMockConnector, MOCK_SECRET_CANARY, mockHarness, type MockConnectorOptions } from "./mock-connector";
import type { Connector } from "../contract/connector";
import { ConnectorError } from "../contract/errors";
import type { TestProvider } from "./test-provider";

// 1. The mock connector passes the full kit, in each shape it supports.
describeConnectorContract({ name: "mock (read + sync + subscribe + prepareWrite)", setup: () => mockHarness() });
describeConnectorContract({ name: "mock (read-only, no sync)", setup: () => mockHarness({ readOnly: true, sync: false, subscribe: false }) });

// 2. The kit catches broken connectors: each mutation must make the named check fail for the stated reason.
async function runCheck(name: string, harness: ContractHarness): Promise<string> {
  const check = contractChecks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  try {
    await runContractCheck(check, harness);
  } catch (e) {
    return String(e);
  }
  return "(check passed)";
}

type C = Connector<TestProvider>;
function patched(patch: (c: C, h: ContractHarness) => C, options?: MockConnectorOptions): ContractHarness {
  const base = mockHarness(options);
  return { ...base, connector: patch(base.connector, base) };
}

describe("contract kit catches broken connectors", () => {
  it("has uniquely named checks", () => {
    const names = contractChecks.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(18);
  });

  it("flags a connector that exposes executeWrite", async () => {
    const h = patched((c) => ({ ...c, executeWrite: async () => ({}) }) as unknown as C);
    expect(await runCheck("exposes only contract methods (no executeWrite)", h)).toMatch(/ConnectorWriter/);
  });

  it("flags a connector with an unknown function-valued key", async () => {
    const h = patched((c) => ({ ...c, rawFetch: async () => ({}) }) as unknown as C);
    expect(await runCheck("exposes only contract methods (no executeWrite)", h)).toMatch(/non-contract function rawFetch/);
  });

  it("flags capability flags that disagree with the methods", async () => {
    const h = patched((c) => ({ ...c, capabilities: { ...c.capabilities, sync: false } }));
    expect(await runCheck("declares capabilities that match its methods", h)).toMatch(/capabilities\.sync/);
  });

  it("flags a connector that ignores the caller's lane and the brand", async () => {
    const h = patched((c, base) => ({
      ...c,
      read: async (_laneId, conn, op) => c.read(base.laneId, await base.loader.loadConnection(base.laneId, conn.id), op),
    }));
    expect(await runCheck("read rejects other lanes, forged and unusable connections", h)).toMatch(/from another lane: expected a ConnectorError \(lane_mismatch\), got success/);
  });

  it("flags a connector that trusts the caller's status", async () => {
    const h = mockHarness({ faults: { trustCallerStatus: true } });
    expect(await runCheck("read rejects other lanes, forged and unusable connections", h)).toMatch(/marked reconnect_required: expected a ConnectorError \(reconnect_required\), got success/);
  });

  it("flags a cross-lane reconnect", async () => {
    const h = mockHarness({ faults: { crossLaneReconnect: true } });
    expect(await runCheck("connect refuses a cross-lane reconnect", h)).toMatch(/cross-lane reconnect: expected a ConnectorError.*got success/);
  });

  it("flags a read result without a valid as_of", async () => {
    const h = patched((c) => ({ ...c, read: async (laneId, conn, op) => ({ ...(await c.read(laneId, conn, op)), as_of: "yesterday" }) }));
    expect(await runCheck("read returns a valid SourceResult with as_of and freshness", h)).toMatch(/as_of/);
  });

  it("flags a connector that throws plain errors for unsupported ops", async () => {
    const h = patched((c) => ({
      ...c,
      read: async (laneId, conn, op) => {
        if (!c.readOps.includes(op.op)) throw new Error("nope");
        return c.read(laneId, conn, op);
      },
    }));
    expect(await runCheck("read rejects an unsupported op with a ConnectorError", h)).toMatch(/got Error: nope/);
  });

  it("flags a ConnectorError subclass carrying hidden data", async () => {
    class LeakyError extends ConnectorError {}
    const h = patched((c) => ({
      ...c,
      read: async (laneId, conn, op) => {
        if (!c.readOps.includes(op.op)) throw new LeakyError({ kind: "unsupported_op", message: "Unsupported" });
        return c.read(laneId, conn, op);
      },
    }));
    expect(await runCheck("read rejects an unsupported op with a ConnectorError", h)).toMatch(/prototype must be exactly ConnectorError\.prototype/);
  });

  it("flags a connection that leaks a secret", async () => {
    const h = mockHarness();
    h.secrets = ["mock-account-1"]; // pretend the account id is secret: it appears in the connection
    expect(await runCheck("connect returns an active lane-bound Connection in the caller's lane", h)).toMatch(/connection contains a secret canary/);
  });

  it("flags an error message that leaks a secret, raw or encoded", async () => {
    for (const leak of [MOCK_SECRET_CANARY, Buffer.from(MOCK_SECRET_CANARY).toString("base64")]) {
      const h = patched((c) => ({
        ...c,
        read: async (laneId, conn, op) => {
          if (!c.readOps.includes(op.op)) throw new ConnectorError({ kind: "unsupported_op", message: `bad op with ${leak}` });
          return c.read(laneId, conn, op);
        },
      }));
      expect(await runCheck("read rejects an unsupported op with a ConnectorError", h)).toMatch(/error contains a secret canary/);
    }
  });

  it("flags sync records from the wrong lane", async () => {
    const h = patched((c) => ({
      ...c,
      sync: (laneId, conn, cursor, sink, options) =>
        c.sync!(laneId, conn, cursor, (batch) => sink(batch.map((r) => ({ ...r, lane_id: "lane-synthetic-other" }))), options),
    }));
    expect(await runCheck("sync hands valid RawRecords to the sink and returns a cursor", h)).toMatch(/lane-synthetic-other/);
  });

  it("flags a sync that swallows sink failures", async () => {
    const h = patched((c) => ({
      ...c,
      sync: (laneId, conn, cursor, sink, options) =>
        c.sync!(laneId, conn, cursor, async (batch) => {
          await sink(batch).catch(() => undefined);
        }, options),
    }));
    expect(await runCheck("sync hands valid RawRecords to the sink and returns a cursor", h)).toMatch(/propagate a sink failure/);
  });

  it("flags a prepareWrite that performs an external write", async () => {
    const h = mockHarness({ faults: { prepareWriteExecutes: true } });
    expect(await runCheck("prepareWrite returns a ProposedPayload and never executes", h)).toMatch(/must not write to the provider/);
  });

  it("flags external writes in any check outside disconnect", async () => {
    let extra = 0;
    const base = mockHarness();
    const original = base.connector;
    const h: ContractHarness = {
      ...base,
      externalWriteCount: () => base.externalWriteCount() + extra,
      connector: {
        ...original,
        health: async (laneId, conn) => {
          extra += 1;
          return original.health(laneId, conn);
        },
      },
    };
    expect(await runCheck("health rejects other lanes and forged connections", h)).toMatch(/external write\(s\) but only 0 disconnect/);
  });

  it("flags a connector that detects undeclared features", async () => {
    const h = patched((c) => ({ ...c, featureKeys: [] }));
    expect(await runCheck("health returns a valid HealthStatus", h)).toMatch(/not declared in featureKeys/);
  });

  it("flags health that throws for an unusable connection", async () => {
    const h = patched((c) => ({
      ...c,
      health: async (laneId, conn) => {
        await c.read(laneId, conn, { op: "mock.summary" });
        return c.health(laneId, conn);
      },
    }));
    expect(await runCheck("health reports unusable connections without throwing", h)).toMatch(/ConnectorError: Connection needs to be reconnected/);
  });

  it("flags a disconnect that does not revoke", async () => {
    const h = mockHarness();
    h.externalWriteCount = () => 0;
    expect(await runCheck("disconnect revokes and returns the connection as disconnected", h)).toMatch(/revokes at the provider/);
  });
});

describe("createMockConnector", () => {
  it("counts zero external writes after prepareWrite", async () => {
    const h = mockHarness();
    const conn = await h.connector.connect(h.laneId, h.connectInput);
    await h.connector.prepareWrite!(h.laneId, conn, h.writeIntents![0]!);
    expect(h.externalWriteCount()).toBe(0);
  });

  it("delivers sync records in batches and resumes incrementally", async () => {
    const { connector } = createMockConnector({ recordCount: 3 });
    const h = mockHarness();
    const conn = await connector.connect(h.laneId, h.connectInput);
    const batches: number[] = [];
    const first = await connector.sync!(h.laneId, conn, null, async (batch) => {
      batches.push(batch.length);
    });
    expect(batches).toEqual([2, 1]);
    expect(first.mode).toBe("full");
    expect(first.records).toBe(3);
    const second = await connector.sync!(h.laneId, conn, first.cursor, async () => {});
    expect(second).toMatchObject({ mode: "incremental", records: 0 });
  });

  it("filters sync by object type", async () => {
    const { connector } = createMockConnector();
    const h = mockHarness();
    const conn = await connector.connect(h.laneId, h.connectInput);
    const summary = await connector.sync!(h.laneId, conn, null, async () => {}, { objectTypes: ["Invoice"] });
    expect(summary.records).toBe(0);
  });

  it("reconnects in the same lane, reusing the connection row", async () => {
    const h = mockHarness();
    const conn = await h.connector.connect(h.laneId, h.connectInput);
    await h.markReconnectRequired(conn);
    const again = await h.connector.connect(h.laneId, { ...h.connectInput, reconnect_connection_id: conn.id });
    expect(again.id).toBe(conn.id);
    expect(again.status).toBe("active");
    await h.connector.read(h.laneId, again, { op: "mock.summary" });
  });

  it("refuses a reconnect for a different account", async () => {
    const h = mockHarness();
    const conn = await h.connector.connect(h.laneId, h.connectInput);
    await expect(
      h.connector.connect(h.laneId, { ...h.connectInput, external_account_id: "mock-account-2", reconnect_connection_id: conn.id }),
    ).rejects.toMatchObject({ info: { kind: "invalid_input" } });
  });
});
