// core.connector_api_errors through the lane's job client (service role). Insert only; reads for the export go through the signed-in
// user's client (RLS) in the web route. The error is thrown with a fixed message: the database's own text can echo the row.
import type { LaneId } from "@nichols/core";
import type { JobClientFor } from "../vault/tokens";
import type { ApiErrorStore } from "./sink";

export function createApiErrorStore(clientFor: JobClientFor): ApiErrorStore {
  return {
    async insert(laneId: LaneId, connectionId: string, row) {
      try {
        const client = await clientFor(laneId);
        const { error } = await client
          .schema("core")
          .from("connector_api_errors")
          .insert({ lane_id: laneId, connection_id: connectionId, ...row });
        if (error) throw new Error("insert failed");
      } catch {
        throw new Error("connector api error store unavailable");
      }
    },
  };
}
