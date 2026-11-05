// conn.token_health and conn.subscriptions_renew wired over the real stores (T-040). Server-only; the Inngest route
// imports from "@nichols/connectors/health".
//   - Health checkers: QuickBooks (read-only CompanyInfo call). Google has no `health` yet (the mail/calendar
//     connectors are provider interfaces), so its connections get the expiry rule only. Add checkers as providers land.
//   - Renewers: none. The renewal job is an interface; no provider creates or extends a subscription yet.
import { connectionLoader, tokenHealthStore as store } from "../vault/index";
import { quickbooksConnector } from "../quickbooks/index";
import { createSubscriptionRenewJob, createTokenHealthJob } from "./job";
import type { HealthChecker, SubscriptionRenewer } from "./types";

const checkers: Record<string, HealthChecker> = {
  quickbooks: (laneId, conn) => quickbooksConnector.health(laneId, conn as Parameters<typeof quickbooksConnector.health>[1]),
};
const renewers: Record<string, SubscriptionRenewer> = {};

export const tokenHealthJob = createTokenHealthJob({ loader: connectionLoader, store, checkers });
export const subscriptionRenewJob = createSubscriptionRenewJob({ loader: connectionLoader, store, renewers });

/** Ids for the daily scan. */
export const listHealthConnectionIds = (laneId: Parameters<typeof store.listUsableConnectionIds>[0]) => store.listUsableConnectionIds(laneId);
export const listRenewConnectionIds = (laneId: Parameters<typeof store.listUsableConnectionIds>[0]) =>
  store.listUsableConnectionIds(laneId, subscriptionRenewJob.providers());

export type { HealthJobOutcome, RenewJobOutcome, AttentionAlert } from "./types";
