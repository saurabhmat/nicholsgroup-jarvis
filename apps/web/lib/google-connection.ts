// Settings → Connections, Google section (T-199): who may see it and what it shows. Read-only SQL through the signed-in
// owner's or admin_technical's own lane client (RLS: AAL2, lane membership); no external call, no write (rule 5).
// The output type has exactly these fields: mailbox address, status, last mail and calendar sync times. Tokens, cursor
// values (the column is not even granted), subjects, senders and event titles never reach it.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";

export type GoogleConnectionState = "connected" | "connecting" | "degraded" | "reconnect_required";

export type GoogleConnectionView = {
  /** core.connections.id (a UUID; used as the list key). */
  id: string;
  /** The connected mailbox address (core.connections.external_account_id). */
  mailbox: string;
  state: GoogleConnectionState;
  /** False when the mailbox is not in `lane_config.mailboxes` (the sync refuses it until the list is fixed). */
  mailboxAllowed: boolean;
  /** ISO times of the last cursor write per stream; null = not synced yet. */
  lastMailSyncAt: string | null;
  lastCalendarSyncAt: string | null;
};

/** `unavailable`: the connection state could not be read (database outage); the page says so instead of "not connected". */
export type GoogleSectionView = { connections: GoogleConnectionView[]; unavailable?: true };

type Db = Pick<LaneClient, "schema">;
type RoleGuards = Pick<Guards, "requireRole">;

const STATES: Record<string, GoogleConnectionState | undefined> = {
  active: "connected",
  pending: "connecting",
  degraded: "degraded",
  reconnect_required: "reconnect_required",
  // 'disconnected' is deliberately absent: such a row is shown as not connected.
};

/** Pure mapping of a connection status; undefined = not shown (disconnected or unknown). */
export function mapGoogleStatus(status: unknown): GoogleConnectionState | undefined {
  return typeof status === "string" ? STATES[status] : undefined;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function mailboxList(config: unknown): string[] {
  const list = typeof config === "object" && config !== null ? (config as { mailboxes?: unknown }).mailboxes : undefined;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string").map((m) => m.toLowerCase()) : [];
}

/** The lane's Google connections as the page shows them. Throws on a database error (the page must not show "not connected" for an outage). */
export async function loadGoogleSection(client: Db, laneId: string): Promise<GoogleSectionView> {
  const core = client.schema("core");
  const conns = await core
    .from("connections")
    .select("id, external_account_id, status")
    .eq("lane_id", laneId)
    .eq("provider", "google")
    .eq("transport", "native") // Composio connections have their own section (T-219)
    .order("created_at", { ascending: true });
  if (conns.error) throw new Error("connections unavailable");
  const rows = (conns.data ?? []).flatMap((r) => {
    const state = mapGoogleStatus(r.status);
    return state && typeof r.id === "string" && typeof r.external_account_id === "string" ? [{ id: r.id, mailbox: r.external_account_id, state }] : [];
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
    core.from("lane_config_current").select("mailboxes:config->mailboxes").eq("lane_id", laneId).maybeSingle(),
  ]);
  if (cursors.error) throw new Error("sync state unavailable");
  const at = new Map<string, string | null>();
  for (const c of cursors.data ?? []) at.set(`${String(c.connection_id)}:${String(c.stream)}`, iso(c.updated_at));

  if (cfg.error) throw new Error("lane settings unavailable");
  const allowed = mailboxList(cfg.data);

  return {
    connections: rows.map((r) => ({
      id: r.id,
      mailbox: r.mailbox,
      state: r.state,
      mailboxAllowed: allowed.includes(r.mailbox.toLowerCase()),
      lastMailSyncAt: at.get(`${r.id}:mail`) ?? null,
      lastCalendarSyncAt: at.get(`${r.id}:calendar`) ?? null,
    })),
  };
}

/**
 * Settings page: the section is drawn only for an owner or admin_technical at AAL2. Other roles, AAL1 and lanes that are
 * not theirs get null (no buttons, no data). An outage while reading (after the role check passed) gives an
 * `unavailable` view, so it is never shown as "not connected" and does not take the rest of Settings down; an outage in
 * the role check itself rethrows.
 */
export async function googleSectionFor(g: RoleGuards, laneId: string, load = loadGoogleSection): Promise<GoogleSectionView | null> {
  let client: Db;
  try {
    ({ client } = await g.requireRole(laneId, CONNECT_ROLES));
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  try {
    return await load(client, laneId);
  } catch {
    return { connections: [], unavailable: true };
  }
}
