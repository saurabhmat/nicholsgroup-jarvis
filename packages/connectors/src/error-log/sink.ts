// The one place a provider API error is recorded (T-196, QB-9 / QB-15). Every QuickBooks API error that leaves the error map
// (quickbooks/api.ts) goes through `record`; nothing else writes core.connector_api_errors.
//   1. Scrub (./scrub.ts): path template, the connector's fixed message, code/request-id shapes. Provider text is never used.
//   2. Store the row with the lane's job client (service role). A failure is logged BY CODE ONLY and never reaches the caller:
//      recording an error must not break or retry a sync.
//   3. Hand the SAME scrubbed fields to every transport. The default transport is the redacted connector logger.
//
// SENTRY SEAM (T-041): there is no Sentry SDK in the repo and no DSN (H-011). When T-041 lands it adds one `ApiErrorTransport`
// that calls `Sentry.captureMessage` with `scrubbed` and the lane/connection ids as tags, and passes it in `transports` where the
// sink is wired (quickbooks/index.ts). It must send nothing but these fields. Nothing here changes then.
import type { LaneId } from "@nichols/core";
import type { LaneBoundConnection } from "../contract/lane-bound";
import { assertLaneBound } from "../contract/lane-bound";
import type { ConnectorErrorInfo } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { scrubApiError, type ScrubbedApiError } from "./scrub";

/** What a transport receives: the scrubbed fields and the ids, nothing else. */
export type ApiErrorEvent = { laneId: LaneId; connectionId: string; scrubbed: ScrubbedApiError };
export type ApiErrorTransport = { name: string; send(event: ApiErrorEvent): void | Promise<void> };

/** Persists one scrubbed row. Throws on failure (the sink swallows it). */
export interface ApiErrorStore {
  insert(laneId: LaneId, connectionId: string, row: ScrubbedApiError): Promise<void>;
}

export type ApiErrorSinkDeps = {
  store: ApiErrorStore;
  /** The provider's fixed message for this failure (for QuickBooks: classifyIntuitFailure(info).message). Never the provider's text. */
  messageFor: (info: ConnectorErrorInfo) => string;
  /** Extra transports (Sentry, T-041). The redacted-logger transport is always present. */
  transports?: readonly ApiErrorTransport[];
  logger?: ConnectorLogger;
};

export interface ApiErrorSink {
  record(laneId: LaneId, conn: LaneBoundConnection<string>, info: ConnectorErrorInfo): Promise<void>;
}

/** Default transport: one warn line through the shared redacted logger. */
export function loggerTransport(logger: ConnectorLogger = connectorLog): ApiErrorTransport {
  return {
    name: "log",
    send({ laneId, connectionId, scrubbed }) {
      logger.child({ laneId, provider: scrubbed.provider, connectionId }).warn("connector.api_error", { ...scrubbed });
    },
  };
}

/** True for an error that came from the provider's API (an answer or a network/timeout failure), not from our own checks. */
export function isProviderApiError(info: ConnectorErrorInfo): boolean {
  return info.http_status !== null || info.kind === "timeout" || info.kind === "transient";
}

export function createApiErrorSink(deps: ApiErrorSinkDeps): ApiErrorSink {
  const log = deps.logger ?? connectorLog;
  const transports = [loggerTransport(log), ...(deps.transports ?? [])];
  return {
    async record(laneId, conn, info) {
      try {
        assertLaneBound(laneId, conn);
        if (!isProviderApiError(info)) return;
        const scrubbed = scrubApiError(conn.provider, info, deps.messageFor(info));
        try {
          await deps.store.insert(laneId, conn.id, scrubbed);
        } catch {
          log.child({ laneId, provider: conn.provider, connectionId: conn.id }).error("connector.api_error.store_failed", { code: "store_failed" });
        }
        for (const t of transports) {
          try {
            await t.send({ laneId, connectionId: conn.id, scrubbed });
          } catch {
            log.child({ laneId, provider: conn.provider, connectionId: conn.id }).error("connector.api_error.transport_failed", { code: "transport_failed", transport: t.name });
          }
        }
      } catch {
        // Even the scrub or the lane check failing must not reach the caller.
        try {
          log.error("connector.api_error.record_failed", { code: "record_failed" });
        } catch {
          /* nothing more to do */
        }
      }
    },
  };
}
