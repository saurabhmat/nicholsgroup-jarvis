import "server-only";
// `@nichols/connectors/teams-settings` (T-280): the narrow surface Settings and the Messages page need for Teams, and nothing else. apps/web does not import the Teams package as a
// whole (it holds the guarded Graph client and the health check). Server-only.
//   - `teamsSettingsOf`: the lane's Teams settings from ONE read of the lane config (fails closed with a ConnectorError), reduced to what a page draws.
//   - `disconnectTeams`: local Disconnect (no request to Microsoft).
import type { LaneId } from "@nichols/core";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { laneConfigReader } from "../vault/index";
import { isCloudSupported } from "../microsoft/constants";
import { TEAMS_ADMIN_CONSENT_FEATURES } from "./constants";

export { disconnectTeams } from "./index";

/** What a page draws from: null = the lane has no Teams block; otherwise whether it is on, the cloud is served, and the features (no tenant id or domain leaves this module). */
export type TeamsLaneView = { enabled: boolean; cloudSupported: boolean; features: TeamsFeature[]; needsAdminConsent: boolean; maxAccountsPerPerson: number };

export async function teamsSettingsOf(laneId: LaneId): Promise<TeamsLaneView | null> {
  const s = await laneConfigReader.teamsSettings(laneId); // the one read
  if (s === null) return null;
  return {
    enabled: s.enabled,
    cloudSupported: isCloudSupported(s.cloud),
    features: [...s.features],
    needsAdminConsent: s.features.some((f) => TEAMS_ADMIN_CONSENT_FEATURES.includes(f)),
    maxAccountsPerPerson: s.maxAccountsPerPerson,
  };
}
