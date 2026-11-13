// Which connections a scheduled calendar sync should run for (T-130). Read-only: one lane-bound select with the lane's
// job client (the lane router, wired in vault/index.ts). Returns ids only; the sync job re-loads and re-checks each
// connection (status, lane) when it runs, so a stale answer here is harmless.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "../vault/tokens";

/** Providers whose connector indexes calendar events. Add Microsoft here when its calendar sync lands. */
export const CALENDAR_PROVIDERS = ["google"] as const;
/** Providers whose connector indexes mail (T-238: the scheduled Gmail delta). Add Microsoft here when its mail sync lands. */
export const MAIL_PROVIDERS = ["google"] as const;
/** Same states conn.sync accepts (job.ts USABLE). */
export const SYNCABLE_STATUSES = ["active", "degraded"] as const;
/** A lane has a handful of connections; the cap only bounds a runaway table (more than this many per lane would be dropped silently). */
export const MAX_SYNC_TARGETS = 200;

const LANE_ID = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyncTargetLister {
  /** Ids of the lane's usable QuickBooks connections, sorted (the nightly report pull, T-052). Throws ConnectorError when unreadable. */
  listQuickbooksConnectionIds(laneId: LaneId): Promise<string[]>;
  /** Ids of the lane's usable connections of calendar-capable providers, sorted. Throws ConnectorError when unreadable. */
  listCalendarConnectionIds(laneId: LaneId): Promise<string[]>;
  /** Ids of the lane's usable connections of mail-capable providers (each connected mailbox), sorted. Throws ConnectorError when unreadable. */
  listMailConnectionIds(laneId: LaneId): Promise<string[]>;
}

export function createSyncTargetLister(clientFor: JobClientFor): SyncTargetLister {
  const list = (providers: readonly string[]) => async (laneId: LaneId): Promise<string[]> => {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    }
    let rows: unknown;
    try {
      const client = await clientFor(laneId);
      const { data, error } = await client
        .schema("core")
        .from("connections")
        .select("id")
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
    const ids: string[] = [];
    for (const r of rows) {
      const id = (r as { id?: unknown } | null)?.id;
      if (typeof id === "string" && UUID.test(id)) ids.push(id);
    }
    return ids;
  };
  return { listCalendarConnectionIds: list(CALENDAR_PROVIDERS), listMailConnectionIds: list(MAIL_PROVIDERS), listQuickbooksConnectionIds: list(["quickbooks"]) };
}
