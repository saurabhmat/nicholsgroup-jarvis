// How many Teams accounts a person already has in a lane that count against `teams.max_accounts_per_person` (T-294; spec docs/specs/messages.md 22.1, 22.3).
// Read through the PERSON'S OWN lane client, so row-level security decides what is visible (their own rows); the filter on the owner is explicit as well, because a lane owner's policy shows
// the health of other people's rows. The count is only the first, friendly refusal at the start of a connect: the SQL function and the connections trigger refuse again when a token is stored.
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import { ConnectorError } from "../contract/errors";

/** The statuses that count: everything but `disconnected` and `pending` (one definition for the SQL, the page and this read). */
export const TEAMS_COUNTED_STATUSES = ["active", "degraded", "reconnect_required"] as const;

export async function countOwnTeamsAccounts(input: { laneId: LaneId; userId: string; client: LaneClient }): Promise<number> {
  const { count, error } = await input.client
    .schema("core")
    .from("connections")
    .select("id", { count: "exact", head: true })
    .eq("lane_id", input.laneId)
    .eq("provider", "microsoft_teams")
    .eq("owner_user_id", input.userId)
    .in("status", [...TEAMS_COUNTED_STATUSES]);
  if (error) throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
  return count ?? 0;
}
