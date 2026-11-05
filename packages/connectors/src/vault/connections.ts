// Creating connection rows (T-035). The OAuth callback learns the account (QuickBooks realm, Google mailbox) only after
// the token exchange, so it needs a row before `storeToken`. A new row starts `pending`; `storeToken` makes it active.
// An existing row for the same (lane, provider, account) is reused untouched (a reconnect), so a failed reconnect never
// downgrades an active connection. Uses the lane's job client: `connectionStore` is a restricted name (connectors only).
import type { LaneId } from "@nichols/core";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, Provider } from "../contract/schemas";
import { CONNECTION_COLUMNS } from "./loader";
import type { JobClientFor } from "./tokens";

export interface ConnectionStore {
  /** The lane's connection for this provider account, created `pending` when there is none; minted lane-bound. */
  ensureConnection(laneId: LaneId, provider: Provider, externalAccountId: string, createdBy?: string): Promise<LaneBoundConnection>;
  /** The lane's newest connection for the provider that is not disconnected, or null. Read-only (T-198 health check). */
  findConnection(laneId: LaneId, provider: Provider): Promise<LaneBoundConnection | null>;
}

const ONE_LANE_INDEX = "connections_one_lane_per_account";
const LANE_ID = /^[A-Z]{1,8}$/;

export function createConnectionStore(clientFor: JobClientFor): ConnectionStore {
  return {
    async ensureConnection(laneId, provider, externalAccountId, createdBy) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof externalAccountId !== "string" || externalAccountId.length === 0) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane and an account id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let row: unknown;
      try {
        const table = () => client.schema("core").from("connections");
        const inserted = await table().upsert(
          { lane_id: laneId, provider, external_account_id: externalAccountId, status: "pending", ...(createdBy ? { created_by: createdBy } : {}) },
          { onConflict: "lane_id,provider,external_account_id", ignoreDuplicates: true },
        );
        // 23514: a check refused the account id (format, or it looks like a secret). Database text is never passed on.
        // 23505 on the one-lane-per-account index (D-23): this account is connected in another lane. The index is
        // identified by its name in the error; any other unique violation stays a generic outage. (The index excludes
        // pending rows, so this insert is not expected to hit it; the refusal normally comes when the token is stored.)
        if (inserted.error?.code === "23505" && typeof inserted.error.message === "string" && inserted.error.message.includes(ONE_LANE_INDEX)) throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
        if (inserted.error?.code === "23514") throw new ConnectorError({ kind: "invalid_input", message: "The provider account id was refused" });
        if (inserted.error) throw inserted.error;
        const { data, error } = await table()
          .select(CONNECTION_COLUMNS)
          .eq("lane_id", laneId)
          .eq("provider", provider)
          .eq("external_account_id", externalAccountId)
          .maybeSingle();
        if (error) throw error;
        row = data;
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      try {
        return mintLaneBoundConnection(row as Connection);
      } catch {
        throw new ConnectorError({ kind: "provider_error", message: "Stored connection row is invalid" });
      }
    },
    async findConnection(laneId, provider) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let row: unknown;
      try {
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .select(CONNECTION_COLUMNS)
          .eq("lane_id", laneId)
          .eq("provider", provider)
          .neq("status", "disconnected")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        row = data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) return null;
      try {
        return mintLaneBoundConnection(row as Connection);
      } catch {
        throw new ConnectorError({ kind: "provider_error", message: "Stored connection row is invalid" });
      }
    },
  };
}
