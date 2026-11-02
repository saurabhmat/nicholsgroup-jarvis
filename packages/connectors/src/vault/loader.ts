// The real ConnectionLoader (T-033; contract in ../contract/lane-bound.ts). Reads the authoritative row from
// core.connections with the lane's job client, by (lane_id, id), and mints it lane-bound. A missing row and a row in
// another lane give the same `not_found`, so a caller cannot probe other lanes.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type ConnectionLoader, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import type { JobClientFor } from "./tokens";

/** Exactly the ConnectionSchema fields (the strict schema rejects anything else, e.g. created_at). */
export const CONNECTION_COLUMNS =
  "id, lane_id, provider, external_account_id, status, features, features_checked_at, token_expires_at, last_sync_at, last_error";

/** Same shape the lane router accepts (core.lanes.code). */
const LANE_ID = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createConnectionLoader(clientFor: JobClientFor): ConnectionLoader {
  return {
    async loadConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection> {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof connectionId !== "string" || !UUID.test(connectionId)) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane and a connection id are required" });
      }
      let row: unknown;
      try {
        const client = await clientFor(laneId);
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .select(CONNECTION_COLUMNS)
          .eq("lane_id", laneId)
          .eq("id", connectionId)
          .maybeSingle();
        if (error) throw error;
        row = data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      try {
        return mintLaneBoundConnection(row as Connection);
      } catch {
        throw new ConnectorError({ kind: "provider_error", message: "Stored connection row is invalid" });
      }
    },
  };
}
