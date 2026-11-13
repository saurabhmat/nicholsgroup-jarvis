// The database side of the purge job (T-042): the only SQL the job runs are these purge functions, each bound to a lane
// and called with the lane's job client (the lane router, wired in vault/index.ts). Nothing here deletes directly.
// Errors carry no detail: a failure is a failure (the cause could hold row data).
import type { LaneId } from "@nichols/core";
import type { JobClientFor } from "../vault/tokens";

export class RetentionStoreError extends Error {
  override readonly name = "RetentionStoreError";
  constructor() {
    super("retention purge unavailable");
  }
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

export interface RetentionStore {
  /** comms.message_index_purge via core.retention_comms_purge: keeps `keepDays`, at most the lane policy. */
  purgeMessageIndex(laneId: LaneId, keepDays: number): Promise<number>;
  /** cal.event_index_purge via core.retention_cal_purge: keeps `keepDays` (30 to 180). */
  purgeEventIndex(laneId: LaneId, keepDays: number): Promise<number>;
  /** core.source_records_purge_bodies: deletes stored raw bodies when the lane policy has store_content_bodies off. */
  purgeSourceRecordBodies(laneId: LaneId): Promise<number>;
  /** core.connector_api_errors_purge (T-196): deletes the lane's connector API errors older than the fixed 90-day window in SQL. */
  purgeConnectorApiErrors(laneId: LaneId): Promise<number>;
}

export function createRetentionStore(clientFor: JobClientFor): RetentionStore {
  const call = async (laneId: LaneId, fn: string, args: Record<string, unknown>): Promise<number> => {
    try {
      const client = await clientFor(laneId);
      const core = client.schema("core");
      const { data, error } = await (core.rpc.bind(core) as unknown as Rpc)(fn, { p_lane: laneId, ...args });
      if (error) throw new RetentionStoreError();
      if (typeof data !== "number" || !Number.isInteger(data) || data < 0) throw new RetentionStoreError();
      return data;
    } catch {
      throw new RetentionStoreError();
    }
  };
  const keep = (days: number) => {
    if (!Number.isInteger(days) || days < 1) throw new RetentionStoreError();
    return `${String(days)} days`;
  };
  return {
    purgeMessageIndex: async (laneId, d) => call(laneId, "retention_comms_purge", { p_keep: keep(d) }),
    purgeEventIndex: async (laneId, d) => call(laneId, "retention_cal_purge", { p_keep: keep(d) }),
    purgeSourceRecordBodies: (laneId) => call(laneId, "source_records_purge_bodies", {}),
    purgeConnectorApiErrors: (laneId) => call(laneId, "connector_api_errors_purge", {}),
  };
}
