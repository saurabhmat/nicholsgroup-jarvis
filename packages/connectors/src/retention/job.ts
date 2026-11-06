// retention.purge for one lane (T-042). Pure orchestration over injected parts, so it is tested with an in-memory
// registry. The Inngest functions (daily schedule, per-lane worker) live in @nichols/core/inngest.
//   - The lane's days per class come from `settings(laneId)` (lane policy + lane_config). A class whose days cannot be read is
//     reported as an error and skipped; the other classes (and the policy-driven raw-body purge, which needs no days) still run.
//   - Each registered table is purged by its SQL purge function with the lane's days for its class. One table failing never
//     stops the others; the result lists it (error kind only) and `ok` is false so the caller can retry.
//   - Only counts are logged (no row contents, no error detail beyond the fixed kind).
import type { LaneId } from "@nichols/core";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { RetentionRegistry } from "./registry";
import { RETENTION_CLASSES, type LanePurgeResult, type RetentionClass, type RetentionDays, type TablePurgeResult } from "./types";

const LANE_ID = /^[A-Z]{1,8}$/;

export type RetentionJobDeps = {
  registry: RetentionRegistry;
  /** Days per class the lane's settings could provide. A class missing here is NOT purged and is reported as an error (fail closed), while the rest still run. */
  settings: (laneId: LaneId) => Promise<Partial<RetentionDays>>;
  logger?: ConnectorLogger;
};

export function createRetentionPurgeJob(deps: RetentionJobDeps) {
  const log = deps.logger ?? connectorLog;
  return {
    async run(laneId: LaneId): Promise<LanePurgeResult> {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new Error("retention: a lane is required");
      const child = log.child({ laneId });
      const days = await deps.settings(laneId).catch((): Partial<RetentionDays> => ({}));
      const results: TablePurgeResult[] = [];
      const emptyClasses: RetentionClass[] = [];
      for (const cls of RETENTION_CLASSES) {
        const tables = deps.registry.byClass(cls);
        if (tables.length === 0) {
          emptyClasses.push(cls);
          continue;
        }
        const keep = cls === "policy" ? null : (days[cls] ?? undefined);
        for (const t of tables) {
          if (keep === undefined) {
            results.push({ table: t.id, class: cls, error: "settings_unavailable" });
            child.error("retention.purge.table_failed", { table: t.id, class: cls, reason: "settings_unavailable" });
            continue;
          }
          try {
            const deleted = await t.purge(laneId, keep);
            results.push({ table: t.id, class: cls, deleted });
            child.info("retention.purge.table", { table: t.id, class: cls, keepDays: keep, deleted });
          } catch (e) {
            results.push({ table: t.id, class: cls, error: "purge_failed" });
            // The error class name only (RetentionStoreError, ...): never the message, which could carry row text.
            child.error("retention.purge.table_failed", { table: t.id, class: cls, reason: e instanceof Error ? e.name : "unknown" });
          }
        }
      }
      const ok = results.every((r) => !("error" in r));
      child.info("retention.purge.lane", { ok, tables: results.length, emptyClasses: emptyClasses.join(",") });
      return { laneId, ok, results, emptyClasses };
    },
  };
}
