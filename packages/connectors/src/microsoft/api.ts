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

/**
 * Extra request parts (T-258), each checked here:
 *  - `headers`: only `Prefer` (the `IdType="ImmutableId"` and `odata.maxpagesize` preferences; they apply to the one request they are on, so every
 *    request carries them), printable ASCII.
 *  - `rawQuery`: an OPAQUE query string sent exactly as given (a delta/next link's `$skiptoken` / `$deltatoken` must not be rebuilt; the
 *    first delta request uses it so `$select` and `$orderby` go out unencoded). It carries no path and no host: the path is still the
 *    `/me/...` template, and the host is still the allow-listed one. Characters outside the URL query set, a `#`, and more than
 *    MAX_RAW_QUERY characters are refused; it cannot be combined with `query`.
 */
export type GraphGetOptions = {
  headers?: Record<string, string>;
  rawQuery?: string;
  /**
   * T-259: a SHORTER timeout per attempt than the client's default (a bounded read that must not hold up a page), 1 to 60,000 ms; and `noRetry`: the shared
   * client makes no retry of its own (a 429 or 5xx is answered as it is). The guard still runs before the attempt, inside the slot, and the rate bucket
   * still paces the call; a 401 still refreshes the token once.
   */
  timeoutMs?: number;
  noRetry?: boolean;
};

export interface GraphApi {
  /** GET a path template under `/v1.0`, e.g. `/me/messages/{id}` with `params.id`. Only `/me/...` is reachable. */
  get<T = unknown>(laneId: LaneId, conn: unknown, path: string, params?: Record<string, string | number>, query?: Query, options?: GraphGetOptions): Promise<ConnectorResponse<T>>;
}

/** Longest opaque query accepted (a link's query is never truncated: longer is refused). */
export const MAX_RAW_QUERY = 4096;
/** The URL query character set (RFC 3986 `query` without the apostrophe, which the URL parser would re-encode; `%` for escapes): nothing that could end the query, start a fragment or break the request line. */
const RAW_QUERY = /^[A-Za-z0-9\-._~!$&()*+,;=:@/?%]*$/;

/** Whether `q` could be sent as a raw query (a link's query is checked with this before it is stored or used). */
export const isOpaqueQuery = (q: string): boolean => q.length <= MAX_RAW_QUERY && RAW_QUERY.test(q);

function assertOptions(options: GraphGetOptions | undefined, query: Query | undefined): void {
  const bad = (m: string) => new ConnectorError({ kind: "invalid_input", message: m });
  for (const [k, v] of Object.entries(options?.headers ?? {})) {
    if (k.toLowerCase() !== "prefer" || !/^[\x20-\x7e]{1,200}$/.test(v)) throw bad("A request header is not allowed");
  }
  const t = options?.timeoutMs;
  if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= 60_000)) throw bad("The timeout is not allowed");
  const raw = options?.rawQuery;
  if (raw !== undefined) {
    if (!isOpaqueQuery(raw)) throw bad("The query is not allowed");
    // Checked HERE, before the slot, the guard and any token read: the URL parser must keep the query exactly as given (a throw inside the fetch wrapper
    // would be read as a transport failure and retried, with a token read each time).
    if (raw !== "") {
      const probe = new URL(GRAPH_COMMERCIAL_BASE);
      probe.search = `?${raw}`;
      if (probe.search !== `?${raw}`) throw bad("The query is not allowed");
    }
    if (query && Object.keys(query).length > 0) throw bad("A raw query cannot be combined with a query object");
  }
}

/** A fetch that puts the opaque query (already checked by `assertOptions`) on the request the client built, which has none. It never throws. */
function withRawQuery(inner: typeof fetch, rawQuery: string): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    if (rawQuery !== "") url.search = `?${rawQuery}`;
    return inner(url, init);
  };
}

/** Path parameter values are single segments: a separator or an escape could move the request (no caller passes provider ids yet; T-258 will). */
function assertParams(params: Record<string, string | number> | undefined): void {
  for (const v of Object.values(params ?? {})) {
    if (typeof v === "string" && /[/\\%]/.test(v)) throw new ConnectorError({ kind: "invalid_input", message: "A path parameter contains a character that is not allowed" });
  }
}

export function createGraphApi(deps: GraphApiDeps): GraphApi {
  const max = deps.maxConcurrent ?? MAX_CONCURRENT_PER_MAILBOX;
  const httpFor = (laneId: LaneId, g: GuardedMicrosoftConnection, options?: GraphGetOptions): HttpClient => {
    const rawQuery = options?.rawQuery;
    const bucket = graphBucket(g.conn.id, "read");
    return createGraphHttp(
      {
        // Test hooks first: they can never replace the base URL, the allow-list checks the final value.
        ...deps.httpOptions,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.noRetry === true ? { maxRetries: 0 } : {}),
        ...(rawQuery === undefined ? {} : { fetch: withRawQuery(deps.httpOptions?.fetch ?? fetch, rawQuery) }),
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
    async get<T = unknown>(laneId: LaneId, conn: unknown, path: string, params?: Record<string, string | number>, query?: Query, options?: GraphGetOptions) {
      assertParams(params);
      assertOptions(options, query);
      assertLaneBound(laneId, conn);
      return withMailboxSlot(`${laneId}\u0000${conn.id}`, max, async () => {
        const g = await deps.guard(laneId, conn); // decided inside the slot: after any wait for it
        const http = httpFor(laneId, g, options); // host allow-list: before any token read or request
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
            ...(options?.headers ? { headers: options.headers } : {}),
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
