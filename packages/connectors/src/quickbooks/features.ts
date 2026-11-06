// Edition features of a QuickBooks connection (T-051, QB-10): class tracking, location tracking, multicurrency, read from
// Preferences on every sync and stored on `core.connections.features` (+ `features_checked_at`). A change (including the
// first detection) is audited: `connection.features_update.requested/.succeeded/.failed` in audit.events, with the
// connection as target and the old and new flags as metadata (booleans only). The audit is written before the row is
// changed, so an unaudited change never happens (CLAUDE.md audit rule; withAudit).
import type { LaneId } from "@nichols/core";
import { withAudit, type Audit } from "@nichols/core/audit";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import type { QboFeatures } from "./entities";
import { assertQuickbooksConnection, type QboConnection } from "./guard";

/** Persists the detected flags on the connection row. Merges into the stored object (other keys are kept). */
export interface QboFeatureStore {
  save(laneId: LaneId, conn: QboConnection, features: QboFeatures, checkedAt: string): Promise<void>;
}

export type FeatureChange = { from: boolean | null; to: boolean };

export function diffFeatures(previous: Readonly<Record<string, boolean>>, next: QboFeatures): Record<string, FeatureChange> {
  const changes: Record<string, FeatureChange> = {};
  for (const [key, to] of Object.entries(next)) {
    const from = typeof previous[key] === "boolean" ? (previous[key] as boolean) : null;
    if (from !== to) changes[key] = { from, to };
  }
  return changes;
}

export interface QboFeatureRecorder {
  /** Stores `features` and `checkedAt`; audits first when any flag differs from the connection's stored flags. */
  record(laneId: LaneId, conn: QboConnection, features: QboFeatures, checkedAt: string): Promise<{ changes: Record<string, FeatureChange> }>;
}

export function createQboFeatureRecorder(deps: { store: QboFeatureStore; audit: Audit }): QboFeatureRecorder {
  return {
    async record(laneId, conn, features, checkedAt) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      const changes = diffFeatures(conn.features, features);
      const save = () => deps.store.save(laneId, conn, features, checkedAt);
      if (Object.keys(changes).length === 0) {
        await save();
        return { changes };
      }
      await withAudit(deps.audit, { laneId, actor: { kind: "service" }, action: "connection.features_update", target: `connection:${conn.id}`, metadata: { provider: "quickbooks", changes } }, save);
      return { changes };
    },
  };
}

/** The real store over the lane's job client (service role). */
export function createQboFeatureStore(clientFor: JobClientFor): QboFeatureStore {
  return {
    async save(laneId, conn, features, checkedAt) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      try {
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .update({ features: { ...conn.features, ...features }, features_checked_at: checkedAt })
          .eq("lane_id", laneId)
          .eq("id", conn.id)
          .eq("provider", "quickbooks")
          .select("id");
        if (error) throw error;
        if (!Array.isArray(data) || data.length === 0) throw new Error("no row");
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
    },
  };
}
