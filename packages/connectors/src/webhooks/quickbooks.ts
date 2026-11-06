// QuickBooks webhook provider (T-053, QB-11): plugs Intuit's notifications into the shared receiver (handler.ts).
//   - Signature: `intuit-signature` = base64(HMAC-SHA256(verifier token, RAW body)), compared in constant time. No signed
//     timestamp exists, so replay protection is the dedupe key in core.webhook_events (toleranceSeconds: null, chosen explicitly).
//   - The token comes from INTUIT_WEBHOOK_VERIFIER_TOKEN through its own required env shape (`intuit_webhook`): unset means the
//     receiver answers 503 and processes nothing (fail closed). It is never logged or put in a queued event.
//   - The body is untrusted data (rule 9) even when the signature is valid: strict, size-capped Zod parsing; entity names are
//     matched against the T-051 entity set (everything else, such as Employee or TimeActivity, is dropped); ids and times are
//     pattern-checked; nothing from the body is stored or forwarded except entity names and ids.
//   - Two payload shapes are read: Intuit's legacy `eventNotifications` and CloudEvents (`type: qbo.<entity>.<op>.v1`,
//     `intuitaccountid`, `intuitentityid`). The CloudEvents field names are from Intuit's published migration notes and are
//     UNVERIFIED against the sandbox (needs-human live check); anything that does not fit is ignored, never guessed.
//   - Dedupe key = sha256(realm | entity | id | operation | lastUpdated). One event per change; a very large delivery is grouped
//     per (realm, entity, operation) so it still fits the receiver's 200-event cap instead of being refused and retried forever.
import { z } from "zod";
import { requireConnectorEnv } from "@nichols/core/env/server";
import { QBO_SYNC_ENTITIES } from "../quickbooks/entities";
import { SecretValue } from "../vault/secret";
import { sha256Hex } from "./crypto";
import { hmacSha256Verifier } from "./hmac";
import type { ParseResult, WebhookEvent, WebhookProvider } from "./types";

/** URL segment: /api/webhooks/qbo (the endpoint registered at Intuit, H-024). */
export const QBO_WEBHOOK_KEY = "qbo";
export const QBO_WEBHOOK_MAX_BODY_BYTES = 512 * 1024;
/** Notifications (companies) read per delivery, and changes read per delivery; more is refused as a bad payload. */
const MAX_NOTIFICATIONS = 50;
const MAX_CHANGES = 5000;
/** The receiver accepts at most 200 events and 100 refs per event. */
const MAX_EVENTS = 200;
const MAX_REFS = 100;

const REALM = /^[A-Za-z0-9_-]{1,40}$/;
const OBJECT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ENTITY_BY_LOWER = new Map<string, string>(QBO_SYNC_ENTITIES.map((e) => [e.toLowerCase(), e]));
const OPERATIONS: Readonly<Record<string, string>> = {
  create: "create", created: "create", update: "update", updated: "update", delete: "delete", deleted: "delete",
  merge: "merge", merged: "merge", void: "void", voided: "void", emailed: "emailed",
};

export const intuitSignatureVerifier = hmacSha256Verifier({ signatureHeader: "intuit-signature", encoding: "base64" });

type Change = { realm: string; entity: string; id: string; op: string; at: string };

const LegacyBody = z.object({
  eventNotifications: z
    .array(
      z.object({
        realmId: z.string().max(64),
        dataChangeEvent: z.object({ entities: z.array(z.unknown()).max(MAX_CHANGES) }).optional(),
      }),
    )
    .max(MAX_NOTIFICATIONS),
});
const LegacyEntity = z.object({ name: z.string().max(64), id: z.string().max(64), operation: z.string().max(32).optional(), lastUpdated: z.string().max(40).optional() });

const CloudEvent = z.object({
  type: z.string().max(128),
  intuitaccountid: z.string().max(64),
  intuitentityid: z.string().max(64),
  time: z.string().max(40).optional(),
});

function accept(realm: string, name: string, id: string, operation: string | undefined, at: string | undefined, noTime: string): Change | null {
  const entity = ENTITY_BY_LOWER.get(name.toLowerCase());
  if (!entity || !REALM.test(realm) || !OBJECT_ID.test(id)) return null;
  // An operation this code does not know still means "something changed": it is kept as `other`, never dropped.
  const op = OPERATIONS[(operation ?? "").toLowerCase()] ?? "other";
  // No usable time (CloudEvents `time` is optional): key on this delivery's body hash instead, so a later update to the same record
  // is never mistaken for this one. A retry of the identical body still dedupes.
  const stamp = at && !Number.isNaN(Date.parse(at)) ? at : noTime;
  return { realm, entity, id, op, at: stamp };
}

function readChanges(json: unknown, noTime: string): Change[] | null {
  const out: Change[] = [];
  const legacy = LegacyBody.safeParse(json);
  if (legacy.success) {
    for (const n of legacy.data.eventNotifications) {
      for (const raw of n.dataChangeEvent?.entities ?? []) {
        const e = LegacyEntity.safeParse(raw);
        const c = e.success ? accept(n.realmId, e.data.name, e.data.id, e.data.operation, e.data.lastUpdated, noTime) : null;
        if (c) out.push(c);
      }
    }
    return out;
  }
  const list = Array.isArray(json) ? json : typeof json === "object" && json !== null && "specversion" in json ? [json] : null;
  if (!list || list.length > MAX_CHANGES) return null;
  for (const raw of list) {
    const e = CloudEvent.safeParse(raw);
    if (!e.success) continue;
    const m = /^qbo\.([a-z]+)\.([a-z]+)\.v[0-9]+$/i.exec(e.data.type);
    const c = m?.[1] && m[2] ? accept(e.data.intuitaccountid, m[1], e.data.intuitentityid, m[2], e.data.time, noTime) : null;
    if (c) out.push(c);
  }
  return out;
}

const keyOf = (c: Change) => [c.realm, c.entity, c.id, c.op, c.at].join("|");

/** Reads the changes out of a VERIFIED body. Never throws; { ok: false } for anything that is not a notification. */
export function parseQuickbooksBody(body: Uint8Array): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { ok: false };
  }
  const read = readChanges(json, `nots:${sha256Hex(body).slice(0, 24)}`);
  if (!read) return { ok: false };
  const unique = new Map<string, Change>();
  for (const c of read) unique.set(keyOf(c), c);
  const changes = [...unique.values()];

  const events: WebhookEvent[] = [];
  if (changes.length <= MAX_EVENTS) {
    for (const c of changes) {
      events.push({ accountId: c.realm, eventId: `qbo:${sha256Hex(keyOf(c))}`, eventType: `${c.entity}.${c.op}`, refs: [{ type: c.entity, id: c.id }] });
    }
    return { ok: true, events };
  }
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    const g = groups.get(`${c.realm}|${c.entity}|${c.op}`);
    if (g) g.push(c);
    else groups.set(`${c.realm}|${c.entity}|${c.op}`, [c]);
  }
  if (groups.size > MAX_EVENTS) return { ok: false };
  for (const g of groups.values()) {
    const first = g[0] as Change;
    const key = g.map(keyOf).sort().join("\n");
    events.push({
      accountId: first.realm,
      eventId: `qbo:${sha256Hex(key)}`,
      eventType: `${first.entity}.${first.op}`,
      refs: g.slice(0, MAX_REFS).map((c) => ({ type: c.entity, id: c.id })),
    });
  }
  return { ok: true, events };
}

/** The verifier token, or null when it is not configured (the receiver then answers 503). Never logged. */
function verifierToken(): SecretValue | null {
  try {
    return new SecretValue(requireConnectorEnv("intuit_webhook").INTUIT_WEBHOOK_VERIFIER_TOKEN);
  } catch {
    return null; // the error text names variables only, but the receiver does not need it
  }
}

export function createQuickbooksWebhookProvider(getSecret: () => SecretValue | null = verifierToken): WebhookProvider {
  return {
    provider: "quickbooks",
    verifier: intuitSignatureVerifier,
    getSecret,
    contentTypes: ["application/json", "application/cloudevents+json", "application/cloudevents-batch+json"],
    toleranceSeconds: null,
    maxBodyBytes: QBO_WEBHOOK_MAX_BODY_BYTES,
    parse: parseQuickbooksBody,
  };
}

export const quickbooksWebhookProvider = createQuickbooksWebhookProvider();
