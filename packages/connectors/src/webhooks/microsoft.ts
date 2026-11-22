// The Microsoft Graph change-notification receiver (T-068, T-264): `POST /api/webhooks/microsoft`. Microsoft does not sign its notifications, so this is NOT a `WebhookProvider` of the
// T-036 pipeline (that contract assumes ONE shared signing secret and an HMAC over the body, and bending it to fit would weaken it for QuickBooks). It reuses the pipeline's parts - the
// capped raw body reader and content-type check (./body.ts), constant-time comparison and hashing (./crypto.ts), the dedupe and receipt store (core.webhook_events through the
// WebhookStore: `claim` and `mark`), lane resolution from the STORED record, and the Inngest hand-off with ids only - and replaces only what is Microsoft-specific: the validation
// handshake and the per-subscription `clientState` instead of a signature.
//
// Steps, in order, each refusing before the next one costs anything:
//   1. POST only                                  -> 405
//   2. `?validationToken=` present                -> 200 `text/plain`, the URL-decoded token and NOTHING else (V-21: answered within 10 seconds); no other work is done: no
//                                                    store read, no queue. The token is capped (1,024 characters) and refused if it holds control characters -> 400.
//   3. jobs available (not a Preview)             -> 503 (nothing can be queued, so nothing is accepted; Graph retries)
//   4. content type application/json              -> 415
//   5. raw body read, capped (256 KiB)            -> 413 / 400
//   6. strict parse (Zod): `{ value: [...] }`, at most 200 items -> 400. Each item must carry a well-formed `subscriptionId`; a bad item is dropped.
//   7. per distinct subscription id (at most 25): look it up by that id in each served lane (core.push_subscription_lookup, service path). The lane and the connection come from the
//      STORED row, never from the request. Unknown, removed, disconnected or ambiguous -> the item is dropped.
//   8. per item: `clientState` compared with the stored secret in constant time; a wrong or missing one -> dropped (logged with ids only: the lane and connection of the subscription).
//   9. per verified item, by kind:
//        change notification     -> claim (dedupe) -> queue a `webhook/received` event (provider microsoft, `mail.changed` / `calendar.changed`, ids only) that the debounced
//                                   microsoft-webhook-sync job turns into ONE delta sync of that connection's stream
//        missed                  -> the same with `*.missed` (a delta resync)
//        reauthorizationRequired -> claim -> mark the row `reauthorization_required` -> queue the connection's renewal job (conn/subscription.renew.requested)
//        subscriptionRemoved     -> claim -> mark the row `removed` -> queue the connection's renewal job, which creates a new subscription
//   10. every delivery whose items were read answers 202 with an empty body, whether items were accepted, deduped or dropped, so a prober learns nothing. A queue or store failure after
//       the clientState check answers 503 so Graph retries (the retry claims the failed row again).
//
// What a notification can do: select "sync THIS connection" (or "renew this connection's subscription"). Its `resource`, `resourceData`, `changeType` and every other field are never read
// (rule 9), nothing is fetched from Graph here, no content is read or stored, and nothing is forwarded except ids. The `clientState`, the validation token and bodies are never logged.
//
// Dedupe key: Graph notifications carry no event id, and the same delivery is retried with the same bytes, so neither an id nor the body can tell a replay from a LATER change to the
// same mailbox. The key is therefore (lane, subscription, kind, 10-second slot of OUR clock): a replay inside the slot is a duplicate; a change in a later slot is a new event and
// queues another sync. A late retry in a later slot costs one extra delta sync, which is idempotent and metadata-only; a missed sync costs up to 15 minutes (the poll). The slot equals the
// debounce window of the sync job, so a change that lands inside a slot whose sync has not run yet is picked up by that sync.
import { randomUUID } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { MicrosoftSubscriptionStore, SubscriptionLookup } from "../microsoft/subscription-store";
import { mediaType, readRawBody } from "./body";
import { safeEqual, sha256Hex } from "./crypto";
import { WEBHOOK_EVENT_NAME, type WebhookDeps } from "./handler";
import type { WebhookStore } from "./store";

export const MICROSOFT_WEBHOOK_KEY = "microsoft";
/** A delivery is small (no resource data is ever requested); this cap is generous for 200 items. */
export const MICROSOFT_MAX_BODY_BYTES = 256 * 1024;
export const MICROSOFT_MAX_ITEMS = 200;
export const MICROSOFT_MAX_SUBSCRIPTIONS = 25;
export const MAX_VALIDATION_TOKEN_CHARS = 1024;
/** The dedupe slot of change and missed notifications (equal to the sync job's debounce window). */
export const CHANGE_SLOT_MS = 10_000;
/** The dedupe slot of lifecycle notifications: Microsoft asks not to reauthorize twice within 10 minutes; one renewal per 5 minutes is plenty. */
export const LIFECYCLE_SLOT_MS = 300_000;
/** The queued renewal event (conn/subscription.renew.requested is registered in @nichols/core/inngest). */
export const RENEW_EVENT_NAME = "conn/subscription.renew.requested";

const CONTROL = /[\u0000-\u001f\u007f]/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SUBSCRIPTION_ID = /^[A-Za-z0-9_=@.+:-]{1,256}$/;

const Delivery = z.object({ value: z.array(z.unknown()).min(1).max(MICROSOFT_MAX_ITEMS) });
const Item = z.looseObject({
  subscriptionId: z.string().regex(SUBSCRIPTION_ID),
  clientState: z.string().max(256).optional(),
  lifecycleEvent: z.string().max(64).optional(),
});

type Kind = "change" | "missed" | "reauthorizationRequired" | "subscriptionRemoved";
const LIFECYCLE: Readonly<Record<string, Kind>> = { missed: "missed", reauthorizationRequired: "reauthorizationRequired", subscriptionRemoved: "subscriptionRemoved" };

export interface MicrosoftNotificationDeps {
  /** Finds a notification's subscription by its id (the lane and connection come from the stored row) and records a lifecycle status. */
  subscriptions: Pick<MicrosoftSubscriptionStore, "lookup" | "mark">;
  /** Dedupe and receipt (core.webhook_events). */
  store: Pick<WebhookStore, "claim" | "mark">;
  /** The lanes this deployment serves, asked in turn (a subscription id is unique to one lane's database). */
  lanes: () => readonly LaneId[];
  enqueue: WebhookDeps["enqueue"];
  jobsAvailable: () => boolean;
  log?: ConnectorLogger;
  now?: () => Date;
}

const reply = (status: number, body: string | null = null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
const json = (status: number, error: string, headers: Record<string, string> = {}) => reply(status, JSON.stringify({ error }), { "content-type": "application/json", ...headers });

export function createMicrosoftNotificationHandler(deps: MicrosoftNotificationDeps): (request: Request) => Promise<Response> {
  const baseLog = (deps.log ?? connectorLog).child({ provider: "microsoft" });
  const now = deps.now ?? (() => new Date());

  return async function handle(request) {
    const headerId = request.headers.get("x-vercel-id") ?? request.headers.get("x-request-id");
    const requestId = headerId && REQUEST_ID.test(headerId) ? headerId : randomUUID();

    if (request.method !== "POST") return json(405, "method_not_allowed", { allow: "POST" });

    // The validation handshake: the token and nothing else, no other work.
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (url?.searchParams.has("validationToken")) {
      const token = url.searchParams.get("validationToken") ?? "";
      if (token.length === 0 || token.length > MAX_VALIDATION_TOKEN_CHARS || CONTROL.test(token)) return json(400, "bad_request");
      return reply(200, token, { "content-type": "text/plain; charset=utf-8" });
    }

    const refuse = (status: number, error: string, outcome: string, fields: Record<string, unknown> = {}) => {
      baseLog[status >= 500 ? "error" : "warn"]("webhook.refused", { outcome, request_id: requestId, ...fields });
      return json(status, error);
    };
    if (!deps.jobsAvailable()) return refuse(503, "jobs_not_configured", "jobs_not_configured");
    if (mediaType(request.headers.get("content-type")) !== "application/json") return refuse(415, "unsupported_media_type", "content_type");
    const read = await readRawBody(request, MICROSOFT_MAX_BODY_BYTES);
    if (!read.ok) return read.reason === "too_large" ? refuse(413, "payload_too_large", "too_large") : refuse(400, "bad_request", "unreadable");

    let delivery: z.infer<typeof Delivery>;
    try {
      const parsed = Delivery.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)));
      if (!parsed.success) return refuse(400, "bad_payload", "bad_payload");
      delivery = parsed.data;
    } catch {
      return refuse(400, "bad_payload", "bad_payload");
    }

    const payloadHash = sha256Hex(read.bytes);
    const at = now();
    const counts = { items: delivery.value.length, malformed: 0, unknown: 0, ambiguous: 0, bad_state: 0, unknown_event: 0, enqueued: 0, duplicate: 0, conflict: 0, failed: 0, too_many: 0 };

    // Read each item's id, state and kind; only these three fields are looked at.
    const items: { subscriptionId: string; clientState: string; kind: Kind | "unknown" }[] = [];
    for (const raw of delivery.value) {
      const item = Item.safeParse(raw);
      if (!item.success) {
        counts.malformed += 1;
        continue;
      }
      const lifecycle = item.data.lifecycleEvent;
      items.push({
        subscriptionId: item.data.subscriptionId,
        clientState: item.data.clientState ?? "",
        kind: lifecycle === undefined ? "change" : (Object.hasOwn(LIFECYCLE, lifecycle) ? LIFECYCLE[lifecycle] : undefined) ?? "unknown",
      });
    }

    const found = new Map<string, SubscriptionLookup | null>();
    try {
      for (const { subscriptionId } of items) {
        if (found.has(subscriptionId)) continue;
        if (found.size >= MICROSOFT_MAX_SUBSCRIPTIONS) {
          counts.too_many += 1;
          continue;
        }
        const hits = (await Promise.all(deps.lanes().map((laneId) => deps.subscriptions.lookup(laneId, subscriptionId)))).filter((h): h is SubscriptionLookup => h !== null);
        if (hits.length > 1) counts.ambiguous += 1; // cannot happen with provider GUIDs; treated as unknown
        found.set(subscriptionId, hits.length === 1 ? (hits[0] ?? null) : null);
      }

      // One action per (subscription, kind) with a verified clientState.
      const actions = new Map<string, { sub: SubscriptionLookup; subscriptionId: string; kind: Kind }>();
      for (const item of items) {
        const sub = found.get(item.subscriptionId);
        if (sub === undefined) continue; // beyond the subscription cap (counted)
        if (sub === null) {
          counts.unknown += 1;
          continue;
        }
        // Constant time. A missing state compares as "" and never equals the stored secret (at least 32 characters).
        if (!safeEqual(item.clientState, sub.clientState.reveal())) {
          counts.bad_state += 1;
          baseLog.child({ laneId: sub.laneId, connectionId: sub.connectionId }).warn("webhook.skipped", { outcome: "bad_client_state", request_id: requestId });
          continue;
        }
        if (item.kind === "unknown") {
          counts.unknown_event += 1;
          continue;
        }
        actions.set(`${item.subscriptionId}\u0000${item.kind}`, { sub, subscriptionId: item.subscriptionId, kind: item.kind });
      }

      for (const { sub, subscriptionId, kind } of actions.values()) {
        const laneId = sub.laneId;
        const elog = baseLog.child({ laneId, connectionId: sub.connectionId });
        const lifecycle = kind === "reauthorizationRequired" || kind === "subscriptionRemoved";
        const slot = Math.floor(at.getTime() / (lifecycle ? LIFECYCLE_SLOT_MS : CHANGE_SLOT_MS));
        // An id derived from OUR records (lane, the subscription, the kind and the slot): nothing from a notification's content goes into it.
        const eventId = `ms:${kind}:${sha256Hex(`${laneId}|${subscriptionId}|${String(slot)}`)}`;
        const eventType = lifecycle ? `${sub.resource}.${kind}`.slice(0, 128) : `${sub.resource}.${kind === "change" ? "changed" : "missed"}`;
        const claim = await deps.store.claim(laneId, sub.connectionId, "microsoft", { id: eventId, type: eventType, payloadHash });
        if (claim !== "process") {
          counts[claim] += 1;
          elog[claim === "conflict" ? "warn" : "info"]("webhook.skipped", { outcome: claim, request_id: requestId });
          continue;
        }
        try {
          if (lifecycle) {
            // Record what Microsoft told us first, so the renewal job sees it, then ask the job to run for this connection.
            await deps.subscriptions.mark(laneId, sub.connectionId, subscriptionId, kind === "subscriptionRemoved" ? "removed" : "reauthorization_required");
            await deps.enqueue({ name: RENEW_EVENT_NAME, id: `msub:${laneId}:${sub.connectionId}:${kind}:${String(slot)}`, data: { laneId, connectionId: sub.connectionId } });
          } else {
            await deps.enqueue({
              name: WEBHOOK_EVENT_NAME,
              id: `wh:${laneId}:microsoft:${sha256Hex(eventId).slice(0, 40)}`,
              data: { laneId, provider: "microsoft", connectionId: sub.connectionId, eventId, eventType, refs: [] },
            });
          }
        } catch {
          counts.failed += 1;
          await deps.store.mark(laneId, "microsoft", eventId, "failed").catch(() => false);
          elog.error("webhook.enqueue_failed", { outcome: "enqueue_failed", request_id: requestId });
          continue;
        }
        counts.enqueued += 1;
        await deps.store.mark(laneId, "microsoft", eventId, "enqueued").catch(() => false);
        elog.info("webhook.enqueued", { outcome: "enqueued", kind, request_id: requestId });
      }
    } catch {
      return refuse(503, "unavailable", "store_unavailable", counts);
    }

    if (counts.failed > 0) return refuse(503, "enqueue_failed", "enqueue_failed", counts);
    baseLog.info("webhook.done", { outcome: "ok", request_id: requestId, ...counts });
    return reply(202);
  };
}
