// Zod schemas for the connector contract (architecture §6 M2).
// Data shapes are snake_case because they mirror stored rows: `core.connections` (T-031), `raw.source_records` (T-039),
// `core.connector_api_errors` (T-196) and `act.proposed_actions` (T-110). Function parameters stay camelCase.
// Nothing here is company-specific: realms, accounts and mailboxes are values, never constants.
import { z } from "zod";

/** Timestamps are always instants with an explicit offset (rule 11: timestamptz). */
export const InstantSchema = z.iso.datetime({ offset: true });

/** Lane ids come from the database / lane_config; the contract only requires a non-empty, bounded id. */
export const LaneIdSchema = z.string().min(1).max(64);

/** Real providers only. The test-only `mock` provider lives in `@nichols/connectors/testing` (never in data). */
export const PROVIDERS = ["quickbooks", "stripe", "gohighlevel", "google", "microsoft", "monday", "notion", "timesolv"] as const;
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

/** Lower snake_case identifier, e.g. `class_tracking`. */
export const SnakeKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** Dotted lower snake_case name, e.g. `report.profit_and_loss`, `monday.item.update`. */
export const OpNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63}){0,4}$/);
/** Provider object type as stored in `raw.source_records.object_type`, e.g. `Invoice`. */
export const ObjectTypeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/);

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
 * Safe, storable error description (T-196 `core.connector_api_errors`). Must never carry tokens, secrets or personal
 * data. Redacting provider messages before they get here is the connector's job (shared redactor in T-033).
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
  /** Endpoint template without ids, query strings or fragments, e.g. `/v3/company/{realm}/reports/ProfitAndLoss`. */
  endpoint: z.string().max(256).regex(/^\/[^?#\s]*$/, "endpoint is a path template without query or fragment").nullable(),
});
export type ConnectorErrorInfo = z.infer<typeof ConnectorErrorInfoSchema>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * OAuth redirect URI: https, or http on loopback only; no userinfo, no fragment. This is shape validation only —
 * connectors must send the server-configured redirect URI and the provider must match it exactly (T-035).
 */
export const RedirectUriSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value) || value.includes("#")) return false;
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  }, "redirect_uri must be https (http only for loopback), without userinfo or fragment");

const ReconnectFields = {
  /** Account id from the provider (QuickBooks callback `realmId`); checked against lane_config by T-050. */
  external_account_id: z.string().min(1).max(256),
  /** Reuse an existing connection row on reconnect (T-195). Must be in the same lane, provider and account. */
  reconnect_connection_id: z.uuid().optional(),
};

/**
 * Input to `connect`.
 * - `oauth_code`: only the in-app OAuth callback produces one (QB-7: no Playground or offline tokens).
 * - `vault_secret`: a reference to a secret an admin already stored in the Vault (Stripe restricted key, GoHighLevel,
 *   monday, Notion tokens). Never the secret itself.
 */
export const ConnectInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth_code"),
    code: z.string().min(1).max(2048),
    redirect_uri: RedirectUriSchema,
    /** PKCE verifier (T-035). */
    code_verifier: z.string().min(43).max(128).optional(),
    external_account_id: ReconnectFields.external_account_id.optional(),
    reconnect_connection_id: ReconnectFields.reconnect_connection_id,
  }),
  z.strictObject({
    kind: z.literal("vault_secret"),
    secret_ref: z.uuid(),
    ...ReconnectFields,
  }),
]);
export type ConnectInput = z.infer<typeof ConnectInputSchema>;

export const JsonObjectSchema = z.record(z.string(), z.json());
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

/**
 * Builds every schema that names a provider, for a given provider enum. The contract uses real providers
 * (`ProviderSchema`); the test kit builds the same schemas with the test-only provider added.
 */
export function buildProviderSchemas<P extends z.ZodType<string>>(provider: P) {
  /**
   * A lane's connection to one provider account. Mirrors the non-secret columns of `core.connections` (T-031).
   * Strict: tokens and secrets live only in the Vault and can never ride along on this object.
   */
  const ConnectionSchema = z.strictObject({
    id: z.uuid(),
    lane_id: LaneIdSchema,
    provider,
    /** Provider account id (QuickBooks realmId, Stripe account, mailbox, workspace). Comes from the provider, not code. */
    external_account_id: z.string().min(1).max(256),
    status: ConnectionStatusSchema,
    features: ConnectionFeaturesSchema.default({}),
    features_checked_at: InstantSchema.nullable(),
    /** Expiry of the credential whose loss forces a reconnect (refresh token, API key), not the access token's. */
    token_expires_at: InstantSchema.nullable(),
    last_sync_at: InstantSchema.nullable(),
    last_error: ConnectorErrorInfoSchema.nullable(),
  });

  /** Envelope for every live read: provenance, `as_of` and freshness (architecture §2 principle 6). */
  function sourceResultSchema<T extends z.ZodType>(data: T) {
    return z.strictObject({
      lane_id: LaneIdSchema,
      provider,
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

  /** One provider object as synced into `raw.source_records` (T-039). T-039 computes `payload_hash`. */
  const RawRecordSchema = z.strictObject({
    lane_id: LaneIdSchema,
    provider,
    connection_id: z.uuid(),
    object_type: ObjectTypeSchema,
    external_id: z.string().min(1).max(256),
    payload: JsonObjectSchema,
    /** Provider's last-updated time for the object, when it has one. */
    source_updated_at: InstantSchema.nullable(),
    /** CDC/delta deletion marker. */
    deleted: z.boolean(),
    synced_at: InstantSchema,
  });

  const SubscriptionSchema = z.strictObject({
    id: z.string().min(1).max(256),
    lane_id: LaneIdSchema,
    provider,
    connection_id: z.uuid(),
    kind: z.enum(["webhook", "push"]),
    /** Null when the provider subscription does not expire (e.g. Intuit webhooks). */
    expires_at: InstantSchema.nullable(),
    created_at: InstantSchema,
  });

  /**
   * Output of `prepareWrite`: the exact payload a human will approve (approvals spec §4).
   * Hashing, consequences and approval are the approvals module's job, so they cannot appear here.
   */
  const ProposedPayloadSchema = z.strictObject({
    lane_id: LaneIdSchema,
    provider,
    connection_id: z.uuid(),
    action_type: OpNameSchema,
    target: JsonObjectSchema,
    payload: JsonObjectSchema,
    payload_schema_version: z.number().int().positive(),
    /** Target state when proposed, so the executor can detect drift. Null for creates. */
    expected_before: JsonObjectSchema.nullable(),
  });

  return {
    ConnectionSchema,
    sourceResultSchema,
    SourceResultSchema: sourceResultSchema(z.unknown()),
    RawRecordSchema,
    SubscriptionSchema,
    ProposedPayloadSchema,
  };
}

const realProviderSchemas = buildProviderSchemas(ProviderSchema);
export const ConnectionSchema = realProviderSchemas.ConnectionSchema;
export const sourceResultSchema = realProviderSchemas.sourceResultSchema;
export const SourceResultSchema = realProviderSchemas.SourceResultSchema;
export const RawRecordSchema = realProviderSchemas.RawRecordSchema;
export const SubscriptionSchema = realProviderSchemas.SubscriptionSchema;
export const ProposedPayloadSchema = realProviderSchemas.ProposedPayloadSchema;

type WithProvider<T, P extends string> = Omit<T, "provider"> & { provider: P };
export type Connection<P extends string = Provider> = WithProvider<z.infer<typeof ConnectionSchema>, P>;
export type SourceResult<T = unknown, P extends string = Provider> = Omit<WithProvider<z.infer<typeof SourceResultSchema>, P>, "data"> & { data: T };
export type RawRecord<P extends string = Provider> = WithProvider<z.infer<typeof RawRecordSchema>, P>;
export type Subscription<P extends string = Provider> = WithProvider<z.infer<typeof SubscriptionSchema>, P>;
export type ProposedPayload<P extends string = Provider> = WithProvider<z.infer<typeof ProposedPayloadSchema>, P>;

/** Opaque, connector-defined sync position (CDC timestamp, history id, delta link token). */
export const SyncCursorSchema = z.strictObject({
  value: z.string().min(1).max(4096),
});
export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export const SyncOptionsSchema = z.strictObject({
  /** Limit the run to these object types (e.g. a targeted CDC fetch after a webhook, T-053). */
  objectTypes: z.array(ObjectTypeSchema).max(64).optional(),
});
export type SyncOptions = z.infer<typeof SyncOptionsSchema>;

/**
 * Returned when a sync run completes. The caller persists `cursor` only after the whole run succeeded (T-038, T-051).
 * `mode: "full"` when there was no cursor or it was too old to resume (e.g. outside Intuit's 30-day CDC window).
 */
export const SyncSummarySchema = z.strictObject({
  cursor: SyncCursorSchema,
  mode: z.enum(["full", "incremental"]),
  records: z.number().int().nonnegative(),
  provider_tid: z.string().max(256).nullable(),
});
export type SyncSummary = z.infer<typeof SyncSummarySchema>;

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

/** What a caller wants written; the connector turns it into an exact payload for approval. */
export const WriteIntentSchema = z.strictObject({
  action_type: OpNameSchema,
  target: JsonObjectSchema,
  changes: JsonObjectSchema,
});
export type WriteIntent = z.infer<typeof WriteIntentSchema>;

/** Result of an approved write (approvals module only; see `writer.ts`). No content bodies. */
export const ExecResultSchema = z.strictObject({
  outcome: z.enum(["accepted", "already_applied"]),
  external_id: z.string().max(256).nullable(),
  executed_at: InstantSchema,
  provider_tid: z.string().max(256).nullable(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;
