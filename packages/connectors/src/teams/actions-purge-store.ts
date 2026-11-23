// The service-side closing of a Teams connection's open send actions (T-286): `core.teams_actions_purge_connection` through the lane's job client. Used by the Teams disconnect (spec 5, test 19)
// as a purger: a proposed or approved `teams.*` action of the connection becomes invalidated with its text purged, and an executing one ends failed / connection_disconnected (also purged).
// Fixed error text only; the number closed is returned (never an id or a text).
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

export interface TeamsActionsStore {
  /** Closes the open Teams send actions of one connection of the lane; how many. */
  purgeConnection(laneId: LaneId, connectionId: string): Promise<number>;
  /** Of these message ids, the ones another action of the connection recorded on its claim (T-286 review; ids only). */
  claimedExternalIds(laneId: LaneId, connectionId: string, exceptActionId: string, ids: readonly string[]): Promise<string[]>;
}

export function createTeamsActionsStore(clientFor: JobClientFor): TeamsActionsStore {
  return {
    async purgeConnection(laneId, connectionId) {
      try {
        const client = await clientFor(laneId);
        const core = client.schema("core");
        const { data, error } = await (core.rpc.bind(core) as unknown as Rpc)("teams_actions_purge_connection", { p_lane: laneId, p_connection: connectionId });
        if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) throw new Error("unavailable");
        return data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "The open Teams messages could not be closed" });
      }
    },
    async claimedExternalIds(laneId, connectionId, exceptActionId, ids) {
      try {
        const client = await clientFor(laneId);
        const core = client.schema("core");
        const { data, error } = await (core.rpc.bind(core) as unknown as Rpc)("act_claimed_external_ids", { p_lane: laneId, p_connection: connectionId, p_except: exceptActionId, p_ids: [...ids] });
        if (error || !Array.isArray(data) || !data.every((x) => typeof x === "string")) throw new Error("unavailable");
        return data as string[];
      } catch {
        throw new ConnectorError({ kind: "transient", message: "The earlier Teams messages could not be checked" });
      }
    },
  };
}
