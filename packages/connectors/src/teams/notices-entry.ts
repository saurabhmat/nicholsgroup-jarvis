import "server-only";
// `@nichols/connectors/teams-notices` (T-289): the one thing the `teams-activity` Inngest function needs, and nothing else: record that a valid new-message notice arrived for a Teams connection.
// Times and a capped counter go into comms.teams_activity (service role, through the lane's job client); no Graph call, no token, no chat, no message. The receiver has already checked the
// clientState against the stored subscription and the lane and connection come from that stored row.
import type { LaneId } from "@nichols/core";
import { teamsNoticesStore } from "../vault/index";

/** Records one accepted notice. False: no usable Teams connection of this lane with this id (disconnected meanwhile): dropped. Throws for a failure worth a retry. */
export function recordTeamsNotice(laneId: LaneId, connectionId: string): Promise<boolean> {
  return teamsNoticesStore.recordNotice(laneId, connectionId);
}
