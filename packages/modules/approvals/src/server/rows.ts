// Reading act.proposed_actions rows from the core.act_* functions (T-232): snake_case JSON in, a typed row out. Anything
// that is not what the database promises is `unavailable` (never a guess), and the hash is recomputed by callers.
import { computePayloadSha256 } from "@nichols/connectors/writer";
import { z } from "zod";
import { ApprovalsError } from "./errors";
import type { ActionRow } from "./types";

const json = z.record(z.string(), z.unknown());
const RowSchema = z.object({
  id: z.uuid(),
  lane_id: z.string().regex(/^[A-Z]{1,8}$/),
  action_type: z.enum(["email.send", "email.save_draft"]),
  connection_id: z.uuid(),
  provider: z.string(),
  target: json,
  payload: json,
  payload_schema_version: z.number().int().positive(),
  payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rationale: z.string().nullable(),
  source_refs: z.array(z.unknown()),
  proposer_kind: z.enum(["user", "assistant", "job"]),
  proposer_user_id: z.string().nullable(),
  derived_from_retrieved: z.boolean(),
  supersedes_id: z.string().nullable(),
  superseded_by_id: z.string().nullable(),
  status: z.enum(["proposed", "approved", "executing", "verified", "failed", "rejected", "expired", "invalidated"]),
  expires_at: z.string(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_hash: z.string().nullable(),
  executed_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  result: json,
  failure_code: z.string().nullable(),
  payload_purged_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function toRow(raw: unknown): ActionRow {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) throw new ApprovalsError("unavailable");
  const r = parsed.data;
  return {
    id: r.id,
    laneId: r.lane_id,
    actionType: r.action_type,
    connectionId: r.connection_id,
    provider: r.provider,
    target: r.target,
    payload: r.payload,
    payloadSchemaVersion: r.payload_schema_version,
    payloadSha256: r.payload_sha256,
    rationale: r.rationale,
    sourceRefs: r.source_refs,
    proposerKind: r.proposer_kind,
    proposerUserId: r.proposer_user_id,
    derivedFromRetrieved: r.derived_from_retrieved,
    supersedesId: r.supersedes_id,
    supersededById: r.superseded_by_id,
    status: r.status,
    expiresAt: r.expires_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approvedHash: r.approved_hash,
    executedAt: r.executed_at,
    verifiedAt: r.verified_at,
    result: r.result,
    failureCode: r.failure_code,
    payloadPurgedAt: r.payload_purged_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** One row from a function result that is a composite (object) or a set (array of one). */
export function firstRow(data: unknown): ActionRow {
  const item = Array.isArray(data) ? data[0] : data;
  return toRow(item);
}

export function rowsOf(data: unknown): ActionRow[] {
  if (!Array.isArray(data)) throw new ApprovalsError("unavailable");
  return data.map(toRow);
}

/** The JCS hash of a stored row's content, as defined in docs/specs/approvals.md §4 (the connector computes it the same way). */
export function hashOfRow(row: Pick<ActionRow, "laneId" | "actionType" | "connectionId" | "target" | "payload" | "payloadSchemaVersion">): string {
  return computePayloadSha256({
    lane_id: row.laneId,
    action_type: row.actionType,
    connection_id: row.connectionId,
    target: row.target as never,
    payload: row.payload as never,
    payload_schema_version: row.payloadSchemaVersion,
  });
}
