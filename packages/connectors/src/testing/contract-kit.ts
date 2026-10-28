// Reusable contract test kit: every connector registers itself with `describeConnectorContract` in its own test file.
//
//   describeConnectorContract({ name: "quickbooks", setup: () => ({ connector, laneId, otherLaneId, ... }) });
//
// The checks are also exported (`contractChecks`) so the kit's own tests can prove it catches broken connectors.
import { describe, expect, it } from "vitest";
import type { LaneId } from "@nichols/core";
import type { Connector } from "../contract/connector";
import { ConnectorError } from "../contract/errors";
import {
  ConnectionSchema,
  ConnectorErrorInfoSchema,
  HealthStatusSchema,
  ProposedPayloadSchema,
  ProviderSchema,
  OpNameSchema,
  RawRecordSchema,
  SourceResultSchema,
  SubscriptionSchema,
  SyncSummarySchema,
  type ConnectInput,
  type Connection,
  type ConnectorErrorKind,
  type ReadOp,
  type WriteIntent,
} from "../contract/schemas";

export interface ContractHarness {
  connector: Connector;
  /** Synthetic lane the connection is made in. */
  laneId: LaneId;
  /** A different synthetic lane, used for cross-lane denial checks. */
  otherLaneId: LaneId;
  /** Synthetic OAuth result the provider mock (MSW / sandbox fixture) accepts. */
  connectInput: ConnectInput;
  /** At least one valid read op; each is executed against a fresh connection. */
  readOps: ReadOp[];
  /** Required when the connector has `prepareWrite`. */
  writeIntents?: WriteIntent[];
  /** Required when the connector has `prepareWrite`: number of write calls the provider mock has received. */
  externalWriteCount?: () => number;
  /** Canary values the connector can see (synthetic tokens, client secret). None may appear in any output or error. */
  secrets: string[];
  teardown?: () => void | Promise<void>;
}

export interface ConnectorContractFixture {
  name: string;
  /** Called once per check, so every check gets fresh state. */
  setup: () => ContractHarness | Promise<ContractHarness>;
}

export interface ContractCheck {
  name: string;
  /** When false the check does not apply (e.g. no `sync`) and is reported as skipped. */
  applies?: (connector: Connector) => boolean;
  run: (h: ContractHarness) => Promise<void>;
}

const CLOCK_SKEW_MS = 5_000;
const UNSUPPORTED_OP: ReadOp = { op: "contract_kit.unsupported_op", params: {} };

function assertNoSecrets(h: ContractHarness, value: unknown, where: string): void {
  const text = value instanceof Error ? `${value.message}\n${JSON.stringify(value)}` : JSON.stringify(value) ?? "";
  for (const secret of h.secrets) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error(`${where} contains a secret canary`);
    }
  }
}

async function expectConnectorError(
  h: ContractHarness,
  action: () => Promise<unknown>,
  kinds: readonly ConnectorErrorKind[],
  where: string,
): Promise<ConnectorError> {
  let thrown: unknown;
  try {
    await action();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) throw new Error(`${where}: expected a ConnectorError (${kinds.join("|")}), got success`);
  if (!(thrown instanceof ConnectorError)) throw new Error(`${where}: expected a ConnectorError, got ${String(thrown)}`);
  expect(ConnectorErrorInfoSchema.safeParse(thrown.info).success, `${where}: invalid error info`).toBe(true);
  expect(kinds, `${where}: unexpected error kind ${thrown.info.kind}`).toContain(thrown.info.kind);
  assertNoSecrets(h, thrown, `${where} error`);
  return thrown;
}

async function connect(h: ContractHarness): Promise<Connection> {
  const conn = await h.connector.connect(h.laneId, h.connectInput);
  return ConnectionSchema.parse(conn);
}

function expectFeaturesDeclared(h: ContractHarness, features: Record<string, boolean> | undefined, where: string): void {
  for (const key of Object.keys(features ?? {})) {
    expect(h.connector.featureKeys, `${where}: feature ${key} not declared in featureKeys`).toContain(key);
  }
}

async function drain<T, R>(gen: AsyncGenerator<T, R, void>): Promise<{ items: T[]; result: R }> {
  const items: T[] = [];
  let next = await gen.next();
  while (!next.done) {
    items.push(next.value);
    next = await gen.next();
  }
  return { items, result: next.value };
}

/** Lane and status denial shared by every connection-taking method. */
async function expectGuarded(h: ContractHarness, call: (laneId: LaneId, conn: Connection) => Promise<unknown>, where: string) {
  const conn = await connect(h);
  await expectConnectorError(h, () => call(h.otherLaneId, conn), ["lane_mismatch"], `${where} from another lane`);
  await expectConnectorError(h, () => call(h.laneId, { ...conn, lane_id: h.otherLaneId }), ["lane_mismatch"], `${where} with a foreign connection`);
  const rr = await expectConnectorError(h, () => call(h.laneId, { ...conn, status: "reconnect_required" }), ["reconnect_required"], `${where} on reconnect_required`);
  expect(rr.info.disposition, `${where}: reconnect_required must never be retried`).toBe("reconnect_required");
  await expectConnectorError(h, () => call(h.laneId, { ...conn, status: "disconnected" }), ["connection_unavailable"], `${where} on disconnected`);
}

export const contractChecks: readonly ContractCheck[] = [
  {
    name: "exposes no executeWrite on the connector surface",
    run: async (h) => {
      expect("executeWrite" in h.connector, "executeWrite belongs on a ConnectorWriter (approvals only)").toBe(false);
    },
  },
  {
    name: "declares capabilities that match its methods",
    run: async (h) => {
      const c = h.connector;
      expect(c.capabilities.sync, "capabilities.sync").toBe(typeof c.sync === "function");
      expect(c.capabilities.subscribe, "capabilities.subscribe").toBe(typeof c.subscribe === "function");
      expect(c.capabilities.prepareWrite, "capabilities.prepareWrite").toBe(typeof c.prepareWrite === "function");
      expect(c.capabilities.disconnect, "capabilities.disconnect").toBe(typeof c.disconnect === "function");
    },
  },
  {
    name: "declares a known provider and well-formed readOps and featureKeys",
    run: async (h) => {
      const c = h.connector;
      expect(ProviderSchema.safeParse(c.provider).success, "provider").toBe(true);
      expect(c.readOps.length, "at least one read op").toBeGreaterThan(0);
      for (const op of c.readOps) expect(OpNameSchema.safeParse(op).success, `read op ${op}`).toBe(true);
      for (const key of c.featureKeys) expect(key).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(h.readOps.length, "harness must supply at least one read op").toBeGreaterThan(0);
      expect(h.secrets.length, "harness must supply secret canaries").toBeGreaterThan(0);
      expect(h.otherLaneId).not.toBe(h.laneId);
    },
  },
  {
    name: "connect returns an active Connection in the caller's lane",
    run: async (h) => {
      const conn = await connect(h);
      expect(conn.lane_id).toBe(h.laneId);
      expect(conn.provider).toBe(h.connector.provider);
      expect(conn.status).toBe("active");
      expectFeaturesDeclared(h, conn.features, "connect");
      assertNoSecrets(h, conn, "connection");
    },
  },
  {
    name: "connect rejects an empty laneId",
    run: async (h) => {
      await expectConnectorError(h, () => h.connector.connect("", h.connectInput), ["invalid_input"], "connect");
    },
  },
  {
    name: "health returns a valid HealthStatus",
    run: async (h) => {
      const conn = await connect(h);
      const health = HealthStatusSchema.parse(await h.connector.health(h.laneId, conn));
      if (health.ok) expect(health.error, "ok health has no error").toBeNull();
      else expect(health.error, "failing health carries an error").not.toBeNull();
      expectFeaturesDeclared(h, health.features, "health");
      assertNoSecrets(h, health, "health");
    },
  },
  {
    name: "health rejects a connection from another lane",
    run: async (h) => {
      const conn = await connect(h);
      await expectConnectorError(h, () => h.connector.health(h.otherLaneId, conn), ["lane_mismatch"], "health");
    },
  },
  {
    name: "read returns a valid SourceResult with as_of and freshness",
    run: async (h) => {
      const conn = await connect(h);
      for (const op of h.readOps) {
        const result = SourceResultSchema.parse(await h.connector.read(h.laneId, conn, op));
        expect(result.lane_id).toBe(h.laneId);
        expect(result.connection_id).toBe(conn.id);
        expect(result.provider).toBe(h.connector.provider);
        expect(result.op).toBe(op.op);
        expect(Date.parse(result.as_of), "as_of is not after fetched_at").toBeLessThanOrEqual(Date.parse(result.fetched_at) + CLOCK_SKEW_MS);
        assertNoSecrets(h, result, `read ${op.op}`);
      }
    },
  },
  {
    name: "read rejects a connection from another lane",
    run: async (h) => {
      const conn = await connect(h);
      const op = h.readOps[0]!;
      await expectConnectorError(h, () => h.connector.read(h.otherLaneId, conn, op), ["lane_mismatch"], "read");
      await expectConnectorError(h, () => h.connector.read(h.laneId, { ...conn, lane_id: h.otherLaneId }, op), ["lane_mismatch"], "read foreign connection");
    },
  },
  {
    name: "read refuses a reconnect_required connection without retry",
    run: async (h) => {
      const conn = await connect(h);
      const op = h.readOps[0]!;
      const err = await expectConnectorError(h, () => h.connector.read(h.laneId, { ...conn, status: "reconnect_required" }, op), ["reconnect_required"], "read");
      expect(err.info.disposition).toBe("reconnect_required");
      await expectConnectorError(h, () => h.connector.read(h.laneId, { ...conn, status: "disconnected" }, op), ["connection_unavailable"], "read disconnected");
    },
  },
  {
    name: "read rejects an unsupported op with a ConnectorError",
    run: async (h) => {
      const conn = await connect(h);
      await expectConnectorError(h, () => h.connector.read(h.laneId, conn, UNSUPPORTED_OP), ["unsupported_op"], "read unsupported op");
      await expectConnectorError(h, () => h.connector.read(h.laneId, conn, { op: "Not A Valid Op" }), ["invalid_input", "unsupported_op"], "read malformed op");
    },
  },
  {
    name: "sync yields valid RawRecords and returns a cursor",
    applies: (c) => typeof c.sync === "function",
    run: async (h) => {
      const conn = await connect(h);
      const full = await drain(h.connector.sync!(h.laneId, conn, null));
      const summary = SyncSummarySchema.parse(full.result);
      expect(summary.mode, "a sync without a cursor is a full load").toBe("full");
      expect(summary.records, "summary counts yielded records").toBe(full.items.length);
      for (const item of full.items) {
        const record = RawRecordSchema.parse(item);
        expect(record.lane_id).toBe(h.laneId);
        expect(record.connection_id).toBe(conn.id);
        expect(record.provider).toBe(h.connector.provider);
      }
      assertNoSecrets(h, full, "sync");
      const again = await drain(h.connector.sync!(h.laneId, conn, summary.cursor));
      SyncSummarySchema.parse(again.result);
      for (const item of again.items) RawRecordSchema.parse(item);
    },
  },
  {
    name: "sync rejects another lane and unusable connections",
    applies: (c) => typeof c.sync === "function",
    run: async (h) => {
      await expectGuarded(h, (laneId, conn) => h.connector.sync!(laneId, conn, null).next(), "sync");
    },
  },
  {
    name: "subscribe returns a valid Subscription",
    applies: (c) => typeof c.subscribe === "function",
    run: async (h) => {
      const conn = await connect(h);
      const sub = SubscriptionSchema.parse(await h.connector.subscribe!(h.laneId, conn));
      expect(sub.lane_id).toBe(h.laneId);
      expect(sub.connection_id).toBe(conn.id);
      expect(sub.provider).toBe(h.connector.provider);
      assertNoSecrets(h, sub, "subscribe");
      await expectGuarded(h, (laneId, c) => h.connector.subscribe!(laneId, c), "subscribe");
    },
  },
  {
    name: "prepareWrite returns a ProposedPayload and never executes",
    applies: (c) => typeof c.prepareWrite === "function",
    run: async (h) => {
      expect(h.writeIntents?.length ?? 0, "harness must supply writeIntents").toBeGreaterThan(0);
      expect(typeof h.externalWriteCount, "harness must supply externalWriteCount").toBe("function");
      const conn = await connect(h);
      const before = h.externalWriteCount!();
      for (const intent of h.writeIntents!) {
        const proposed = ProposedPayloadSchema.parse(await h.connector.prepareWrite!(h.laneId, conn, intent));
        expect(proposed.lane_id).toBe(h.laneId);
        expect(proposed.connection_id).toBe(conn.id);
        expect(proposed.provider).toBe(h.connector.provider);
        expect(proposed.action_type).toBe(intent.action_type);
        assertNoSecrets(h, proposed, "prepareWrite");
      }
      expect(h.externalWriteCount!(), "prepareWrite must not write to the provider").toBe(before);
    },
  },
  {
    name: "prepareWrite rejects another lane and unusable connections",
    applies: (c) => typeof c.prepareWrite === "function",
    run: async (h) => {
      const intent = h.writeIntents?.[0];
      expect(intent, "harness must supply writeIntents").toBeDefined();
      await expectGuarded(h, (laneId, conn) => h.connector.prepareWrite!(laneId, conn, intent!), "prepareWrite");
    },
  },
  {
    name: "disconnect returns the connection as disconnected",
    applies: (c) => typeof c.disconnect === "function",
    run: async (h) => {
      const conn = await connect(h);
      await expectConnectorError(h, () => h.connector.disconnect!(h.otherLaneId, conn), ["lane_mismatch"], "disconnect");
      const out = ConnectionSchema.parse(await h.connector.disconnect!(h.laneId, conn));
      expect(out.id).toBe(conn.id);
      expect(out.lane_id).toBe(h.laneId);
      expect(out.status).toBe("disconnected");
      assertNoSecrets(h, out, "disconnect");
    },
  },
];

/** Registers the full contract suite for one connector. Call it at the top level of the connector's test file. */
export function describeConnectorContract(fixture: ConnectorContractFixture): void {
  describe(`connector contract: ${fixture.name}`, () => {
    for (const check of contractChecks) {
      it(check.name, async (ctx) => {
        const h = await fixture.setup();
        try {
          if (check.applies && !check.applies(h.connector)) {
            ctx.skip();
            return;
          }
          await check.run(h);
        } finally {
          await h.teardown?.();
        }
      });
    }
  });
}
