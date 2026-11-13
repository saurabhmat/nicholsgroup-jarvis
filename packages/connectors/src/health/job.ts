// conn.token_health and conn.subscriptions_renew (T-040) for ONE connection. Pure orchestration over injected parts, so
// it is tested with a fake store and mock checkers. The Inngest crons/fan-out live in @nichols/core/inngest.
//
// Token health: (1) the credential-expiry rule: `core.connections.token_expires_at` (the credential whose loss forces a
// reconnect) within 7 days, or already past, raises an alert; (2) the provider's read-only `health` check: a failure
// raises an alert and flags the connection (last_error = redacted error; active -> degraded). Not done here:
// notifying anyone (the notification consumer). Moving a connection to reconnect_required is done where the failure happens (T-195, quickbooks/reconnect.ts).
// A transient health-check failure (timeout, rate limit, 5xx) is inconclusive: it changes nothing and raises nothing.
//
// Failure isolation: one connection per call; every error is reduced to a redacted kind.
import type { LaneId } from "@nichols/core";
import { toConnectorError } from "../contract/errors";
import type { ConnectionLoader } from "../contract/lane-bound";
import type { HealthStatus } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { HEALTH_CHECK_ENDPOINT, type AttentionAlert, type HealthChecker, type HealthJobOutcome, type RenewJobOutcome, type SubscriptionRenewer, type TokenHealthStore } from "./types";

const USABLE = new Set(["active", "degraded"]);
export const TOKEN_WARNING_DAYS = 7;
const DAY_MS = 86_400_000;

type Common = { loader: ConnectionLoader<string>; store: TokenHealthStore; now?: () => Date; logger?: ConnectorLogger };

/** Alert for the credential expiry, or null. Exactly 7 days left is flagged; 7 days and a second is not. */
export function expiryAlert(provider: string, expiresAt: string | null, now: Date): AttentionAlert | null {
  if (expiresAt === null) return null;
  const left = Date.parse(expiresAt) - now.getTime();
  if (Number.isNaN(left) || left > TOKEN_WARNING_DAYS * DAY_MS) return null;
  const daysLeft = Math.max(-3650, Math.min(3650, Math.floor(left / DAY_MS)));
  return { provider, reason: left <= 0 ? "token_expired" : "token_expiring", daysLeft };
}

export function createTokenHealthJob(deps: Common & { checkers: Readonly<Record<string, HealthChecker>> }) {
  const log = deps.logger ?? connectorLog;
  const now = deps.now ?? (() => new Date());

  return {
    async run(laneId: LaneId, connectionId: string): Promise<HealthJobOutcome> {
      let conn;
      try {
        conn = await deps.loader.loadConnection(laneId, connectionId);
      } catch (e) {
        const err = toConnectorError(e);
        return { ok: false, retryable: err.info.disposition === "retry", errorKind: err.info.kind };
      }
      const child = log.child({ laneId, provider: conn.provider, connectionId: conn.id });
      // T-195: a QuickBooks connection recorded as reconnect_required is listed only while its admin notice is unsent: raise it again.
      if (conn.status === "reconnect_required" && conn.provider === "quickbooks") {
        return { ok: true, skipped: "connection_not_usable", alerts: [{ provider: conn.provider, reason: "reconnect_required", errorKind: "reconnect_required" }] };
      }
      if (!USABLE.has(conn.status)) return { ok: true, skipped: "connection_not_usable", alerts: [] };

      const alerts: AttentionAlert[] = [];
      const expiry = expiryAlert(conn.provider, conn.token_expires_at, now());
      if (expiry) {
        alerts.push(expiry);
        child.warn("conn.token_health.expiring", { reason: expiry.reason, daysLeft: expiry.daysLeft });
      }

      const checker = deps.checkers[conn.provider];
      if (checker) {
        let health: HealthStatus;
        try {
          health = await checker(laneId, conn);
        } catch (e) {
          const err = toConnectorError(e);
          health = { ok: false, status: "degraded", checked_at: now().toISOString(), provider_tid: err.info.provider_tid, error: err.toJSON() };
        }
        if (health.ok) {
          // A good check heals a degraded connection's status, and clears last_error only when it is the health check's own
          // error (marked with HEALTH_CHECK_ENDPOINT): an error from a sync or a renewal is kept (a successful sync clears its own).
          try {
            if (conn.status === "degraded" && !(await deps.store.applyHealth(laneId, conn, { status: "active" }))) child.warn("conn.token_health.superseded", {});
            if (conn.last_error?.endpoint === HEALTH_CHECK_ENDPOINT) await deps.store.clearHealthError(laneId, conn);
          } catch (e) {
            return { ok: false, retryable: true, errorKind: toConnectorError(e).info.kind };
          }
          child.info("conn.token_health.ok", {});
        } else if (health.error?.disposition === "retry") {
          child.warn("conn.token_health.inconclusive", { kind: health.error.kind });
        } else {
          // Marked as the health check's own error, so a later good check may clear it (and only it).
          const error = { ...(health.error ?? toConnectorError(new Error("health check failed")).toJSON()), endpoint: HEALTH_CHECK_ENDPOINT };
          // A refused grant is its own reason (T-195): the same event id as the one the token manager sent, so Inngest drops the repeat.
          alerts.push({ provider: conn.provider, reason: error.kind === "reconnect_required" ? "reconnect_required" : "health_check_failed", errorKind: error.kind });
          child.warn("conn.token_health.failed", { kind: error.kind, disposition: error.disposition });
          try {
            // reconnect_required is recorded where the failure happens (T-195); here it is only flagged, the status is not touched.
            const applied = await deps.store.applyHealth(laneId, conn, { ...(conn.status === "active" && error.kind !== "reconnect_required" ? { status: "degraded" as const } : {}), last_error: error });
            if (!applied) child.warn("conn.token_health.superseded", {}); // the row changed meanwhile (e.g. T-195): not overwritten
          } catch (e) {
            return { ok: false, retryable: true, errorKind: toConnectorError(e).info.kind };
          }
        }
      }
      return { ok: true, skipped: null, alerts };
    },
  };
}

export type TokenHealthJob = ReturnType<typeof createTokenHealthJob>;

export function createSubscriptionRenewJob(deps: Common & { renewers: Readonly<Record<string, SubscriptionRenewer>> }) {
  const log = deps.logger ?? connectorLog;
  const now = deps.now ?? (() => new Date());

  return {
    /** Connections of providers that have a renewer (the scan lists only those). */
    providers(): string[] {
      return Object.keys(deps.renewers);
    },
    async run(laneId: LaneId, connectionId: string): Promise<RenewJobOutcome> {
      let conn;
      try {
        conn = await deps.loader.loadConnection(laneId, connectionId);
      } catch (e) {
        const err = toConnectorError(e);
        return { ok: false, retryable: err.info.disposition === "retry", errorKind: err.info.kind };
      }
      const child = log.child({ laneId, provider: conn.provider, connectionId: conn.id });
      if (!USABLE.has(conn.status)) return { ok: true, skipped: "connection_not_usable", alerts: [] };
      const renewer = deps.renewers[conn.provider];
      if (!renewer) return { ok: true, skipped: "no_renewer", alerts: [] };
      try {
        const r = await renewer(laneId, conn, { now: now() });
        child.info("conn.subscriptions_renew.done", { renewed: r.renewed });
        return { ok: true, skipped: null, alerts: [] };
      } catch (e) {
        const err = toConnectorError(e);
        if (err.info.disposition === "retry") return { ok: false, retryable: true, errorKind: err.info.kind };
        child.warn("conn.subscriptions_renew.failed", { kind: err.info.kind });
        try {
          if (!(await deps.store.applyHealth(laneId, conn, { last_error: err.toJSON() }))) child.warn("conn.subscriptions_renew.superseded", {});
        } catch (se) {
          return { ok: false, retryable: true, errorKind: toConnectorError(se).info.kind };
        }
        return { ok: true, skipped: null, alerts: [{ provider: conn.provider, reason: "subscription_renewal_failed", errorKind: err.info.kind }] };
      }
    },
  };
}

export type SubscriptionRenewJob = ReturnType<typeof createSubscriptionRenewJob>;
