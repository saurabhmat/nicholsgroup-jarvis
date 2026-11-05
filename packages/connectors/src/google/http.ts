// HTTP clients for Google hosts (T-063): the shared connector client with a host allowlist in front, so a base URL
// from data or config can never move a Google token to another host.
import type { LaneId } from "@nichols/core";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "../http/client";
import { GOOGLE_HOSTS } from "./constants";
import { assertGoogleHost } from "./guard";

/**
 * Google error bodies: OAuth `{ error: "invalid_grant", error_description }` or API
 * `{ error: { code, message, status, errors: [{ reason }] } }`. Only a short code is kept, never the message.
 */
export function googleErrorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; errors?: { reason?: unknown }[] };
    const reason = e.errors?.[0]?.reason;
    if (typeof reason === "string") return reason;
    if (typeof e.status === "string") return e.status;
  }
  return undefined;
}

export function createGoogleHttp(options: Omit<HttpClientOptions, "provider" | "errorCode">): HttpClient {
  assertGoogleHost(options.baseUrl, GOOGLE_HOSTS);
  return createHttpClient({ ...options, provider: "google", errorCode: googleErrorCode });
}

export type GoogleHttpFor = (laneId: LaneId, connectionId: string | undefined, baseUrl: string) => HttpClient;
