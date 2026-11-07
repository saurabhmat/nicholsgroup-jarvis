// The Gmail API client (T-063): read-only by construction. It exposes GET only: no send, modify, trash, delete or
// batch (a test fails on anything else). The access token is picked up per attempt from the token manager; a 401
// refreshes once and retries once. A 403 that Google uses for rate limiting is reported as `rate_limited`.
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { CALENDAR_BASE, CALENDAR_PATHS, CALENDAR_RATE_LIMIT, GMAIL_BASE, GMAIL_RATE_LIMIT } from "./constants";
import { assertGoogleConnection } from "./guard";
import { createGoogleHttp } from "./http";
import type { GoogleTokenManager } from "./token-manager";

export type GoogleApiDeps = {
  tokens: GoogleTokenManager;
  logger?: ConnectorLogger;
  /** Test hook: extra HTTP client options (fast backoff, injected fetch). */
  httpOptions?: Partial<HttpClientOptions>;
  httpFor?: (laneId: LaneId, conn: LaneBoundConnection<string>, baseUrl: string) => HttpClient;
  /** Test hook: the pause before retrying a rate-limit 403. */
  sleep?: (ms: number) => Promise<void>;
};

/** Attempts for a call Google answered with a rate-limit 403 (the HTTP client already retries 429 and 5xx with Retry-After). */
// Five attempts, about 18 s of pauses in all: a first mailbox load with parallel reads can stay limited for several
// seconds (Nov 6, 2026: three attempts over 4 s failed the whole run, and every retry hit the same wall).
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_PAUSE_MS = [1000, 2000, 5000, 10_000];

export type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>;

export interface GoogleApi {
  /**
   * GET a path template, e.g. `/gmail/v1/users/me/messages/{id}` with `params.id`. `/gmail/v1/...` goes to the Gmail host;
   * `/calendar/v3/...` to www.googleapis.com and only when the template is one of CALENDAR_PATHS. Any other path is refused.
   */
  get<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, params?: Record<string, string | number>, query?: Query): Promise<ConnectorResponse<T>>;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RESOURCE_EXHAUSTED", "quotaExceeded", "dailyLimitExceeded"]);
const SHORT_RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RESOURCE_EXHAUSTED"]);

/** Host and rate-limit bucket for a path template; throws for anything that is not a known Gmail or allowed Calendar path. */
function target(path: string): { baseUrl: string; bucket: string; limit: typeof GMAIL_RATE_LIMIT | typeof CALENDAR_RATE_LIMIT } {
  if (path.startsWith("/gmail/v1/")) return { baseUrl: GMAIL_BASE, bucket: "", limit: GMAIL_RATE_LIMIT };
  if (CALENDAR_PATHS.has(path)) return { baseUrl: CALENDAR_BASE, bucket: ":calendar", limit: CALENDAR_RATE_LIMIT };
  throw new ConnectorError({ kind: "invalid_input", message: "Path is not an allowed Google API path" });
}

export function createGoogleApi(deps: GoogleApiDeps): GoogleApi {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const httpFor = (laneId: LaneId, conn: LaneBoundConnection<string>, t: ReturnType<typeof target>): HttpClient =>
    deps.httpFor
      ? deps.httpFor(laneId, conn, t.baseUrl)
      : createGoogleHttp({
          baseUrl: t.baseUrl,
          laneId,
          connectionId: conn.id,
          rateLimitKey: `${conn.id}${t.bucket}`,
          rateLimit: t.limit,
          ...(deps.logger ? { logger: deps.logger } : {}),
          ...deps.httpOptions,
        });

  return {
    async get<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, params?: Record<string, string | number>, query?: Query) {
      assertGoogleConnection(conn); // before any request or token read: another provider's token never goes to Google
      const http = httpFor(laneId, conn, target(path));
      let used: SecretValue | undefined;
      const request = (rejected?: SecretValue) =>
        http.request<T>({
          method: "GET",
          path,
          ...(params ? { params } : {}),
          ...(query ? { query } : {}),
          auth: {
            scheme: "Bearer",
            secret: async () => {
              used = await deps.tokens.accessToken(laneId, conn, rejected ? { rejected } : undefined);
              return used;
            },
          },
        });
      const once = async (): Promise<ConnectorResponse<T>> => {
        try {
          return await request();
        } catch (e) {
          if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used) {
            try {
              return await request(used);
            } catch (e2) {
              throw mapRateLimit(e2);
            }
          }
          throw mapRateLimit(e);
        }
      };
      // Google reports some rate limits as 403 with a reason; retry those with a bounded pause. A 429 is retried by the
      // HTTP client (Retry-After honoured up to its cap) and arrives here as rate_limited when the wait is too long.
      for (let attempt = 1; ; attempt++) {
        try {
          return await once();
        } catch (e) {
          // Short-window limits clear in seconds; a daily quota does not, so it is not retried here.
          const retriable = isConnectorError(e) && e.info.kind === "rate_limited" && e.info.http_status === 403 && SHORT_RATE_LIMIT_REASONS.has(e.info.provider_error_code ?? "");
          if (!retriable || attempt >= RATE_LIMIT_ATTEMPTS) throw e;
          await sleep(RATE_LIMIT_PAUSE_MS[attempt - 1] ?? 10_000);
        }
      }
    },
  };
}

function mapRateLimit(e: unknown): unknown {
  if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 403 && RATE_LIMIT_REASONS.has(e.info.provider_error_code ?? "")) {
    return new ConnectorError({ kind: "rate_limited", message: "Google rate limit", http_status: 403, retry_after_seconds: 30, provider_error_code: e.info.provider_error_code, endpoint: e.info.endpoint });
  }
  return e;
}
