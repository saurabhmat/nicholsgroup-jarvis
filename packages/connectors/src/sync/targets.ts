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

/** A usable mail-capable connection with its provider (Sync now sends a Microsoft connection's two streams as two events, T-260). */
export type MailTarget = { connectionId: string; provider: string };

export interface SyncTargetLister {
  /** Same list as listMailConnectionIds, with each connection's provider. */
  listMailTargets(laneId: LaneId): Promise<MailTarget[]>;
  /** Ids of the lane's usable QuickBooks connections, sorted (the nightly report pull, T-052). Throws ConnectorError when unreadable. */
  listQuickbooksConnectionIds(laneId: LaneId): Promise<string[]>;
  /** Ids of the lane's usable connections of calendar-capable providers, sorted. Throws ConnectorError when unreadable. */
  listCalendarConnectionIds(laneId: LaneId): Promise<string[]>;
  /** Ids of the lane's usable connections of mail-capable providers (each connected mailbox), sorted. Throws ConnectorError when unreadable. */
  listMailConnectionIds(laneId: LaneId): Promise<string[]>;
}

export function createSyncTargetLister(clientFor: JobClientFor): SyncTargetLister {
  const listTargets = (providers: readonly string[]) => async (laneId: LaneId): Promise<MailTarget[]> => {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    }
    let rows: unknown;
    try {
      const client = await clientFor(laneId);
      const { data, error } = await client
        .schema("core")
        .from("connections")
        .select("id, provider")
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
    const targets: MailTarget[] = [];
    for (const r of rows) {
      const row = r as { id?: unknown; provider?: unknown } | null;
      if (typeof row?.id === "string" && UUID.test(row.id)) targets.push({ connectionId: row.id, provider: typeof row.provider === "string" ? row.provider : "" });
    }
    return targets;
  };
  const list = (providers: readonly string[]) => async (laneId: LaneId): Promise<string[]> => (await listTargets(providers)(laneId)).map((t) => t.connectionId);
  return { listMailTargets: listTargets(MAIL_PROVIDERS), listCalendarConnectionIds: list(CALENDAR_PROVIDERS), listMailConnectionIds: list(MAIL_PROVIDERS), listQuickbooksConnectionIds: list(["quickbooks"]) };
}
