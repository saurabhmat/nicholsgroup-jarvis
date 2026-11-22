// `@nichols/connectors/webhooks` (T-036): the receiver wired to the lane router (via the token-vault module, the only
// place that may name the job client), the Inngest sender and the provider registry. apps/web's
// /api/webhooks/[provider] route is a thin wrapper over `receiveWebhook`. Server-only.
import { getServerEnv } from "@nichols/core/env/server";
import { inngestAvailable, sendLaneEvent } from "@nichols/core/inngest";
import { microsoftSubscriptionStore, webhookStore } from "../vault/index";
import { createWebhookHandler } from "./handler";
import { createMicrosoftNotificationHandler } from "./microsoft";
import { WEBHOOK_PROVIDERS } from "./registry";

export { createWebhookHandler, MAX_EVENTS_PER_DELIVERY, MIN_SECRET_LENGTH, WEBHOOK_EVENT_NAME } from "./handler";
export type { WebhookDeps } from "./handler";
export { hmacSha256Verifier } from "./hmac";
export type { HmacVerifierOptions } from "./hmac";
export { hmacSha256, safeEqual, sha256Hex, withinTolerance } from "./crypto";
export { DEFAULT_MAX_BODY_BYTES, HARD_MAX_BODY_BYTES, mediaType, readRawBody } from "./body";
export { WEBHOOK_PROVIDERS } from "./registry";
export { createMicrosoftNotificationHandler, MICROSOFT_WEBHOOK_KEY } from "./microsoft";
export type { MicrosoftNotificationDeps } from "./microsoft";
export { WebhookStoreError } from "./store";
export type { ClaimResult, ResolveResult, WebhookStore } from "./store";
export type { ParseResult, VerifyInput, VerifyRefusal, VerifyResult, WebhookEvent, WebhookProvider, WebhookVerifier } from "./types";

export const receiveWebhook = createWebhookHandler({
  providers: WEBHOOK_PROVIDERS,
  store: webhookStore,
  enqueue: sendLaneEvent,
  jobsAvailable: () => getServerEnv().APP_ENV !== "preview" && inngestAvailable(),
});

/**
 * `POST /api/webhooks/microsoft` (T-068, T-264): Microsoft Graph change notifications. A dedicated handler beside the T-036 pipeline (Microsoft sends no signature: each subscription has its own
 * `clientState`, and the endpoint answers a validation handshake). The lane comes from the stored subscription, never from the request. See ./microsoft.ts.
 */
export const receiveMicrosoftNotification = createMicrosoftNotificationHandler({
  subscriptions: microsoftSubscriptionStore,
  store: webhookStore,
  lanes: () => getServerEnv().ENABLED_LANES,
  enqueue: sendLaneEvent,
  jobsAvailable: () => getServerEnv().APP_ENV !== "preview" && inngestAvailable(),
});
