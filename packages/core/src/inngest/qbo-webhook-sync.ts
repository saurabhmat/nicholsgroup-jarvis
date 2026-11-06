import "server-only";
// qbo.webhook_sync (T-053): turns accepted QuickBooks webhook events (webhook/received, provider "quickbooks", queued by the
// shared receiver after signature, lane and dedupe checks) into ONE targeted conn/sync.requested per connection and batch.
//   - The webhook never calls Intuit and never writes anywhere. This function only decides whether to ask conn.sync for a
//     targeted CDC fetch of the changed entity types; conn.sync does the read through the connector (rule 5, rule 9).
//   - Batching: events of one connection are collected for a few seconds (Intuit sends one notification per change burst), so
//     a burst costs one CDC call, not one per entity.
//   - Entity names come from retrieved data: only names in `allowedEntities` (the T-051 entity set, injected because core
//     cannot import connectors) are kept; anything else is dropped. No ids or content go into the sync event.
//   - No sync for a connection that is not usable (`reconnect_required`, disconnected, pending...): the check is a read through
//     the lane router (`isUsable`), and conn.sync checks again (backstop). A missed change is caught by the next full cursor run.
//   - Idempotent: the conn/sync.requested id is derived from the connection and the batch's event ids, so a replayed batch is
//     dropped by Inngest; a repeated change is also dropped earlier by the receiver's claim on `core.webhook_events`.
// Events carry ids only; the lane must be one this deployment serves, checked again on receipt.
import { createHash } from "node:crypto";
import type { Inngest, InngestFunction } from "inngest";
import { connSyncRequested, webhookReceived } from "./events";

export type QboWebhookSyncDeps = {
  /** True when the connection exists in the lane, is a QuickBooks connection and is active or degraded (not reconnect_required). */
  isUsable: (laneId: string, connectionId: string) => Promise<boolean>;
  enabledLanes: () => readonly string[];
  /** Entity names a webhook may ask to refresh (apps/web passes QBO_SYNC_ENTITIES). */
  allowedEntities: readonly string[];
};

/** Function options, exported so tests assert them. */
export const QBO_WEBHOOK_BATCH = { maxSize: 100, timeout: "10s", key: "event.data.laneId + '/' + event.data.connectionId" } as const;
export const QBO_WEBHOOK_RETRIES = 3;

type StepApi = {
  run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>;
  sendEvent: (id: string, events: ReturnType<typeof connSyncRequested.create>[]) => Promise<unknown>;
};

export type QboWebhookSyncResult = {
  requested: number;
  skipped: { not_quickbooks: number; invalid: number; lane_not_served: number; not_usable: number; no_entities: number };
};

/** Deterministic Inngest event id for one connection and the set of webhook events it is answering. */
export function qboWebhookSyncEventId(laneId: string, connectionId: string, eventIds: readonly string[]): string {
  const digest = createHash("sha256").update([...new Set(eventIds)].sort().join("\n")).digest("hex").slice(0, 40);
  return `qbo-webhook:${laneId}:${connectionId}:${digest}`;
}

/** The function body without Inngest, for tests. `events` are the raw event data of one batch. */
export async function handleQboWebhookSync(deps: QboWebhookSyncDeps, events: readonly unknown[], step: StepApi): Promise<QboWebhookSyncResult> {
  const result: QboWebhookSyncResult = { requested: 0, skipped: { not_quickbooks: 0, invalid: 0, lane_not_served: 0, not_usable: 0, no_entities: 0 } };
  const allowed = new Set(deps.allowedEntities);
  const groups = new Map<string, { laneId: string; connectionId: string; entities: Set<string>; eventIds: string[] }>();

  for (const raw of events) {
    // Events can reach Inngest without passing sendLaneEvent: validate again, echo nothing.
    const parsed = await webhookReceived.schema["~standard"].validate(raw);
    if (parsed.issues) {
      result.skipped.invalid += 1;
      continue;
    }
    const data = parsed.value;
    if (data.provider !== "quickbooks") {
      result.skipped.not_quickbooks += 1;
      continue;
    }
    if (!deps.enabledLanes().includes(data.laneId)) {
      result.skipped.lane_not_served += 1;
      continue;
    }
    const names = data.refs.map((r) => r.type).filter((t) => allowed.has(t));
    if (names.length === 0) {
      result.skipped.no_entities += 1;
      continue;
    }
    const key = `${data.laneId}:${data.connectionId}`;
    const group = groups.get(key) ?? { laneId: data.laneId, connectionId: data.connectionId, entities: new Set<string>(), eventIds: [] };
    for (const n of names) group.entities.add(n);
    group.eventIds.push(data.eventId);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const usable = await step.run(`usable:${group.laneId}:${group.connectionId}`, () => deps.isUsable(group.laneId, group.connectionId));
    if (!usable) {
      result.skipped.not_usable += group.eventIds.length;
      continue;
    }
    const objectTypes = [...group.entities].sort();
    await step.sendEvent(`sync:${group.laneId}:${group.connectionId}`, [
      connSyncRequested.create(
        { laneId: group.laneId, connectionId: group.connectionId, trigger: "webhook", objectTypes },
        { id: qboWebhookSyncEventId(group.laneId, group.connectionId, group.eventIds) },
      ),
    ]);
    result.requested += 1;
  }
  return result;
}

export function qboWebhookSyncFunctions(inngest: Inngest, deps: QboWebhookSyncDeps): InngestFunction.Any[] {
  const fn = inngest.createFunction(
    { id: "qbo-webhook-sync", triggers: [webhookReceived], retries: QBO_WEBHOOK_RETRIES, batchEvents: QBO_WEBHOOK_BATCH },
    async ({ events, step }) => handleQboWebhookSync(deps, events.map((e) => e.data), step as unknown as StepApi),
  );
  return [fn];
}
