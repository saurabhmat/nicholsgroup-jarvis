// Which connections a scheduled calendar sync should run for (T-130). Read-only: one lane-bound select with the lane's
// job client (the lane router, wired in vault/index.ts). Returns ids only; the sync job re-loads and re-checks each
// connection (status, lane) when it runs, so a stale answer here is harmless.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";

/**
 * Providers whose connector indexes calendar events: both (T-255). One lane's tick lists every usable connection of both providers (D-57);
 * conn.sync then skips a connection whose provider the lane has not enabled (`provider_disabled`) and a provider without a runner yet
 * answers `unsupported_op`.
 */
export const CALENDAR_PROVIDERS = ["google", "microsoft"] as const;
/** Providers whose connector indexes mail (T-238 scheduled delta, T-255 both providers). */
export const MAIL_PROVIDERS = ["google", "microsoft"] as const;
/** Same states conn.sync accepts (job.ts USABLE). */
export const SYNCABLE_STATUSES = ["active", "degraded"] as const;
/** A lane has a handful of connections; the cap only bounds a runaway table (more than this many per lane would be dropped silently). */
export const MAX_SYNC_TARGETS = 200;

const LANE_ID = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A usable connection the schedule runs: its id and, for a Microsoft row, its tenant id (the event's per-tenant concurrency key, T-260). */
export type SyncTarget = { connectionId: string; tenantId: string | null };

export interface SyncTargetLister {
  /** Same lists as the two below, with each Microsoft row's tenant id (T-260). Sorted by id; Google rows carry `tenantId: null`. */
  listCalendarTargets(laneId: LaneId): Promise<SyncTarget[]>;
  listMailTargets(laneId: LaneId): Promise<SyncTarget[]>;
  /** Ids of the lane's usable QuickBooks connections, sorted (the nightly report pull, T-052). Throws ConnectorError when unreadable. */
  listQuickbooksConnectionIds(laneId: LaneId): Promise<string[]>;
  /** Ids of the lane's usable connections of calendar-capable providers, sorted. Throws ConnectorError when unreadable. */
  listCalendarConnectionIds(laneId: LaneId): Promise<string[]>;
  /** Ids of the lane's usable connections of mail-capable providers (each connected mailbox), sorted. Throws ConnectorError when unreadable. */
  listMailConnectionIds(laneId: LaneId): Promise<string[]>;
}

export function createSyncTargetLister(clientFor: JobClientFor): SyncTargetLister {
  const list = (providers: readonly string[]) => async (laneId: LaneId): Promise<SyncTarget[]> => {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    }
    let rows: unknown;
    try {
      const client = await clientFor(laneId);
      const { data, error } = await client
        .schema("core")
        .from("connections")
        .select("id, provider, tenant_id")
        .eq("lane_id", laneId)
        .eq("transport", "native") // a Composio connection has no token row; the native sync cannot run on it (T-219)
        .in("provider", [...providers])
        .in("status", [...SYNCABLE_STATUSES])
        .order("id", { ascending: true })
        .limit(MAX_SYNC_TARGETS);
      if (error) throw error;
      rows = data;
    } catch {
      throw new ConnectorError({ kind: "transient", message: "Connection list unavailable" });
    }
    if (!Array.isArray(rows)) throw new ConnectorError({ kind: "transient", message: "Connection list unavailable" });
    const targets: SyncTarget[] = [];
    for (const r of rows) {
      const row = r as { id?: unknown; provider?: unknown; tenant_id?: unknown } | null;
      const id = row?.id;
      if (typeof id !== "string" || !UUID.test(id)) continue;
      // Only a Microsoft row carries a tenant (a malformed value is dropped: the run then keys by its connection alone).
      const tenant = row?.provider === "microsoft" && typeof row.tenant_id === "string" && UUID.test(row.tenant_id) ? row.tenant_id.toLowerCase() : null;
      targets.push({ connectionId: id, tenantId: tenant });
    }
    return targets;
  };
  const ids = (providers: readonly string[]) => async (laneId: LaneId): Promise<string[]> => (await list(providers)(laneId)).map((t) => t.connectionId);
  return {
    listCalendarTargets: list(CALENDAR_PROVIDERS),
    listMailTargets: list(MAIL_PROVIDERS),
    listCalendarConnectionIds: ids(CALENDAR_PROVIDERS),
    listMailConnectionIds: ids(MAIL_PROVIDERS),
    listQuickbooksConnectionIds: ids(["quickbooks"]),
  };
}
