// Settings → Connections, Google section (T-199; T-247): who may see it and what it shows. Read-only SQL through the signed-in
// user's own lane client (RLS: AAL2, lane membership); no external call, no write (rule 5). T-247: every Google connection has an
// OWNER. A member sees their own accounts ("Your Google accounts": connect, reconnect) and, with the connections view (owner,
// admin_technical), the HEALTH of the other accounts of the company (status, last sync, address; no content, no buttons: only an
// account's owner reconnects it).
// The output type has exactly these fields: mailbox address, status, last mail and calendar sync times. Tokens, cursor
// values (the column is not even granted), subjects, senders and event titles never reach it.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { CONNECT_ROLES, MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";
import { mailAccountAllowed } from "@nichols/connectors/mail-policy";

export type GoogleConnectionState = "connected" | "connecting" | "degraded" | "reconnect_required" | "disconnected";

export type GoogleConnectionView = {
  /** core.connections.id (a UUID; used as the list key). */
  id: string;
  /** The connected mailbox address (core.connections.external_account_id). */
  mailbox: string;
  state: GoogleConnectionState;
  /** False when the account is not allowed for the lane (domain not in `lane_config.mail.allowed_domains`, or not on the exact `mailboxes` list when the lane keeps one): the sync refuses it until the config is fixed. */
  mailboxAllowed: boolean;
  /** True when the signed-in user owns this account (they can reconnect it); false for another person's account (health only). */
  mine: boolean;
  /** ISO times of the last cursor write per stream; null = not synced yet. */
  lastMailSyncAt: string | null;
  lastCalendarSyncAt: string | null;
};

/** `unavailable`: the connection state could not be read (database outage); the page says so instead of "not connected". */
export type GoogleSectionView = {
  connections: GoogleConnectionView[];
  unavailable?: true;
  /** True for owner and admin_technical (the connections view): they also get "Sync now" (the route checks the same). */
  canSync?: true;
};

type Db = Pick<LaneClient, "schema">;
type RoleGuards = Pick<Guards, "requireRole">;

const STATES: Record<string, GoogleConnectionState | undefined> = {
  active: "connected",
  pending: "connecting",
  degraded: "degraded",
  reconnect_required: "reconnect_required",
  // T-238: a disconnected row is listed so it can be reconnected (the same row is reused, never a second one).
  disconnected: "disconnected",
};

/** Pure mapping of a connection status; undefined = not shown (an unknown status). */
export function mapGoogleStatus(status: unknown): GoogleConnectionState | undefined {
  return typeof status === "string" ? STATES[status] : undefined;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string").map((m) => m.toLowerCase()) : []);
/** The lane's mail policy from the two config fields the page reads: `mailboxes` and `mail`. */
function mailPolicyOf(config: unknown): { domains: string[]; mailboxes: string[] } {
  const c = typeof config === "object" && config !== null ? (config as { mailboxes?: unknown; mail?: unknown }) : {};
  const mail = typeof c.mail === "object" && c.mail !== null ? (c.mail as { allowed_domains?: unknown }) : {};
  return { domains: strings(mail.allowed_domains), mailboxes: strings(c.mailboxes) };
}

/**
 * The Google connections the caller may see in the lane, as the page shows them: their own, and (connections view) the others'
 * health. `userId` marks which are theirs. Throws on a database error (the page must not show "not connected" for an outage).
 */
export async function loadGoogleSection(client: Db, laneId: string, userId?: string): Promise<GoogleSectionView> {
  const core = client.schema("core");
  const conns = await core
    .from("connections")
    .select("id, external_account_id, status, owner_user_id")
    .eq("lane_id", laneId)
    .eq("provider", "google")
    .eq("transport", "native") // Composio connections have their own section (T-219)
    .order("created_at", { ascending: true });
  if (conns.error) throw new Error("connections unavailable");
  const rows = (conns.data ?? []).flatMap((r) => {
    const state = mapGoogleStatus(r.status);
    return state && typeof r.id === "string" && typeof r.external_account_id === "string"
      ? [{ id: r.id, mailbox: r.external_account_id, state, mine: userId !== undefined && r.owner_user_id === userId }]
      : [];
  });
  if (rows.length === 0) return { connections: [] };

  const ids = rows.map((r) => r.id);
  // core.sync_cursors is not in the generated database types yet (T-063 added it); the shape is fixed by its column grants.
  type CursorRow = { connection_id: string; stream: string; updated_at: string };
  type CursorQuery = { select(c: string): { eq(c: string, v: string): { in(c: string, v: string[]): { in(c: string, v: string[]): PromiseLike<{ data: CursorRow[] | null; error: unknown }> } } } };
  // The sync times and the lane's allowed mailboxes are independent reads: together (T-230 A).
  const [cursors, cfg] = await Promise.all([
    (core as unknown as { from(t: string): CursorQuery })
      .from("sync_cursors")
      .select("connection_id, stream, updated_at") // never cursor_value
      .eq("lane_id", laneId)
      .in("connection_id", ids)
      .in("stream", ["mail", "calendar"]),
    core.from("lane_config_current").select("mailboxes:config->mailboxes, mail:config->mail").eq("lane_id", laneId).maybeSingle(),
  ]);
  if (cursors.error) throw new Error("sync state unavailable");
  const at = new Map<string, string | null>();
  for (const c of cursors.data ?? []) at.set(`${String(c.connection_id)}:${String(c.stream)}`, iso(c.updated_at));

  if (cfg.error) throw new Error("lane settings unavailable");
  const policy = mailPolicyOf(cfg.data);

  return {
    connections: rows.map((r) => ({
      id: r.id,
      mailbox: r.mailbox,
      state: r.state,
      mailboxAllowed: mailAccountAllowed(policy, r.mailbox),
      mine: r.mine,
      lastMailSyncAt: at.get(`${r.id}:mail`) ?? null,
      lastCalendarSyncAt: at.get(`${r.id}:calendar`) ?? null,
    })),
  };
}

/**
 * Settings page: the section is drawn for a member who may connect their own Google account (owner, admin_technical, viewer: the
 * own_mail view) at AAL2. Other roles, AAL1 and lanes that are not theirs get null (no buttons, no data). An outage while reading (after the role check passed) gives an
 * `unavailable` view, so it is never shown as "not connected" and does not take the rest of Settings down; an outage in
 * the role check itself rethrows.
 */
export async function googleSectionFor(g: RoleGuards, laneId: string, load: (client: Db, laneId: string, userId?: string) => Promise<GoogleSectionView> = loadGoogleSection): Promise<GoogleSectionView | null> {
  let client: Db;
  let userId: string;
  try {
    const r = await g.requireRole(laneId, [...MAIL_CONNECT_ROLES]);
    client = r.client;
    userId = r.session.userId;
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  const canSync = await g.requireRole(laneId, [...CONNECT_ROLES]).then(
    () => true,
    (e: unknown) => {
      if (e instanceof AuthError) return false;
      throw e;
    },
  );
  try {
    const view = await load(client, laneId, userId);
    return canSync ? { ...view, canSync: true } : view;
  } catch {
    return { connections: [], unavailable: true, ...(canSync ? { canSync: true as const } : {}) };
  }
}
