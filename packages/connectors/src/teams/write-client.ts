// The Teams Graph WRITE client (T-279, spec 6; used by the approvals executor from T-286): the only code that sends a POST to Graph for Teams. It is BUILT only by the approvals wiring
// (`createTeamsWriteClient` is a restricted name: lint, and write-boundary.test.ts, which also proves that nothing in this task builds one), and nothing in the connector's own
// wiring does.
//
// Allow-list: exactly three POST templates, compared as exact strings, so no other route can be built (no PATCH, DELETE, `/setReaction`, `/softDelete`, `POST /chats`,
// `markChatReadForUser`, or anything else). A request that is not on the list is refused BEFORE the slot, the guard and any token read:
//   POST /chats/{chatId}/messages
//   POST /teams/{teamId}/channels/{channelId}/messages
//   POST /teams/{teamId}/channels/{channelId}/messages/{messageId}/replies
// The body has ONE key, `body`, with `contentType: "text"` and `content` (1 to 80 KB): no mentions, images, attachments or HTML. Never retried: a POST goes out with `retry: false`
// and no transport retry, because Microsoft has no idempotency key and a repeat after a timeout can post twice (vendor facts A2); an ambiguous outcome is settled by the writer's lookup.
// A 401 means the request was not processed: the token is refreshed once and the request goes out once more. The guard runs inside the slot with the feature the route needs and with
// the row's owner required to be the person who sent it, and again before the second attempt after a 401.
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import { isProviderApiError, type ApiErrorSink } from "../error-log/sink";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { withMailboxSlot } from "../microsoft/concurrency";
import { mapGraphError } from "../microsoft/errors";
import { TEAMS_GRAPH_BASE, TEAMS_SEND_RATE_LIMIT, TEAMS_MAX_CONCURRENT, TEAMS_MAX_TEXT_BYTES, TEAMS_PARAM_FORMATS, TEAMS_WRITE_ROUTES } from "./constants";
import type { TeamsGuard } from "./guard";
import { createTeamsHttp } from "./http";
import type { TeamsTokenManager } from "./token-manager";

export type TeamsWriteRequest = {
  /** One of the three send templates. */
  path: string;
  params: Record<string, string>;
  /** The portal user who pressed Send: the connection's owner must be this user. */
  actorUserId: string;
  body: { body: { contentType: "text"; content: string } };
};

export type TeamsWriteClientDeps = {
  guard: TeamsGuard;
  tokens: TeamsTokenManager;
  logger?: ConnectorLogger;
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (injected sleep and clock). It can never replace the base URL or turn retries on. */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
};

export interface TeamsWriteClient {
  /** Sends one allow-listed POST. Anything else is refused with `invalid_input` before a token is read. */
  post<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsWriteRequest): Promise<ConnectorResponse<T>>;
}

const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No control characters except newline and tab (spec 10.1).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

function assertRequest(req: TeamsWriteRequest): import("@nichols/core/lane-config").TeamsFeature {
  if (typeof req !== "object" || req === null || typeof req.path !== "string" || !Object.hasOwn(TEAMS_WRITE_ROUTES, req.path)) throw refused("This Teams write is not allowed");
  const names = [...req.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
  const given = Object.keys(req.params ?? {});
  if (given.length !== names.length || names.some((n) => !given.includes(n))) throw refused("The request parameters are not valid");
  for (const n of names) {
    const v = req.params[n];
    const format = TEAMS_PARAM_FORMATS[n];
    if (typeof v !== "string" || format === undefined || !format.test(v)) throw refused("A path parameter is not valid");
  }
  if (typeof req.actorUserId !== "string" || !USER_ID.test(req.actorUserId)) throw refused("A signed-in user is required");
  const b = req.body as unknown;
  if (typeof b !== "object" || b === null || Array.isArray(b) || Object.keys(b).length !== 1 || !("body" in b)) throw refused("The request body is not valid");
  const inner = (b as { body: unknown }).body;
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) throw refused("The request body is not valid");
  const keys = Object.keys(inner).sort().join(",");
  const { contentType, content } = inner as { contentType?: unknown; content?: unknown };
  if (keys !== "content,contentType" || contentType !== "text" || typeof content !== "string" || content.length === 0 || CONTROL.test(content) || Buffer.byteLength(content, "utf8") > TEAMS_MAX_TEXT_BYTES) {
    throw refused("The message is not valid");
  }
  return TEAMS_WRITE_ROUTES[req.path] as import("@nichols/core/lane-config").TeamsFeature;
}

export function createTeamsWriteClient(deps: TeamsWriteClientDeps): TeamsWriteClient {
  const max = deps.maxConcurrent ?? TEAMS_MAX_CONCURRENT;
  return {
    async post<T = unknown>(laneId: LaneId, conn: unknown, req: TeamsWriteRequest) {
      const feature = assertRequest(req); // before the slot, the guard and any token read
      assertLaneBound(laneId, conn);
      const requirement = { feature, actorUserId: req.actorUserId.toLowerCase() };
      return withMailboxSlot(`${laneId}\u0000teams\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn, requirement);
        const http: HttpClient = createTeamsHttp(
          {
            ...deps.httpOptions,
            maxRetries: 0, // never a transport-level repeat of a write
            baseUrl: TEAMS_GRAPH_BASE,
            laneId,
            connectionId: g.conn.id,
            rateLimitKey: `${g.conn.id}:write`,
            rateLimit: TEAMS_SEND_RATE_LIMIT, // 1 per second per connection (the per-user POST limit); pacing only
            ...(deps.logger ? { logger: deps.logger } : {}),
          },
          g.cloud,
          "write",
        );
        let fresh = true;
        let used: SecretValue | undefined;
        let credentialError: unknown;
        const send = (rejected?: SecretValue) =>
          http.request<T>({
            method: "POST",
            path: req.path,
            params: req.params,
            body: req.body,
            retry: false, // never an automatic second POST
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
          // A credential or Vault failure happens BEFORE any request leaves: nothing was sent. It is never reported as a transport failure (which would read as an unknown outcome).
          if (credentialError !== undefined) {
            const c = toConnectorError(credentialError);
            throw ["reconnect_required", "connection_unavailable", "forbidden", "not_found", "invalid_input", "lane_mismatch", "unsupported_op"].includes(c.info.kind)
              ? c
              : new ConnectorError({ kind: "connection_unavailable", message: "The Teams credential could not be read; nothing was sent" });
          }
          const mapped = toConnectorError(mapGraphError(e));
          if (isProviderApiError(mapped.toJSON())) await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      });
    },
  };
}
