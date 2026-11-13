// The QuickBooks error map (QB-14, T-195): what each Intuit failure means for the caller. One place, so the sync, the reports
// job, the webhook-triggered CDC and the health check all treat an Intuit answer the same way.
//
//   outcome            what the caller does                                              ConnectorError kind
//   retry              try again later: capped exponential backoff (see QBO_RETRY);       rate_limited | transient | timeout
//                      a Retry-After from Intuit is honoured and is the wait when longer
//   reconnect_required never retried; the connection needs a person (status is recorded,  reconnect_required
//                      sync stops, the admin is notified: ./reconnect.ts)
//   failed             not retried; the request is shown to the owner with a fixed,      invalid_input | forbidden | not_found |
//                      safe message (never Intuit's own text: it can echo names)           provider_error
//
// Intuit status / code                                                      outcome
//   400 + Fault code 2xxx (validation), 6xxx (business rule), 5xxx, 610      failed   "QuickBooks rejected the request: it was not valid"
//   400 + Fault code 4xxx (query / syntax: QueryParserError, 4000, 4001)      failed   "QuickBooks could not read the request"
//   400 + a code we do not know                                               failed   (generic)
//   401 (after one refresh and one retry: ./api.ts)                           failed (forbidden): the token WAS just refreshed, so
//                                                                              the grant is not proven dead; no status change
//   403 + 3100 / 003100 (app not authorized for this company)                 reconnect_required (the only API answer that is)
//   403 anything else (permission)                                            failed
//   404                                                                       failed
//   429 (ThrottleExceeded, with or without Retry-After)                       retry
//   500, 502, 503, 504, network failure                                       retry
//   timeout                                                                   retry
//   token endpoint: 400 invalid_grant                                         reconnect_required (./token-manager.ts), never retried
//   token endpoint: anything else (401 invalid_client = our own client id/secret is wrong, 5xx) is NOT a dead grant: it leaves as
//   the token manager threw it, never recorded as reconnect_required (T-195 security review M1).
//
// The fixtures behind the tests (testing/msw/quickbooks/error-fixtures.ts) are written by hand in Intuit's documented response
// format ({"Fault":{"Error":[{"Message","Detail","code"}],"type"}}) with synthetic values; no live call recorded them. Which
// exact codes Intuit's sandbox returns is confirmed in the QB-14 manual check (H-xxx in the backlog).
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { ConnectorErrorInfo } from "../contract/schemas";

/** Backoff for the Accounting API: 500 ms, doubling with jitter, capped at 30 s, three retries. Same numbers as the shared client's defaults, set here on purpose so a change is visible. */
export const QBO_RETRY = { maxRetries: 3, baseMs: 500, maxMs: 30_000 } as const;

export type QboFailureOutcome = "retry" | "reconnect_required" | "failed";

/** What a failure means and the one sentence the owner may be shown (no Intuit text, no ids). */
export type QboFailure = { outcome: QboFailureOutcome; message: string; retryAfterSeconds: number | null };

const MSG = {
  invalid: "QuickBooks rejected the request because it was not valid. Nothing was changed.",
  syntax: "QuickBooks could not read the request. Nothing was changed.",
  badRequest: "QuickBooks refused the request. Nothing was changed.",
  reconnect: "QuickBooks no longer accepts this connection. Reconnect QuickBooks in Settings.",
  unauthorized: "QuickBooks did not accept the request's credentials. It will be checked again; if it keeps happening, reconnect QuickBooks in Settings.",
  forbidden: "QuickBooks says this connection is not allowed to do that. Check the QuickBooks user's permissions, then try again.",
  notFound: "QuickBooks could not find what was asked for.",
  rateLimited: "QuickBooks is limiting requests right now. It will be tried again shortly.",
  unavailable: "QuickBooks is not responding right now. It will be tried again shortly.",
  other: "QuickBooks returned an unexpected answer.",
} as const;

/** The numeric part of an Intuit Fault code ("003200" -> 3200, "6000" -> 6000), or null. */
function codeNumber(code: string | null): number | null {
  if (code === null || !/^\d{1,8}$/.test(code)) return null;
  return Number(code);
}

const AUTH_CODES: ReadonlySet<number> = new Set([3200, 3100]);

/**
 * Classifies one failure. `info` is a ConnectorErrorInfo as the HTTP client produced it (status, Intuit code, Retry-After),
 * already redacted. Pure.
 */
export function classifyIntuitFailure(info: Pick<ConnectorErrorInfo, "kind" | "http_status" | "provider_error_code" | "retry_after_seconds">): QboFailure {
  const status = info.http_status;
  const code = codeNumber(info.provider_error_code);
  const retryAfterSeconds = info.retry_after_seconds;
  if (info.kind === "reconnect_required") return { outcome: "reconnect_required", message: MSG.reconnect, retryAfterSeconds: null };
  if (status === 429 || info.kind === "rate_limited") return { outcome: "retry", message: MSG.rateLimited, retryAfterSeconds };
  if (info.kind === "timeout" || info.kind === "transient" || (status !== null && status >= 500)) return { outcome: "retry", message: MSG.unavailable, retryAfterSeconds };
  if (status === 401) return { outcome: "failed", message: MSG.unauthorized, retryAfterSeconds: null };
  if (status === 403) {
    return code !== null && AUTH_CODES.has(code)
      ? { outcome: "reconnect_required", message: MSG.reconnect, retryAfterSeconds: null }
      : { outcome: "failed", message: MSG.forbidden, retryAfterSeconds: null };
  }
  if (status === 404) return { outcome: "failed", message: MSG.notFound, retryAfterSeconds: null };
  if (status === 400) {
    if (code !== null && code >= 4000 && code < 5000) return { outcome: "failed", message: MSG.syntax, retryAfterSeconds: null };
    if (code !== null && ((code >= 2000 && code < 3000) || (code >= 5000 && code < 7000) || code === 610)) return { outcome: "failed", message: MSG.invalid, retryAfterSeconds: null };
    return { outcome: "failed", message: MSG.badRequest, retryAfterSeconds: null };
  }
  return { outcome: "failed", message: MSG.other, retryAfterSeconds: null };
}

/**
 * The ConnectorError a QuickBooks API failure leaves as: the kind follows the outcome, the message is the fixed one above, the
 * status, Intuit code, request id (`intuit_tid`), Retry-After and endpoint are kept. Anything that is not a ConnectorError is
 * returned unchanged (the caller reduces it).
 */
export function mapIntuitError(e: unknown): unknown {
  if (!isConnectorError(e)) return e;
  const i = e.info;
  // Failures that never reached Intuit (our own input checks, lane or connection problems) keep their own kind and message.
  if (i.http_status === null && i.kind !== "timeout" && i.kind !== "transient") return e;
  const f = classifyIntuitFailure(i);
  const kind = f.outcome === "reconnect_required" ? "reconnect_required" : f.outcome === "retry" ? (i.kind === "timeout" ? "timeout" : i.kind === "rate_limited" ? "rate_limited" : "transient") : failedKind(i);
  if (kind === i.kind && f.message === i.message) return e;
  return new ConnectorError({
    kind,
    message: f.message,
    ...(i.http_status !== null ? { http_status: i.http_status } : {}),
    ...(i.provider_error_code !== null ? { provider_error_code: i.provider_error_code } : {}),
    ...(i.provider_tid !== null ? { provider_tid: i.provider_tid } : {}),
    ...(i.retry_after_seconds !== null ? { retry_after_seconds: i.retry_after_seconds } : {}),
    ...(i.endpoint !== null ? { endpoint: i.endpoint } : {}),
  });
}

function failedKind(i: ConnectorErrorInfo): ConnectorError["info"]["kind"] {
  if (i.http_status === 401 || i.http_status === 403) return "forbidden";
  if (i.http_status === 404) return "not_found";
  if (i.http_status === 400) return "invalid_input";
  return "provider_error";
}
