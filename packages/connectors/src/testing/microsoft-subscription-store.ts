// An in-memory twin of core.push_subscriptions (T-068, T-264 tests only): the same rules as the SQL functions in migration 20261128100000 (lane- and connection-bound
// renew/mark/remove, one live row per connection and stream, the clientState held beside the row and returned only by `lookup`, a usable connection of that lane to record or look up).
// Counters say how many calls of each kind were made, so a "nothing was touched" test can prove it.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { SecretValue } from "../vault/secret";
import { SUBSCRIPTION_RESOURCES, type SubscriptionResource } from "../microsoft/constants";
import type { MicrosoftSubscriptionStore, StoredSubscription, SubscriptionLookup } from "../microsoft/subscription-store";

export type TwinRow = {
  id: number;
  laneId: LaneId;
  connectionId: string;
  resource: SubscriptionResource;
  subscriptionId: string;
  resourcePath: string;
  expiresAt: Date;
  status: "active" | "reauthorization_required" | "removed";
  clientState: string | null;
};

/** What the twin needs to know about a connection (the harness's rows): its lane and status. */
export type TwinConnections = (laneId: string, connectionId: string) => { status: string } | undefined;

export function createSubscriptionStoreTwin(connections: TwinConnections) {
  const rows: TwinRow[] = [];
  const calls = { list: 0, record: 0, renewed: 0, mark: 0, removeConnection: 0, lookup: 0, purge: 0 };
  let seq = 0;
  let failure: unknown = null;
  const live = (r: TwinRow) => r.status !== "removed";
  const maybeFail = () => {
    if (failure !== null) {
      const e = failure;
      failure = null;
      throw e;
    }
  };

  const store: MicrosoftSubscriptionStore = {
    async list(laneId, connectionId) {
      calls.list += 1;
      maybeFail();
      return rows
        .filter((r) => r.laneId === laneId && r.connectionId === connectionId && live(r))
        .map((r): StoredSubscription => ({ resource: r.resource, subscriptionId: r.subscriptionId, status: r.status as "active" | "reauthorization_required", expiresAt: r.expiresAt }));
    },
    async record(laneId, input) {
      calls.record += 1;
      maybeFail();
      const c = connections(laneId, input.connectionId);
      if (!c || (c.status !== "active" && c.status !== "degraded")) throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is not available for subscriptions" });
      for (const old of rows) if (old.connectionId === input.connectionId && old.resource === input.resource && live(old)) Object.assign(old, { status: "removed", clientState: null });
      rows.push({ id: ++seq, laneId, connectionId: input.connectionId, resource: input.resource, subscriptionId: input.subscriptionId, resourcePath: SUBSCRIPTION_RESOURCES[input.resource], expiresAt: input.expiresAt, status: "active", clientState: input.clientState.reveal() });
    },
    async renewed(laneId, connectionId, subscriptionId, expiresAt) {
      calls.renewed += 1;
      maybeFail();
      const r = rows.find((x) => x.laneId === laneId && x.connectionId === connectionId && x.subscriptionId === subscriptionId && live(x));
      if (!r) return false;
      Object.assign(r, { expiresAt, status: "active" });
      return true;
    },
    async mark(laneId, connectionId, subscriptionId, to) {
      calls.mark += 1;
      maybeFail();
      const r = rows.find((x) => x.laneId === laneId && x.connectionId === connectionId && x.subscriptionId === subscriptionId && live(x));
      if (!r) return false;
      if (to === "removed") Object.assign(r, { status: "removed", clientState: null });
      else r.status = to;
      return true;
    },
    async removeConnection(laneId, connectionId) {
      calls.removeConnection += 1;
      maybeFail();
      let n = 0;
      for (const r of rows) {
        if (r.laneId === laneId && r.connectionId === connectionId && live(r)) {
          Object.assign(r, { status: "removed", clientState: null });
          n += 1;
        }
      }
      return n;
    },
    async lookup(laneId, subscriptionId): Promise<SubscriptionLookup | null> {
      calls.lookup += 1;
      maybeFail();
      const r = rows.find((x) => x.laneId === laneId && x.subscriptionId === subscriptionId && live(x));
      const c = r ? connections(laneId, r.connectionId) : undefined;
      if (!r || !c || c.status === "disconnected" || c.status === "pending" || r.clientState === null) return null;
      return { laneId, connectionId: r.connectionId, resource: r.resource, status: r.status as "active" | "reauthorization_required", clientState: new SecretValue(r.clientState) };
    },
    async purge(laneId) {
      calls.purge += 1;
      return rows.filter((r) => r.laneId === laneId && r.status === "removed").length;
    },
  };
  return {
    store,
    rows,
    calls,
    /** The next store call fails with this error, once. */
    failNext(e: unknown) {
      failure = e;
    },
    liveRows: (laneId?: string) => rows.filter((r) => live(r) && (laneId === undefined || r.laneId === laneId)),
    /** A row as a test would plant it (an already recorded subscription), expiring at `expiresAt`. */
    plant(laneId: LaneId, connectionId: string, resource: SubscriptionResource, subscriptionId: string, expiresAt: Date, clientState: string, status: TwinRow["status"] = "active") {
      rows.push({ id: ++seq, laneId, connectionId, resource, subscriptionId, resourcePath: SUBSCRIPTION_RESOURCES[resource], expiresAt, status, clientState: status === "removed" ? null : clientState });
    },
  };
}
