import "server-only";
// microsoft.webhook_sync (T-068, T-264): turns accepted Microsoft change notifications (webhook/received, provider "microsoft", queued by the Microsoft receiver after the clientState check, the
// stored-subscription lookup and the dedupe claim) into ONE conn/sync.requested per connection and stream (mail or calendar), batched.
//   - The notification never calls Graph and never reads content: this function only decides whether to ask conn.sync for a delta sync of one stream, and conn.sync does the metadata read through
//     the connector (rule 5, rule 9). The notification's own content selected nothing but "sync this connection": the stream comes from the STORED subscription (the event type is
//     `mail.changed|mail.missed|calendar.changed|calendar.missed`, set by the receiver from our record), never from the notification.
//   - Batching (not a debounce): events of one connection are collected for up to 10 seconds measured from the batch's FIRST event (not aligned to the receiver's dedupe slots; a batch of 5 closes it early), so a burst
//     of changes costs one delta sync per stream, not one per notification. A change that arrives after that batch's delta read waits for the next notification or the 15-minute poll.
//   - No sync for a connection that is not usable (`reconnect_required`, disconnected, pending...): a read through the lane router (`isUsable`); conn.sync checks again, and also skips a
//     connection whose provider is not enabled for its lane (`provider_disabled`, no Graph call). The 15-minute polling jobs are unchanged and are the fallback for any change missed here.
//   - Idempotent: the conn/sync.requested id is derived from the connection, the stream and the batch's event ids, so a replayed batch is dropped by Inngest.
// Events carry ids only; the lane must be one this deployment serves, checked again on receipt.
import { createHash } from "node:crypto";
import type { Inngest, InngestFunction } from "inngest";
import { connSyncRequested, webhookReceived } from "./events";

export type MicrosoftWebhookSyncDeps = {
  /** True when the connection exists in the lane, is a Microsoft connection and is active or degraded. */
  isUsable: (laneId: string, connectionId: string) => Promise<boolean>;
  enabledLanes: () => readonly string[];
};

/** Function options, exported so tests assert them. maxSize 5: the Inngest plan in use caps batch size at 5 (see qbo-webhook-sync.ts); each batch gets its own deterministic sync id. */
export const MICROSOFT_WEBHOOK_BATCH = { maxSize: 5, timeout: "10s", key: "event.data.laneId + '/' + event.data.connectionId" } as const;
export const MICROSOFT_WEBHOOK_RETRIES = 3;

const EVENT_TYPE = /^(mail|calendar)\.(changed|missed)$/;

type StepApi = {
  run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>;
  sendEvent: (id: string, events: ReturnType<typeof connSyncRequested.create>[]) => Promise<unknown>;
};

export type MicrosoftWebhookSyncResult = {
  requested: number;
  skipped: { not_microsoft: number; invalid: number; lane_not_served: number; not_usable: number; not_a_change: number };
};

/** Deterministic Inngest event id for one connection, one stream and the set of webhook events it is answering. */
export function microsoftWebhookSyncEventId(laneId: string, connectionId: string, stream: "mail" | "calendar", eventIds: readonly string[]): string {
  const digest = createHash("sha256").update([...new Set(eventIds)].sort().join("\n")).digest("hex").slice(0, 40);
  return `ms-webhook:${laneId}:${connectionId}:${stream}:${digest}`;
}

/** The function body without Inngest, for tests. `events` are the raw event data of one batch. */
export async function handleMicrosoftWebhookSync(deps: MicrosoftWebhookSyncDeps, events: readonly unknown[], step: StepApi): Promise<MicrosoftWebhookSyncResult> {
  const result: MicrosoftWebhookSyncResult = { requested: 0, skipped: { not_microsoft: 0, invalid: 0, lane_not_served: 0, not_usable: 0, not_a_change: 0 } };
  const groups = new Map<string, { laneId: string; connectionId: string; stream: "mail" | "calendar"; eventIds: string[] }>();

  for (const raw of events) {
    // Events can reach Inngest without passing sendLaneEvent: validate again, echo nothing.
    const parsed = await webhookReceived.schema["~standard"].validate(raw);
    if (parsed.issues) {
      result.skipped.invalid += 1;
      continue;
    }
    const data = parsed.value;
    if (data.provider !== "microsoft") {
      result.skipped.not_microsoft += 1;
      continue;
    }
    if (!deps.enabledLanes().includes(data.laneId)) {
      result.skipped.lane_not_served += 1;
      continue;
    }
    const m = EVENT_TYPE.exec(data.eventType);
    if (!m) {
      result.skipped.not_a_change += 1;
      continue;
    }
    const stream = m[1] === "calendar" ? "calendar" : "mail";
    const key = `${data.laneId}:${data.connectionId}:${stream}`;
    const group = groups.get(key) ?? { laneId: data.laneId, connectionId: data.connectionId, stream, eventIds: [] };
    group.eventIds.push(data.eventId);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const usable = await step.run(`usable:${group.laneId}:${group.connectionId}`, () => deps.isUsable(group.laneId, group.connectionId));
    if (!usable) {
      result.skipped.not_usable += group.eventIds.length;
      continue;
    }
    await step.sendEvent(`sync:${group.laneId}:${group.connectionId}:${group.stream}`, [
      connSyncRequested.create(
        { laneId: group.laneId, connectionId: group.connectionId, trigger: "webhook", streams: [group.stream] },
        { id: microsoftWebhookSyncEventId(group.laneId, group.connectionId, group.stream, group.eventIds) },
      ),
    ]);
    result.requested += 1;
  }
  return result;
}

export function microsoftWebhookSyncFunctions(inngest: Inngest, deps: MicrosoftWebhookSyncDeps): InngestFunction.Any[] {
  const fn = inngest.createFunction(
    { id: "microsoft-webhook-sync", triggers: [webhookReceived], retries: MICROSOFT_WEBHOOK_RETRIES, batchEvents: MICROSOFT_WEBHOOK_BATCH },
    async ({ events, step }) => handleMicrosoftWebhookSync(deps, events.map((e) => e.data), step as unknown as StepApi),
  );
  return [fn];
}
