// A QuickBooks connection that needs a person (T-195, QB-4 / QB-6): when Intuit refuses the refresh token (`invalid_grant`:
// revoked, expired or used up) or keeps answering 401 after a refresh, the connection is recorded as `reconnect_required` and
// the admin is notified. Everything that talks to Intuit goes through the token manager and the API client, so this one hook
// covers conn.sync, the webhook-triggered CDC, the reports job, the health check and the connection test.
//
//   * The status change is one conditional update (active or degraded -> reconnect_required), with the redacted error as
//     `last_error`. A connection already reconnect_required, disconnected or pending is left alone, so a second failure in
//     parallel changes nothing and notifies once.
//   * Once the status is recorded nothing retries: conn.sync, the reports job and the webhook CDC skip a connection that is not
//     active or degraded (assertStatusUsable, sync/usable.ts), and Intuit is not called again until the user reconnects.
//   * The notification is the existing `conn/attention.needed` event (T-040), reason `reconnect_required`, ids and enums only
//     (never Intuit's text). Its id is per connection and UTC day, so a repeat the same day is dropped by Inngest.
//   * Durable: once the event was sent, `core.connections.reconnect_notified_at` is set. While it is null the daily token-health
//     scan still lists the connection (health/store.ts) and the health job raises the same alert (health/job.ts), so a notify
//     that failed here is retried every day until it goes through or the connection is reconnected (a reconnect or a new
//     reconnect_required clears the marker).
//   * The recorder itself never throws: a failure is logged. The caller already has the reconnect_required error to throw.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorErrorInfo } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { JobClientFor } from "../vault/tokens";

export interface ReconnectStore {
  /** Marks the connection `reconnect_required` if it is still active or degraded. True when this call changed it. */
  markReconnectRequired(laneId: LaneId, conn: LaneBoundConnection<string>, error: ConnectorErrorInfo): Promise<boolean>;
  /** Records that the admin notification was sent (only while the connection is still reconnect_required). */
  markNotified(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<void>;
}

export type ReconnectNotice = { laneId: LaneId; connectionId: string; provider: string; errorKind: string };

export type ReconnectRecorderDeps = {
  store: ReconnectStore;
  /** Sends the admin notification event. Ids and enums only. */
  notify: (notice: ReconnectNotice) => Promise<void>;
  logger?: ConnectorLogger;
};

/** The hook the token manager and the API client call. Never throws. */
export type OnReconnectRequired = (laneId: LaneId, conn: LaneBoundConnection<string>, error: ConnectorErrorInfo) => Promise<void>;

export function createReconnectRecorder(deps: ReconnectRecorderDeps): OnReconnectRequired {
  const log = deps.logger ?? connectorLog;
  return async (laneId, conn, error) => {
    const child = log.child({ laneId, provider: conn.provider, connectionId: conn.id });
    try {
      const changed = await deps.store.markReconnectRequired(laneId, conn, error);
      if (!changed) return;
      child.warn("conn.reconnect_required", { http_status: error.http_status, provider_error_code: error.provider_error_code });
    } catch {
      child.error("conn.reconnect_required.record_failed", {});
      return;
    }
    try {
      await deps.notify({ laneId, connectionId: conn.id, provider: conn.provider, errorKind: "reconnect_required" });
      await deps.store.markNotified(laneId, conn);
    } catch {
      // Not marked notified: the daily token-health scan raises the alert again.
      child.error("conn.reconnect_required.notify_failed", {});
    }
  };
}

/** The status update over the lane's job client. Only health fields are written; database text is never passed on. */
export function createReconnectStore(clientFor: JobClientFor): ReconnectStore {
  return {
    async markReconnectRequired(laneId, conn, error) {
      assertLaneBound(laneId, conn);
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection health" });
      }
      try {
        const { data, error: dbError } = await client
          .schema("core")
          .from("connections")
          .update({ status: "reconnect_required", last_error: error, reconnect_notified_at: null })
          .eq("lane_id", laneId)
          .eq("id", conn.id)
          .in("status", ["active", "degraded"])
          .select("id");
        if (dbError) throw dbError;
        return Array.isArray(data) && data.length > 0;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
    },
    async markNotified(laneId, conn) {
      assertLaneBound(laneId, conn);
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection health" });
      }
      const { error: dbError } = await client
        .schema("core")
        .from("connections")
        .update({ reconnect_notified_at: new Date().toISOString() })
        .eq("lane_id", laneId)
        .eq("id", conn.id)
        .eq("status", "reconnect_required");
      if (dbError) throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
    },
  };
}
