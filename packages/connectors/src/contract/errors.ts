import { redactId, redactText } from "../log/redact";
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
/**
 * D-23: a provider account (QuickBooks realm, Stripe account, GoHighLevel location) connects to one lane only. The
 * database refuses a second connection for it (unique index `connections_one_lane_per_account`); the connection store
 * and the token vault turn that into a `forbidden` ConnectorError with exactly this message, which the connect flow
 * recognises and reports as a refused account. Fixed text: database messages are never passed on.
 */
export const ACCOUNT_IN_USE_MESSAGE = "This provider account is already connected to another company";

export function dispositionFor(kind: ConnectorErrorKind): ErrorDisposition {
  return DISPOSITION[kind];
}

/** A request path with no query or fragment; anything else is not stored (query strings carry codes and tokens). */
const ENDPOINT_PATH = /^\/[^?#\s]*$/;

/** The endpoint path with credentials redacted, or null when it is not a plain path (T-033 review H2/M4). */
function safeEndpoint(endpoint: string | null | undefined): string | null {
  if (endpoint == null) return null;
  const redacted = redactText(endpoint);
  return redacted.length <= 256 && ENDPOINT_PATH.test(redacted) ? redacted : null;
}

export type ConnectorErrorInit = Pick<ConnectorErrorInfo, "kind" | "message"> &
  Partial<Omit<ConnectorErrorInfo, "kind" | "message" | "disposition">>;

/**
 * The only error type a connector may throw across the contract.
 * - No `cause`, and the instance is non-extensible (so one cannot be attached later): provider responses and transport
 *   errors can contain tokens or personal data, so only the safe `info` fields travel.
 * - `toJSON` returns `info` only (no stack), so it is safe to log and to store (T-196).
 * - Effectively final: subclasses cannot add fields (the contract kit also requires the exact prototype).
 * Connectors must not put tokens, secrets or personal data in `message` (T-033 redacts; the kit checks with canaries).
 */
export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  readonly info: Readonly<ConnectorErrorInfo>;

  constructor(init: ConnectorErrorInit) {
    // Redacted here, once, for every connector: provider messages can echo tokens (T-033).
    const message = redactText(init.message).slice(0, ERROR_MESSAGE_MAX) || "Connector error";
    const id = (v: string | null | undefined, max: number) => (v == null ? null : redactId(v).slice(0, max));
    super(message);
    this.info = Object.freeze({
      kind: init.kind,
      disposition: dispositionFor(init.kind),
      message,
      http_status: init.http_status ?? null,
      provider_error_code: id(init.provider_error_code, 128),
      provider_tid: id(init.provider_tid, 256),
      retry_after_seconds: init.retry_after_seconds ?? null,
      endpoint: safeEndpoint(init.endpoint),
    });
    Object.preventExtensions(this);
  }

  toJSON(): ConnectorErrorInfo {
    return { ...this.info };
  }
}

export function isConnectorError(value: unknown): value is ConnectorError {
  return value instanceof ConnectorError;
}

/**
 * Converts anything a connector caught into a `ConnectorError`. Foreign errors become `provider_error` with a generic
 * message: their message, stack and cause are dropped because they may contain tokens or personal data.
 */
export function toConnectorError(value: unknown): ConnectorError {
  if (value instanceof ConnectorError) return value;
  return new ConnectorError({ kind: "provider_error", message: "Unexpected connector failure" });
}
