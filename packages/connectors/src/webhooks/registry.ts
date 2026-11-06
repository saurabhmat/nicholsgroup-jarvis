// The registered webhook providers (T-036): URL segment -> provider. A provider that is not here answers 404.
// QuickBooks (T-053) is registered; Stripe (T-058), Gmail push (T-065) and monday add theirs.
import { QBO_WEBHOOK_KEY, quickbooksWebhookProvider } from "./quickbooks";
import type { WebhookProvider } from "./types";

export const WEBHOOK_PROVIDERS: Readonly<Record<string, WebhookProvider>> = {
  [QBO_WEBHOOK_KEY]: quickbooksWebhookProvider,
};
