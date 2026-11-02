// gohighlevel mocks (MSW). Base URLs below; handlers are added with the connector (T-059). Synthetic data only.
import type { RequestHandler } from "msw";

export const API = "https://services.leadconnectorhq.com";

/** Default handlers for this provider (none until its connector lands). */
export const handlers: RequestHandler[] = [];
