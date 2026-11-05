// microsoft mocks (MSW). Base URLs below; handlers are added with the connector (T-066 – T-068). Synthetic data only.
import type { RequestHandler } from "msw";

export const GRAPH = "https://graph.microsoft.com";
export const OAUTH_TOKEN_TEMPLATE = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token";

/** Default handlers for this provider (none until its connector lands). */
export const handlers: RequestHandler[] = [];
