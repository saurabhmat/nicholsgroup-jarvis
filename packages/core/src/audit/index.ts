// Audit write API (T-015) over audit.log() (T-014). Callers pass a sink that performs the database call (the lane
// router wires it to the service client, T-016), so this module stays pure and testable.
// Metadata is redacted before it leaves the process: credential-, personal- and content-named fields are dropped,
// secret-looking values replaced, only plain objects and arrays are walked, strings are truncated and the size is
// bounded. The database checks again. Errors never carry the database message (Postgres echoes the failing row).
// withAudit() records <action>.requested before the action runs (an unaudited action never runs) and
// <action>.succeeded or <action>.failed afterwards, so the log never claims an outcome that did not happen.
import { z } from "zod";
import type { LaneId } from "../lanes/index";
import { looksLikeSecretValue } from "../secrets/index";

export type AuditActor = { kind: "user"; userId: string } | { kind: "service" } | { kind: "system" };

export type AuditEntry = {
  laneId: LaneId;
  actor: AuditActor;
  /** Dotted lowercase event name, e.g. "lane_config.version_created". */
  action: string;
  /** An id or reference, never content, e.g. "lane_config:PKG:3". */
  target?: string;
  metadata?: Record<string, unknown>;
};

/** Arguments of audit.log(), in its parameter order. */
export type AuditRow = {
  p_lane_id: string;
  p_actor_kind: AuditActor["kind"];
  p_actor_id: string | null;
  p_action: string;
  p_target: string | null;
  p_metadata: Record<string, unknown>;
};

export type AuditSink = (row: AuditRow) => Promise<void>;

export class AuditError extends Error {
  readonly reason: "invalid_entry" | "write_failed";
  constructor(reason: "invalid_entry" | "write_failed") {
    super(reason === "invalid_entry" ? "Audit entry is invalid." : "Audit write failed; the action was not performed.");
    this.name = "AuditError";
    this.reason = reason;
  }
}

const entrySchema = z.strictObject({
  laneId: z.string().regex(/^[A-Z]{1,8}$/),
  actor: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("user"), userId: z.uuid() }),
    z.strictObject({ kind: z.literal("service") }),
    z.strictObject({ kind: z.literal("system") }),
  ]),
  action: z.string().max(100).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  target: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9_.:/@-]+$/)
    .refine((t) => !looksLikeSecretValue(t))
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------- redaction

export const REDACTED = "[redacted]";
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_KEYS = 200;
const MAX_JSON_CHARS = 8000;

/** Word parts (after splitting camelCase, snake_case and kebab-case; plurals too) that mark a field to drop. */
const SENSITIVE_PARTS = new Set([
  // credentials
  "token", "secret", "password", "passwd", "pwd", "apikey", "key", "private", "credential", "authorization", "auth",
  "cookie", "session", "bearer", "signature", "sig", "otp", "totp", "jwt", "code",
  // personal and financial data the portal never stores (CLAUDE.md, architecture §7)
  "ssn", "account", "routing", "iban", "card", "cvv", "salary", "salarie", "compensation",
  // content (CLAUDE.md rule 6: no bodies) and error internals that can quote rows or queries
  "body", "bodie", "content", "html", "text", "snippet", "message", "subject", "attachment", "raw", "payload",
  "prompt", "completion", "transcript", "note", "detail", "hint", "query", "stack",
]);
/** Field names kept although a part matches (counters and references, not values). */
const ALLOWED_KEYS = new Set([
  "input_tokens", "output_tokens", "max_tokens", "idempotency_key", "error_code", "status_code", "lane_code",
  "entity_code", "account_id_count",
]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** True for a field name that marks a credential, personal data or content (e.g. accessToken, email_body, api-key). */
export function isSensitiveKey(key: string): boolean {
  const k = snake(key);
  if (ALLOWED_KEYS.has(k)) return false;
  const parts = k.split(/[^a-z0-9]+/).filter(Boolean);
  const hit = (p: string) => SENSITIVE_PARTS.has(p) || (p.endsWith("s") && SENSITIVE_PARTS.has(p.slice(0, -1)));
  return parts.some(hit) || parts.join("").includes("apikey") || parts.join("").includes("accesskey");
}

const isPlainObject = (v: object) => {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value !== "object") return undefined; // functions, symbols, undefined: dropped
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[binary]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1) ?? null);
  if (!isPlainObject(value)) return "[object]"; // Map, Set, Error, class instances: never walked
  const out = Object.create(null) as Record<string, unknown>;
  let kept = 0;
  for (const k of Object.keys(value)) {
    if (kept >= MAX_KEYS) {
      out._more_keys = true;
      break;
    }
    if (UNSAFE_KEYS.has(k) || isSensitiveKey(k)) continue;
    const r = redactValue((value as Record<string, unknown>)[k], depth + 1);
    if (r !== undefined) {
      out[k] = r;
      kept += 1;
    }
  }
  return out;
}

/**
 * Metadata safe to store: credential-, personal- and content-named fields removed, secret-looking values replaced
 * with "[redacted]", only plain objects and arrays walked (binary, Map, Set and class instances replaced by a
 * marker), strings cut at 200 characters, depth 4, arrays 50 items, 200 keys per object, about 8 KB of JSON.
 * Throws if reading the input throws (e.g. a getter); createAudit turns that into AuditError.
 */
export function redactMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (metadata === undefined) return {};
  const out = redactValue(metadata, 0);
  if (out === null || typeof out !== "object" || Array.isArray(out)) return {};
  const plain = { ...(out as Record<string, unknown>) };
  return JSON.stringify(plain).length > MAX_JSON_CHARS ? { _truncated: true } : plain;
}

// ---------------------------------------------------------------- API

export type Audit = { log(entry: AuditEntry): Promise<void> };

export function createAudit(sink: AuditSink): Audit {
  return {
    async log(entry) {
      let row: AuditRow;
      try {
        const parsed = entrySchema.safeParse(entry);
        if (!parsed.success) throw new AuditError("invalid_entry");
        const e = parsed.data;
        row = {
          p_lane_id: e.laneId,
          p_actor_kind: e.actor.kind,
          p_actor_id: e.actor.kind === "user" ? e.actor.userId : null,
          p_action: e.action,
          p_target: e.target ?? null,
          p_metadata: redactMetadata(e.metadata),
        };
      } catch {
        // Includes getters that throw while redacting: their messages are not carried either.
        throw new AuditError("invalid_entry");
      }
      try {
        await sink(row);
      } catch {
        // Never attach the cause: database errors can quote the row being written.
        throw new AuditError("write_failed");
      }
    },
  };
}

/**
 * Records `<entry.action>.requested`, runs `action`, then records `<entry.action>.succeeded` or
 * `<entry.action>.failed` (with the error's class name only). If the first write fails the action does not run; if
 * the outcome write fails after a success, AuditError is thrown so the caller fails too. A failed action's own error
 * is rethrown even when recording the failure also fails.
 */
export async function withAudit<T>(audit: Audit, entry: AuditEntry, action: () => Promise<T>): Promise<T> {
  await audit.log({ ...entry, action: `${entry.action}.requested` });
  let result: T;
  try {
    result = await action();
  } catch (err) {
    const errorClass = err instanceof Error ? err.name : typeof err;
    await audit
      .log({ ...entry, action: `${entry.action}.failed`, metadata: { ...entry.metadata, error_class: errorClass } })
      .catch(() => undefined);
    throw err;
  }
  await audit.log({ ...entry, action: `${entry.action}.succeeded` });
  return result;
}
