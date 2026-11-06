// fin.qbo_reports wired over the real stores (T-052). Server-only. The Inngest route imports `qboReportsJob` and
// `listQuickbooksConnectionIds` from "@nichols/connectors/reports"; core cannot import connectors.
import type { LaneId } from "@nichols/core";
import { quickbooksReportsJob } from "../quickbooks/index";
import { syncTargetLister } from "../vault/index";

export const qboReportsJob = quickbooksReportsJob;

/** Ids of a lane's usable QuickBooks connections, for the nightly report fan-out. */
export const listQuickbooksConnectionIds = (laneId: LaneId) => syncTargetLister.listQuickbooksConnectionIds(laneId);

export type { QboReportsOutcome } from "../quickbooks/reports-job";
