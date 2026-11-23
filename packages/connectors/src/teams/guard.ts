// The Teams guard (T-279, spec 6; mirrors microsoft/guard.ts). Every Graph call for a Teams connection runs it FIRST, before any Vault token read and before any request. ONE
// `teamsSettings` read decides (never the lane's mail settings: a Google-mail lane has Teams), then in this order:
//   lane brand -> provider `microsoft_teams` -> authoritative row (id, usable status) -> `teams.enabled` -> the lane's cloud is one this build serves -> the row's `tenant_id` is in
//   `teams.tenant_ids` -> the row's `cloud` is the lane's cloud -> the account's domain is in `teams.allowed_domains` -> the feature the operation needs is on in the lane AND on the
//   connection -> for a request made for a person, the row's OWNER is that person (an admin can read the row's HEALTH through RLS, so "the row is visible" proves nothing).
// It returns a `GuardedTeamsConnection`, the only thing the Teams token manager accepts, so a token is never read for a call that was not checked.
import type { LaneId } from "@nichols/core";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { ConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { LaneConfigReader, TeamsSettings } from "../vault/lane-config";
import { isCloudSupported, isTenantId, type MicrosoftCloud } from "../microsoft/constants";
import { TEAMS_PROVIDER, teamsFeatureKey } from "./constants";

export type TeamsConnection = LaneBoundConnection<typeof TEAMS_PROVIDER>;

export const TEAMS_NOT_ENABLED_MESSAGE = "Teams is not enabled for this company";
export const TEAMS_TENANT_NOT_ALLOWED_MESSAGE = "This Teams tenant is not allowed for this company";
export const TEAMS_CLOUD_CHANGED_MESSAGE = "This company's Microsoft cloud changed; reconnect Teams";
export const TEAMS_CLOUD_UNSUPPORTED_MESSAGE = "This Microsoft cloud is not supported for Teams yet";
export const TEAMS_IDENTITY_MISSING_MESSAGE = "The tenant of this Teams account is not recorded; reconnect Teams";
export const TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE = "This Teams account is not on a domain this company allows";
export const TEAMS_FEATURE_OFF_LANE_MESSAGE = "This Teams feature is not enabled for this company";
export const TEAMS_FEATURE_OFF_CONNECTION_MESSAGE = "This Teams connection does not have that feature; reconnect Teams";

export function assertTeamsConnection(conn: { readonly provider: string }): asserts conn is TeamsConnection {
  if (conn.provider !== TEAMS_PROVIDER) throw new ConnectorError({ kind: "forbidden", message: "Connection belongs to another provider" });
}

/** The identity set once at connect time (T-278): the tenant and cloud the account signed in to and its Entra object id. Server-only. */
export type TeamsIdentity = { tenantId: string | null; cloud: string | null; entraObjectId: string | null };
export interface TeamsIdentityReader {
  read(laneId: LaneId, connectionId: string): Promise<TeamsIdentity>;
}

declare const guardedBrand: unique symbol;
/** A connection the guard approved for one call: the authoritative row plus what it was checked against. */
export type GuardedTeamsConnection = {
  readonly conn: TeamsConnection;
  readonly tenantId: string;
  readonly cloud: MicrosoftCloud;
  /** The account's Entra object id (recognises the person's own messages; the subscription resource). */
  readonly entraObjectId: string;
  readonly settings: TeamsSettings;
  readonly [guardedBrand]: true;
};
const approved = new WeakSet<object>();
export const isGuardedTeams = (v: unknown): v is GuardedTeamsConnection => typeof v === "object" && v !== null && approved.has(v);

export type TeamsGuardDeps = {
  /** The authoritative connection row (status, lane, provider, owner, features), read on every call. */
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  laneConfig: Pick<LaneConfigReader, "teamsSettings">;
  identity: TeamsIdentityReader;
};

/** What a call needs beyond "a usable Teams connection of this lane". */
export type TeamsRequirement = {
  /** The lane feature the operation needs: on in `teams.features` AND recorded on the connection. */
  feature?: TeamsFeature | null;
  /** The signed-in person a user-request read is made for: the row's owner must be this user. Omitted only for jobs and health checks (which read `/me` only). */
  actorUserId?: string;
};

export type TeamsGuard = (laneId: LaneId, conn: unknown, requirement?: TeamsRequirement) => Promise<GuardedTeamsConnection>;

/** Whether `settings` (one read) let a call through, and why not: the lane-level checks only, without the connection row. Used by the guard and by the health skip. */
export function teamsLaneProblem(settings: TeamsSettings | null): string | null {
  if (settings === null || !settings.enabled) return TEAMS_NOT_ENABLED_MESSAGE;
  if (!isCloudSupported(settings.cloud)) return TEAMS_CLOUD_UNSUPPORTED_MESSAGE;
  return null;
}

export function createTeamsGuard(deps: TeamsGuardDeps): TeamsGuard {
  return async function guard(laneId, conn, requirement) {
    assertLaneBound(laneId, conn);
    assertTeamsConnection(conn);
    const row = await deps.connections.load(laneId, conn.id);
    assertTeamsConnection(row);
    if (row.id !== conn.id || row.lane_id !== laneId) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection row does not match" });
    assertStatusUsable(row.status);

    // ONE read of the lane's Teams settings decides everything below that is about the lane's configuration.
    const settings = await deps.laneConfig.teamsSettings(laneId);
    if (settings === null || !settings.enabled) throw new ConnectorError({ kind: "connection_unavailable", message: TEAMS_NOT_ENABLED_MESSAGE });
    if (!isCloudSupported(settings.cloud)) throw new ConnectorError({ kind: "unsupported_op", message: TEAMS_CLOUD_UNSUPPORTED_MESSAGE });

    const identity = await deps.identity.read(laneId, row.id);
    const tenantId = typeof identity.tenantId === "string" ? identity.tenantId.toLowerCase() : null;
    const entra = typeof identity.entraObjectId === "string" ? identity.entraObjectId.toLowerCase() : null;
    if (!isTenantId(tenantId) || !isTenantId(entra) || (identity.cloud !== "commercial" && identity.cloud !== "gcc_high")) {
      throw new ConnectorError({ kind: "connection_unavailable", message: TEAMS_IDENTITY_MISSING_MESSAGE });
    }
    if (!settings.tenantIds.some((t) => t.toLowerCase() === tenantId)) throw new ConnectorError({ kind: "forbidden", message: TEAMS_TENANT_NOT_ALLOWED_MESSAGE });
    if (identity.cloud !== settings.cloud) throw new ConnectorError({ kind: "connection_unavailable", message: TEAMS_CLOUD_CHANGED_MESSAGE });

    // An account whose domain is not listed for the lane is not read. Empty or malformed: refused (fail closed).
    const domain = row.external_account_id.includes("@") ? row.external_account_id.slice(row.external_account_id.lastIndexOf("@") + 1).toLowerCase() : "";
    if (domain === "" || !settings.allowedDomains.some((d) => d.toLowerCase() === domain)) throw new ConnectorError({ kind: "forbidden", message: TEAMS_DOMAIN_NOT_ALLOWED_MESSAGE });

    const feature = requirement?.feature ?? null;
    if (feature !== null) {
      if (!settings.features.includes(feature)) throw new ConnectorError({ kind: "forbidden", message: TEAMS_FEATURE_OFF_LANE_MESSAGE });
      if (row.features[teamsFeatureKey(feature)] !== true) throw new ConnectorError({ kind: "forbidden", message: TEAMS_FEATURE_OFF_CONNECTION_MESSAGE });
    }

    // A request made for a person reads only that person's own connection. `not_found`, the same answer as an unknown id, so another person's row is not revealed.
    if (requirement?.actorUserId !== undefined && (row.owner_user_id ?? null) !== requirement.actorUserId) {
      throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
    }

    const guarded = Object.freeze({ conn: row, tenantId, cloud: identity.cloud, entraObjectId: entra, settings }) as unknown as GuardedTeamsConnection;
    approved.add(guarded);
    return guarded;
  };
}
