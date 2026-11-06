// Whether a QuickBooks connection can be synced now (T-053): active or degraded. Not reconnect_required, disconnected, pending
// or error. A missing connection, or one that belongs to another lane (the loader answers not_found for both), is "no". Any other
// failure (database, lane router) is rethrown so the caller retries: the webhook receiver has already claimed the event, so a
// silent "no" would lose the change until the next scheduled sync.
import type { LaneId } from "@nichols/core";
import { isConnectorError } from "../contract/errors";
import type { ConnectionLoader } from "../contract/lane-bound";

export function createQuickbooksUsableCheck(loader: ConnectionLoader<string>): (laneId: LaneId, connectionId: string) => Promise<boolean> {
  return async (laneId, connectionId) => {
    try {
      const conn = await loader.loadConnection(laneId, connectionId);
      return conn.provider === "quickbooks" && (conn.status === "active" || conn.status === "degraded");
    } catch (e) {
      if (isConnectorError(e) && e.info.kind === "not_found") return false;
      throw e;
    }
  };
}
