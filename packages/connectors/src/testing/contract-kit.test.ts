import { describe, expect, it } from "vitest";
import { contractChecks, describeConnectorContract, type ContractHarness } from "./contract-kit";
import { createMockConnector, MOCK_SECRET_CANARY, mockHarness } from "./mock-connector";
import type { Connector } from "../contract/connector";
import { ConnectorError } from "../contract/errors";

// 1. The mock connector passes the full kit, in each shape it supports.
describeConnectorContract({ name: "mock (read + sync + subscribe + prepareWrite)", setup: () => mockHarness() });
describeConnectorContract({ name: "mock (read-only, no sync)", setup: () => mockHarness({ readOnly: true, sync: false, subscribe: false }) });

// 2. The kit catches broken connectors: each mutation must make at least the named check fail.
async function runCheck(name: string, harness: ContractHarness): Promise<string> {
  const check = contractChecks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  try {
    await check.run(harness);
  } catch (e) {
    return String(e);
  }
  return "(check passed)";
}

function withConnector(base: ContractHarness, patch: (c: Connector) => Connector): ContractHarness {
  return { ...base, connector: patch(base.connector) };
}

describe("contract kit catches broken connectors", () => {
  it("has uniquely named checks", () => {
    const names = contractChecks.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("flags a connector that exposes executeWrite", async () => {
    const h = withConnector(mockHarness(), (c) => ({ ...c, executeWrite: async () => ({}) }) as unknown as Connector);
    expect(await runCheck("exposes no executeWrite on the connector surface", h)).toMatch(/ConnectorWriter/);
  });

  it("flags capability flags that disagree with the methods", async () => {
    const h = withConnector(mockHarness(), (c) => ({ ...c, capabilities: { ...c.capabilities, sync: false } }));
    expect(await runCheck("declares capabilities that match its methods", h)).toMatch(/capabilities\.sync/);
  });

  it("flags a connector that ignores the laneId on read", async () => {
    const base = mockHarness();
    const h = withConnector(base, (c) => ({
      ...c,
      read: (_laneId, conn, op) => c.read(conn.lane_id, conn, op),
    }));
    expect(await runCheck("read rejects a connection from another lane", h)).toMatch(/expected a ConnectorError \(lane_mismatch\), got success/);
  });

  it("flags a connector that reads through a reconnect_required connection", async () => {
    const base = mockHarness();
    const h = withConnector(base, (c) => ({
      ...c,
      read: (laneId, conn, op) => c.read(laneId, { ...conn, status: "active" }, op),
    }));
    expect(await runCheck("read refuses a reconnect_required connection without retry", h)).toMatch(/expected a ConnectorError \(reconnect_required\), got success/);
  });

  it("flags a read result without a valid as_of", async () => {
    const h = withConnector(mockHarness(), (c) => ({
      ...c,
      read: async (laneId, conn, op) => ({ ...(await c.read(laneId, conn, op)), as_of: "yesterday" }),
    }));
    expect(await runCheck("read returns a valid SourceResult with as_of and freshness", h)).toMatch(/as_of/);
  });

  it("flags a connector that throws plain errors for unsupported ops", async () => {
    const h = withConnector(mockHarness(), (c) => ({
      ...c,
      read: async (laneId, conn, op) => {
        if (!c.readOps.includes(op.op)) throw new Error("nope");
        return c.read(laneId, conn, op);
      },
    }));
    expect(await runCheck("read rejects an unsupported op with a ConnectorError", h)).toMatch(/got Error: nope/);
  });

  it("flags a connection that leaks a secret", async () => {
    const h = withConnector(mockHarness(), (c) => ({
      ...c,
      connect: async (laneId, input) => ({ ...(await c.connect(laneId, input)), external_account_id: MOCK_SECRET_CANARY }),
    }));
    expect(await runCheck("connect returns an active Connection in the caller's lane", h)).toMatch(/connection contains a secret canary/);
  });

  it("flags an error message that leaks a secret", async () => {
    const h = withConnector(mockHarness(), (c) => ({
      ...c,
      read: async (laneId, conn, op) => {
        if (!c.readOps.includes(op.op)) throw new ConnectorError({ kind: "unsupported_op", message: `bad op with ${MOCK_SECRET_CANARY}` });
        return c.read(laneId, conn, op);
      },
    }));
    expect(await runCheck("read rejects an unsupported op with a ConnectorError", h)).toMatch(/error contains a secret canary/);
  });

  it("flags sync records from the wrong lane", async () => {
    const h = withConnector(mockHarness(), (c) => ({
      ...c,
      sync: async function* (laneId, conn, cursor) {
        const gen = c.sync!(laneId, conn, cursor);
        let next = await gen.next();
        while (!next.done) {
          yield { ...next.value, lane_id: "lane-synthetic-other" };
          next = await gen.next();
        }
        return next.value;
      },
    }));
    expect(await runCheck("sync yields valid RawRecords and returns a cursor", h)).toMatch(/lane-synthetic-other/);
  });

  it("flags a prepareWrite that performs an external write", async () => {
    const h = mockHarness({ prepareWriteExecutes: true });
    expect(await runCheck("prepareWrite returns a ProposedPayload and never executes", h)).toMatch(/must not write to the provider/);
  });

  it("flags a connector that detects undeclared features", async () => {
    const h = withConnector(mockHarness(), (c) => ({ ...c, featureKeys: [] }));
    expect(await runCheck("health returns a valid HealthStatus", h)).toMatch(/not declared in featureKeys/);
  });
});

describe("createMockConnector", () => {
  it("counts zero external writes after prepareWrite", async () => {
    const h = mockHarness();
    const conn = await h.connector.connect(h.laneId, h.connectInput);
    await h.connector.prepareWrite!(h.laneId, conn, h.writeIntents![0]!);
    expect(h.externalWriteCount!()).toBe(0);
  });

  it("returns an incremental sync with only newer records", async () => {
    const connector = createMockConnector({ recordCount: 3 });
    const h = mockHarness();
    const conn = await connector.connect(h.laneId, h.connectInput);
    const first = connector.sync!(h.laneId, conn, null);
    let n = await first.next();
    let count = 0;
    while (!n.done) {
      count += 1;
      n = await first.next();
    }
    expect(count).toBe(3);
    expect(n.value.mode).toBe("full");
    const second = connector.sync!(h.laneId, conn, n.value.cursor);
    const r = await second.next();
    expect(r.done).toBe(true);
    if (r.done) expect(r.value.mode).toBe("incremental");
  });
});
