// The Microsoft guard (T-256, spec §7 "Guard"; mirrors google/guard.ts). Every Graph call runs it FIRST, before any Vault token
// read and before any request. One `mailProviderSettings` read decides (never `isMailProviderEnabled` plus a separate
// `microsoftSettings`: two reads could mix two config versions), then in this order:
//   lane brand -> provider `microsoft` -> authoritative row (id, status usable) -> Microsoft enabled for the lane (`microsoft` in
//   `mail.providers` AND a valid `microsoft` block) -> the lane's cloud is one this build serves -> the row's `tenant_id` is in the
//   block's `tenant_ids` -> the row's `cloud` is the lane's cloud -> mail policy on the address.
// The guard never looks at the lane's Google settings or connections: a lane with Google enabled as well is no reason to refuse.
// It returns a `GuardedMicrosoftConnection`, the only thing the token manager accepts, so a token is never read for a call
// that was not checked.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { PROVIDER_DISABLED_MESSAGE, providerEnabledIn } from "../facade/gate";
import { assertMailAccountAllowed, readMailPolicy } from "../mail-policy";
import type { LaneConfigReader } from "../vault/lane-config";
import { isCloudSupported, isTenantId, type MicrosoftCloud } from "./constants";

export type MicrosoftConnection = LaneBoundConnection<"microsoft">;

export function assertMicrosoftConnection(conn: { readonly provider: string }): asserts conn is MicrosoftConnection {
  if (conn.provider !== "microsoft") throw new ConnectorError({ kind: "forbidden", message: "Connection belongs to another provider" });
}

/** Refuses a base URL whose host is not in `allowed` (the per-cloud allow-list). Run before any token is read. */
export function assertGraphHost(baseUrl: string, allowed: ReadonlySet<string>): void {
  const ok = URL.canParse(baseUrl) && allowed.has(new URL(baseUrl).hostname);
  if (!ok) throw new ConnectorError({ kind: "invalid_input", message: "Host is not an allowed Microsoft host" });
}

/** The identity set once at connect time (T-254): the tenant the account signed in to and the cloud it lives in. */
export type MicrosoftIdentity = { tenantId: string | null; cloud: string | null };
export interface MicrosoftIdentityReader {
  read(laneId: LaneId, connectionId: string): Promise<MicrosoftIdentity>;
}

declare const guardedBrand: unique symbol;
/** A connection the guard approved for one call: the authoritative row plus the tenant and cloud it was checked against. */
export type GuardedMicrosoftConnection = {
  readonly conn: MicrosoftConnection;
  readonly tenantId: string;
  readonly cloud: MicrosoftCloud;
  readonly [guardedBrand]: true;
};
const approved = new WeakSet<object>();
export const isGuarded = (v: unknown): v is GuardedMicrosoftConnection => typeof v === "object" && v !== null && approved.has(v);

export type MicrosoftGuardDeps = {
  /** The authoritative connection row (status, lane, provider), read on every call. */
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "mailDomains" | "mailProviderSettings">;
  identity: MicrosoftIdentityReader;
};

export const TENANT_NOT_ALLOWED_MESSAGE = "This Microsoft tenant is not allowed for this company";
export const CLOUD_CHANGED_MESSAGE = "This company's Microsoft cloud changed; reconnect this account";
export const CLOUD_UNSUPPORTED_MESSAGE = "This Microsoft cloud is not supported yet";
export const IDENTITY_MISSING_MESSAGE = "The tenant of this Microsoft account is not recorded; reconnect this account";

export type MicrosoftGuard = (laneId: LaneId, conn: unknown) => Promise<GuardedMicrosoftConnection>;

export function createMicrosoftGuard(deps: MicrosoftGuardDeps): MicrosoftGuard {
  return async function guard(laneId, conn) {
    assertLaneBound(laneId, conn);
    assertMicrosoftConnection(conn);
    const row = await deps.connections.load(laneId, conn.id);
    assertMicrosoftConnection(row);
    if (row.id !== conn.id || row.lane_id !== laneId) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection row does not match" });
    assertStatusUsable(row.status);

    // ONE read of the lane's mail provider settings decides everything below that is about the lane's configuration.
    const settings = await deps.laneConfig.mailProviderSettings(laneId);
    if (!providerEnabledIn(settings, "microsoft") || !settings.microsoft) {
      throw new ConnectorError({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    }
    const lane = settings.microsoft;
    if (!isCloudSupported(lane.cloud)) throw new ConnectorError({ kind: "unsupported_op", message: CLOUD_UNSUPPORTED_MESSAGE });

    const identity = await deps.identity.read(laneId, row.id);
    const tenantId = typeof identity.tenantId === "string" ? identity.tenantId.toLowerCase() : null;
    if (!isTenantId(tenantId) || (identity.cloud !== "commercial" && identity.cloud !== "gcc_high")) {
      throw new ConnectorError({ kind: "connection_unavailable", message: IDENTITY_MISSING_MESSAGE });
    }
    if (!lane.tenantIds.some((t) => t.toLowerCase() === tenantId)) throw new ConnectorError({ kind: "forbidden", message: TENANT_NOT_ALLOWED_MESSAGE });
    if (identity.cloud !== lane.cloud) throw new ConnectorError({ kind: "connection_unavailable", message: CLOUD_CHANGED_MESSAGE });

    // An account whose domain is not allowed for the lane, or that is no longer on the exact mailbox list, is not read (T-247).
    assertMailAccountAllowed(await readMailPolicy(deps.laneConfig, laneId), row.external_account_id);

    const guarded = Object.freeze({ conn: row, tenantId, cloud: identity.cloud }) as unknown as GuardedMicrosoftConnection;
    approved.add(guarded);
    return guarded;
  };
}
