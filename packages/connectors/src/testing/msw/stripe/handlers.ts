// stripe mocks (MSW). Base URLs below; handlers are added with the connector (T-054, T-058). Synthetic data only.
import type { RequestHandler } from "msw";

export const API = "https://api.stripe.com";

/** Default handlers for this provider (none until its connector lands). */
export const handlers: RequestHandler[] = [];
