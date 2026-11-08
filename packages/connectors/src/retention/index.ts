// retention.purge wired over the real stores (T-042). Server-only. The Inngest route imports `retentionPurgeJob` from
// "@nichols/connectors/retention"; tables add themselves with `retentionRegistry.register(...)`.
import { laneConfigReader, retentionStore, webhookStore } from "../vault/index";
import { createRetentionPurgeJob } from "./job";
import { createRetentionRegistry } from "./registry";
import { retentionSettingsFrom } from "./settings";
import { defaultRetentionTables } from "./tables";

export const retentionRegistry = createRetentionRegistry(defaultRetentionTables({ store: retentionStore, webhooks: webhookStore }));

export const retentionPurgeJob = createRetentionPurgeJob({
  registry: retentionRegistry,
  // Read separately, so a bad lane_config.retention does not stop the comms purge (policy days) or the body purge.
  settings: retentionSettingsFrom(laneConfigReader),
});

export { createRetentionRegistry } from "./registry";
export { RETENTION_CLASSES } from "./types";
export type { LanePurgeResult, RetentionClass, RetentionDays, RetentionDeclaration, RetentionTable, TablePurgeResult } from "./types";
