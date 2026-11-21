// The Microsoft identity of a connection row (T-254: `core.connections.tenant_id` and `cloud`, set once at connect time by
// `core.connection_set_microsoft_identity`). Read on every guarded call, over the lane's job client (lane router only, rule 1),
// by (lane, id). Read-only: two columns, no token, no content. A database failure is `transient` with fixed text.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";
import type { MicrosoftIdentityReader } from "./guard";

const LANE_ID = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMicrosoftIdentityReader(clientFor: JobClientFor): MicrosoftIdentityReader {
  return {
    async read(laneId: LaneId, connectionId: string) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof connectionId !== "string" || !UUID.test(connectionId)) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane and a connection id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let row: unknown;
      try {
        const { data, error } = await client.schema("core").from("connections").select("tenant_id, cloud").eq("lane_id", laneId).eq("id", connectionId).maybeSingle();
        if (error) throw error;
        row = data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      const r = row as { tenant_id?: unknown; cloud?: unknown };
      return { tenantId: typeof r.tenant_id === "string" ? r.tenant_id : null, cloud: typeof r.cloud === "string" ? r.cloud : null };
    },
  };
}
