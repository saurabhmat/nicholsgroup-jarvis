// The Microsoft Graph WRITE client (T-262, spec §10): the only code that sends a POST or PATCH to Graph. Exported through the connectors write subpath only
// (rule 5: nothing writes to an external system except packages/modules/approvals; a source test enforces it).
//
// Allow-list: exactly four method + path templates, compared as exact strings, so no other route can be built (no DELETE, move, copy, forward, rules, settings,
// attachments, sendMail or any other path). A request that is not on the list is refused BEFORE the mailbox slot, the guard and any token read.
//   POST  /me/messages                       create a draft (a new message)
//   POST  /me/messages/{id}/createReply      create a reply draft in the conversation of message {id}
//   PATCH /me/messages/{id}                  update a draft this action created (the writer proves it: the id came from its own create in this run)
//   POST  /me/messages/{id}/send             send a draft
// Never retried: POST and PATCH go out with `retry: false`, so a timeout, a 5xx or a network failure is NOT repeated by the HTTP client (a second send must never
// happen); an ambiguous failure is resolved by the writer's marker lookup. A 401 means the request was not processed: the token is refreshed once and the request
// goes out once more. Every request carries `Prefer: IdType="ImmutableId"` (the ids of the synced rows are immutable ids). The guard runs inside the mailbox
// slot, and again before the second attempt after a 401, before the token is read (same freshness rule as ./api.ts).
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
export const GRAPH_WRITE_ROUTES = Object.freeze([
  Object.freeze({ method: "POST", path: "/me/messages" }),
  Object.freeze({ method: "POST", path: "/me/messages/{id}/createReply" }),
  Object.freeze({ method: "PATCH", path: "/me/messages/{id}" }),
  Object.freeze({ method: "POST", path: "/me/messages/{id}/send" }),
] as const);

export type GraphWriteRequest = {
  method: "POST" | "PATCH";
  path: string;
  params?: Record<string, string>;
  /** A JSON object (never a string or a form). */
  body: Record<string, unknown>;
};

export type GraphWriteClientDeps = {
  guard: MicrosoftGuard;
  tokens: MicrosoftTokenManager;
  logger?: ConnectorLogger;
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (injected sleep and clock). It can never replace the base URL or turn retries on. */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
};

export interface GraphWriteClient {
  /** Sends one allow-listed request. Anything else is refused with `invalid_input` before a token is read. */
  request<T = unknown>(laneId: LaneId, conn: unknown, req: GraphWriteRequest): Promise<ConnectorResponse<T>>;
}

const ID_PARAM = /^[A-Za-z0-9_=@.+:-]{1,512}$/;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** Whether method + path template is one of the four allowed routes (exact match). */
export const isAllowedGraphWrite = (method: string, path: string): boolean => GRAPH_WRITE_ROUTES.some((r) => r.method === method && r.path === path);

function assertRequest(req: GraphWriteRequest): void {
  if (typeof req !== "object" || req === null || !isAllowedGraphWrite(String(req.method), String(req.path))) throw refused("This Microsoft write is not allowed");
  const wanted = (req.path.match(/\{id\}/g) ?? []).length;
  const given = Object.keys(req.params ?? {});
  if (given.length !== wanted || (wanted === 1 && given[0] !== "id")) throw refused("The request parameters are not valid");
  for (const v of Object.values(req.params ?? {})) {
    if (typeof v !== "string" || !ID_PARAM.test(v) || v === "." || v === "..") throw refused("A path parameter contains a character that is not allowed");
  }
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw refused("The request body is not valid");
}

export function createGraphWriteClient(deps: GraphWriteClientDeps): GraphWriteClient {
  const max = deps.maxConcurrent ?? MAX_CONCURRENT_PER_MAILBOX;
  return {
    async request<T = unknown>(laneId: LaneId, conn: unknown, req: GraphWriteRequest) {
      assertRequest(req); // before the slot, the guard and any token read
      assertLaneBound(laneId, conn);
      return withMailboxSlot(`${laneId}\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn);
        const bucket = graphBucket(g.conn.id, "write");
        const http: HttpClient = createGraphHttp(
          {
            ...deps.httpOptions,
            maxRetries: 0, // never a transport-level repeat of a write
            baseUrl: GRAPH_COMMERCIAL_BASE,
            laneId,
            connectionId: g.conn.id,
            rateLimitKey: bucket.key,
            rateLimit: bucket.limit,
            ...(deps.logger ? { logger: deps.logger } : {}),
          },
          g.cloud,
          "api",
        );
        let fresh = true;
        let used: SecretValue | undefined;
        let credentialError: unknown;
        const send = (rejected?: SecretValue) =>
          http.request<T>({
            method: req.method,
            path: req.path,
            ...(req.params ? { params: req.params } : {}),
            headers: { Prefer: 'IdType="ImmutableId"' },
            body: req.body,
            retry: false, // never an automatic second POST or PATCH
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
          if (isProviderApiError(mapped.toJSON())) await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      });
    },
  };
}
