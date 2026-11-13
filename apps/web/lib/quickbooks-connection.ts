// Settings -> Connections, QuickBooks row (T-233, extended by T-197): who may see it and what it shows. Read-only SQL through the
// signed-in owner's or admin_technical's own lane client (RLS: AAL2, lane membership, the `connections` and `sync_runs` health
// views); no external call and no write (rule 5). Every read takes `laneId`. The output has exactly: connection id (list key), the
// last four characters of the realm id (never the whole id), status, last successful time per job, the class-tracking flag, and
// whether a disconnect is waiting for approval (its id and whether it can be approved yet). No tokens, no company name, no
// figures and no error text ever reach it.
import { AuthError, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";
import { capabilityOf, isQboDisconnectable, QBO_DISCONNECT, type ApprovalsPublicDeps } from "@nichols/approvals/server";
import { coreRpc } from "./approvals";

export type QuickBooksConnectionState = "connected" | "connecting" | "degraded" | "reconnect_required";
export const QBO_JOBS = ["sync", "reports", "normalize"] as const;
export type QuickBooksJob = (typeof QBO_JOBS)[number];

export type QuickBooksDisconnectView = {
  /** The pending disconnect proposal for this connection, if one is waiting for approval. */
  pendingId: string | null;
  /** Whether it can be approved now (lane policy class `qbo_disconnect` and approvals_live); the reason when not. Null = not read. */
  gate: { enabled: boolean; message: string | null } | null;
};

export type QuickBooksConnectionView = {
  id: string;
  /** The last four characters of the QuickBooks company (realm) id; "" for an id of 8 characters or fewer. The whole id is never sent to the page. */
  realmTail: string;
  state: QuickBooksConnectionState;
  /** End of the last successful sync (core.connections.last_sync_at); null = not synced yet. */
  lastSyncAt: string | null;
  /** Last successful run per job (sync = the books, reports, normalize = the finance tables); null = not yet. */
  jobs: { job: QuickBooksJob; at: string | null }[];
  /** `class_tracking` from the connection's detected features; null = not detected yet. */
  classTracking: boolean | null;
  disconnect: QuickBooksDisconnectView;
};

/** `unavailable`: the status could not be read (outage); the page says so instead of "not connected". `wasDisconnected`: no live connection, but one was disconnected. */
export type QuickBooksSectionView = { connections: QuickBooksConnectionView[]; unavailable?: true; wasDisconnected?: true };

type Db = Pick<LaneClient, "schema">;
type RoleGuards = Pick<Guards, "requireRole">;

const STATES: Record<string, QuickBooksConnectionState | undefined> = {
  active: "connected",
  pending: "connecting",
  degraded: "degraded",
  reconnect_required: "reconnect_required",
  // 'disconnected' is deliberately absent: such a row is shown as not connected (see `wasDisconnected`).
};

export function mapQuickBooksStatus(status: unknown): QuickBooksConnectionState | undefined {
  return typeof status === "string" ? STATES[status] : undefined;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Last four characters of the realm id; empty when the id is 8 characters or shorter (a tail would be half the id). */
export const realmTailOf = (realmId: string): string => (realmId.length > 8 ? realmId.slice(-4) : "");

/** One status list with the database and the approvals module: active, degraded and reconnect_required (not a connection still being set up). */
export const canDisconnect = (state: QuickBooksConnectionState): boolean => isQboDisconnectable(state === "connected" ? "active" : state);

const NO_DISCONNECT: QuickBooksDisconnectView = { pendingId: null, gate: null };

async function lastSuccess(client: Db, laneId: string, connectionId: string, job: QuickBooksJob): Promise<string | null> {
  const { data, error } = await client
    .schema("core")
    .from("sync_runs")
    .select("finished_at")
    .eq("lane_id", laneId)
    .eq("connection_id", connectionId)
    .eq("job", job)
    .eq("status", "succeeded")
    .order("finished_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("sync runs unavailable");
  const row = (data ?? [])[0] as { finished_at?: unknown } | undefined;
  return iso(row?.finished_at);
}

/** The lane's QuickBooks connections. Throws on a database error (an outage must not read as "not connected"). */
export async function loadQuickBooksSection(client: Db, laneId: string): Promise<QuickBooksSectionView> {
  const { data, error } = await client
    .schema("core")
    .from("connections")
    .select("id, external_account_id, status, last_sync_at, features")
    .eq("lane_id", laneId)
    .eq("provider", "quickbooks")
    .order("created_at", { ascending: true });
  if (error) throw new Error("connections unavailable");
  const rows = data ?? [];
  const live = rows.flatMap((r) => {
    const state = mapQuickBooksStatus(r.status);
    return state && typeof r.id === "string" && typeof r.external_account_id === "string" ? [{ r, id: r.id, realm: r.external_account_id, state }] : [];
  });
  const connections = await Promise.all(
    live.map(async ({ r, id, realm, state }): Promise<QuickBooksConnectionView> => {
      const features = (r.features ?? {}) as Record<string, unknown>;
      return {
        id,
        realmTail: realmTailOf(realm),
        state,
        lastSyncAt: iso(r.last_sync_at),
        jobs: await Promise.all(QBO_JOBS.map(async (job) => ({ job, at: await lastSuccess(client, laneId, id, job) }))),
        classTracking: typeof features.class_tracking === "boolean" ? features.class_tracking : null,
        disconnect: NO_DISCONNECT,
      };
    }),
  );
  return { connections, ...(connections.length === 0 && rows.some((r) => r.status === "disconnected") ? { wasDisconnected: true as const } : {}) };
}

type PendingDeps = Pick<ApprovalsPublicDeps, "readFacts">;

/**
 * Adds, to each disconnectable connection, the disconnect proposal waiting for approval (if any) and whether it could be approved
 * now. Read-only: the pending ids come from core.act_pending_qbo_disconnects (invoker, RLS, no row cap, no writes; unlike
 * listApprovals it does not expire stale proposals). The gate (lane policy class and approvals_live) is lane-level, so the lane's
 * facts are read once. A failure only hides the pending state (the button stays; the database refuses a second pending request).
 */
export async function withDisconnectState(
  view: QuickBooksSectionView,
  ctx: { client: Db; laneId: string },
  approvals: PendingDeps,
): Promise<QuickBooksSectionView> {
  const first = view.connections.find((c) => canDisconnect(c.state));
  if (!first) return view;
  let pending: { id: string; connectionId: string }[] = [];
  try {
    const { data, error } = await coreRpc(ctx.client as never)("act_pending_qbo_disconnects", { p_lane: ctx.laneId });
    if (error || !Array.isArray(data)) return view;
    pending = data.flatMap((r: unknown) => {
      const o = r as { id?: unknown; connection_id?: unknown };
      return typeof o?.id === "string" && typeof o.connection_id === "string" ? [{ id: o.id, connectionId: o.connection_id }] : [];
    });
  } catch {
    return view;
  }
  let gate: QuickBooksDisconnectView["gate"] = null;
  try {
    const cap = capabilityOf(ctx.laneId as never, await approvals.readFacts(ctx.laneId as never, first.id), QBO_DISCONNECT);
    gate = { enabled: cap.enabled, message: cap.message };
  } catch {
    gate = null;
  }
  const connections = view.connections.map((c): QuickBooksConnectionView => (canDisconnect(c.state) ? { ...c, disconnect: { pendingId: pending.find((p) => p.connectionId === c.id)?.id ?? null, gate } } : c));
  return { ...view, connections };
}

/**
 * Settings page: the row is drawn only for an owner or admin_technical at AAL2 (the same guard as connecting). Other roles,
 * AAL1 and lanes that are not theirs get null. An outage after the role check gives `unavailable`; an outage in the role
 * check itself rethrows.
 */
export async function quickbooksSectionFor(
  g: RoleGuards,
  laneId: string,
  load = loadQuickBooksSection,
  approvals?: PendingDeps,
): Promise<QuickBooksSectionView | null> {
  let client: Db;
  try {
    const r = await g.requireRole(laneId, CONNECT_ROLES);
    client = r.client;
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
  try {
    const view = await load(client, laneId);
    return approvals ? await withDisconnectState(view, { client, laneId }, approvals) : view;
  } catch {
    return { connections: [], unavailable: true };
  }
}
