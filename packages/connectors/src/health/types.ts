// conn.token_health and conn.subscriptions_renew (T-040): shapes shared by the jobs and the connection store.
import type { LaneId } from "@nichols/core";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorErrorInfo, HealthStatus } from "../contract/schemas";

/** The reasons a connection needs attention. Mirrors CONN_ATTENTION_REASONS in @nichols/core/inngest (structural). */
export type AttentionReason = "token_expiring" | "token_expired" | "health_check_failed" | "subscription_renewal_failed" | "reconnect_required";

/** Ids and enums only; becomes a `conn/attention.needed` event. Never a message, token or provider text. */
export type AttentionAlert = { provider: string; reason: AttentionReason; errorKind?: string; daysLeft?: number };

export type JobFailure = { ok: false; retryable: boolean; errorKind: string };
export type HealthJobOutcome = { ok: true; skipped: "connection_not_usable" | null; alerts: AttentionAlert[] } | JobFailure;
export type RenewJobOutcome = { ok: true; skipped: "connection_not_usable" | "no_renewer" | null; alerts: AttentionAlert[] } | JobFailure;

/** A provider's read-only health check, normally `connector.health`. Must not write to the provider. */
export type HealthChecker = (laneId: LaneId, conn: LaneBoundConnection<string>) => Promise<HealthStatus>;

/**
 * Renews (or creates again) a provider push subscription that is due to expire, if it is due. INTERFACE ONLY (T-040):
 * no provider implements it yet. It is a call that changes provider-side state, so an implementation is reviewed
 * against rule 5 before it is registered (see the T-040 notes). It reports `renewed: false` when nothing was due.
 */
export type SubscriptionRenewer = (laneId: LaneId, conn: LaneBoundConnection<string>, input: { now: Date }) => Promise<{ renewed: boolean; expires_at: string | null }>;

/** What the jobs change on a connection row: nothing but the health fields (never tokens, lane or provider). */
export type ConnectionHealthPatch = { status?: "active" | "degraded"; last_error?: ConnectorErrorInfo | null };

export interface TokenHealthStore {
  /** Ids of the lane's active/degraded connections, limited to `providers` when given. Empty `providers` means none. */
  listUsableConnectionIds(laneId: LaneId, providers?: readonly string[]): Promise<string[]>;
  /**
   * Applies the patch to the connection if it is still in the status it was loaded with (so it never overwrites a
   * transition made meanwhile, e.g. reconnect_required by T-195). Returns false when the row changed or is gone.
   */
  applyHealth(laneId: LaneId, conn: LaneBoundConnection<string>, patch: ConnectionHealthPatch): Promise<boolean>;
  /**
   * Clears `last_error` only when it is still the health check's own error (endpoint = HEALTH_CHECK_ENDPOINT), so an error
   * written by a sync or a renewal meanwhile is kept. Returns false when nothing was cleared.
   */
  clearHealthError(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<boolean>;
  /** True while a reconnect_required connection's admin notice has not been sent (`reconnect_notified_at is null`, T-195). */
  reconnectNoticePending(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<boolean>;
  /** Records that the notice was sent (only while the connection is still reconnect_required). */
  markReconnectNotified(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<void>;
}

/** Marker stored as `last_error.endpoint` for errors written by the health check (not a real path). */
export const HEALTH_CHECK_ENDPOINT = "/health-check";
