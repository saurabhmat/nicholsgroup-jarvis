// The webhook receiver pipeline (T-036). One handler serves every provider; a provider is a `WebhookProvider` entry in
// the registry. Steps, in order, each refusing before the next one costs anything:
//
//   1. POST only                         -> 405
//   2. provider is registered            -> 404
//   3. jobs available (not a Preview)    -> 503 jobs_not_configured   (nothing can be queued, so nothing is accepted)
//   4. signing secret configured         -> 503 webhook_not_configured (fail closed: no secret, no processing)
//   5. content type allowed              -> 415
//   6. raw body read, capped             -> 413 / 400
//   7. signature verified (constant time)-> 401 (one answer for missing, malformed, wrong and stale)
//   8. timestamp within tolerance        -> 401 (replay window)
//   9. body parsed into events           -> 400
//  10. per event: account -> lane + connection from SERVER data (D-23 predicate), never from the payload
//        unknown or ambiguous account   -> skipped, same 200 as success (a verified sender learns nothing about lanes
//                                          and the provider does not retry forever)
//  11. per event: claim (dedupe on lane, provider, event id) -> duplicate / conflict: skipped, 200
//  12. per event: enqueue an Inngest event with ids only, mark enqueued; failure -> mark failed, answer 503 so the
//        provider retries (the retry claims the failed row again)
//
// Nothing is processed inline, nothing is written to any external system, and the payload is never stored, logged or
// forwarded: the queued event holds ids, and the job fetches objects through the connector (rule 9, rule 5, rule 6).
// Signatures, secrets and bodies are never logged.
import { randomUUID } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { DEFAULT_MAX_BODY_BYTES, HARD_MAX_BODY_BYTES, mediaType, readRawBody } from "./body";
import { sha256Hex, withinTolerance } from "./crypto";
import type { WebhookStore } from "./store";
import type { WebhookEvent, WebhookProvider } from "./types";

export const WEBHOOK_EVENT_NAME = "webhook/received";
export const MAX_EVENTS_PER_DELIVERY = 200;
/** Minimum signing secret length: shorter values are treated as not configured (a placeholder is not a secret). */
export const MIN_SECRET_LENGTH = 16;

const PROVIDER_KEY = /^[a-z][a-z0-9-]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface WebhookDeps {
  /** URL segment (`/api/webhooks/<key>`) -> provider. */
  providers: Readonly<Record<string, WebhookProvider>>;
  store: WebhookStore;
  /** Queues a lane event (the wired one is `sendLaneEvent`: validated, lane-checked). */
  enqueue: (event: { name: string; data: Record<string, unknown> & { laneId: string }; id: string }) => Promise<unknown>;
  /** False when this deployment cannot queue jobs (a PR Preview, or no Inngest keys). */
  jobsAvailable: () => boolean;
  log?: ConnectorLogger;
  now?: () => Date;
}

const reply = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

function validEvent(e: WebhookEvent): boolean {
  const ok = (s: unknown, max: number) => typeof s === "string" && s.length >= 1 && s.length <= max && !CONTROL.test(s);
  return (
    ok(e.accountId, 256) && ok(e.eventId, 256) && ok(e.eventType, 128) &&
    Array.isArray(e.refs) && e.refs.length <= 100 && e.refs.every((r) => ok(r.type, 64) && ok(r.id, 256))
  );
}

export function createWebhookHandler(deps: WebhookDeps): (request: Request, providerKey: string) => Promise<Response> {
  const baseLog = deps.log ?? connectorLog;
  const now = deps.now ?? (() => new Date());

  return async function handle(request, providerKey) {
    const headerId = request.headers.get("x-vercel-id") ?? request.headers.get("x-request-id");
    const requestId = headerId && REQUEST_ID.test(headerId) ? headerId : randomUUID();

    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, { allow: "POST" });
    const entry = PROVIDER_KEY.test(providerKey) && Object.hasOwn(deps.providers, providerKey) ? deps.providers[providerKey] : undefined;
    if (!entry) return reply(404, { error: "not_found" });

    const log = baseLog.child({ provider: entry.provider });
    const refuse = (status: number, error: string, outcome: string, fields: Record<string, unknown> = {}) => {
      log[status >= 500 ? "error" : "warn"]("webhook.refused", { outcome, request_id: requestId, ...fields });
      return reply(status, { error });
    };

    if (!deps.jobsAvailable()) return refuse(503, "jobs_not_configured", "jobs_not_configured");

    let secret: ReturnType<WebhookProvider["getSecret"]>;
    try {
      secret = entry.getSecret();
    } catch {
      secret = null; // the error text may name variables; it is not logged
    }
    if (!secret || secret.reveal().trim().length < MIN_SECRET_LENGTH) {
      return refuse(503, "webhook_not_configured", "secret_not_configured");
    }

    if (!entry.contentTypes.includes(mediaType(request.headers.get("content-type")))) {
      return refuse(415, "unsupported_media_type", "content_type");
    }

    const max = Math.min(entry.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, HARD_MAX_BODY_BYTES);
    const read = await readRawBody(request, max);
    if (!read.ok) {
      return read.reason === "too_large" ? refuse(413, "payload_too_large", "too_large") : refuse(400, "bad_request", "unreadable");
    }
    const body = read.bytes;

    const at = now();
    let verdict;
    try {
      verdict = entry.verifier.verify({ body, headers: request.headers, secret, now: at });
    } catch {
      verdict = { ok: false as const, reason: "bad_signature" as const };
    }
    if (!verdict.ok) return refuse(401, "unauthorized", "signature", { reason: verdict.reason });
    if (entry.toleranceSeconds !== null) {
      if (!verdict.signedAt) return refuse(401, "unauthorized", "signature", { reason: "missing_timestamp" });
      if (!withinTolerance(verdict.signedAt, at, entry.toleranceSeconds)) {
        return refuse(401, "unauthorized", "stale_timestamp");
      }
    }

    let parsed;
    try {
      parsed = entry.parse(body);
    } catch {
      parsed = { ok: false as const };
    }
    if (!parsed.ok || parsed.events.length > MAX_EVENTS_PER_DELIVERY || !parsed.events.every(validEvent)) {
      return refuse(400, "bad_payload", "bad_payload");
    }

    const payloadHash = sha256Hex(body);
    const counts = { enqueued: 0, duplicate: 0, conflict: 0, unknown_account: 0, failed: 0 };
    const accounts = new Map<string, ReturnType<WebhookStore["resolve"]>>();

    try {
      for (const event of parsed.events) {
        const accountKey = event.accountId.toLowerCase();
        let pending = accounts.get(accountKey);
        if (!pending) accounts.set(accountKey, (pending = deps.store.resolve(entry.provider, event.accountId)));
        const lane = await pending;
        if (lane.kind !== "found") {
          counts.unknown_account += 1;
          log.warn("webhook.skipped", { outcome: lane.kind === "ambiguous" ? "ambiguous_account" : "unknown_account", event_id: event.eventId, request_id: requestId });
          continue;
        }
        const laneId: LaneId = lane.laneId;
        const elog = log.child({ laneId, connectionId: lane.connectionId });
        const claim = await deps.store.claim(laneId, lane.connectionId, entry.provider, { id: event.eventId, type: event.eventType, payloadHash });
        if (claim !== "process") {
          counts[claim] += 1;
          elog[claim === "conflict" ? "warn" : "info"]("webhook.skipped", { outcome: claim, event_id: event.eventId, request_id: requestId });
          continue;
        }
        try {
          await deps.enqueue({
            name: WEBHOOK_EVENT_NAME,
            // Inngest drops a second send with the same id inside its dedupe window: a second line of defence behind the claim.
            id: `wh:${laneId}:${entry.provider}:${sha256Hex(event.eventId).slice(0, 40)}`,
            data: {
              laneId,
              provider: entry.provider,
              connectionId: lane.connectionId,
              eventId: event.eventId,
              eventType: event.eventType,
              refs: event.refs.map((r) => ({ type: r.type, id: r.id })),
            },
          });
        } catch {
          counts.failed += 1;
          await deps.store.mark(laneId, entry.provider, event.eventId, "failed").catch(() => false);
          elog.error("webhook.enqueue_failed", { outcome: "enqueue_failed", event_id: event.eventId, request_id: requestId });
          continue;
        }
        counts.enqueued += 1;
        // If this fails the event is queued anyway; the row stays 'received' and a late retry is dropped by Inngest's event id.
        await deps.store.mark(laneId, entry.provider, event.eventId, "enqueued").catch(() => false);
        elog.info("webhook.enqueued", { outcome: "enqueued", event_id: event.eventId, request_id: requestId });
      }
    } catch {
      return refuse(503, "unavailable", "store_unavailable", counts);
    }

    if (counts.failed > 0) return refuse(503, "enqueue_failed", "enqueue_failed", counts);
    log.info("webhook.done", { outcome: "ok", request_id: requestId, ...counts });
    // One answer for accepted, duplicate and unknown-account events alike.
    return reply(200, { status: "ok" });
  };
}
