// Creating connection rows (T-035). The OAuth callback learns the account (QuickBooks realm, Google mailbox) only after
// the token exchange, so it needs a row before `storeToken`. A new row starts `pending`; `storeToken` makes it active.
// An existing row for the same (lane, provider, account) is reused untouched (a reconnect), so a failed reconnect never
// downgrades an active connection. Uses the lane's job client: `connectionStore` is a restricted name (connectors only).
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, Provider } from "../contract/schemas";
import { CONNECTION_COLUMNS } from "./loader";
import type { JobClientFor } from "./tokens";

export interface ConnectionStore {
  /** The lane's connection for this provider account, created `pending` when there is none; minted lane-bound. */
  ensureConnection(laneId: LaneId, provider: Provider, externalAccountId: string): Promise<LaneBoundConnection>;
}

const LANE_ID = /^[A-Z]{1,8}$/;

export function createConnectionStore(clientFor: JobClientFor): ConnectionStore {
  return {
    async ensureConnection(laneId, provider, externalAccountId) {
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
          { lane_id: laneId, provider, external_account_id: externalAccountId, status: "pending" },
          { onConflict: "lane_id,provider,external_account_id", ignoreDuplicates: true },
        );
        // 23514: a check refused the account id (format, or it looks like a secret). Database text is never passed on.
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
  };
}
