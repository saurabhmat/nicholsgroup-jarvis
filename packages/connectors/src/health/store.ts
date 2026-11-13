// core.connections reads/updates for the token-health jobs (T-040), through the lane router's job client. Database
// messages are never passed on. Only health fields are written.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { JobClientFor } from "../vault/tokens";
import { HEALTH_CHECK_ENDPOINT, type TokenHealthStore } from "./types";

/** A runaway listing is cut here (the Inngest scan applies its own cap too). */
const LIST_LIMIT = 500;

export function createTokenHealthStore(clientFor: JobClientFor): TokenHealthStore {
  async function client(laneId: LaneId) {
    try {
      return await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection health" });
    }
  }
  const unavailable = () => new ConnectorError({ kind: "transient", message: "Connection store unavailable" });

  return {
    async listUsableConnectionIds(laneId, providers) {
      if (providers && providers.length === 0) return [];
      const db = await client(laneId);
      try {
        let q = db.schema("core").from("connections").select("id").eq("lane_id", laneId).eq("transport", "native") // Composio connections have no token to check (T-219)
          // Usable connections, plus a QuickBooks connection that is reconnect_required and whose admin notice was never sent (T-195):
          // the scan re-raises that alert until it goes through.
          .or("status.in.(active,degraded),and(status.eq.reconnect_required,provider.eq.quickbooks,reconnect_notified_at.is.null)");
        if (providers) q = q.in("provider", [...providers]);
        const { data, error } = await q.order("created_at", { ascending: true }).limit(LIST_LIMIT);
        if (error) throw error;
        return (data ?? []).map((r) => String((r as { id: string }).id));
      } catch {
        throw unavailable();
      }
    },

    async applyHealth(laneId, conn, patch) {
      assertLaneBound(laneId, conn);
      const db = await client(laneId);
      try {
        const { data, error } = await db
          .schema("core")
          .from("connections")
          .update({ ...(patch.status ? { status: patch.status } : {}), ...(patch.last_error !== undefined ? { last_error: patch.last_error } : {}) })
          .eq("lane_id", laneId)
          .eq("id", conn.id)
          .eq("status", conn.status)
          .select("id");
        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
      } catch {
        throw unavailable();
      }
    },
    async clearHealthError(laneId, conn) {
      assertLaneBound(laneId, conn);
      const db = await client(laneId);
      try {
        const { data, error } = await db
          .schema("core")
          .from("connections")
          .update({ last_error: null })
          .eq("lane_id", laneId)
          .eq("id", conn.id)
          .eq("last_error->>endpoint", HEALTH_CHECK_ENDPOINT)
          .select("id");
        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
      } catch {
        throw unavailable();
      }
    },
  };
}
