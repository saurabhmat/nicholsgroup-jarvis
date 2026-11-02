// quickbooks mocks (MSW). Base URLs below; handlers are added with the connector (T-050 – T-053). Synthetic data only.
import type { RequestHandler } from "msw";

export const API_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
export const API_PRODUCTION = "https://quickbooks.api.intuit.com";
export const OAUTH_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

/** Default handlers for this provider (none until its connector lands). */
export const handlers: RequestHandler[] = [];
