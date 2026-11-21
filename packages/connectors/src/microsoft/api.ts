// The Microsoft Graph client (T-256): read-only by construction. It exposes GET only (writes arrive with T-262, in their own `:write`
// rate bucket, see `graphBucket`). Every call runs the guard FIRST (no token read and no request for a refused call), then:
//  - the host is checked when the HTTP client is built (graph.microsoft.com for a `commercial` connection; `gcc_high` has none yet);
//  - at most MAX_CONCURRENT_PER_MAILBOX requests are in flight per connection (our own cap; a mailbox that is being throttled
//    only holds back its own queue, never another connection or tenant);
//  - a per-connection rate bucket paces calls, and the shared client honours 429/503 `Retry-After`;
//  - the access token is picked up per attempt from the token manager; a 401 refreshes once and retries once;
//  - every failure leaves through the error map (./errors.ts) and is recorded once with scrubbed fields by the T-196 error log
//    (the fixed message, never Microsoft's text). Token-endpoint failures are not API errors: they pass through as thrown.
import type { LaneId } from "@nichols/core";
import { isConnectorError, toConnectorError } from "../contract/errors";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import type { ApiErrorSink } from "../error-log/sink";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { withMailboxSlot } from "./concurrency";
import { GRAPH_COMMERCIAL_BASE, graphBucket, MAX_CONCURRENT_PER_MAILBOX } from "./constants";
import { mapGraphError } from "./errors";
import type { GuardedMicrosoftConnection, MicrosoftGuard } from "./guard";
import { createGraphHttp } from "./http";
import type { MicrosoftTokenManager } from "./token-manager";

export type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>;

export type GraphApiDeps = {
  guard: MicrosoftGuard;
  tokens: MicrosoftTokenManager;
  logger?: ConnectorLogger;
  /** Records every Graph API error once, after the error map (T-196). Never throws. */
  errors?: ApiErrorSink;
  /** Test hook: extra HTTP client options (fast backoff, injected sleep). */
  httpOptions?: Partial<HttpClientOptions>;
  maxConcurrent?: number;
};

export interface GraphApi {
  /** GET a path template under `/v1.0`, e.g. `/me/messages/{id}` with `params.id`. Only `/me/...` is reachable. */
  get<T = unknown>(laneId: LaneId, conn: unknown, path: string, params?: Record<string, string | number>, query?: Query): Promise<ConnectorResponse<T>>;
}

export function createGraphApi(deps: GraphApiDeps): GraphApi {
  const max = deps.maxConcurrent ?? MAX_CONCURRENT_PER_MAILBOX;
  const httpFor = (laneId: LaneId, g: GuardedMicrosoftConnection): HttpClient => {
    const bucket = graphBucket(g.conn.id, "read");
    return createGraphHttp(
      {
        baseUrl: GRAPH_COMMERCIAL_BASE,
        laneId,
        connectionId: g.conn.id,
        rateLimitKey: bucket.key,
        rateLimit: bucket.limit,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...deps.httpOptions,
      },
      g.cloud,
      "api",
    );
  };

  return {
    async get<T = unknown>(laneId: LaneId, conn: unknown, path: string, params?: Record<string, string | number>, query?: Query) {
      const g = await deps.guard(laneId, conn); // before any token read or request
      const http = httpFor(laneId, g); // host allow-list: before any token read or request
      let used: SecretValue | undefined;
      // An error thrown by the token manager (the token endpoint, a store outage) is not a Graph API answer: it is passed on as thrown.
      let tokenError: unknown;
      const request = (rejected?: SecretValue) =>
        http.request<T>({
          method: "GET",
          path,
          ...(params ? { params } : {}),
          ...(query ? { query } : {}),
          auth: {
            scheme: "Bearer",
            secret: async () => {
              tokenError = undefined;
              try {
                used = await deps.tokens.accessToken(laneId, g, rejected ? { rejected } : undefined);
              } catch (e) {
                tokenError = e;
                throw e;
              }
              return used;
            },
          },
        });
      return withMailboxSlot(`${laneId}\u0000${g.conn.id}`, max, async () => {
        try {
          try {
            return await request();
          } catch (e) {
            // 401 is `forbidden` with that status (HTTP client contract). Refresh once, retry once; a second 401 is final.
            if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used && tokenError === undefined) return await request(used);
            throw e;
          }
        } catch (e) {
          if (!isConnectorError(e)) throw e;
          if (tokenError !== undefined) throw toConnectorError(tokenError);
          const mapped = toConnectorError(mapGraphError(e));
          await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      });
    },
  };
}
