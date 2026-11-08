// Composio connection rows (T-219) with the lane's job client: a pending row when a connect starts its callback, the
// security-definer activation (no token row), the lane's current row per toolkit, and health writes. Every query names
// the lane; database messages are never passed on (fixed ConnectorError text). The Composio connected account id comes
// only from the lane-bound row (`external_account_id`), never from request input (spec §8.5).
import type { LaneId } from "@nichols/core";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";
import { COMPOSIO_PROVIDER, CONNECTED_ACCOUNT_ID, isToolkit, type Toolkit } from "./constants";

export type ComposioConnectionStatus = "pending" | "active" | "degraded" | "reconnect_required" | "disconnected";

export type ComposioConnection = {
  id: string;
  laneId: LaneId;
  toolkit: Toolkit;
  /** The Composio connected account id (`ca_...`). */
  accountId: string;
  /** The verified account address (lower-cased); null until activated. */
  identity: string | null;
  status: ComposioConnectionStatus;
  /** The Jarvis user who connected it: Composio's `userId` for calls on this account. */
  createdBy: string | null;
  lastSyncAt: string | null;
};

export interface ComposioConnectionStore {
  /** The lane's pending row for this connected account, created when missing (a retry reuses it). */
  ensurePending(laneId: LaneId, toolkit: Toolkit, accountId: string, createdBy: string): Promise<ComposioConnection>;
  /** Activates the row (identity verified by the caller). Throws `forbidden` + ACCOUNT_IN_USE_MESSAGE when another lane holds the account. */
  activate(laneId: LaneId, connectionId: string, identity: string, actorUserId: string): Promise<void>;
  /** The lane's newest composio connection for the toolkit that is not disconnected, or null. */
  find(laneId: LaneId, toolkit: Toolkit): Promise<ComposioConnection | null>;
  /** Binds the toolkit and the connected account id created by `link` to the user's own pending state (`core.oauth_state_bind`, service_role); once. */
  bindState(laneId: LaneId, userId: string, stateHash: string, toolkit: Toolkit, accountId: string): Promise<void>;
  /** Deletes a `pending` composio row of the lane (a connect that was refused or failed); never touches any other status. */
  discardPending(laneId: LaneId, connectionId: string): Promise<void>;
  /** Moves a usable connection to `reconnect_required` (or back to `active`) when Composio's account status says so; true when changed. */
  setHealth(laneId: LaneId, conn: ComposioConnection, to: "active" | "reconnect_required"): Promise<boolean>;
}

const LANE_ID = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["pending", "active", "degraded", "reconnect_required", "disconnected"]);
/** A pending row older than the connect state's lifetime (10 minutes) is abandoned: ignored by `find`. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
const COLUMNS = "id, lane_id, toolkit, external_account_id, account_identity, status, created_by, last_sync_at";

function parseRow(row: unknown): ComposioConnection {
  const r = row as Record<string, unknown> | null;
  if (
    !r || typeof r.id !== "string" || !UUID.test(r.id) || typeof r.lane_id !== "string" || !LANE_ID.test(r.lane_id) || !isToolkit(r.toolkit) ||
    typeof r.external_account_id !== "string" || !CONNECTED_ACCOUNT_ID.test(r.external_account_id) || typeof r.status !== "string" || !STATUSES.has(r.status)
  ) {
    throw new ConnectorError({ kind: "provider_error", message: "Stored connection row is invalid" });
  }
  return {
    id: r.id,
    laneId: r.lane_id,
    toolkit: r.toolkit,
    accountId: r.external_account_id,
    identity: typeof r.account_identity === "string" ? r.account_identity : null,
    status: r.status as ComposioConnectionStatus,
    createdBy: typeof r.created_by === "string" ? r.created_by : null,
    lastSyncAt: typeof r.last_sync_at === "string" ? r.last_sync_at : null,
  };
}

export function createComposioConnectionStore(clientFor: JobClientFor, now: () => number = Date.now): ComposioConnectionStore {
  async function client(laneId: LaneId) {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    try {
      return await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
    }
  }
  const unavailable = () => new ConnectorError({ kind: "transient", message: "Connection store unavailable" });

  return {
    async ensurePending(laneId, toolkit, accountId, createdBy) {
      if (!isToolkit(toolkit) || !CONNECTED_ACCOUNT_ID.test(accountId) || !UUID.test(createdBy)) throw new ConnectorError({ kind: "invalid_input", message: "A toolkit, an account id and a user are required" });
      const db = await client(laneId);
      try {
        const table = () => db.schema("core").from("connections");
        const inserted = await table().upsert(
          { lane_id: laneId, provider: COMPOSIO_PROVIDER, external_account_id: accountId, transport: "composio", toolkit, status: "pending", created_by: createdBy },
          { onConflict: "lane_id,provider,external_account_id", ignoreDuplicates: true },
        );
        if (inserted.error) throw inserted.error;
        const { data, error } = await table()
          .select(COLUMNS)
          .eq("lane_id", laneId)
          .eq("provider", COMPOSIO_PROVIDER)
          .eq("external_account_id", accountId)
          .eq("transport", "composio")
          .eq("toolkit", toolkit)
          .maybeSingle();
        if (error || !data) throw error ?? new Error("missing");
        return parseRow(data);
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        throw unavailable();
      }
    },

    async activate(laneId, connectionId, identity, actorUserId) {
      if (!UUID.test(connectionId) || !UUID.test(actorUserId)) throw new ConnectorError({ kind: "invalid_input", message: "A connection and a user are required" });
      const db = await client(laneId);
      const { error } = await db.schema("core").rpc("connection_activate_composio", { p_lane_id: laneId, p_connection_id: connectionId, p_identity: identity, p_actor_id: actorUserId });
      if (!error) return;
      if (error.code === "D0023") throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
      if (error.code === "22023") throw new ConnectorError({ kind: "provider_error", message: "The account identity is not valid" });
      throw unavailable();
    },

    async find(laneId, toolkit) {
      if (!isToolkit(toolkit)) throw new ConnectorError({ kind: "invalid_input", message: "A toolkit is required" });
      const db = await client(laneId);
      try {
        const { data, error } = await db
          .schema("core")
          .from("connections")
          .select(COLUMNS + ", created_at")
          .eq("lane_id", laneId)
          .eq("provider", COMPOSIO_PROVIDER)
          .eq("transport", "composio")
          .eq("toolkit", toolkit)
          .neq("status", "disconnected")
          .order("created_at", { ascending: false })
          .limit(10);
        if (error) throw error;
        const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
        // A usable row wins over any pending one; a pending row counts only while its connect could still finish.
        const fresh = (r: Record<string, unknown>) => r.status !== "pending" || (typeof r.created_at === "string" && now() - Date.parse(r.created_at) < PENDING_TTL_MS);
        const pick = rows.find((r) => r.status !== "pending") ?? rows.find(fresh);
        return pick ? parseRow(pick) : null;
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        throw unavailable();
      }
    },

    async bindState(laneId, userId, stateHash, toolkit, accountId) {
      if (!UUID.test(userId) || !/^[0-9a-f]{64}$/.test(stateHash) || !isToolkit(toolkit) || !CONNECTED_ACCOUNT_ID.test(accountId)) throw new ConnectorError({ kind: "invalid_input", message: "A user, a state, a toolkit and an account id are required" });
      const db = await client(laneId);
      const { error } = await db.schema("core").rpc("oauth_state_bind", { p_lane: laneId, p_state_hash: stateHash, p_user: userId, p_toolkit: toolkit, p_account_ref: accountId });
      if (error) throw unavailable();
    },

    async discardPending(laneId, connectionId) {
      if (!UUID.test(connectionId)) return;
      const db = await client(laneId);
      try {
        const { error } = await db.schema("core").from("connections").delete().eq("lane_id", laneId).eq("id", connectionId).eq("transport", "composio").eq("status", "pending");
        if (error) throw error;
      } catch {
        // Best effort: a leftover pending row is ignored after its TTL and never holds an account.
      }
    },

    async setHealth(laneId, conn, to) {
      if (conn.laneId !== laneId) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection belongs to another lane" });
      if (conn.status === to || conn.status === "pending" || conn.status === "disconnected") return false;
      const db = await client(laneId);
      try {
        const { data, error } = await db
          .schema("core")
          .from("connections")
          .update({ status: to })
          .eq("lane_id", laneId)
          .eq("id", conn.id)
          .eq("transport", "composio")
          .eq("status", conn.status)
          .select("id");
        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
      } catch {
        throw unavailable();
      }
    },
  };
}
