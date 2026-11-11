// Settings -> Connections, QuickBooks row (T-233): who may see it and what it shows. Read-only SQL through the signed-in
// owner's or admin_technical's own lane client (RLS: AAL2, lane membership, the `connections` view); no external call and
// no write (rule 5). The output has exactly: connection id (list key), realm id (the company id, shown to connect roles
// only), status, last sync time. Tokens and error text never reach it.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";

export type QuickBooksConnectionState = "connected" | "connecting" | "degraded" | "reconnect_required";

export type QuickBooksConnectionView = {
  id: string;
  /** core.connections.external_account_id: the QuickBooks company (realm) id. */
  realmId: string;
  state: QuickBooksConnectionState;
  /** End of the last successful sync (core.connections.last_sync_at); null = not synced yet. */
  lastSyncAt: string | null;
};

/** `unavailable`: the status could not be read (outage); the page says so instead of "not connected". */
export type QuickBooksSectionView = { connections: QuickBooksConnectionView[]; unavailable?: true };

type Db = Pick<LaneClient, "schema">;
type RoleGuards = Pick<Guards, "requireRole">;

const STATES: Record<string, QuickBooksConnectionState | undefined> = {
  active: "connected",
  pending: "connecting",
  degraded: "degraded",
  reconnect_required: "reconnect_required",
  // 'disconnected' is deliberately absent: such a row is shown as not connected.
};

export function mapQuickBooksStatus(status: unknown): QuickBooksConnectionState | undefined {
  return typeof status === "string" ? STATES[status] : undefined;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The lane's QuickBooks connections. Throws on a database error (an outage must not read as "not connected"). */
export async function loadQuickBooksSection(client: Db, laneId: string): Promise<QuickBooksSectionView> {
  const { data, error } = await client
    .schema("core")
    .from("connections")
    .select("id, external_account_id, status, last_sync_at")
    .eq("lane_id", laneId)
    .eq("provider", "quickbooks")
    .order("created_at", { ascending: true });
  if (error) throw new Error("connections unavailable");
  return {
    connections: (data ?? []).flatMap((r) => {
      const state = mapQuickBooksStatus(r.status);
      return state && typeof r.id === "string" && typeof r.external_account_id === "string" ? [{ id: r.id, realmId: r.external_account_id, state, lastSyncAt: iso(r.last_sync_at) }] : [];
    }),
  };
}

/**
 * Settings page: the row is drawn only for an owner or admin_technical at AAL2 (the same guard as connecting). Other roles,
 * AAL1 and lanes that are not theirs get null. An outage after the role check gives `unavailable`; an outage in the role
 * check itself rethrows.
 */
export async function quickbooksSectionFor(g: RoleGuards, laneId: string, load = loadQuickBooksSection): Promise<QuickBooksSectionView | null> {
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
