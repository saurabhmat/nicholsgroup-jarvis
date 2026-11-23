// The service-side deletion of the portal's Teams read markers (T-282): `core.teams_chat_reads_purge_connection` through the lane's job client. Used by the Teams disconnect (spec 5) as a
// purger. The markers are read and written by the SIGNED-IN person through their own session (apps/web/lib/teams-reads.ts, RLS), never through this client. Fixed error text only.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

export interface TeamsChatReadsStore {
  /** Deletes every read marker of one Teams connection of the lane; the number deleted. */
  purgeConnection(laneId: LaneId, connectionId: string): Promise<number>;
}

export function createTeamsChatReadsStore(clientFor: JobClientFor): TeamsChatReadsStore {
  return {
    async purgeConnection(laneId, connectionId) {
      try {
        const client = await clientFor(laneId);
        const core = client.schema("core");
        const { data, error } = await (core.rpc.bind(core) as unknown as Rpc)("teams_chat_reads_purge_connection", { p_lane: laneId, p_connection: connectionId });
        if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) throw new Error("unavailable");
        return data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "The Teams read markers could not be deleted" });
      }
    },
  };
}
