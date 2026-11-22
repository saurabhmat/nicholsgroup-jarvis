// HTTP clients for Microsoft hosts (T-256): the shared connector client with a per-cloud host allow-list in front, so a base URL
// from data or config can never move a Microsoft token to another host, and (on the Graph host) only `/me/...` is reachable.
// The host check runs when the client is built, before any token is read or request is made. `gcc_high` has no hosts yet (T-267).
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "../http/client";
import { GRAPH_REQUEST_ID_HEADER, isGraphPath, isSubscriptionsPath, microsoftHostsFor, type MicrosoftCloud } from "./constants";
import { assertGraphHost } from "./guard";

/**
 * Microsoft error bodies: the OAuth token endpoint answers `{ error: "invalid_grant", error_description, error_codes: [70008] }` and
 * Graph answers `{ error: { code: "InvalidAuthenticationToken", message, innerError } }`. Only a short code is kept, never a
 * message or description (they can echo names and addresses). The OAuth `error` string decides (V-7); `error_codes` (AADSTS) are not used.
 */
export function graphErrorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export type GraphHttpFor = (laneId: LaneId, connectionId: string | undefined, baseUrl: string) => HttpClient;

/**
 * `kind: "api"` is Graph (base `https://graph.microsoft.com/v1.0`, only `/me/...` paths); `kind: "subscriptions"` is the same Graph host with
 * ONLY the two subscription path templates (T-068: `/subscriptions` and `/subscriptions/{id}`; never `/me/...`); `kind: "token"` is the sign-in host of the
 * same cloud (token endpoint). Throws `invalid_input` for any other host, and for every host of a cloud this build does not serve.
 */
export function createGraphHttp(options: Omit<HttpClientOptions, "provider" | "errorCode">, cloud: MicrosoftCloud, kind: "api" | "token" | "subscriptions"): HttpClient {
  assertGraphHost(options.baseUrl, microsoftHostsFor(cloud, kind === "token" ? "token" : "api"));
  const client = createHttpClient({ ...options, provider: "microsoft", requestIdHeader: GRAPH_REQUEST_ID_HEADER, errorCode: graphErrorCode });
  if (kind === "token") return client;
  const allowed = kind === "subscriptions" ? isSubscriptionsPath : isGraphPath;
  return {
    request(req) {
      if (!allowed(req.path)) throw new ConnectorError({ kind: "invalid_input", message: "Path is not an allowed Graph path" });
      return client.request(req);
    },
  };
}
