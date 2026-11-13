// The QuickBooks Accounting API client (T-050): read-only by construction. It exposes GET only: no create, update,
// delete or batch (QB-scope of use; T-051 adds query/CDC/report reads on top of `get`, and a test fails on anything else).
// Every response's `intuit_tid` is captured by the shared HTTP client into the redacted connector log (QB-9).
// The access token is picked up per attempt from the token manager; a 401 refreshes once and retries once (QB-2).
import type { LaneId } from "@nichols/core";
import { isConnectorError, toConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { assertQuickbooksConnection } from "./guard";
import { createHttpClient, type ConnectorResponse, type HttpClient, type HttpClientOptions } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { SecretValue } from "../vault/secret";
import { API_BASE, API_RATE_LIMIT, INTUIT_TID_HEADER, MINOR_VERSION, type IntuitEnvironment } from "./constants";
import { mapIntuitError, QBO_RETRY } from "./errors";
import type { OnReconnectRequired } from "./reconnect";
import type { TokenManager } from "./token-manager";

export type QboApiDeps = {
  tokens: TokenManager;
  environment: () => IntuitEnvironment;
  logger?: ConnectorLogger;
  /** Called when a call ends in reconnect_required (a 401 that survived a refresh, an app authorization refusal): records the status and notifies (T-195). Never throws. */
  onReconnectRequired?: OnReconnectRequired;
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

/**
 * Intuit error bodies: `{ Fault: { Error: [{ code, Message, Detail }] } }`. Some responses (401 from the gateway) use the same
 * shape with lower-case keys (`fault`, `error`, `code`). Only the code is kept (never the message or detail).
 */
export function intuitErrorCode(body: unknown): string | undefined {
  const root = body as { Fault?: unknown; fault?: unknown } | null;
  const fault = (root?.Fault ?? root?.fault) as { Error?: unknown; error?: unknown } | undefined;
  const list = fault?.Error ?? fault?.error;
  const first = Array.isArray(list) ? (list[0] as { code?: unknown } | undefined) : undefined;
  const code = first?.code;
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
        maxRetries: QBO_RETRY.maxRetries,
        retryBaseMs: QBO_RETRY.baseMs,
        retryMaxMs: QBO_RETRY.maxMs,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...deps.httpOptions,
      }));

  return {
    async get<T = unknown>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, params?: Record<string, string | number>, query?: Record<string, string | number | boolean | null | undefined>) {
      assertQuickbooksConnection(conn); // before any request or token read: another provider's token never goes to Intuit
      const http = httpFor(laneId, conn);
      let used: SecretValue | undefined;
      // An error thrown by the token manager while it got a token (the token endpoint: invalid_client, 5xx, a store outage) is not
      // an Intuit API answer: it is passed on as the token manager threw it and is never classified here (T-195 security M1).
      let tokenError: unknown;
      const request = (rejected?: SecretValue) =>
        http.request<T>({
          method: "GET",
          path,
          ...(params ? { params } : {}),
          query: { minorversion: MINOR_VERSION, ...query },
          auth: {
            scheme: "Bearer",
            secret: async () => {
              tokenError = undefined; // a failure of an earlier attempt must not outrank this attempt's own API answer
              try {
                used = await deps.tokens.accessToken(laneId, conn, rejected ? { rejected } : undefined);
              } catch (e) {
                tokenError = e;
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
          if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used) return await request(used);
          throw e;
        }
      } catch (e) {
        // The error map (QB-14, ./errors.ts): every Intuit failure leaves as retry, reconnect_required or failed-with-message.
        if (!isConnectorError(e)) throw e;
        if (tokenError !== undefined) throw toConnectorError(tokenError);
        const mapped = toConnectorError(mapIntuitError(e));
        if (mapped.info.kind === "reconnect_required" && e.info.kind !== "reconnect_required") {
          // Intuit says the app is not authorized for this company (403, code 3100): the grant is dead although the refresh did not say so.
          await deps.onReconnectRequired?.(laneId, conn, mapped.toJSON());
        }
        throw mapped;
      }
    },
  };
}
