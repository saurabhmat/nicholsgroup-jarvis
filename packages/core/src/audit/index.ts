// Audit write API (T-015) over audit.log() (T-014). Callers pass a sink that performs the database call (the lane
// router wires it to the service client in T-016), so this module stays pure and testable.
// Metadata is redacted before it leaves the process: credential-like and body-like fields are dropped, secret-looking
// values replaced, long strings truncated and the size bounded. The database checks again.
// Failures throw AuditError, and withAudit() writes the entry BEFORE running the action, so an action never runs
// unaudited. Errors never carry the database message (Postgres echoes the failing row, i.e. the metadata).
import { z } from "zod";
import { isSecretLikeValue } from "../env/secret-patterns";
import type { LaneId } from "../lanes/index";

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
  target: z.string().max(300).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------- redaction

export const REDACTED = "[redacted]";
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_JSON_CHARS = 8000;
const JWT = /^eyJ[\w-]+\.[\w-]+\./;

/** Word parts (after splitting camelCase, snake_case and kebab-case) that mark a credential or content field. */
const SENSITIVE_PARTS = new Set([
  // credentials
  "token", "secret", "password", "passwd", "pwd", "apikey", "private", "credential", "credentials", "authorization",
  "auth", "cookie", "cookies", "session", "bearer", "signature", "otp", "totp",
  // content (CLAUDE.md rule 6: no bodies)
  "body", "bodies", "content", "html", "text", "snippet", "message", "messages", "subject", "attachment",
  "attachments", "raw", "payload", "prompt", "completion", "transcript", "note", "notes",
]);

const keyParts = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** True for a field name that marks a credential or content (e.g. accessToken, email_body, api-key). */
export function isSensitiveKey(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((p) => SENSITIVE_PARTS.has(p)) || parts.join("").includes("apikey");
}

function redactValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const v = value.trim();
    if (isSecretLikeValue(v) || JWT.test(v)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "object") return undefined; // functions, symbols, undefined: dropped
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSensitiveKey(k)) continue;
    const r = redactValue(v, depth + 1);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

/**
 * Metadata safe to store: credential- and content-named fields removed, secret-looking values replaced with
 * "[redacted]", strings cut at 200 characters, depth 4, arrays 50 items, about 8 KB of JSON in total.
 */
export function redactMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (metadata === undefined) return {};
  const out = redactValue(metadata, 0) as Record<string, unknown>;
  return JSON.stringify(out).length > MAX_JSON_CHARS ? { _truncated: true } : out;
}

// ---------------------------------------------------------------- API

export type Audit = { log(entry: AuditEntry): Promise<void> };

export function createAudit(sink: AuditSink): Audit {
  return {
    async log(entry) {
      const parsed = entrySchema.safeParse(entry);
      if (!parsed.success) throw new AuditError("invalid_entry");
      const e = parsed.data;
      const row: AuditRow = {
        p_lane_id: e.laneId,
        p_actor_kind: e.actor.kind,
        p_actor_id: e.actor.kind === "user" ? e.actor.userId : null,
        p_action: e.action,
        p_target: e.target ?? null,
        p_metadata: redactMetadata(e.metadata),
      };
      try {
        await sink(row);
      } catch {
        // Never attach the cause: database errors can quote the row being written.
        throw new AuditError("write_failed");
      }
    },
  };
}

/** Audits `entry`, then runs `action`. If the audit write fails, the action does not run. */
export async function withAudit<T>(audit: Audit, entry: AuditEntry, action: () => Promise<T>): Promise<T> {
  await audit.log(entry);
  return action();
}
