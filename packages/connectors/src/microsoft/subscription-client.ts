// The Microsoft Graph SUBSCRIPTION client (T-068, T-264, spec §14): the only code that sends a request to `/subscriptions`. It is separate from the mail write client on purpose: that
// client's allow-list is exactly four message templates and a test pins it, so nothing about subscriptions can be added there. Subscriptions change provider-side state without
// moving data (accepted infrastructure under the T-062 review conditions, spec §3 rule 5): they are created, renewed and stopped only from jobs (microsoft/subscriptions.ts),
// the callback URL comes from server configuration only, and every subscription is recorded server-side. Importing this module is restricted (lint, `createGraphSubscriptionClient`)
// and a source test pins who may name it.
//
// Allow-list: exactly three method + path templates, compared as exact strings. A request that is not on the list is refused BEFORE the mailbox slot, the guard and any token read.
//   POST   /subscriptions        create a subscription (Graph validates the callback URL during this request: the receiver answers the validation token)
//   PATCH  /subscriptions/{id}   renew (`expirationDateTime` only)
//   DELETE /subscriptions/{id}   stop
// Allowed body keys per route, also refused before any token read: POST takes changeType, notificationUrl, lifecycleNotificationUrl, resource, expirationDateTime and clientState and
// NOTHING else, so `includeResourceData` (rich notifications, which would put mail content in a notification) can never be sent; PATCH takes `expirationDateTime`; DELETE takes no body.
// Never retried: every request goes out with `retry: false`, so a timeout, a 5xx or a network failure is NOT repeated by the HTTP client (a second POST could create a second
// subscription; the caller's next scan finds out what exists from our own records). A 401 means the request was not processed: the token is refreshed once and the request goes
// out once more. The guard runs inside the mailbox slot and again before the second attempt, before the token is read (same freshness rule as ./api.ts).
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import { isProviderApiError, type ApiErrorSink } from "../error-log/sink";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { withMailboxSlot } from "./concurrency";
import { GRAPH_COMMERCIAL_BASE, graphBucket, MAX_CONCURRENT_PER_MAILBOX } from "./constants";
import { mapGraphError } from "./errors";
import type { MicrosoftGuard } from "./guard";
import { createGraphHttp } from "./http";
import type { MicrosoftTokenManager } from "./token-manager";

/** The complete list of what this client can send. Nothing else is reachable. */
export const GRAPH_SUBSCRIPTION_ROUTES = Object.freeze([
  Object.freeze({ method: "POST", path: "/subscriptions" }),
  Object.freeze({ method: "PATCH", path: "/subscriptions/{id}" }),
  Object.freeze({ method: "DELETE", path: "/subscriptions/{id}" }),
] as const);

export type GraphSubscriptionRequest = {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, string>;
  /** A JSON object for POST and PATCH; absent for DELETE. */
  body?: Record<string, unknown>;
};

export type GraphSubscriptionClientDeps = {
  guard: MicrosoftGuard;
  tokens: MicrosoftTokenManager;
  logger?: ConnectorLogger;
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (injected sleep and clock). It can never replace the base URL or turn retries on. */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
};

export interface GraphSubscriptionClient {
  /** Sends one allow-listed request. Anything else is refused with `invalid_input` before a token is read. */
  request<T = unknown>(laneId: LaneId, conn: unknown, req: GraphSubscriptionRequest): Promise<ConnectorResponse<T>>;
}

/** Body keys allowed per "METHOD path" (an empty list = no body at all). */
export const GRAPH_SUBSCRIPTION_BODY_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "POST /subscriptions": Object.freeze(["changeType", "notificationUrl", "lifecycleNotificationUrl", "resource", "expirationDateTime", "clientState"]),
  "PATCH /subscriptions/{id}": Object.freeze(["expirationDateTime"]),
  "DELETE /subscriptions/{id}": Object.freeze([] as string[]),
});
const ID_PARAM = /^[A-Za-z0-9_=@.+:-]{1,256}$/;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** Whether method + path template is one of the three allowed routes (exact match). */
export const isAllowedGraphSubscription = (method: string, path: string): boolean => GRAPH_SUBSCRIPTION_ROUTES.some((r) => r.method === method && r.path === path);

function assertRequest(req: GraphSubscriptionRequest): void {
  if (typeof req !== "object" || req === null || !isAllowedGraphSubscription(String(req.method), String(req.path))) throw refused("This Microsoft subscription request is not allowed");
  const wanted = (req.path.match(/\{id\}/g) ?? []).length;
  const given = Object.keys(req.params ?? {});
  if (given.length !== wanted || (wanted === 1 && given[0] !== "id")) throw refused("The request parameters are not valid");
  for (const v of Object.values(req.params ?? {})) {
    if (typeof v !== "string" || !ID_PARAM.test(v) || v === "." || v === "..") throw refused("A path parameter contains a character that is not allowed");
  }
  const allowed = GRAPH_SUBSCRIPTION_BODY_KEYS[`${req.method} ${req.path}`] ?? [];
  if (req.method === "DELETE") {
    if (req.body !== undefined) throw refused("The request body is not valid");
    return;
  }
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw refused("The request body is not valid");
  if (Object.keys(req.body).some((k) => !allowed.includes(k))) throw refused("A field of the request body is not allowed");
}

export function createGraphSubscriptionClient(deps: GraphSubscriptionClientDeps): GraphSubscriptionClient {
  const max = deps.maxConcurrent ?? MAX_CONCURRENT_PER_MAILBOX;
  return {
    async request<T = unknown>(laneId: LaneId, conn: unknown, req: GraphSubscriptionRequest) {
      assertRequest(req); // before the slot, the guard and any token read
      assertLaneBound(laneId, conn);
      return withMailboxSlot(`${laneId}\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn);
        const bucket = graphBucket(g.conn.id, "write");
        const http: HttpClient = createGraphHttp(
          {
            ...deps.httpOptions,
            maxRetries: 0, // never a transport-level repeat
            baseUrl: GRAPH_COMMERCIAL_BASE,
            laneId,
            connectionId: g.conn.id,
            rateLimitKey: bucket.key,
            rateLimit: bucket.limit,
            ...(deps.logger ? { logger: deps.logger } : {}),
          },
          g.cloud,
          "subscriptions",
        );
        let fresh = true;
        let used: SecretValue | undefined;
        let credentialError: unknown;
        const send = (rejected?: SecretValue) =>
          http.request<T>({
            method: req.method,
            path: req.path,
            ...(req.params ? { params: req.params } : {}),
            ...(req.body ? { body: req.body } : {}),
            // A DELETE answers 204 with no body; the other two answer the subscription as JSON.
            ...(req.method === "DELETE" ? { responseType: "text" as const } : {}),
            retry: false, // never an automatic second POST, PATCH or DELETE
            auth: {
              scheme: "Bearer",
              secret: async () => {
                credentialError = undefined;
                try {
                  const approved = fresh ? g : await deps.guard(laneId, conn);
                  fresh = false;
                  used = await deps.tokens.accessToken(laneId, approved, rejected ? { rejected } : undefined);
                } catch (e) {
                  credentialError = e;
                  throw e;
                }
                return used;
              },
            },
          });
        try {
          try {
            return await send();
          } catch (e) {
            // A 401 means the request was not processed: refresh once and send once more.
            if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used && credentialError === undefined) return await send(used);
            throw e;
          }
        } catch (e) {
          if (!isConnectorError(e)) throw e;
          if (credentialError !== undefined) throw toConnectorError(credentialError);
          const mapped = toConnectorError(mapGraphError(e));
          // A 404 on a renewal or a stop means "already gone": the caller decides; it is not an API error worth a row in the error log.
          if (isProviderApiError(mapped.toJSON()) && !(mapped.info.http_status === 404 && req.method !== "POST")) await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      });
    },
  };
}
