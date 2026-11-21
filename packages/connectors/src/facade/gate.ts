// Which comms providers a lane has enabled (D-57, T-255). One decision, taken from ONE read of the lane config
// (`mailProviderSettings`, never `isMailProviderEnabled` plus a separate `microsoftSettings`: two reads could mix two config versions).
//   - Google is enabled when `google` is in `mail.providers` (the default for every stored lane).
//   - Microsoft is enabled when `microsoft` is in `mail.providers` AND the `microsoft` block is present and valid (a lane with
//     `microsoft: null` never allows a Microsoft connection; T-250 review L1).
// The decision is about the connection ROW's provider, never a lane-level value. A read that fails (unreadable or malformed config)
// throws a ConnectorError: fail closed.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { CommsProviderId } from "../comms/provider";
import type { LaneConfigReader } from "../vault/lane-config";

/** Fixed text (no provider text, no config values) for a read or write refused because the provider is not enabled for the lane. */
export const PROVIDER_DISABLED_MESSAGE = "This provider is not enabled for this company";

export const COMMS_PROVIDERS: readonly CommsProviderId[] = ["google", "microsoft"];
export const isCommsProvider = (p: string): p is CommsProviderId => (COMMS_PROVIDERS as readonly string[]).includes(p);

export interface ProviderGate {
  /** True when a connection of `provider` may be synced, read or written in the lane. Providers that are not mail/calendar providers: true, with no config read. */
  enabled(laneId: LaneId, provider: string): Promise<boolean>;
  /** Throws `connection_unavailable` (PROVIDER_DISABLED_MESSAGE) when not enabled. Call before any token read. */
  assertEnabled(laneId: LaneId, provider: string): Promise<void>;
}

/**
 * The one decision, from settings already read (so a caller that needs more of the same read, like the Microsoft guard's tenant
 * check, decides from that read and never from a second one).
 */
export function providerEnabledIn(settings: { providers: readonly string[]; microsoft: unknown }, provider: CommsProviderId): boolean {
  if (!settings.providers.includes(provider)) return false;
  return provider === "microsoft" ? settings.microsoft !== null && settings.microsoft !== undefined : true;
}

export function createProviderGate(deps: { laneConfig: Pick<LaneConfigReader, "mailProviderSettings"> }): ProviderGate {
  async function enabled(laneId: LaneId, provider: string): Promise<boolean> {
    if (!isCommsProvider(provider)) return true;
    return providerEnabledIn(await deps.laneConfig.mailProviderSettings(laneId), provider);
  }
  return {
    enabled,
    async assertEnabled(laneId, provider) {
      if (!(await enabled(laneId, provider))) throw new ConnectorError({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    },
  };
}

/** True for the error `assertEnabled` throws (the message is fixed, so callers can tell it from other unavailable connections). */
export function isProviderDisabledError(e: unknown): boolean {
  return e instanceof ConnectorError && e.info.kind === "connection_unavailable" && e.info.message === PROVIDER_DISABLED_MESSAGE;
}
