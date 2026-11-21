// The Microsoft identity of a connection row (T-254: `core.connections.tenant_id` and `cloud`, set once at connect time by
// `core.connection_set_microsoft_identity`). Read on every guarded call, over the lane's job client (lane router only, rule 1),
// by (lane, id). The reader is read-only: two columns, no token, no content. A database failure is `transient` with fixed text. The writer (T-066, below) sets them once at connect time.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";
import { isTenantId } from "./constants";
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

/** Records the tenant and cloud of a Microsoft connection ONCE (T-254 `core.connection_set_microsoft_identity`; service_role, lane-checked). */
export interface MicrosoftIdentityWriter {
  setOnce(laneId: LaneId, connectionId: string, tenantId: string, cloud: string): Promise<void>;
}

/** Database codes of that function to what the connector reports. Database text is never passed on. */
const SET_ERRORS: Record<string, { kind: "not_found" | "invalid_input" | "forbidden"; message: string }> = {
  P0002: { kind: "not_found", message: "Connection not found" },
  "23514": { kind: "invalid_input", message: "Not a Microsoft connection" },
  "55000": { kind: "forbidden", message: "The tenant of this connection is already recorded" },
  "22023": { kind: "invalid_input", message: "The cloud is not allowed" },
  "22004": { kind: "invalid_input", message: "Lane, connection, tenant and cloud are required" },
};

export function createMicrosoftIdentityWriter(clientFor: JobClientFor): MicrosoftIdentityWriter {
  return {
    async setOnce(laneId, connectionId, tenantId, cloud) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof connectionId !== "string" || !UUID.test(connectionId) || !isTenantId(tenantId)) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane, a connection id and a tenant id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>;
      let result: Awaited<ReturnType<Rpc>>;
      try {
        const core = client.schema("core");
        result = await (core.rpc.bind(core) as unknown as Rpc)("connection_set_microsoft_identity", { p_lane: laneId, p_connection_id: connectionId, p_tenant_id: tenantId, p_cloud: cloud });
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (result.error) {
        const known = result.error.code ? SET_ERRORS[result.error.code] : undefined;
        throw new ConnectorError(known ?? { kind: "transient", message: "Connection store unavailable" });
      }
    },
  };
}
