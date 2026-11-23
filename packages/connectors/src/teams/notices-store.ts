// The service side of the Teams new-message notices (T-289): comms.teams_activity through the lane's job client and the `core` wrappers, plus the one ownership question the renewal asks.
//   - `recordNotice`: core.teams_activity_notice (service_role): a valid notification arrived for this connection. Times and a counter only: no chat, message or sender is known here.
//   - `purgeConnection`: core.teams_activity_purge_connection: the Teams disconnect purger (the activity row goes with the connection).
//   - `ownerStillAllowed`: core.teams_connection_ids(owner, lane) called by the service role on a job's behalf: true while the connection's owner still holds `own_mail` in the lane
//     (a person removed from the lane, or who lost the permission, no longer has their Teams connection listed: the subscription is then stopped).
// The people's own reads and the "seen" mark go through their own session (apps/web/lib/teams-activity.ts, RLS), never through this client. Fixed error text only: a database message could name a row.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeamsNoticesStore {
  /** Records one accepted notification. False when the database does not know a usable Teams connection of this lane with this id (it was disconnected meanwhile): nothing was recorded, not an error. */
  recordNotice(laneId: LaneId, connectionId: string): Promise<boolean>;
  /** Deletes the activity row of one Teams connection of the lane; the number deleted. */
  purgeConnection(laneId: LaneId, connectionId: string): Promise<number>;
  /** Whether the Teams connection's owner still holds `own_mail` in the lane. Throws (transient) when it cannot be told: the caller then changes nothing. */
  ownerStillAllowed(laneId: LaneId, connectionId: string, ownerUserId: string | null): Promise<boolean>;
}

const unavailable = (message: string) => new ConnectorError({ kind: "transient", message });

export function createTeamsNoticesStore(clientFor: JobClientFor): TeamsNoticesStore {
  const rpc = async (laneId: LaneId, fn: string, args: Record<string, unknown>) => {
    const client = await clientFor(laneId);
    const core = client.schema("core");
    return (core.rpc.bind(core) as unknown as Rpc)(fn, args);
  };
  return {
    async recordNotice(laneId, connectionId) {
      let result: Awaited<ReturnType<Rpc>>;
      try {
        result = await rpc(laneId, "teams_activity_notice", { p_lane: laneId, p_connection: connectionId });
      } catch {
        throw unavailable("The Teams notice could not be recorded");
      }
      if (result.error) {
        if (result.error.code === "P0002") return false; // not a usable Teams connection of this lane (any more)
        throw unavailable("The Teams notice could not be recorded");
      }
      return typeof result.data === "string";
    },
    async purgeConnection(laneId, connectionId) {
      try {
        const { data, error } = await rpc(laneId, "teams_activity_purge_connection", { p_lane: laneId, p_connection: connectionId });
        if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) throw new Error("unavailable");
        return data;
      } catch {
        throw unavailable("The Teams activity could not be deleted");
      }
    },
    async ownerStillAllowed(laneId, connectionId, ownerUserId) {
      if (ownerUserId === null || !UUID.test(ownerUserId)) return false; // a Teams row always has an owner (a check); one without is not allowed
      try {
        const { data, error } = await rpc(laneId, "teams_connection_ids", { p_uid: ownerUserId, p_lane: laneId });
        if (error || !Array.isArray(data)) throw new Error("unavailable");
        return data.includes(connectionId);
      } catch {
        throw unavailable("The Teams connection's owner could not be checked");
      }
    },
  };
}
