import {
  ERROR_MESSAGE_MAX,
  type ConnectorErrorInfo,
  type ConnectorErrorKind,
  type ErrorDisposition,
} from "./schemas";

const DISPOSITION: Record<ConnectorErrorKind, ErrorDisposition> = {
  lane_mismatch: "fail",
  connection_unavailable: "fail",
  reconnect_required: "reconnect_required",
  unsupported_op: "fail",
  invalid_input: "fail",
  rate_limited: "retry",
  transient: "retry",
  timeout: "retry",
  not_found: "fail",
  forbidden: "fail",
  provider_error: "fail",
};

/** Retry only transient failures; `reconnect_required` (e.g. `invalid_grant`) is never retried (QB-3, QB-4). */
export function dispositionFor(kind: ConnectorErrorKind): ErrorDisposition {
  return DISPOSITION[kind];
}

export type ConnectorErrorInit = Pick<ConnectorErrorInfo, "kind" | "message"> &
  Partial<Omit<ConnectorErrorInfo, "kind" | "message" | "disposition">>;

/**
 * The only error type a connector may throw across the contract.
 * Deliberately has no `cause`: provider responses and transport errors can contain tokens or personal data, so only the
 * safe `info` fields travel. `toJSON` returns `info` only (no stack), so it is safe to log and to store (T-196).
 * Connectors must not put tokens, secrets or personal data in `message`; the contract kit checks this with canaries.
 */
export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  readonly info: Readonly<ConnectorErrorInfo>;

  constructor(init: ConnectorErrorInit) {
    const message = init.message.slice(0, ERROR_MESSAGE_MAX);
    super(message);
    this.info = Object.freeze({
      kind: init.kind,
      disposition: dispositionFor(init.kind),
      message,
      http_status: init.http_status ?? null,
      provider_error_code: init.provider_error_code ?? null,
      provider_tid: init.provider_tid ?? null,
      retry_after_seconds: init.retry_after_seconds ?? null,
      endpoint: init.endpoint ?? null,
    });
  }

  toJSON(): ConnectorErrorInfo {
    return { ...this.info };
  }
}

export function isConnectorError(value: unknown): value is ConnectorError {
  return value instanceof ConnectorError;
}
