// Reusable contract test kit: every connector registers itself with `describeConnectorContract` in its own test file.
//
//   describeConnectorContract({ name: "quickbooks", setup: () => ({ connector, loader, laneId, otherLaneId, ... }) });
//
// The checks are also exported (`contractChecks`) so the kit's own tests can prove it catches broken connectors.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { LaneId } from "@nichols/core";
import { CONNECTOR_KEYS, type Connector } from "../contract/connector";
import { ConnectorError } from "../contract/errors";
import { isLaneBound, type ConnectionLoader, type LaneBoundConnection } from "../contract/lane-bound";
import {
  ConnectorErrorInfoSchema,
  HealthStatusSchema,
  OpNameSchema,
  SyncSummarySchema,
  type ConnectInput,
  type ConnectorErrorKind,
  type ReadOp,
  type WriteIntent,
} from "../contract/schemas";
import { testSchemas, TestProviderSchema, type TestProvider } from "./test-provider";

type AnyConnection = LaneBoundConnection<TestProvider>;

export interface ContractHarness {
  connector: Connector<TestProvider>;
  /** Loader over the same store the connector uses (the real one comes with T-031/T-016/T-033). */
  loader: ConnectionLoader<TestProvider>;
  /** Synthetic lane the connection is made in. */
  laneId: LaneId;
  /** A different synthetic lane, used for cross-lane denial checks. */
  otherLaneId: LaneId;
  /** Synthetic connect input the provider mock (MSW / sandbox fixture) accepts. */
  connectInput: ConnectInput;
  /** At least one valid read op; each is executed against a fresh connection. */
  readOps: ReadOp[];
  /** Required when the connector has `prepareWrite`. */
  writeIntents?: WriteIntent[];
  /** Number of write calls the provider mock has received (revocations included). Must not move except on disconnect. */
  externalWriteCount: () => number;
  /** Mark the stored connection row `reconnect_required` (what T-195 does after `invalid_grant`). */
  markReconnectRequired: (conn: AnyConnection) => void | Promise<void>;
  /** Optional: make the provider mock answer `invalid_grant` on the next token refresh/use. */
  simulateInvalidGrant?: (conn: AnyConnection) => void | Promise<void>;
  /** Canary values the connector can see (synthetic tokens, client secret). None may appear in any output or error. */
  secrets: string[];
  teardown?: () => void | Promise<void>;
}

export interface ConnectorContractFixture {
  name: string;
  /** Called once per check, so every check gets fresh state. */
  setup: () => ContractHarness | Promise<ContractHarness>;
}

/** Per-run bookkeeping: revocations the check itself caused through `disconnect`. */
export interface CheckState {
  revokes: number;
}

export interface ContractCheck {
  name: string;
  /** When false the check does not apply (e.g. no `sync`) and is reported as skipped. */
  applies?: (h: ContractHarness) => boolean;
  run: (h: ContractHarness, state: CheckState) => Promise<void>;
}

const CLOCK_SKEW_MS = 5_000;
const UNSUPPORTED_OP: ReadOp = { op: "contract_kit.unsupported_op", params: {} };
const ERROR_OWN_KEYS = new Set<PropertyKey>(["name", "info", "message", "stack"]);
/** A value the harness or connector must supply; fails the test with its name (not a TypeError) when missing. */
function need<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`contract kit: ${what} is missing`);
  return value;
}

const DATA_KEYS = new Set<PropertyKey>(["provider", "capabilities", "readOps", "featureKeys"]);
const ALLOWED_KEYS = new Set<PropertyKey>(CONNECTOR_KEYS);

/** A canary plus the encodings it could leak in. */
function canaryForms(secret: string): string[] {
  const forms = [
    secret,
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
    encodeURIComponent(secret),
  ];
  return [...new Set(forms.filter((f) => f.length > 0))];
}

function renderForScan(value: unknown): string {
  const parts: string[] = [inspect(value, { depth: Infinity, showHidden: true, maxArrayLength: Infinity, maxStringLength: Infinity })];
  try {
    parts.push(JSON.stringify(value) ?? "");
  } catch {
    // circular structures are covered by inspect
  }
  let current: unknown = value;
  for (let i = 0; i < 10 && current instanceof Error; i += 1) {
    parts.push(current.message, current.stack ?? "");
    current = (current as { cause?: unknown }).cause;
    if (current !== undefined) parts.push(inspect(current, { depth: Infinity, showHidden: true }));
  }
  return parts.join("\n");
}

function assertNoSecrets(h: ContractHarness, value: unknown, where: string): void {
  const text = renderForScan(value);
  for (const secret of h.secrets) {
    for (const form of canaryForms(secret)) {
      if (text.includes(form)) throw new Error(`${where} contains a secret canary`);
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
  if (Object.getPrototypeOf(thrown) !== ConnectorError.prototype) throw new Error(`${where}: error prototype must be exactly ConnectorError.prototype`);
  expect((thrown as { cause?: unknown }).cause, `${where}: error must have no cause`).toBeUndefined();
  expect(Object.isExtensible(thrown), `${where}: error must be non-extensible`).toBe(false);
  for (const key of Reflect.ownKeys(thrown)) {
    if (!ERROR_OWN_KEYS.has(key)) throw new Error(`${where}: error has unexpected own property ${String(key)}`);
  }
  expect(ConnectorErrorInfoSchema.safeParse(thrown.info).success, `${where}: invalid error info`).toBe(true);
  expect(kinds, `${where}: unexpected error kind ${thrown.info.kind}`).toContain(thrown.info.kind);
  assertNoSecrets(h, thrown, `${where} error`);
  return thrown;
}

async function connect(h: ContractHarness): Promise<AnyConnection> {
  const conn = await h.connector.connect(h.laneId, h.connectInput);
  testSchemas.ConnectionSchema.parse(conn);
  return conn;
}

async function disconnect(h: ContractHarness, state: CheckState, laneId: LaneId, conn: AnyConnection): Promise<AnyConnection> {
  state.revokes += 1;
  return h.connector.disconnect(laneId, conn);
}

function expectFeaturesDeclared(h: ContractHarness, features: Record<string, boolean> | undefined, where: string): void {
  for (const key of Object.keys(features ?? {})) {
    expect(h.connector.featureKeys, `${where}: feature ${key} not declared in featureKeys`).toContain(key);
  }
}

/** Forged copies (another lane, or an exact unminted copy) and a minted connection used from another lane. */
async function expectLaneEnforced(h: ContractHarness, call: (laneId: LaneId, conn: AnyConnection) => Promise<unknown>, where: string) {
  const conn = await connect(h);
  await expectConnectorError(h, () => call(h.otherLaneId, conn), ["lane_mismatch"], `${where} from another lane`);
  const forgedOther = { ...conn, lane_id: h.otherLaneId } as AnyConnection;
  await expectConnectorError(h, () => call(h.otherLaneId, forgedOther), ["lane_mismatch", "not_found"], `${where} with a forged other-lane connection`);
  const forgedSame = { ...conn } as AnyConnection;
  await expectConnectorError(h, () => call(h.laneId, forgedSame), ["lane_mismatch", "not_found"], `${where} with an unminted copy`);
}

/** Lane enforcement plus authoritative status: stale `active` objects must not get through. */
async function expectGuarded(
  h: ContractHarness,
  state: CheckState,
  call: (laneId: LaneId, conn: AnyConnection) => Promise<unknown>,
  where: string,
) {
  await expectLaneEnforced(h, call, where);

  const stale = await connect(h);
  await h.markReconnectRequired(stale);
  const rr = await expectConnectorError(h, () => call(h.laneId, stale), ["reconnect_required"], `${where} on a connection marked reconnect_required`);
  expect(rr.info.disposition, `${where}: reconnect_required must never be retried`).toBe("reconnect_required");

  const gone = await connect(h);
  await disconnect(h, state, h.laneId, gone);
  await expectConnectorError(h, () => call(h.laneId, gone), ["connection_unavailable"], `${where} on a disconnected connection`);
}

export const contractChecks: readonly ContractCheck[] = [
  {
    name: "exposes only contract methods (no executeWrite)",
    run: async (h) => {
      expect("executeWrite" in h.connector, "executeWrite belongs on a ConnectorWriter (approvals only)").toBe(false);
      for (let obj: object | null = h.connector; obj !== null && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
        for (const key of Reflect.ownKeys(obj)) {
          if (key === "constructor" || ALLOWED_KEYS.has(key)) continue;
          const value = (obj as Record<PropertyKey, unknown>)[key];
          if (typeof value === "function") throw new Error(`connector exposes a non-contract function ${String(key)}`);
        }
      }
      for (const key of DATA_KEYS) expect(typeof (h.connector as unknown as Record<PropertyKey, unknown>)[key]).not.toBe("function");
    },
  },
  {
    name: "declares capabilities that match its methods",
    run: async (h) => {
      const c = h.connector;
      expect(c.capabilities.sync, "capabilities.sync").toBe(typeof c.sync === "function");
      expect(c.capabilities.subscribe, "capabilities.subscribe").toBe(typeof c.subscribe === "function");
      expect(c.capabilities.prepareWrite, "capabilities.prepareWrite").toBe(typeof c.prepareWrite === "function");
      expect(typeof c.disconnect, "disconnect is required").toBe("function");
    },
  },
  {
    name: "declares a known provider and well-formed readOps and featureKeys",
    run: async (h) => {
      const c = h.connector;
      expect(TestProviderSchema.safeParse(c.provider).success, "provider").toBe(true);
      expect(c.readOps.length, "at least one read op").toBeGreaterThan(0);
      for (const op of c.readOps) expect(OpNameSchema.safeParse(op).success, `read op ${op}`).toBe(true);
      for (const key of c.featureKeys) expect(key).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(h.readOps.length, "harness must supply at least one read op").toBeGreaterThan(0);
      expect(h.secrets.length, "harness must supply secret canaries").toBeGreaterThan(0);
      expect(typeof h.externalWriteCount, "harness must supply externalWriteCount").toBe("function");
      expect(h.otherLaneId).not.toBe(h.laneId);
    },
  },
  {
    name: "connect returns an active lane-bound Connection in the caller's lane",
    run: async (h) => {
      const conn = await connect(h);
      expect(isLaneBound(conn), "connect must return a minted LaneBoundConnection").toBe(true);
      expect(Object.isFrozen(conn), "connection must be frozen").toBe(true);
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
    name: "connect refuses a cross-lane reconnect",
    run: async (h) => {
      const conn = await connect(h);
      await expectConnectorError(
        h,
        () => h.connector.connect(h.otherLaneId, { ...h.connectInput, reconnect_connection_id: conn.id }),
        ["not_found", "lane_mismatch", "invalid_input", "forbidden"],
        "cross-lane reconnect",
      );
      // The original connection is untouched and still works in its own lane.
      const reloaded = await h.loader.loadConnection(h.laneId, conn.id);
      expect(reloaded.lane_id).toBe(h.laneId);
      await h.connector.read(h.laneId, reloaded, need(h.readOps[0], "readOps[0]"));
    },
  },
  {
    name: "loader returns lane-bound connections and hides other lanes'",
    run: async (h) => {
      const conn = await connect(h);
      const loaded = await h.loader.loadConnection(h.laneId, conn.id);
      expect(isLaneBound(loaded)).toBe(true);
      expect(Object.isFrozen(loaded)).toBe(true);
      expect(loaded.id).toBe(conn.id);
      await expectConnectorError(h, () => h.loader.loadConnection(h.otherLaneId, conn.id), ["not_found"], "loader from another lane");
      await expectConnectorError(h, () => h.loader.loadConnection(h.laneId, "00000000-0000-4000-8000-00000000dead"), ["not_found"], "loader unknown id");
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
    name: "health reports unusable connections without throwing",
    run: async (h, state) => {
      const stale = await connect(h);
      await h.markReconnectRequired(stale);
      const rr = HealthStatusSchema.parse(await h.connector.health(h.laneId, stale));
      expect(rr.ok, "health on reconnect_required").toBe(false);
      expect(rr.status).toBe("reconnect_required");
      expect(rr.error).not.toBeNull();

      const gone = await connect(h);
      await disconnect(h, state, h.laneId, gone);
      const after = HealthStatusSchema.parse(await h.connector.health(h.laneId, gone));
      expect(after.ok, "health after disconnect").toBe(false);
      assertNoSecrets(h, [rr, after], "health");
    },
  },
  {
    name: "health rejects other lanes and forged connections",
    run: async (h) => {
      await expectLaneEnforced(h, (laneId, conn) => h.connector.health(laneId, conn), "health");
    },
  },
  {
    name: "read returns a valid SourceResult with as_of and freshness",
    run: async (h) => {
      const conn = await connect(h);
      for (const op of h.readOps) {
        const result = testSchemas.SourceResultSchema.parse(await h.connector.read(h.laneId, conn, op));
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
    name: "read rejects other lanes, forged and unusable connections",
    run: async (h, state) => {
      await expectGuarded(h, state, (laneId, conn) => h.connector.read(laneId, conn, need(h.readOps[0], "readOps[0]")), "read");
    },
  },
  {
    name: "read raises reconnect_required on invalid_grant",
    applies: (h) => typeof h.simulateInvalidGrant === "function",
    run: async (h) => {
      const conn = await connect(h);
      await need(h.simulateInvalidGrant, "simulateInvalidGrant")(conn);
      const err = await expectConnectorError(h, () => h.connector.read(h.laneId, conn, need(h.readOps[0], "readOps[0]")), ["reconnect_required"], "read after invalid_grant");
      expect(err.info.disposition).toBe("reconnect_required");
      const health = HealthStatusSchema.parse(await h.connector.health(h.laneId, conn));
      expect(health.ok).toBe(false);
      expect(health.status).toBe("reconnect_required");
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
    name: "sync hands valid RawRecords to the sink and returns a cursor",
    applies: (h) => typeof h.connector.sync === "function",
    run: async (h) => {
      const conn = await connect(h);
      const collect = async (cursor: Parameters<NonNullable<Connector["sync"]>>[2]) => {
        const items: unknown[] = [];
        const summary = SyncSummarySchema.parse(
          await need(h.connector.sync, "connector.sync").call(h.connector, h.laneId, conn, cursor, async (batch) => {
            items.push(...batch);
          }),
        );
        return { items, summary };
      };
      const full = await collect(null);
      expect(full.summary.mode, "a sync without a cursor is a full load").toBe("full");
      expect(full.summary.records, "summary counts delivered records").toBe(full.items.length);
      for (const item of full.items) {
        const record = testSchemas.RawRecordSchema.parse(item);
        expect(record.lane_id).toBe(h.laneId);
        expect(record.connection_id).toBe(conn.id);
        expect(record.provider).toBe(h.connector.provider);
      }
      assertNoSecrets(h, full, "sync");
      const again = await collect(full.summary.cursor);
      expect(again.summary.records).toBe(again.items.length);
      for (const item of again.items) testSchemas.RawRecordSchema.parse(item);

      // A failing sink aborts the run: the connector must reject rather than return a cursor.
      let failed = false;
      try {
        await need(h.connector.sync, "connector.sync").call(h.connector, h.laneId, conn, null, async () => {
          throw new Error("sink failure");
        });
      } catch {
        failed = true;
      }
      if (full.items.length > 0) expect(failed, "sync must propagate a sink failure").toBe(true);
    },
  },
  {
    name: "sync rejects other lanes, forged and unusable connections",
    applies: (h) => typeof h.connector.sync === "function",
    run: async (h, state) => {
      await expectGuarded(h, state, (laneId, conn) => need(h.connector.sync, "connector.sync").call(h.connector, laneId, conn, null, async () => {}), "sync");
    },
  },
  {
    name: "subscribe returns a valid Subscription and is guarded",
    applies: (h) => typeof h.connector.subscribe === "function",
    run: async (h, state) => {
      const conn = await connect(h);
      const sub = testSchemas.SubscriptionSchema.parse(await need(h.connector.subscribe, "connector.subscribe").call(h.connector, h.laneId, conn));
      expect(sub.lane_id).toBe(h.laneId);
      expect(sub.connection_id).toBe(conn.id);
      expect(sub.provider).toBe(h.connector.provider);
      assertNoSecrets(h, sub, "subscribe");
      await expectGuarded(h, state, (laneId, c) => need(h.connector.subscribe, "connector.subscribe").call(h.connector, laneId, c), "subscribe");
    },
  },
  {
    name: "prepareWrite returns a ProposedPayload and never executes",
    applies: (h) => typeof h.connector.prepareWrite === "function",
    run: async (h) => {
      expect(h.writeIntents?.length ?? 0, "harness must supply writeIntents").toBeGreaterThan(0);
      const conn = await connect(h);
      const before = h.externalWriteCount();
      for (const intent of need(h.writeIntents, "writeIntents")) {
        const proposed = testSchemas.ProposedPayloadSchema.parse(await need(h.connector.prepareWrite, "connector.prepareWrite").call(h.connector, h.laneId, conn, intent));
        expect(proposed.lane_id).toBe(h.laneId);
        expect(proposed.connection_id).toBe(conn.id);
        expect(proposed.provider).toBe(h.connector.provider);
        expect(proposed.action_type).toBe(intent.action_type);
        assertNoSecrets(h, proposed, "prepareWrite");
      }
      expect(h.externalWriteCount(), "prepareWrite must not write to the provider").toBe(before);
    },
  },
  {
    name: "prepareWrite rejects other lanes, forged and unusable connections",
    applies: (h) => typeof h.connector.prepareWrite === "function",
    run: async (h, state) => {
      const intent = h.writeIntents?.[0];
      expect(intent, "harness must supply writeIntents").toBeDefined();
      await expectGuarded(h, state, (laneId, conn) => need(h.connector.prepareWrite, "connector.prepareWrite").call(h.connector, laneId, conn, need(intent, "writeIntents[0]")), "prepareWrite");
    },
  },
  {
    name: "disconnect revokes and returns the connection as disconnected",
    run: async (h, state) => {
      await expectLaneEnforced(h, (laneId, conn) => h.connector.disconnect(laneId, conn), "disconnect");
      const conn = await connect(h);
      const before = h.externalWriteCount();
      const out = await disconnect(h, state, h.laneId, conn);
      testSchemas.ConnectionSchema.parse(out);
      expect(isLaneBound(out), "disconnect returns a minted LaneBoundConnection").toBe(true);
      expect(out.id).toBe(conn.id);
      expect(out.lane_id).toBe(h.laneId);
      expect(out.status).toBe("disconnected");
      expect(h.externalWriteCount(), "disconnect revokes at the provider").toBeGreaterThan(before);
      assertNoSecrets(h, out, "disconnect");
    },
  },
];

/** Runs one check with the external-write invariant: only the check's own disconnects may write (revoke). */
export async function runContractCheck(check: ContractCheck, h: ContractHarness): Promise<"skipped" | "passed"> {
  if (check.applies && !check.applies(h)) return "skipped";
  const state: CheckState = { revokes: 0 };
  const before = h.externalWriteCount();
  await check.run(h, state);
  const writes = h.externalWriteCount() - before;
  if (writes > state.revokes) {
    throw new Error(`${check.name}: ${writes} external write(s) but only ${state.revokes} disconnect revocation(s)`);
  }
  return "passed";
}

/** Registers the full contract suite for one connector. Call it at the top level of the connector's test file. */
export function describeConnectorContract(fixture: ConnectorContractFixture): void {
  describe(`connector contract: ${fixture.name}`, () => {
    for (const check of contractChecks) {
      it(check.name, async (ctx) => {
        const h = await fixture.setup();
        try {
          if ((await runContractCheck(check, h)) === "skipped") ctx.skip();
        } finally {
          await h.teardown?.();
        }
      });
    }
  });
}
