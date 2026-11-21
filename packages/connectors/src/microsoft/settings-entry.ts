import "server-only";
// `@nichols/connectors/microsoft-settings` (T-257): the narrow surface Settings needs for Microsoft, and nothing else. apps/web does not import
// the Microsoft package as a whole (it holds the guarded Graph client and the health check). Server-only.
//   - `mailProvidersOf`: which providers a lane has enabled, decided from ONE read of the lane config (fails closed with a ConnectorError).
//   - `microsoftAdminConsentLink`: the tenant admin consent link, or null (public values only, no state stored).
//   - `disconnectMicrosoft`: local Disconnect (no request to Microsoft).
import type { LaneId } from "@nichols/core";
import { providerEnabledIn } from "../facade/gate";
import { laneConfigReader } from "../vault/index";

export { disconnectMicrosoft, microsoftAdminConsentLink } from "./index";

/** What Settings draws from: Google enabled, and Microsoft enabled (in `mail.providers` AND a valid `microsoft` block) with the two settings the consent link needs. */
export type MailProvidersOfLane = { google: boolean; microsoft: { cloud: string; tenantIds: string[] } | null };

export async function mailProvidersOf(laneId: LaneId): Promise<MailProvidersOfLane> {
  const settings = await laneConfigReader.mailProviderSettings(laneId); // the one read: both decisions come from it
  return {
    google: providerEnabledIn(settings, "google"),
    microsoft: settings.microsoft && providerEnabledIn(settings, "microsoft") ? { cloud: settings.microsoft.cloud, tenantIds: [...settings.microsoft.tenantIds] } : null,
  };
}
