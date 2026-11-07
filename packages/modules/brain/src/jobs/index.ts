// brain/jobs: the hourly import-candidate purge (T-210, spec §7a, plan-review finding 19). Candidates are deleted when an
// import is done and, at the latest, 24 h after creation: this job deletes those older than 23 h (core.brain_import_purge,
// service_role only, lane-checked) and closes imports still open after 24 h. It is not a T-042 day class, because the
// retention.purge registry works in whole days. The Inngest schedule is in @nichols/core/inngest (brain-import-purge).
import type { LaneId } from "@nichols/core";
import type { BrainDb } from "../server/store";

export type ImportPurgeDeps = {
  /** The lane router's job client for the lane (getLaneJobClient). Refuses disabled and unserved lanes. */
  clientFor: (laneId: LaneId) => Promise<BrainDb>;
};

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

export class ImportPurgeError extends Error {
  override readonly name = "ImportPurgeError";
  constructor() {
    super("brain import purge unavailable");
  }
}

export function createImportPurge(deps: ImportPurgeDeps) {
  return {
    /** Purges one lane; returns the number of candidates deleted. Errors carry no detail. */
    async purgeLane(laneId: LaneId): Promise<number> {
      if (typeof laneId !== "string" || !/^[A-Z]{1,8}$/.test(laneId)) throw new ImportPurgeError();
      try {
        const client = await deps.clientFor(laneId);
        const core = client.schema("core");
        const { data, error } = await (core.rpc.bind(core) as unknown as Rpc)("brain_import_purge", { p_lane: laneId });
        if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) throw new ImportPurgeError();
        return data;
      } catch {
        throw new ImportPurgeError();
      }
    },
  };
}
