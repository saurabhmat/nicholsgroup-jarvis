// Settings -> Connections, "Your Teams account" (T-280; spec docs/specs/messages.md 5, 11). Read-only SQL through the signed-in user's own lane client (RLS); no external call, no write.
// A member with `own_mail` (owner, admin_technical, viewer) sees their own Teams account and, with the connections view, the HEALTH of other people's (status and address; never chats).
// The output holds the sign-in name, the status and which features the connection has. Tokens, tenant ids and the Entra object id (not even readable by this client) never reach it.
//   - Teams enabled for the company (`teams.enabled`, a supported cloud): the section, with Sign in / Reconnect / Disconnect.
//   - Not enabled: rows that exist are kept and listed as paused (no Sign in, no Reconnect, data kept, Disconnect still possible for the owner); with no rows there is no section.
//   - The company's Teams settings could not be read: fail closed (no Sign in, no Reconnect); only a person who has Teams rows sees anything.
// The company's mail providers are never consulted: a Google-mail company has this section.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import type { TeamsFeature } from "@nichols/core/lane-config";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { teamsSettingsOf, type TeamsLaneView } from "@nichols/connectors/teams-settings";
import { mapGoogleStatus, type GoogleConnectionState } from "./google-connection";

export const TEAMS_FEATURE_LIST: readonly TeamsFeature[] = ["chat_read", "chat_send", "call_links", "channels_read", "channels_send"];

export type TeamsConnectionView = {
  id: string;
  /** The sign-in name (core.connections.external_account_id). */
  account: string;
  state: GoogleConnectionState;
  /** True when the signed-in user owns it (they can reconnect or disconnect it); false = another person's account: health only. */
  mine: boolean;
  /** The features the connection has (what was requested and granted at its last connect). */
  has: TeamsFeature[];
};

export type TeamsSectionView = {
  connections: TeamsConnectionView[];
  /** The features the company lists. */
  laneFeatures: TeamsFeature[];
  needsAdminConsent: boolean;
  /** Teams is not enabled for this company (any more): rows are kept, no Sign in or Reconnect. */
  paused?: true;
  /** Teams is enabled in the settings but this Microsoft cloud is not supported yet (GCC High): paused for that reason (T-278 review C5). */
  unsupportedCloud?: true;
  /** The company's Teams settings could not be read. */
  settingsUnknown?: true;
  /** The connection rows could not be read. */
  unavailable?: true;
};

type Db = Pick<LaneClient, "schema">;
type RoleGuards = Pick<Guards, "requireRole">;

const hasFeature = (features: unknown, f: TeamsFeature): boolean => typeof features === "object" && features !== null && (features as Record<string, unknown>)[`teams_${f}`] === true;

/** The Teams connections the caller may see in the lane, as the page shows them. Throws on a database error (the page must not show "not connected" for an outage). */
export async function loadTeamsRows(client: Db, laneId: string, userId: string): Promise<TeamsConnectionView[]> {
  const res = await client.schema("core").from("connections").select("id, external_account_id, status, owner_user_id, features").eq("lane_id", laneId).eq("provider", "microsoft_teams").order("created_at", { ascending: true });
  if (res.error) throw new Error("connections unavailable");
  return (res.data ?? []).flatMap((r) => {
    // A `pending` row is a connect that has not stored a token (the row is made before the account is checked): it is not a connection, so it is neither listed nor does it hide Sign in (T-278 review C2).
    if (r.status === "pending") return [];
    const state = mapGoogleStatus(r.status);
    return state && typeof r.id === "string" && typeof r.external_account_id === "string"
      ? [{ id: r.id, account: r.external_account_id, state, mine: r.owner_user_id === userId, has: TEAMS_FEATURE_LIST.filter((f) => hasFeature(r.features, f)) }]
      : [];
  });
}

export async function teamsSectionFor(
  g: RoleGuards,
  laneId: string,
  load: (client: Db, laneId: string, userId: string) => Promise<TeamsConnectionView[]> = loadTeamsRows,
  lane: (laneId: LaneId) => Promise<TeamsLaneView | null> = teamsSettingsOf,
  /** The Messages page wants the view even when Settings would draw no section (Teams not enabled and no rows: "Teams is not set up"). */
  opts: { keepEmpty?: boolean } = {},
): Promise<TeamsSectionView | null> {
  let client: Db;
  let userId: string;
  try {
    const r = await g.requireRole(laneId, [...MAIL_CONNECT_ROLES]);
    client = r.client;
    userId = r.session.userId;
  } catch (e) {
    if (e instanceof AuthError) return null; // the caller may not connect their own account here: no section, no read
    throw e;
  }
  // The two reads are independent: together.
  const [settings, rows] = await Promise.allSettled([lane(laneId as LaneId), load(client, laneId, userId)]);
  const view = settings.status === "fulfilled" ? settings.value : undefined; // undefined = unreadable
  const base = { laneFeatures: view?.features ?? [], needsAdminConsent: view?.needsAdminConsent ?? false };
  if (rows.status === "rejected") return (view?.enabled && view.cloudSupported) || opts.keepEmpty ? { connections: [], ...base, unavailable: true } : null;
  const connections = rows.value;
  if (view === undefined) return connections.length === 0 && !opts.keepEmpty ? null : { connections, ...base, settingsUnknown: true };
  if (view === null || !view.enabled || !view.cloudSupported) {
    const unsupportedCloud = view !== null && view.enabled && !view.cloudSupported;
    return connections.length === 0 && !opts.keepEmpty ? null : { connections, ...base, paused: true, ...(unsupportedCloud ? { unsupportedCloud: true as const } : {}) };
  }
  return { connections, ...base };
}
