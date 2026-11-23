// The Teams identity of a connection row (T-278, T-279: `core.connections.tenant_id`, `cloud` and the server-only `entra_object_id`, set ONCE at connect time by
// `core.connection_set_teams_identity`). The reader is read-only, over the lane's job client (lane router only, rule 1), by (lane, id); the object id has no column grant to
// `authenticated`, so only a job client can read it. A database failure is `transient` with fixed text. The writer sets the three values once.
import type { LaneId } from "@nichols/core";
import { ConnectorError, TEAMS_ONE_ACCOUNT_MESSAGE } from "../contract/errors";
import { isTenantId } from "../microsoft/constants";
import type { JobClientFor } from "../vault/tokens";
import type { TeamsIdentity, TeamsIdentityReader } from "./guard";

const LANE_ID = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTeamsIdentityReader(clientFor: JobClientFor): TeamsIdentityReader {
  return {
    async read(laneId: LaneId, connectionId: string): Promise<TeamsIdentity> {
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
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .select("tenant_id, cloud, entra_object_id")
          .eq("lane_id", laneId)
          .eq("id", connectionId)
          .eq("provider", "microsoft_teams")
          .maybeSingle();
        if (error) throw error;
        row = data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
      const r = row as { tenant_id?: unknown; cloud?: unknown; entra_object_id?: unknown };
      return {
        tenantId: typeof r.tenant_id === "string" ? r.tenant_id : null,
        cloud: typeof r.cloud === "string" ? r.cloud : null,
        entraObjectId: typeof r.entra_object_id === "string" ? r.entra_object_id : null,
      };
    },
  };
}

/** Records the tenant, cloud and Entra object id of a Teams connection ONCE (`core.connection_set_teams_identity`; service_role, lane-checked). */
export interface TeamsIdentityWriter {
  /** Refuses (`forbidden`, the one-account message) when the owner of this connection has ANOTHER usable Teams connection in the lane: the check a reconnect needs, because its identity is already set. */
  assertOnePerOwner(laneId: LaneId, connectionId: string): Promise<void>;
  setOnce(laneId: LaneId, connectionId: string, identity: { tenantId: string; cloud: string; entraObjectId: string }): Promise<void>;
}

/** Database codes of that function to what the connector reports. Database text is never passed on. */
const SET_ERRORS: Record<string, { kind: "not_found" | "invalid_input" | "forbidden"; message: string }> = {
  P0002: { kind: "not_found", message: "Connection not found" },
  "23514": { kind: "invalid_input", message: "Not a Teams connection" },
  "55000": { kind: "forbidden", message: "The tenant of this connection is already recorded" },
  "22023": { kind: "invalid_input", message: "The cloud is not allowed" },
  "22004": { kind: "invalid_input", message: "Lane, connection, tenant, cloud and object id are required" },
  // The owner already has another usable Teams connection in this lane: a fixed message the connect flow turns into its own text.
  D0024: { kind: "forbidden", message: TEAMS_ONE_ACCOUNT_MESSAGE },
};

export function createTeamsIdentityWriter(clientFor: JobClientFor): TeamsIdentityWriter {
  type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>;
  return {
    async assertOnePerOwner(laneId, connectionId) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof connectionId !== "string" || !UUID.test(connectionId)) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane and a connection id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let result: Awaited<ReturnType<Rpc>>;
      try {
        const core = client.schema("core");
        result = await (core.rpc.bind(core) as unknown as Rpc)("teams_assert_one_per_owner", { p_lane: laneId, p_connection_id: connectionId });
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (result.error) {
        const known = result.error.code ? SET_ERRORS[result.error.code] : undefined;
        throw new ConnectorError(known ?? { kind: "transient", message: "Connection store unavailable" });
      }
    },
    async setOnce(laneId, connectionId, identity) {
      if (
        typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof connectionId !== "string" || !UUID.test(connectionId) ||
        !isTenantId(identity.tenantId) || !isTenantId(identity.entraObjectId)
      ) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane, a connection id, a tenant id and an object id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let result: Awaited<ReturnType<Rpc>>;
      try {
        const core = client.schema("core");
        result = await (core.rpc.bind(core) as unknown as Rpc)("connection_set_teams_identity", {
          p_lane: laneId,
          p_connection_id: connectionId,
          p_tenant_id: identity.tenantId,
          p_cloud: identity.cloud,
          p_entra_object_id: identity.entraObjectId,
        });
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
