// Zod schemas for the connector contract (architecture §6 M2).
// Data shapes are snake_case because they mirror stored rows: `core.connections` (T-031), `raw.source_records` (T-039),
// `core.connector_api_errors` (T-196) and `act.proposed_actions` (T-110). Function parameters stay camelCase.
// Nothing here is company-specific: realms, accounts and mailboxes are values, never constants.
import { z } from "zod";

/** Timestamps are always instants with an explicit offset (rule 11: timestamptz). */
export const InstantSchema = z.iso.datetime({ offset: true });

/** Lane ids come from the database / lane_config; the contract only requires a non-empty, bounded id. */
export const LaneIdSchema = z.string().min(1).max(64);

export const PROVIDERS = [
  "quickbooks",
  "stripe",
  "gohighlevel",
  "google",
  "microsoft",
  "monday",
  "notion",
  "timesolv",
  // Test-only provider used by the contract kit's mock connector and job tests (T-038, T-113). Never connected for real.
  "mock",
] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Connection lifecycle.
 * - `pending`: connect flow started, tokens not yet stored.
 * - `active`: usable.
 * - `degraded`: tokens valid but the last health check or sync failed; still usable, retried.
 * - `reconnect_required`: refresh token revoked/expired (`invalid_grant`); never retried, no sync, admin notified (QB-4).
 * - `disconnected`: revoked by the user; tokens deleted (QB-8).
 */
export const CONNECTION_STATUSES = ["pending", "active", "degraded", "reconnect_required", "disconnected"] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** Lower snake_case identifier, e.g. `class_tracking`, `invoice`. */
const SnakeKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** Dotted lower snake_case name, e.g. `report.profit_and_loss`, `monday.item.update`. */
export const OpNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){0,4}$/);

/**
 * Edition/plan-dependent features detected on the provider account (e.g. QuickBooks Preferences: `class_tracking`,
 * `location_tracking`, `multicurrency`; QB-10). Keys are declared per connector in `Connector.featureKeys`.
 */
export const ConnectionFeaturesSchema = z.record(SnakeKeySchema, z.boolean());
export type ConnectionFeatures = z.infer<typeof ConnectionFeaturesSchema>;

export const ERROR_KINDS = [
  "lane_mismatch",
  "connection_unavailable",
  "reconnect_required",
  "unsupported_op",
  "invalid_input",
  "rate_limited",
  "transient",
  "timeout",
  "not_found",
  "forbidden",
  "provider_error",
] as const;
export const ConnectorErrorKindSchema = z.enum(ERROR_KINDS);
export type ConnectorErrorKind = z.infer<typeof ConnectorErrorKindSchema>;

/** What the caller does next (QB-3, QB-4, QB-14). */
export const ErrorDispositionSchema = z.enum(["retry", "reconnect_required", "fail"]);
export type ErrorDisposition = z.infer<typeof ErrorDispositionSchema>;

export const ERROR_MESSAGE_MAX = 500;

/**
 * Safe, storable error description (T-196 `core.connector_api_errors`). Must never carry tokens, secrets or personal data.
 * `provider_tid` is the provider's transaction/request id (Intuit `intuit_tid`, Stripe `Request-Id`, ...).
 */
export const ConnectorErrorInfoSchema = z.strictObject({
  kind: ConnectorErrorKindSchema,
  disposition: ErrorDispositionSchema,
  message: z.string().min(1).max(ERROR_MESSAGE_MAX),
  http_status: z.number().int().min(100).max(599).nullable(),
  provider_error_code: z.string().max(128).nullable(),
  provider_tid: z.string().max(256).nullable(),
  retry_after_seconds: z.number().int().nonnegative().nullable(),
  /** Endpoint template without ids or query values, e.g. `/v3/company/{realm}/reports/ProfitAndLoss`. */
  endpoint: z.string().max(256).nullable(),
});
export type ConnectorErrorInfo = z.infer<typeof ConnectorErrorInfoSchema>;

/**
 * A lane's connection to one provider account. Mirrors the non-secret columns of `core.connections` (T-031).
 * Strict: tokens and secrets live only in the Vault and can never ride along on this object.
 */
export const ConnectionSchema = z.strictObject({
  id: z.uuid(),
  lane_id: LaneIdSchema,
  provider: ProviderSchema,
  /** Provider account id (QuickBooks realmId, Stripe account, mailbox, workspace). Comes from the provider, not code. */
  external_account_id: z.string().min(1).max(256),
  status: ConnectionStatusSchema,
  features: ConnectionFeaturesSchema.default({}),
  features_checked_at: InstantSchema.nullable(),
  token_expires_at: InstantSchema.nullable(),
  last_sync_at: InstantSchema.nullable(),
  last_error: ConnectorErrorInfoSchema.nullable(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

const RedirectUriSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}, "redirect_uri must be https (http only for localhost)");

/**
 * Input to `connect`. Only the in-app OAuth callback produces one (QB-7: no Playground or offline tokens).
 * A discriminated union so key-based providers (e.g. a Vault-held restricted key) can add a variant later.
 */
export const ConnectInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth_code"),
    code: z.string().min(1).max(2048),
    redirect_uri: RedirectUriSchema,
    /** PKCE verifier (T-035). */
    code_verifier: z.string().min(43).max(128).optional(),
    /** Account id returned on the callback (QuickBooks `realmId`); checked against lane_config by T-050. */
    external_account_id: z.string().min(1).max(256).optional(),
    /** Reuse an existing connection row on reconnect (T-195). */
    reconnect_connection_id: z.uuid().optional(),
  }),
]);
export type ConnectInput = z.infer<typeof ConnectInputSchema>;

const JsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

/** A live retrieval request. `op` must be one of the connector's `readOps`. */
export const ReadOpSchema = z.strictObject({
  op: OpNameSchema,
  params: JsonObjectSchema.default({}),
});
export type ReadOp = z.input<typeof ReadOpSchema>;

/** live = fetched from the provider now; cached = served from cache within threshold; stale = older than threshold. */
export const FreshnessSchema = z.enum(["live", "cached", "stale"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const SourceRefSchema = z.strictObject({
  kind: SnakeKeySchema,
  ref: z.string().min(1).max(512),
  label: z.string().max(256).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Envelope for every live read: provenance, `as_of` and freshness (architecture §2 principle 6). */
export function sourceResultSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    lane_id: LaneIdSchema,
    provider: ProviderSchema,
    connection_id: z.uuid(),
    op: OpNameSchema,
    data,
    /** The instant the data reflects at the source. */
    as_of: InstantSchema,
    /** When the connector obtained it (from the provider or a cache). */
    fetched_at: InstantSchema,
    freshness: FreshnessSchema,
    provider_tid: z.string().max(256).nullable(),
    source_refs: z.array(SourceRefSchema).default([]),
    notes: z.array(z.string().max(500)).default([]),
  });
}
export const SourceResultSchema = sourceResultSchema(z.unknown());
export type SourceResult<T = unknown> = Omit<z.infer<typeof SourceResultSchema>, "data"> & { data: T };

/** One provider object as synced into `raw.source_records` (T-039). T-039 computes `payload_hash`. */
export const RawRecordSchema = z.strictObject({
  lane_id: LaneIdSchema,
  provider: ProviderSchema,
  connection_id: z.uuid(),
  object_type: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/),
  external_id: z.string().min(1).max(256),
  payload: JsonObjectSchema,
  /** Provider's last-updated time for the object, when it has one. */
  source_updated_at: InstantSchema.nullable(),
  /** CDC/delta deletion marker. */
  deleted: z.boolean(),
  synced_at: InstantSchema,
});
export type RawRecord = z.infer<typeof RawRecordSchema>;

/** Opaque, connector-defined sync position (CDC timestamp, history id, delta link token). */
export const SyncCursorSchema = z.strictObject({
  value: z.string().min(1).max(4096),
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

/**
 * Returned when a sync run completes. The caller persists `cursor` only after the whole run succeeded (T-038, T-051).
 * `mode: "full"` when there was no cursor or it was too old to resume (e.g. outside Intuit's 30-day CDC window).
 */
export const SyncSummarySchema = z.strictObject({
  cursor: SyncCursorSchema,
  mode: z.enum(["full", "incremental"]),
  records: z.number().int().nonnegative(),
  provider_tid: z.string().max(256).nullable().default(null),
});
export type SyncSummary = z.input<typeof SyncSummarySchema>;

export const HealthStatusSchema = z.strictObject({
  ok: z.boolean(),
  /** The status the connection should move to given this check. */
  status: ConnectionStatusSchema,
  checked_at: InstantSchema,
  /** Feature flags re-detected during the check (QB-10), when the provider exposes them. */
  features: ConnectionFeaturesSchema.optional(),
  provider_tid: z.string().max(256).nullable(),
  error: ConnectorErrorInfoSchema.nullable(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const SubscriptionSchema = z.strictObject({
  id: z.string().min(1).max(256),
  lane_id: LaneIdSchema,
  provider: ProviderSchema,
  connection_id: z.uuid(),
  kind: z.enum(["webhook", "push"]),
  /** Null when the provider subscription does not expire (e.g. Intuit webhooks). */
  expires_at: InstantSchema.nullable(),
  created_at: InstantSchema,
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** What a caller wants written; the connector turns it into an exact payload for approval. */
export const WriteIntentSchema = z.strictObject({
  action_type: OpNameSchema,
  target: JsonObjectSchema,
  changes: JsonObjectSchema,
});
export type WriteIntent = z.infer<typeof WriteIntentSchema>;

/**
 * Output of `prepareWrite`: the exact payload a human will approve (approvals spec §4).
 * Hashing, consequences and approval are the approvals module's job, so they cannot appear here.
 */
export const ProposedPayloadSchema = z.strictObject({
  lane_id: LaneIdSchema,
  provider: ProviderSchema,
  connection_id: z.uuid(),
  action_type: OpNameSchema,
  target: JsonObjectSchema,
  payload: JsonObjectSchema,
  payload_schema_version: z.number().int().positive(),
  /** Target state when proposed, so the executor can detect drift. Null for creates. */
  expected_before: JsonObjectSchema.nullable(),
});
export type ProposedPayload = z.infer<typeof ProposedPayloadSchema>;

/** Result of an approved write (approvals module only; see `writer.ts`). No content bodies. */
export const ExecResultSchema = z.strictObject({
  outcome: z.enum(["accepted", "already_applied"]),
  external_id: z.string().max(256).nullable(),
  executed_at: InstantSchema,
  provider_tid: z.string().max(256).nullable(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;
