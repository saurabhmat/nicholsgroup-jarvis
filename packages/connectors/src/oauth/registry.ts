// OAuth providers available to the connect routes (T-035). Each provider task adds its adapter here (T-050 QuickBooks,
// T-063 Google, T-066 Microsoft, ...). A slug that is not registered answers 404.
import { googleOAuthProvider } from "../google/index";
import { quickbooksOAuthProvider } from "../quickbooks/index";
import type { OAuthProvider } from "./flow";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [quickbooksOAuthProvider, googleOAuthProvider];
