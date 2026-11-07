// Retention registry types (T-042). A table class says which retention setting governs a table; "policy" tables are
// purged by their lane policy alone (no day count).
import type { LaneId } from "@nichols/core";

export const RETENTION_CLASSES = ["comms", "calendar", "conversations", "webhooks", "policy"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Retention days per class for one lane, already validated (see LaneConfigReader.retentionSettings). */
export type RetentionDays = { comms: number; calendar: number; conversations: number; webhooks: number };

/**
 * A table (or group of tables) the purge job covers. `purge` must call a SQL purge function for the lane (never delete
 * directly) and return the number of rows deleted. `keepDays` is the lane's days for the class, or null for "policy".
 *
 * Contract for every registered purge (T-042 review M2): the SQL function itself must (1) enforce its own floor and cap
 * on the interval, so a bad lane_config value or a code bug cannot delete a whole lane's data (the TypeScript bounds are
 * not enough), (2) delete only `lane_id = p_lane` rows, (3) refuse a disabled or unknown lane, and (4) be service_role
 * only. Its pgTAP must include a floor test and a cross-lane denial test.
 */
export type RetentionTable = {
  /** Stable id, `schema.table`, used in logs and results. */
  id: string;
  class: RetentionClass;
  purge(laneId: LaneId, keepDays: number | null): Promise<number>;
};

/**
 * A table the purge job does NOT purge, declared so the retention catalog is complete: `until_deleted` (kept until the
 * user deletes it, e.g. owner-authored brain pages) or `own_job` (cleaned up by its own job, named in `job`). Catalog only:
 * the purge job never touches a declared table.
 */
export type RetentionDeclaration = {
  /** `schema.table`, unique across tables and declarations. */
  id: string;
  rule: "until_deleted" | "own_job";
  /** Why, in one sentence (shown in the catalog). */
  reason: string;
  /** The job that cleans it up (required for `own_job`). */
  job?: string;
};

export type TablePurgeResult = { table: string; class: RetentionClass; deleted: number } | { table: string; class: RetentionClass; error: string };
export type LanePurgeResult = {
  laneId: LaneId;
  ok: boolean;
  results: TablePurgeResult[];
  /** Classes with no registered table (e.g. conversations before T-103), so the gap is visible and not silent. */
  emptyClasses: RetentionClass[];
};
