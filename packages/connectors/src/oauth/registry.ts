// OAuth providers available to the connect routes (T-035). Each provider task adds its adapter here (T-050 QuickBooks,
// T-063 Google, T-066 Microsoft, ...). Empty until then: every connect route answers 404.
import type { OAuthProvider } from "./flow";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [];
