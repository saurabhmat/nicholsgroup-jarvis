// The tables the purge job covers today (T-042). Each entry calls a SQL purge function; later tasks add theirs with
// `retentionRegistry.register(...)` (assistant ai.* with T-103, approvals payloads with T-112 and so on).
import type { WebhookStore } from "../webhooks/store";
import type { RetentionStore } from "./store";
import type { RetentionTable } from "./types";

// The brain tables are not purged here: they are declared (retentionRegistry.declare) by the brain module, wired in the
// web app's Inngest route — owner-authored pages kept until deleted, imports cleaned by their own hourly job (T-210).
export function defaultRetentionTables(deps: { store: RetentionStore; webhooks: Pick<WebhookStore, "purge"> }): RetentionTable[] {
  const { store, webhooks } = deps;
  return [
    { id: "comms.message_index", class: "comms", purge: async (lane, days) => store.purgeMessageIndex(lane, need(days)) },
    { id: "cal.event_index", class: "calendar", purge: async (lane, days) => store.purgeEventIndex(lane, need(days)) },
    // Receipts older than the window; the database refuses under 7 days.
    { id: "core.webhook_events", class: "webhooks", purge: async (lane, days) => webhooks.purge(lane, need(days)) },
    // Stored bodies must not outlive store_content_bodies (T-039 note). Decided by the lane policy in SQL, not by days.
    { id: "raw.source_records", class: "policy", purge: (lane) => store.purgeSourceRecordBodies(lane) },
  ];
}

function need(days: number | null): number {
  if (days === null) throw new Error("retention: days required for this class");
  return days;
}
