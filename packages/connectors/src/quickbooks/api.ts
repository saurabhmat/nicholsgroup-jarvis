// The QuickBooks Accounting API client (T-050): read-only by construction. It exposes GET only: no create, update,
// delete or batch (QB-scope of use; T-051 adds query/CDC/report reads on top of `get`, and a test fails on anything else).
// Every response's `intuit_tid` is captured by the shared HTTP client into the redacted connector log (QB-9).
// The access token is picked up per attempt from the token manager; a 401 refreshes once and retries once (QB-2).
import type { LaneId } from "@nichols/core";
import { isConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { assertQuickbooksConnection } from "./guard";
import { createHttpClient, type ConnectorResponse, type HttpClient, type HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { API_BASE, API_RATE_LIMIT, INTUIT_TID_HEADER, MINOR_VERSION, type IntuitEnvironment } from "./constants";
import type { TokenManager } from "./token-manager";

export type QboApiDeps = {
  tokens: TokenManager;
  environment: () => IntuitEnvironment;
  logger?: ConnectorLogger;
  /** Test hook: extra HTTP client options (fast backoff, injected fetch). */
  httpOptions?: Partial<HttpClientOptions>;
  httpFor?: (laneId: LaneId, conn: LaneBoundConnection<string>) => HttpClient;
};

export interface QboApi {
  /** GET a path template under the API base, e.g. `/v3/company/{realm}/companyinfo/{realm}` with `params.realm`. */
  get<T = unknown>(
    laneId: LaneId,
    conn: LaneBoundConnection<string>,
    path: string,
    params?: Record<string, string | number>,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<ConnectorResponse<T>>;
}

/** Intuit error bodies: `{ Fault: { Error: [{ code, Message, Detail }] } }`. Only the code is kept. */
export function intuitErrorCode(body: unknown): string | undefined {
  const fault = (body as { Fault?: { Error?: { code?: unknown }[] } } | null)?.Fault;
  const code = fault?.Error?.[0]?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

export function createQboApi(deps: QboApiDeps): QboApi {
  const httpFor =
    deps.httpFor ??
    ((laneId: LaneId, conn: LaneBoundConnection<string>) =>
      createHttpClient({
        provider: "quickbooks",
        baseUrl: API_BASE[deps.environment()],
        laneId,
        connectionId: conn.id,
        rateLimitKey: conn.id,
        rateLimit: API_RATE_LIMIT,
        requestIdHeader: INTUIT_TID_HEADER,
        errorCode: intuitErrorCode,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...deps.httpOptions,
      }));

  return {
    async get<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, params?: Record<string, string | number>, query?: Record<string, string | number | boolean | null | undefined>) {
      assertQuickbooksConnection(conn); // before any request or token read: another provider's token never goes to Intuit
      const http = httpFor(laneId, conn);
      let used: SecretValue | undefined;
      const request = (rejected?: SecretValue) =>
        http.request<T>({
          method: "GET",
          path,
          ...(params ? { params } : {}),
          query: { minorversion: MINOR_VERSION, ...query },
          auth: {
            scheme: "Bearer",
            secret: async () => {
              used = await deps.tokens.accessToken(laneId, conn, rejected ? { rejected } : undefined);
              return used;
            },
          },
        });
      try {
        return await request();
      } catch (e) {
        // 401 is `forbidden` with that status (HTTP client contract). Refresh once, retry once; a second 401 is final.
        if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used) return request(used);
        throw e;
      }
    },
  };
}
