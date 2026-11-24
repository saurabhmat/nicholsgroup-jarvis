// conn.token_health and conn.subscriptions_renew wired over the real stores (T-040). Server-only; the Inngest route
// imports from "@nichols/connectors/health".
//   - Health checkers: QuickBooks (read-only CompanyInfo call), Microsoft (read-only `GET /me`, T-256), Teams (read-only `GET /me` through the Teams app, T-279). Google has no `health` yet (the mail/calendar
//     connectors are provider interfaces), so its connections get the expiry rule only. Add checkers as providers land.
//   - Renewers: Microsoft (T-068, T-264): ensures the connection's change-notification subscriptions (create when missing, renew within 24 hours of expiry, recreate when gone;
//     stops them when the provider is paused). Teams (T-289): the same for the one all-chats subscription of a Teams connection (stops locally when Teams or chat reading is paused, the owner lost own_mail,
//     or Microsoft's lifetime is under 26 hours). Google has none (Gmail watch is T-065, not built).
import { connectionLoader, tokenHealthStore as store } from "../vault/index";
import { microsoftHealth, microsoftHealthSkip, microsoftSubscriptionRenewer } from "../microsoft/index";
import { quickbooksConnector } from "../quickbooks/index";
import { teamsHealth, teamsHealthSkip, teamsSubscriptionRenewer } from "../teams/index";
import { createSubscriptionRenewJob, createTokenHealthJob } from "./job";
import type { HealthChecker, SubscriptionRenewer } from "./types";

const checkers: Record<string, HealthChecker> = {
  microsoft: microsoftHealth,
  microsoft_teams: teamsHealth,
  quickbooks: (laneId, conn) => quickbooksConnector.health(laneId, conn as Parameters<typeof quickbooksConnector.health>[1]),
};
const renewers: Record<string, SubscriptionRenewer> = { microsoft: microsoftSubscriptionRenewer, microsoft_teams: teamsSubscriptionRenewer };

export const tokenHealthJob = createTokenHealthJob({ loader: connectionLoader, store, checkers, skips: { microsoft: microsoftHealthSkip, microsoft_teams: teamsHealthSkip } });
export const subscriptionRenewJob = createSubscriptionRenewJob({ loader: connectionLoader, store, renewers });

/** Marks a reconnect_required connection's admin notice as sent, after the scan's event went out (T-195). */
export async function markReconnectNotified(laneId: Parameters<typeof store.listUsableConnectionIds>[0], connectionId: string): Promise<void> {
  await store.markReconnectNotified(laneId, await connectionLoader.loadConnection(laneId, connectionId));
}

/** Ids for the daily scan. */
export const listHealthConnectionIds = (laneId: Parameters<typeof store.listUsableConnectionIds>[0]) => store.listUsableConnectionIds(laneId);
export const listRenewConnectionIds = (laneId: Parameters<typeof store.listUsableConnectionIds>[0]) =>
  store.listUsableConnectionIds(laneId, subscriptionRenewJob.providers());

export type { HealthJobOutcome, RenewJobOutcome, AttentionAlert } from "./types";
