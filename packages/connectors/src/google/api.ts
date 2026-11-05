// The Gmail API client (T-063): read-only by construction. It exposes GET only: no send, modify, trash, delete or
// batch (a test fails on anything else). The access token is picked up per attempt from the token manager; a 401
// refreshes once and retries once. A 403 that Google uses for rate limiting is reported as `rate_limited`.
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { ConnectorResponse, HttpClient, HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { GMAIL_BASE, GMAIL_RATE_LIMIT } from "./constants";
import { assertGoogleConnection } from "./guard";
import { createGoogleHttp } from "./http";
import type { GoogleTokenManager } from "./token-manager";

export type GoogleApiDeps = {
  tokens: GoogleTokenManager;
  logger?: ConnectorLogger;
  /** Test hook: extra HTTP client options (fast backoff, injected fetch). */
  httpOptions?: Partial<HttpClientOptions>;
  httpFor?: (laneId: LaneId, conn: LaneBoundConnection<string>) => HttpClient;
  /** Test hook: the pause before retrying a rate-limit 403. */
  sleep?: (ms: number) => Promise<void>;
};

/** Attempts for a call Google answered with a rate-limit 403 (the HTTP client already retries 429 and 5xx with Retry-After). */
const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_PAUSE_MS = [1000, 3000];

export type Query = Record<string, string | number | boolean | null | undefined | readonly string[]>;

export interface GoogleApi {
  /** GET a path template under the Gmail host, e.g. `/gmail/v1/users/me/messages/{id}` with `params.id`. */
  get<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, params?: Record<string, string | number>, query?: Query): Promise<ConnectorResponse<T>>;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RESOURCE_EXHAUSTED", "quotaExceeded", "dailyLimitExceeded"]);

export function createGoogleApi(deps: GoogleApiDeps): GoogleApi {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const httpFor =
    deps.httpFor ??
    ((laneId: LaneId, conn: LaneBoundConnection<string>) =>
      createGoogleHttp({
        baseUrl: GMAIL_BASE,
        laneId,
        connectionId: conn.id,
        rateLimitKey: conn.id,
        rateLimit: GMAIL_RATE_LIMIT,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...deps.httpOptions,
      }));

  return {
    async get<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, params?: Record<string, string | number>, query?: Query) {
      assertGoogleConnection(conn); // before any request or token read: another provider's token never goes to Google
      const http = httpFor(laneId, conn);
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
          const retriable = isConnectorError(e) && e.info.kind === "rate_limited" && e.info.http_status === 403;
          if (!retriable || attempt >= RATE_LIMIT_ATTEMPTS) throw e;
          await sleep(RATE_LIMIT_PAUSE_MS[attempt - 1] ?? 3000);
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
