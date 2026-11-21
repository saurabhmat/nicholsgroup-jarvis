// The Microsoft Graph client (T-256): read-only by construction. It exposes GET only (writes arrive with T-262, in their own `:write`
// rate bucket, see `graphBucket`). The guard decision must be FRESH when a request goes out, not when the call started: a call may queue for
// a mailbox slot and a retry may sleep on Retry-After, and an admin may switch Microsoft off or remove the tenant meanwhile. So:
//  - the call first takes its mailbox slot, and the guard runs INSIDE the slot (a refused call reads no token and sends no request);
//  - the guard runs again before every later attempt (a retry after a wait, the retry after a 401), in the per-attempt credential step,
//    before the token is read, so no token is attached to a request under a decision from before the wait;
//  - the host is checked when the HTTP client is built (graph.microsoft.com for a `commercial` connection; `gcc_high` has none yet);
//  - at most MAX_CONCURRENT_PER_MAILBOX requests are in flight per connection (our own cap; a mailbox that is being throttled
//    only holds back its own queue, never another connection or tenant);
//  - a per-connection rate bucket paces calls, and the shared client honours 429/503 `Retry-After`;
//  - the access token is picked up per attempt from the token manager; a 401 refreshes once and retries once;
//  - every failure leaves through the error map (./errors.ts) and is recorded once with scrubbed fields by the T-196 error log
//    (the fixed message, never Microsoft's text). Token-endpoint failures are not API errors: they pass through as thrown.
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

/** Path parameter values are single segments: a separator or an escape could move the request (no caller passes provider ids yet; T-258 will). */
function assertParams(params: Record<string, string | number> | undefined): void {
  for (const v of Object.values(params ?? {})) {
    if (typeof v === "string" && /[/\\%]/.test(v)) throw new ConnectorError({ kind: "invalid_input", message: "A path parameter contains a character that is not allowed" });
  }
}

export function createGraphApi(deps: GraphApiDeps): GraphApi {
  const max = deps.maxConcurrent ?? MAX_CONCURRENT_PER_MAILBOX;
  const httpFor = (laneId: LaneId, g: GuardedMicrosoftConnection): HttpClient => {
    const bucket = graphBucket(g.conn.id, "read");
    return createGraphHttp(
      {
        // Test hooks first: they can never replace the base URL, the allow-list checks the final value.
        ...deps.httpOptions,
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
  };

  return {
    async get<T = unknown>(laneId: LaneId, conn: unknown, path: string, params?: Record<string, string | number>, query?: Query) {
      assertParams(params);
      assertLaneBound(laneId, conn);
      return withMailboxSlot(`${laneId}\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn); // decided inside the slot: after any wait for it
        const http = httpFor(laneId, g); // host allow-list: before any token read or request
        let fresh = true; // the first attempt uses the decision just made; every later attempt decides again
        let used: SecretValue | undefined;
        // An error thrown while getting the credential (the guard again, the token endpoint, a store outage) is not a Graph API answer:
        // it is passed on as thrown and never classified here.
        let credentialError: unknown;
        const request = (rejected?: SecretValue) =>
          http.request<T>({
            method: "GET",
            path,
            ...(params ? { params } : {}),
            ...(query ? { query } : {}),
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
          // Only what Microsoft answered (or a timeout/network failure) is an API error; our own refusals (a bad path, a guard refusal) are not.
          if (isProviderApiError(mapped.toJSON())) await deps.errors?.record(laneId, g.conn, mapped.toJSON());
          throw mapped;
        }
      });
    },
  };
}
