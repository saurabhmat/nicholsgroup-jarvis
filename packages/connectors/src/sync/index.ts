// conn.sync wired over the real stores (T-038). Server-only. Not exported from the package root; the Inngest route
// imports `connSyncJob` from "@nichols/connectors/sync". Providers join `runners` as their sync lands (QuickBooks
// T-051 is in; Stripe, GoHighLevel...); a provider without a runner fails its runs with unsupported_op.
import type { LaneId } from "@nichols/core";
import { providerGate, syncRunners } from "../facade/index";
import { quickbooksConnector } from "../quickbooks/index";
import { connectionLoader, laneConfigReader, rawRecords, syncCursorStore, syncRunStore, syncTargetLister } from "../vault/index";
import { createConnSyncJob } from "./job";
import { createQuickbooksUsableCheck, createUsableCheck } from "./usable";
import { createConnectorSyncRunner } from "./runners";

export const connSyncJob = createConnSyncJob({
  loader: connectionLoader,
  runs: syncRunStore,
  // T-255: a mail/calendar connection is run by its own row's provider through the facade (Google today; Microsoft answers unsupported_op
  // until its tasks land), and skipped as `provider_disabled` when the lane has not enabled that provider, before the run is logged.
  gate: (laneId, conn) => providerGate.enabled(laneId, conn.provider),
  runners: {
    ...syncRunners(),
    // QuickBooks (T-051): Connector.sync through the generic cursor (stream 'default' = the CDC changedSince instant).
    quickbooks: createConnectorSyncRunner({ connector: quickbooksConnector, cursors: syncCursorStore, sinkFor: rawRecords.sinkFor }),
  },
});

/** Whether a QuickBooks connection of the lane can be synced now (see ./usable.ts). Used by the webhook follow-up (T-053). */
export const isQuickbooksConnectionUsable = createQuickbooksUsableCheck(connectionLoader);

/** Whether a Microsoft connection of the lane can be synced now (T-068): the Microsoft webhook follow-up asks it before it queues a sync. */
export const isMicrosoftConnectionUsable = createUsableCheck(connectionLoader, "microsoft");

export { SYNC_TRIGGERS } from "./types";

/**
 * T-241: before a (re)connected QuickBooks connection's first sync, drop its stored cursor so that sync, and any later one if it is
 * skipped, is a full load. Lane-checked (the loader binds the connection to the lane; the SQL checks again). Ids in, nothing out.
 */
export async function resetSyncCursorForReload(laneId: LaneId, connectionId: string): Promise<void> {
  const conn = await connectionLoader.loadConnection(laneId, connectionId);
  await syncCursorStore.reset?.(laneId, conn);
}
export type { ConnSyncOutcome, SyncTrigger } from "./types";

/** Ids of a lane's usable calendar-capable connections, for the scheduled cal.ingest_delta fan-out (T-130). */
export const listCalendarConnectionIds = (laneId: LaneId) => syncTargetLister.listCalendarConnectionIds(laneId);
/** T-260: the same list with each connection's provider, for Sync now (a Microsoft connection gets one event per stream). */
export const listMailTargets = (laneId: LaneId) => syncTargetLister.listMailTargets(laneId);
/** Ids of a lane's usable mail-capable connections (each connected mailbox), for the scheduled mail.ingest_delta fan-out (T-238). */
export const listMailConnectionIds = (laneId: LaneId) => syncTargetLister.listMailConnectionIds(laneId);
export { QBO_SYNC_ENTITIES } from "../quickbooks/entities";
export { CALENDAR_PROVIDERS, MAIL_PROVIDERS } from "./targets";

/** Ids of a lane's usable QuickBooks connections for the scheduled backup poll (T-090); same list as the nightly report pull. */
export const listQuickbooksSyncConnectionIds = (laneId: LaneId) => syncTargetLister.listQuickbooksConnectionIds(laneId);
/** Hours between a lane's QuickBooks backup polls, from lane_config (default 4); throws when the setting is malformed. */
export const qboSyncIntervalHours = (laneId: LaneId) => laneConfigReader.qboSyncIntervalHours(laneId);
