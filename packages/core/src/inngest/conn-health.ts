import "server-only";
// conn.token_health and conn.subscriptions_renew (T-040): two daily-ish Inngest cron scans, each fanning out one event per
// usable connection of every enabled lane, and one per-connection function behind each. The checks themselves (health
// call, expiry rule, subscription renewal, the core.connections update) are injected: core cannot import connectors;
// apps/web wires @nichols/connectors/health.
//   - Every event and function carries laneId; the cron scan has no lane of its own, so it lists ENABLED_LANES and sends
//     one event per connection. A lane whose listing fails is skipped without blocking the others.
//   - Per-connection functions are keyed by connection id (limit 1) and retried; one connection failing never touches
//     another (separate runs).
//   - Alerts are `conn/attention.needed` events (ids and enums only). They carry an Inngest event id per connection,
//     reason and UTC day, so a retry or a second run the same day does not notify twice. No consumer exists yet.
import { NonRetriableError, cron, type Inngest, type InngestFunction } from "inngest";
import {
  CONN_ATTENTION_REASONS,
  attentionEventId,
  connAttentionNeeded,
  connHealthCheckRequested,
  connSubscriptionRenewRequested,
} from "./events";

export type AttentionAlert = {
  provider: string;
  reason: (typeof CONN_ATTENTION_REASONS)[number];
  errorKind?: string | undefined;
  daysLeft?: number | undefined;
};

type Failure = { ok: false; retryable: boolean; errorKind: string };

/** Mirrors the connectors' token-health outcome (structural: core does not import connectors). */
export type ConnHealthResult = { ok: true; skipped: "connection_not_usable" | null; alerts: AttentionAlert[] } | Failure;
/** Mirrors the connectors' renewal outcome. */
export type ConnRenewResult =
  | { ok: true; skipped: "connection_not_usable" | "no_renewer" | null; alerts: AttentionAlert[] }
  | Failure;

type Lanes = { enabledLanes: () => readonly string[]; listConnectionIds: (laneId: string) => Promise<readonly string[]> };

export type ConnHealthDeps = Lanes & {
  check: (laneId: string, connectionId: string) => Promise<ConnHealthResult>;
  /** Called after a `reconnect_required` alert's event was sent: records that the admin notice went out so the scan stops listing it (T-195). */
  markReconnectNotified?: (laneId: string, connectionId: string) => Promise<void>;
};
export type ConnRenewDeps = Lanes & { renew: (laneId: string, connectionId: string) => Promise<ConnRenewResult> };

/** Function options, exported so tests assert them. UTC; 11:00 is 06:00/07:00 in New York, before the business day. */
export const CONN_HEALTH_CRON = "0 11 * * *";
/** Twice a day: push subscriptions are short-lived (days), and a missed run must not let one lapse. */
export const CONN_RENEW_CRON = "15 */12 * * *";
export const CONN_HEALTH_RETRIES = 2;
// Keys carry the lane (rule 1), even though connection ids are unique UUIDs.
const CONN_KEY = 'event.data.laneId + ":" + event.data.connectionId';
export const CONN_HEALTH_CONCURRENCY = { key: CONN_KEY, limit: 1 } as const;
export const CONN_RENEW_CONCURRENCY = { key: CONN_KEY, limit: 1 } as const;
/** At most one check (or renewal) per connection per hour, whatever sends the event: a forged flood costs no provider calls. */
export const CONN_HEALTH_RATE_LIMIT = { key: CONN_KEY, limit: 1, period: "1h" } as const;
/** Scans are not retried: the listing is saved in the "plan" step, so a retry would only replay it. The throw keeps the failure visible. */
export const CONN_SCAN_RETRIES = 0;
/** Upper bound of connections fanned out per lane in one scan (a runaway listing must not flood Inngest). */
const MAX_PER_LANE = 500;

/** One event payload per usable connection of every enabled lane. A lane that fails to list is skipped (and counted). */
export async function planFanOut(deps: Lanes): Promise<{ targets: { laneId: string; connectionId: string }[]; failedLanes: string[] }> {
  const targets: { laneId: string; connectionId: string }[] = [];
  const failedLanes: string[] = [];
  for (const laneId of deps.enabledLanes()) {
    try {
      for (const connectionId of (await deps.listConnectionIds(laneId)).slice(0, MAX_PER_LANE)) targets.push({ laneId, connectionId });
    } catch {
      failedLanes.push(laneId); // no message: database errors are not passed on
    }
  }
  return { targets, failedLanes };
}

const day = (now: Date) => now.toISOString().slice(0, 10);

type Schema = { schema: { "~standard": { validate(v: unknown): unknown } } };
async function validated(event: Schema, data: unknown): Promise<void> {
  const parsed = (await event.schema["~standard"].validate(data)) as { issues?: unknown };
  if (parsed.issues) throw new NonRetriableError("invalid event data");
}

async function guard(deps: Lanes, event: Schema, data: { laneId: string }): Promise<boolean> {
  // Events can reach Inngest without passing sendLaneEvent: validate again, echo nothing.
  await validated(event, data);
  return deps.enabledLanes().includes(data.laneId);
}

function failureError(r: Failure, what: string): Error {
  return r.retryable ? new Error(`${what} failed: ${r.errorKind}`) : new NonRetriableError(`${what} failed: ${r.errorKind}`);
}

export async function handleConnHealthCheck(
  deps: ConnHealthDeps,
  data: { laneId: string; connectionId: string },
): Promise<Exclude<ConnHealthResult, { ok: false }> | { ok: true; skipped: "lane_not_served"; alerts: [] }> {
  if (!(await guard(deps, connHealthCheckRequested, data))) return { ok: true, skipped: "lane_not_served", alerts: [] };
  const result = await deps.check(data.laneId, data.connectionId);
  if (!result.ok) throw failureError(result, "conn.token_health");
  return result;
}

export async function handleConnRenew(
  deps: ConnRenewDeps,
  data: { laneId: string; connectionId: string },
): Promise<Exclude<ConnRenewResult, { ok: false }> | { ok: true; skipped: "lane_not_served"; alerts: [] }> {
  if (!(await guard(deps, connSubscriptionRenewRequested, data))) return { ok: true, skipped: "lane_not_served", alerts: [] };
  const result = await deps.renew(data.laneId, data.connectionId);
  if (!result.ok) throw failureError(result, "conn.subscriptions_renew");
  return result;
}

/** Attention events, each checked against its schema first (step.sendEvent does not validate): an alert that fails is dropped. */
export async function attentionEvents(laneId: string, connectionId: string, alerts: readonly AttentionAlert[], now: Date) {
  const events = [];
  for (const a of alerts) {
    const data = {
      laneId,
      connectionId,
      provider: a.provider,
      reason: a.reason,
      ...(a.errorKind ? { errorKind: a.errorKind } : {}),
      ...(a.daysLeft !== undefined ? { daysLeft: a.daysLeft } : {}),
    };
    const parsed = (await connAttentionNeeded.schema["~standard"].validate(data)) as { issues?: unknown };
    if (parsed.issues) continue;
    events.push(connAttentionNeeded.create(data, { id: attentionEventId(laneId, connectionId, a.reason, now) }));
  }
  return events;
}

/** The four functions: two cron scans and the two per-connection workers. */
export function connHealthFunctions(inngest: Inngest, health: ConnHealthDeps, renew: ConnRenewDeps, now: () => Date = () => new Date()): InngestFunction.Any[] {
  return [
    inngest.createFunction({ id: "conn-token-health-scan", triggers: [cron(CONN_HEALTH_CRON)], retries: CONN_SCAN_RETRIES }, async ({ step }) => {
      // Day and lists are fixed in one step, so a retry across midnight reuses the same event ids.
      const plan = await step.run("plan", async () => ({ ...(await planFanOut(health)), stamp: day(now()) }));
      const d = plan.stamp;
      if (plan.targets.length > 0) {
        await step.sendEvent(
          "fan-out",
          plan.targets.map((t: { laneId: string; connectionId: string }) => connHealthCheckRequested.create(t, { id: `health:${t.laneId}:${t.connectionId}:${d}` })),
        );
      }
      // After the fan-out: lanes that listed fine are served; the failure still shows in Inngest (the next run lists again).
      if (plan.failedLanes.length > 0) throw new Error("conn.token_health scan: a lane could not be listed");
      return { lanes: health.enabledLanes().length, connections: plan.targets.length };
    }),
    inngest.createFunction(
      { id: "conn-token-health", triggers: [connHealthCheckRequested], retries: CONN_HEALTH_RETRIES, concurrency: CONN_HEALTH_CONCURRENCY, rateLimit: CONN_HEALTH_RATE_LIMIT },
      async ({ event, step }) => {
        // In a step, so the replay after step.sendEvent does not call the provider (or write the row) again.
        const result = await step.run("check", () => handleConnHealthCheck(health, event.data));
        const attention = await attentionEvents(event.data.laneId, event.data.connectionId, result.alerts, now());
        if (attention.length > 0) await step.sendEvent("attention", attention);
        if (attention.length > 0 && health.markReconnectNotified && result.alerts.some((a: AttentionAlert) => a.reason === "reconnect_required")) {
          const mark = health.markReconnectNotified;
          await step.run("mark-notified", () => mark(event.data.laneId, event.data.connectionId));
        }
        return { skipped: result.skipped, alerts: result.alerts.length };
      },
    ),
    inngest.createFunction({ id: "conn-subscriptions-renew-scan", triggers: [cron(CONN_RENEW_CRON)], retries: CONN_SCAN_RETRIES }, async ({ step }) => {
      const plan = await step.run("plan", async () => ({ ...(await planFanOut(renew)), stamp: now().toISOString().slice(0, 13) })); // per hour
      const stamp = plan.stamp;
      if (plan.targets.length > 0) {
        await step.sendEvent(
          "fan-out",
          plan.targets.map((t: { laneId: string; connectionId: string }) => connSubscriptionRenewRequested.create(t, { id: `renew:${t.laneId}:${t.connectionId}:${stamp}` })),
        );
      }
      if (plan.failedLanes.length > 0) throw new Error("conn.subscriptions_renew scan: a lane could not be listed");
      return { lanes: renew.enabledLanes().length, connections: plan.targets.length };
    }),
    inngest.createFunction(
      { id: "conn-subscriptions-renew", triggers: [connSubscriptionRenewRequested], retries: CONN_HEALTH_RETRIES, concurrency: CONN_RENEW_CONCURRENCY, rateLimit: CONN_HEALTH_RATE_LIMIT },
      async ({ event, step }) => {
        // In a step: a renewal changes provider-side state, so it must never run twice on replay.
        const result = await step.run("renew", () => handleConnRenew(renew, event.data));
        const attention = await attentionEvents(event.data.laneId, event.data.connectionId, result.alerts, now());
        if (attention.length > 0) await step.sendEvent("attention", attention);
        return { skipped: result.skipped, alerts: result.alerts.length };
      },
    ),
  ];
}
