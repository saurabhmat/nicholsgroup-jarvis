// The registered webhook providers (T-036): URL segment -> provider. Empty until a provider's task adds its entry
// (T-053 QuickBooks, T-058 Stripe, T-065 Gmail push, monday). A provider that is not here answers 404.
import type { WebhookProvider } from "./types";

export const WEBHOOK_PROVIDERS: Readonly<Record<string, WebhookProvider>> = {};
