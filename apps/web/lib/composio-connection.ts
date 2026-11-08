// Settings → Connections, Composio section (T-219): who may see it and what it shows. Read-only SQL through the signed-in
// owner's or admin_technical's own lane client (RLS: AAL2, lane membership); no external call, no write (rule 5). The
// output has exactly: per toolkit, the status, the account address (the verified mailbox) and the last sync time. The
// Composio connected account id, tokens and any content never reach it. Which toolkits are configured comes from the
// server (booleans only).
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";

export const COMPOSIO_TOOLKITS = [
  { toolkit: "gmail", label: "Gmail" },
  { toolkit: "googlecalendar", label: "Google Calendar" },
] as const;
export type ComposioToolkitId = (typeof COMPOSIO_TOOLKITS)[number]["toolkit"];

export type ComposioConnectionState = "connected" | "connecting" | "degraded" | "reconnect_required";

export type ComposioToolkitView = {
  toolkit: ComposioToolkitId;
  label: string;
  /** False when the auth config id (or the project key) is not set on the server: the button says "Not configured". */
  configured: boolean;
  /** Null = not connected. */
  connection: null | {
    id: string;
    state: ComposioConnectionState;
    /** The verified account address; null until the connect completes. */
    address: string | null;
    /** False when the address is not in `lane_config.mailboxes` (calls are refused until the list is fixed). */
    mailboxAllowed: boolean;
    lastSyncAt: string | null;
  };
};

/** `unavailable`: the state could not be read (database outage); the page says so instead of "not connected". */
export type ComposioSectionView = { toolkits: ComposioToolkitView[]; unavailable?: true };

type Db = Pick<LaneClient, "schema">;
type RoleGuards = Pick<Guards, "requireRole">;
export type Availability = Record<ComposioToolkitId, boolean>;

const STATES: Record<string, ComposioConnectionState | undefined> = {
  active: "connected",
  pending: "connecting",
  degraded: "degraded",
  reconnect_required: "reconnect_required",
};

const iso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function mailboxList(config: unknown): string[] {
  const list = typeof config === "object" && config !== null ? (config as { mailboxes?: unknown }).mailboxes : undefined;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string").map((m) => m.toLowerCase()) : [];
}

/** The lane's Composio connections as the page shows them. Throws on a database error. */
export async function loadComposioSection(client: Db, laneId: string, availability: Availability, now: number = Date.now()): Promise<ComposioSectionView> {
  const core = client.schema("core");
  const conns = await core
    .from("connections")
    .select("id, toolkit, account_identity, status, last_sync_at, created_at")
    .eq("lane_id", laneId)
    .eq("transport", "composio")
    .neq("status", "disconnected")
    .order("created_at", { ascending: false });
  if (conns.error) throw new Error("connections unavailable");
  const cfg = await core.from("lane_config_current").select("mailboxes:config->mailboxes").eq("lane_id", laneId).maybeSingle();
  if (cfg.error) throw new Error("lane settings unavailable");
  const allowed = mailboxList(cfg.data);
  const rows = conns.data ?? [];
  return {
    toolkits: COMPOSIO_TOOLKITS.map(({ toolkit, label }) => {
      // Newest first; a pending row (abandoned or in flight) never hides a usable one.
      // A pending row older than the connect state's lifetime (10 minutes) is abandoned and hidden.
      const stale = (r: { status: unknown; created_at: unknown }) => r.status === "pending" && !(typeof r.created_at === "string" && now - Date.parse(r.created_at) < 10 * 60 * 1000);
      const mine = rows.filter((r) => r.toolkit === toolkit && typeof r.id === "string" && STATES[String(r.status)] && !stale(r));
      const row = mine.find((r) => r.status !== "pending") ?? mine[0];
      const address = row && typeof row.account_identity === "string" ? row.account_identity : null;
      return {
        toolkit,
        label,
        configured: availability[toolkit],
        connection: row
          ? {
              id: String(row.id),
              state: STATES[String(row.status)] as ComposioConnectionState,
              address,
              mailboxAllowed: address !== null && allowed.includes(address.toLowerCase()),
              lastSyncAt: iso(row.last_sync_at),
            }
          : null,
      };
    }),
  };
}

/** Settings page: drawn only for an owner or admin_technical at AAL2 (others and AAL1 get null: no buttons, no data). An outage after the role check is an `unavailable` view. */
export async function composioSectionFor(
  g: RoleGuards,
  laneId: string,
  availability: () => Availability,
  load: typeof loadComposioSection = loadComposioSection,
): Promise<ComposioSectionView | null> {
  let client: Db;
  try {
    ({ client } = await g.requireRole(laneId, CONNECT_ROLES));
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  const avail = availability();
  try {
    return await load(client, laneId, avail);
  } catch {
    return { toolkits: COMPOSIO_TOOLKITS.map(({ toolkit, label }) => ({ toolkit, label, configured: avail[toolkit], connection: null })), unavailable: true };
  }
}
