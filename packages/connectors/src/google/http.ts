// HTTP clients for Google hosts (T-063): the shared connector client with a host allowlist in front, so a base URL
// from data or config can never move a Google token to another host.
import type { LaneId } from "@nichols/core";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "../http/client";
import { ConnectorError } from "../contract/errors";
import { CALENDAR_PATHS, GOOGLE_HOSTS } from "./constants";
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

export function createGoogleHttp(options: Omit<HttpClientOptions, "provider" | "errorCode">, allowed: ReadonlySet<string> = GOOGLE_HOSTS): HttpClient {
  assertGoogleHost(options.baseUrl, allowed);
  const client = createHttpClient({ ...options, provider: "google", errorCode: googleErrorCode });
  // www.googleapis.com serves every Google API: through this client only the Calendar templates are reachable (T-064).
  if (new URL(options.baseUrl).hostname !== "www.googleapis.com") return client;
  return {
    request(req) {
      if (!CALENDAR_PATHS.has(req.path)) throw new ConnectorError({ kind: "invalid_input", message: "Path is not an allowed Calendar path" });
      return client.request(req);
    },
  };
}

export type GoogleHttpFor = (laneId: LaneId, connectionId: string | undefined, baseUrl: string) => HttpClient;
