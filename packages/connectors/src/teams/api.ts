// The Teams Graph READ client (T-279, spec 6): GET only, exact path templates (./constants.ts), every call for a named ACTOR. Same freshness rules as microsoft/api.ts:
//  - the call first takes its connection slot, and the guard runs INSIDE the slot (a refused call reads no token and sends no request), and again before every later attempt;
//  - a path or id that is not allowed is refused BEFORE the slot, the guard and any token read (templates are exact strings; ids match their format; no `/`, `\` or `%`);
//  - the access token is picked up per attempt from the Teams token manager; a 401 refreshes once and retries once;
//  - our own pacing per connection: 1 request/s for `/me/chats` and 1 request/s per chat for its messages (vendor facts A2), 4 requests/s for everything else; the shared client honours `Retry-After`;
//  - every failure leaves through the shared Graph error map and is recorded once, scrubbed, by the T-196 error log (a fixed message, never Microsoft's text).
// The actor is explicit: `{ kind: "user", userId }` for a page request (the guard checks that the row's owner is this user) or `{ kind: "service" }` for a job or a health check, which
// may read `/me` only: nothing of a person's chats is ever read without naming the person.
import { createHmac, randomBytes } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import { isProviderApiError, type ApiErrorSink } from "../error-log/sink";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { withMailboxSlot } from "../microsoft/concurrency";
import { mapGraphError } from "../microsoft/errors";
import type { TeamsGuard } from "./guard";
import { createTeamsHttp } from "./http";
import type { TeamsTokenManager } from "./token-manager";
import { TEAMS_IMAGE_MAX_CONCURRENT, TEAMS_IMAGE_MAX_WAIT_MS, TEAMS_CHAT_MESSAGES_RATE_LIMIT, TEAMS_CHATS_RATE_LIMIT, TEAMS_DEFAULT_RATE_LIMIT, TEAMS_GRAPH_BASE, TEAMS_MAX_CONCURRENT, TEAMS_PARAM_FORMATS, TEAMS_READ_ROUTES } from "./constants";

export type TeamsQuery = Record<string, string | number | boolean | null | undefined | readonly string[]>;
export type TeamsActor = { kind: "user"; userId: string } | { kind: "service" };

export type TeamsGetRequest = {
  /** One of the read templates, e.g. `/chats/{chatId}/messages`. */
  path: string;
  params?: Record<string, string>;
  query?: TeamsQuery;
  actor: TeamsActor;
  /**
   * `false`: no retry of any kind (not on 429, 5xx or a timeout). A page request sets it: the person gets "Teams is busy, try again in N seconds" at once instead of a wait inside the page,
   * and there can never be a retry storm (T-281, vendor facts A2). Default: the shared client's own retry with `Retry-After`.
   */
  retry?: boolean;
  /** Per attempt, in ms (default: the shared client's 30 s). A page read asks for less so a slow answer becomes "could not load" at once. */
  timeoutMs?: number;
  /** `"bytes"` (T-285, a hosted image): the body as raw bytes, cut at `maxBytes` while streaming. Only the hosted-content templates may ask for it. Default: JSON. */
  responseType?: "json" | "bytes";
  /** The largest body accepted (default: the shared client's 20 MB). Required with `"bytes"`. */
  maxBytes?: number;
  /** The caller's own cancellation (the browser closed the request): a waiting call leaves its place in the queue and the rate limit at once, and a running one stops. */
  signal?: AbortSignal;
};

/** What the guard approved for this call, handed back so a reader can tell the person's own messages and external members without a second read: the account's tenant and Entra object id. */
export type TeamsSelf = { readonly tenantId: string; readonly entraObjectId: string };
export type TeamsResponse<T> = ConnectorResponse<T> & { readonly self: TeamsSelf };

export interface TeamsApi {
  get<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsGetRequest): Promise<TeamsResponse<T>>;
}

export type TeamsApiDeps = {
  guard: TeamsGuard;
  tokens: TeamsTokenManager;
  logger?: ConnectorLogger;
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (fast backoff, injected sleep and clock). It can never replace the base URL. */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
  /** Test hook: the bounded wait of a picture (default TEAMS_IMAGE_MAX_WAIT_MS). */
  imageMaxWaitMs?: number;
};

const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The whole request is checked here, before the slot, the guard and any token read. Returns the lane feature the route needs. */
function assertRequest(req: TeamsGetRequest): import("@nichols/core/lane-config").TeamsFeature | null {
  if (typeof req !== "object" || req === null || typeof req.path !== "string" || !Object.hasOwn(TEAMS_READ_ROUTES, req.path)) throw refused("This Teams path is not allowed");
  const names = [...req.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
  const given = Object.keys(req.params ?? {});
  if (given.length !== names.length || names.some((n) => !given.includes(n))) throw refused("The request parameters are not valid");
  for (const n of names) {
    const v = req.params?.[n];
    const format = TEAMS_PARAM_FORMATS[n];
    // Ids are validated before any request: a chat or channel id is `19:...`, a team or user id a UUID; no separator, escape or dot segment can get through the format.
    if (typeof v !== "string" || format === undefined || !format.test(v)) throw refused("A path parameter is not valid");
  }
  if (req.timeoutMs !== undefined && !(Number.isInteger(req.timeoutMs) && req.timeoutMs >= 1000 && req.timeoutMs <= 30_000)) throw refused("The request timeout is not valid");
  if (req.responseType !== undefined && req.responseType !== "json" && req.responseType !== "bytes") throw refused("The response type is not valid");
  if (req.responseType === "bytes" && !req.path.endsWith("/hostedContents/{hostedId}/$value")) throw refused("Only a hosted content may be read as bytes");
  if (req.responseType === "bytes" ? !(Number.isInteger(req.maxBytes) && (req.maxBytes as number) >= 1024 && (req.maxBytes as number) <= 8 * 1024 * 1024) : req.maxBytes !== undefined) throw refused("The size limit is not valid");
  const actor = req.actor;
  if (actor?.kind === "user") {
    if (typeof actor.userId !== "string" || !USER_ID.test(actor.userId)) throw refused("A signed-in user is required");
  } else if (actor?.kind === "service") {
    // Jobs and health checks may read the signed-in account's own profile and nothing else.
    if (req.path !== "/me") throw refused("A job may read only the account's own profile");
  } else {
    throw refused("An actor is required");
  }
  // `GET /users/{userId}` is only for a call link: the one field it may ask for is the sign-in name.
  if (req.path === "/users/{userId}" && (req.query === undefined || req.query.$select !== "userPrincipalName" || Object.keys(req.query).length !== 1)) throw refused("Only the sign-in name may be read");
  return TEAMS_READ_ROUTES[req.path] ?? null;
}

/** A random key made when the process starts, never stored or shared: the pacing keys are per process, so an HMAC with it cannot be matched against a guessed chat id by anyone with log access (L3). */
const PACING_KEY = randomBytes(32);

/** The short keyed hash of a chat id used in the pacing key (exported for the test). */
export const chatPacingToken = (chatId: string): string => createHmac("sha256", PACING_KEY).update(chatId).digest("hex").slice(0, 12);

/** Our own bucket per route (see the header comment). */
function bucketFor(connectionId: string, req: TeamsGetRequest): { key: string; limit: { requests: number; perMs: number } } {
  if (req.path === "/me/chats") return { key: `${connectionId}:chats`, limit: TEAMS_CHATS_RATE_LIMIT };
  // The key is logged on every request line and kept in a process-wide map: a short keyed hash of the chat id, never the id itself (SL2).
  if (req.path === "/chats/{chatId}/messages") return { key: `${connectionId}:chat:${chatPacingToken(req.params?.chatId ?? "")}`, limit: TEAMS_CHAT_MESSAGES_RATE_LIMIT };
  // T-285: an inline image is paced per chat or channel in its OWN bucket (a message with several pictures does not delay the next page of messages or posts). This ASSUMES hosted contents are not
  // counted against the documented 1-per-second GET-messages limit; H-081 / H-084 confirm it (a 429 reaches the route as `rate_limited` and nothing is retried here).
  if (req.path === "/chats/{chatId}/messages/{messageId}/hostedContents/{hostedId}/$value") return { key: `${connectionId}:chatimg:${chatPacingToken(req.params?.chatId ?? "")}`, limit: TEAMS_CHAT_MESSAGES_RATE_LIMIT };
  if (req.path === "/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedId}/$value") return { key: `${connectionId}:chanimg:${chatPacingToken(req.params?.channelId ?? "")}`, limit: TEAMS_CHAT_MESSAGES_RATE_LIMIT };
  // T-291: a channel's posts and replies are paced per channel (1 request per channel per second, vendor facts A2)
  if (req.path.startsWith("/teams/{teamId}/channels/{channelId}/messages")) return { key: `${connectionId}:chan:${chatPacingToken(req.params?.channelId ?? "")}`, limit: TEAMS_CHAT_MESSAGES_RATE_LIMIT };
  return { key: connectionId, limit: TEAMS_DEFAULT_RATE_LIMIT };
}

export function createTeamsApi(deps: TeamsApiDeps): TeamsApi {
  const max = deps.maxConcurrent ?? TEAMS_MAX_CONCURRENT;
  return {
    async get<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsGetRequest) {
      const feature = assertRequest(req);
      assertLaneBound(laneId, conn);
      const requirement = { feature, ...(req.actor.kind === "user" ? { actorUserId: req.actor.userId.toLowerCase() } : {}) };
      // Pictures have their OWN small pool (so a page full of them never queues the person's other reads behind them) and a bounded wait for a slot plus the rate limit together: past it the call
      // ends as `rate_limited` at once. The wait is not part of the request's own timeout (`timeoutMs` covers one attempt, from sending the request to the last byte).
      const image = req.responseType === "bytes";
      const waitSignal = image ? AbortSignal.timeout(deps.imageMaxWaitMs ?? TEAMS_IMAGE_MAX_WAIT_MS) : undefined;
      const slotSignal = waitSignal ? (req.signal ? AbortSignal.any([req.signal, waitSignal]) : waitSignal) : req.signal;
      const slotKey = `${laneId}\u0000teams${image ? "img" : ""}\u0000${conn.id}`;
      const run = () => withMailboxSlot(slotKey, image ? TEAMS_IMAGE_MAX_CONCURRENT : max, async () => {
        const g = await deps.guard(laneId, conn, requirement); // decided inside the slot: after any wait for it
        const bucket = bucketFor(g.conn.id, req);
        const http: HttpClient = createTeamsHttp(
          { ...deps.httpOptions, baseUrl: TEAMS_GRAPH_BASE, laneId, connectionId: g.conn.id, rateLimitKey: bucket.key, rateLimit: bucket.limit, ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}), ...(req.maxBytes !== undefined ? { maxResponseBytes: req.maxBytes } : {}), ...(deps.logger ? { logger: deps.logger } : {}) },
          g.cloud,
          "read",
        );
        let fresh = true; // the first attempt uses the decision just made; every later attempt decides again
        let used: SecretValue | undefined;
        let credentialError: unknown;
        const request = (rejected?: SecretValue) =>
          http.request<T>({
            method: "GET",
            path: req.path,
            ...(req.params ? { params: req.params } : {}),
            ...(req.query ? { query: req.query } : {}),
            ...(req.retry === false ? { retry: false } : {}),
            ...(req.responseType === "bytes" ? { responseType: "bytes" as const } : {}),
            ...(req.signal ? { signal: req.signal } : {}),
            ...(waitSignal ? { waitSignal } : {}),
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
        const self: TeamsSelf = Object.freeze({ tenantId: g.tenantId, entraObjectId: g.entraObjectId });
        try {
          try {
            return { ...(await request()), self };
          } catch (e) {
            // 401 is `forbidden` with that status (HTTP client contract). Refresh once, retry once; a second 401 is final.
            if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used && credentialError === undefined) return { ...(await request(used)), self };
            throw e;
          }
        } catch (e) {
          if (!isConnectorError(e)) throw e;
          if (credentialError !== undefined) throw toConnectorError(credentialError);
          const mapped = toConnectorError(mapGraphError(e));
          // Content written by someone else (a hosted picture that is gone or not allowed) must not be able to add an error row on every view: a 403 or 404 of a picture is not recorded.
          const pictureGone = image && (mapped.info.http_status === 403 || mapped.info.http_status === 404);
          if (!pictureGone && isProviderApiError(mapped.toJSON())) await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      }, slotSignal);
      try {
        return await run();
      } catch (e) {
        // the wait for a slot ran out (the caller did not cancel): the same answer as a rate limit that ran out
        if (waitSignal?.aborted && !req.signal?.aborted && !isConnectorError(e)) throw new ConnectorError({ kind: "rate_limited", message: "Pictures are busy; try again in a moment", retry_after_seconds: 2 });
        throw e;
      }
    },
  };
}
