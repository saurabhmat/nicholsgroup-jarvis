// The Teams Graph SUBSCRIPTION client (T-289, spec 9.1; the pattern of microsoft/subscription-client.ts, T-068): the only code that sends a request to `/subscriptions` for a Teams connection. It is
// separate from the Teams WRITE client on purpose (that client's allow-list is exactly three message POST templates and write-boundary.test.ts pins it) and separate from the Teams READ client
// (GET only). Subscriptions change provider-side state without moving data (accepted infrastructure, spec 3 rule 5, the same conditions as the mail ones): they are created, renewed and
// stopped only from jobs (./subscriptions.ts), the callback URL comes from server configuration only, and every subscription is recorded server-side. Importing this module is restricted (lint:
// `createTeamsSubscriptionClient`) and a source test pins who may name it.
//
// Allow-list: exactly three method + path templates, compared as exact strings. A request that is not on the list is refused BEFORE the slot, the guard and any token read.
//   POST   /subscriptions        create a subscription (Graph validates the callback URL during this request: the receiver answers the validation token)
//   PATCH  /subscriptions/{id}   renew (`expirationDateTime` only)
//   DELETE /subscriptions/{id}   stop
// Allowed body keys per route, also refused before any token read: POST takes changeType, notificationUrl, lifecycleNotificationUrl, resource, expirationDateTime and clientState and NOTHING
// else, so `includeResourceData` (a notification that carries the message) can never be sent; PATCH takes `expirationDateTime`; DELETE takes no body. The POST's `changeType` must be exactly
// `created`, and its `resource` must be the person's all-chats resource (`users/<uuid>/chats/getAllMessages`): no per-chat resource, no `updated`, no `deleted`.
// Never retried: every request goes out with `retry: false`, so a timeout, a 5xx or a network failure is NOT repeated by the HTTP client (a second POST could create a second subscription,
// and only 10 all-chats subscriptions per user are allowed; the next scan finds out what exists from our own records). A 401 means the request was not processed: the token is refreshed once and
// the request goes out once more. The guard runs inside the slot with the feature `chat_read` and again before the second attempt, before the token is read.
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import { isProviderApiError, type ApiErrorSink } from "../error-log/sink";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { withMailboxSlot } from "../microsoft/concurrency";
import { mapGraphError } from "../microsoft/errors";
import { isTeamsSubscriptionRoute, TEAMS_DEFAULT_RATE_LIMIT, TEAMS_GRAPH_BASE, TEAMS_MAX_CONCURRENT, TEAMS_SUBSCRIPTION_CHANGE_TYPES } from "./constants";
import type { TeamsGuard } from "./guard";
import { createTeamsHttp } from "./http";
import type { TeamsTokenManager } from "./token-manager";

export type TeamsSubscriptionRequest = {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, string>;
  /** A JSON object for POST and PATCH; absent for DELETE. */
  body?: Record<string, unknown>;
};

export type TeamsSubscriptionClientDeps = {
  guard: TeamsGuard;
  tokens: TeamsTokenManager;
  logger?: ConnectorLogger;
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (injected sleep and clock). It can never replace the base URL or turn retries on. */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
};

export interface TeamsSubscriptionClient {
  /** Sends one allow-listed request. Anything else is refused with `invalid_input` before a token is read. */
  request<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsSubscriptionRequest): Promise<ConnectorResponse<T>>;
}

/** Body keys allowed per "METHOD path" (an empty list = no body at all). */
export const TEAMS_SUBSCRIPTION_BODY_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "POST /subscriptions": Object.freeze(["changeType", "notificationUrl", "lifecycleNotificationUrl", "resource", "expirationDateTime", "clientState"]),
  "PATCH /subscriptions/{id}": Object.freeze(["expirationDateTime"]),
  "DELETE /subscriptions/{id}": Object.freeze([] as string[]),
});
const ID_PARAM = /^[A-Za-z0-9_=@.+:-]{1,256}$/;
/** The only resource a POST may name: one person's all chats (lower-case Entra object id). */
const ALL_CHATS_RESOURCE = /^users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/chats\/getAllMessages$/;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

function assertRequest(req: TeamsSubscriptionRequest): void {
  if (typeof req !== "object" || req === null || !isTeamsSubscriptionRoute(String(req.method), String(req.path))) throw refused("This Teams subscription request is not allowed");
  const wanted = (req.path.match(/\{id\}/g) ?? []).length;
  const given = Object.keys(req.params ?? {});
  if (given.length !== wanted || (wanted === 1 && given[0] !== "id")) throw refused("The request parameters are not valid");
  for (const v of Object.values(req.params ?? {})) {
    if (typeof v !== "string" || !ID_PARAM.test(v) || v === "." || v === "..") throw refused("A path parameter contains a character that is not allowed");
  }
  const allowed = TEAMS_SUBSCRIPTION_BODY_KEYS[`${req.method} ${req.path}`] ?? [];
  if (req.method === "DELETE") {
    if (req.body !== undefined) throw refused("The request body is not valid");
    return;
  }
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw refused("The request body is not valid");
  if (Object.keys(req.body).some((k) => !allowed.includes(k))) throw refused("A field of the request body is not allowed");
  if (req.method === "POST") {
    // a POST is always complete, and always the same kind of subscription: created only, the person's all chats
    if (allowed.some((k) => !(k in (req.body as object)))) throw refused("The request body is not valid");
    if (req.body.changeType !== TEAMS_SUBSCRIPTION_CHANGE_TYPES) throw refused("Only created notifications may be requested");
    if (typeof req.body.resource !== "string" || !ALL_CHATS_RESOURCE.test(req.body.resource)) throw refused("Only a person's all-chats resource may be subscribed to");
  }
}

export function createTeamsSubscriptionClient(deps: TeamsSubscriptionClientDeps): TeamsSubscriptionClient {
  const max = deps.maxConcurrent ?? TEAMS_MAX_CONCURRENT;
  return {
    async request<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsSubscriptionRequest) {
      assertRequest(req); // before the slot, the guard and any token read
      assertLaneBound(laneId, conn);
      // a job asks for no person: the connection must be a usable Teams connection whose lane and connection both have `chat_read`
      const requirement = { feature: "chat_read" as const };
      return withMailboxSlot(`${laneId}\u0000teams\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn, requirement);
        const http: HttpClient = createTeamsHttp(
          {
            ...deps.httpOptions,
            maxRetries: 0, // never a transport-level repeat
            baseUrl: TEAMS_GRAPH_BASE,
            laneId,
            connectionId: g.conn.id,
            rateLimitKey: `${g.conn.id}:subscriptions`,
            rateLimit: TEAMS_DEFAULT_RATE_LIMIT,
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
                  const approved = fresh ? g : await deps.guard(laneId, conn, requirement);
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
