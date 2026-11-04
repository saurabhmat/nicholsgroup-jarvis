// The QuickBooks company a callback names must be the one the lane is configured for (T-050; spec finance §8.1).
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { LaneConfigReader } from "../vault/lane-config";

const REALM = /^\d{1,20}$/;

/** The realm in the callback's query: exactly one `realmId`, digits only. */
export function realmFromCallback(query: URLSearchParams): string {
  const all = query.getAll("realmId");
  const realm = all.length === 1 ? all[0] : undefined;
  if (realm === undefined || !REALM.test(realm)) {
    throw new ConnectorError({ kind: "invalid_input", message: "The callback does not name exactly one QuickBooks company" });
  }
  return realm;
}

/**
 * Refuses a realm that is not the lane's configured one. When the lane has no realm configured, any company the
 * signed-in owner/admin authorises is accepted (first connect; local and preview only) and the config then pins it
 * (spec finance §8.1). With `requireConfigured` (production) a lane without a configured realm is refused: fail closed.
 * An outage reading the config is `transient`, not a refusal.
 */
export async function assertRealmAllowed(config: LaneConfigReader, laneId: LaneId, realm: string, options: { requireConfigured?: boolean } = {}): Promise<void> {
  if (!REALM.test(realm)) throw new ConnectorError({ kind: "invalid_input", message: "QuickBooks company id is not valid" });
  const configured = await config.qboRealmId(laneId);
  if (configured === null && options.requireConfigured) {
    throw new ConnectorError({ kind: "forbidden", message: "No QuickBooks company is configured for this lane" });
  }
  if (configured !== null && configured !== realm) {
    throw new ConnectorError({ kind: "forbidden", message: "This QuickBooks company is not the one configured for the lane" });
  }
}
