// google mocks (MSW). Base URLs below; handlers are added with the connector (T-063 – T-065). Synthetic data only.
import type { RequestHandler } from "msw";

export const GMAIL = "https://gmail.googleapis.com";
export const CALENDAR = "https://www.googleapis.com/calendar/v3";
export const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

/** Default handlers for this provider (none until its connector lands). */
export const handlers: RequestHandler[] = [];
