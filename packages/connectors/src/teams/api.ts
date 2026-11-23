// The Teams Graph READ client (T-279, spec 6): GET only, exact path templates (./constants.ts), every call for a named ACTOR. Same freshness rules as microsoft/api.ts:
//  - the call first takes its connection slot, and the guard runs INSIDE the slot (a refused call reads no token and sends no request), and again before every later attempt;
//  - a path or id that is not allowed is refused BEFORE the slot, the guard and any token read (templates are exact strings; ids match their format; no `/`, `\` or `%`);
//  - the access token is picked up per attempt from the Teams token manager; a 401 refreshes once and retries once;
//  - our own pacing per connection: 1 request/s for `/me/chats` and 1 request/s per chat for its messages (vendor facts A2), 4 requests/s for everything else; the shared client honours `Retry-After`;
//  - every failure leaves through the shared Graph error map and is recorded once, scrubbed, by the T-196 error log (a fixed message, never Microsoft's text).
// The actor is explicit: `{ kind: "user", userId }` for a page request (the guard checks that the row's owner is this user) or `{ kind: "service" }` for a job or a health check, which
// may read `/me` only: nothing of a person's chats is ever read without naming the person.
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
import { TEAMS_CHAT_MESSAGES_RATE_LIMIT, TEAMS_CHATS_RATE_LIMIT, TEAMS_DEFAULT_RATE_LIMIT, TEAMS_GRAPH_BASE, TEAMS_MAX_CONCURRENT, TEAMS_PARAM_FORMATS, TEAMS_READ_ROUTES } from "./constants";

export type TeamsQuery = Record<string, string | number | boolean | null | undefined | readonly string[]>;
export type TeamsActor = { kind: "user"; userId: string } | { kind: "service" };

export type TeamsGetRequest = {
  /** One of the read templates, e.g. `/chats/{chatId}/messages`. */
  path: string;
  params?: Record<string, string>;
  query?: TeamsQuery;
  actor: TeamsActor;
};

export interface TeamsApi {
  get<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsGetRequest): Promise<ConnectorResponse<T>>;
}

export type TeamsApiDeps = {
  guard: TeamsGuard;
  tokens: TeamsTokenManager;
  logger?: ConnectorLogger;
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (fast backoff, injected sleep and clock). It can never replace the base URL. */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
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

/** Our own bucket per route (see the header comment). */
function bucketFor(connectionId: string, req: TeamsGetRequest): { key: string; limit: { requests: number; perMs: number } } {
  if (req.path === "/me/chats") return { key: `${connectionId}:chats`, limit: TEAMS_CHATS_RATE_LIMIT };
  if (req.path === "/chats/{chatId}/messages") return { key: `${connectionId}:chat:${req.params?.chatId ?? ""}`, limit: TEAMS_CHAT_MESSAGES_RATE_LIMIT };
  return { key: connectionId, limit: TEAMS_DEFAULT_RATE_LIMIT };
}

export function createTeamsApi(deps: TeamsApiDeps): TeamsApi {
  const max = deps.maxConcurrent ?? TEAMS_MAX_CONCURRENT;
  return {
    async get<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsGetRequest) {
      const feature = assertRequest(req);
      assertLaneBound(laneId, conn);
      const requirement = { feature, ...(req.actor.kind === "user" ? { actorUserId: req.actor.userId.toLowerCase() } : {}) };
      return withMailboxSlot(`${laneId}\u0000teams\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn, requirement); // decided inside the slot: after any wait for it
        const bucket = bucketFor(g.conn.id, req);
        const http: HttpClient = createTeamsHttp(
          { ...deps.httpOptions, baseUrl: TEAMS_GRAPH_BASE, laneId, connectionId: g.conn.id, rateLimitKey: bucket.key, rateLimit: bucket.limit, ...(deps.logger ? { logger: deps.logger } : {}) },
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
            return await request();
          } catch (e) {
            // 401 is `forbidden` with that status (HTTP client contract). Refresh once, retry once; a second 401 is final.
            if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used && credentialError === undefined) return await request(used);
            throw e;
          }
        } catch (e) {
          if (!isConnectorError(e)) throw e;
          if (credentialError !== undefined) throw toConnectorError(credentialError);
          const mapped = toConnectorError(mapGraphError(e));
          if (isProviderApiError(mapped.toJSON())) await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      });
    },
  };
}
