// monday mocks (MSW). Base URLs below; handlers are added with the connector (T-070). Synthetic data only.
import type { RequestHandler } from "msw";

export const API = "https://api.monday.com/v2";

/** Default handlers for this provider (none until its connector lands). */
export const handlers: RequestHandler[] = [];
