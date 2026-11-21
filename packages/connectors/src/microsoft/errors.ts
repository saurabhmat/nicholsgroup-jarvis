// The Microsoft Graph error map (T-256, spec §8.5; same shape as the QuickBooks one): what each Graph failure means for the caller.
//
//   outcome            what the caller does                                           ConnectorError kind
//   retry              try again later: capped backoff by the shared client; a        rate_limited | transient | timeout
//                      Retry-After on 429/503 is honoured (it is the wait)
//   reconnect_required never retried; the connection needs a person. Only the token   reconnect_required
//                      manager decides this (token endpoint: invalid_grant, interaction_required, consent_required): no
//                      Graph API answer proves a dead grant
//   failed             not retried; a fixed, safe message (never Microsoft's text)    invalid_input | forbidden | not_found | provider_error
//
// Graph status                                                    outcome
//   400 (and 409, 422)                                            failed
//   401 (after one refresh and one retry: ./api.ts)               failed (forbidden): the token WAS just refreshed, so the grant is not
//                                                                  proven dead; no status change
//   403                                                           failed
//   404                                                           failed (not_found)
//   410 (an expired delta/sync state, T-258)                      failed (not_found), the provider code is kept for the sync to read
//   429 (with or without Retry-After)                             retry
//   500, 502, 503, 504, network failure, timeout                  retry
import { ConnectorError, isConnectorError } from "../contract/errors";
import type { ConnectorErrorInfo } from "../contract/schemas";

export type GraphFailureOutcome = "retry" | "reconnect_required" | "failed";
export type GraphFailure = { outcome: GraphFailureOutcome; message: string; retryAfterSeconds: number | null };

const MSG = {
  badRequest: "Microsoft rejected the request because it was not valid. Nothing was changed.",
  reconnect: "Microsoft no longer accepts this connection. Reconnect Microsoft in Settings.",
  unauthorized: "Microsoft did not accept the request's credentials. It will be checked again; if it keeps happening, reconnect Microsoft in Settings.",
  forbidden: "Microsoft says this connection is not allowed to do that. Check the account's permissions, then try again.",
  notFound: "Microsoft could not find what was asked for.",
  gone: "Microsoft no longer has what was asked for.",
  rateLimited: "Microsoft is limiting requests right now. It will be tried again shortly.",
  unavailable: "Microsoft is not responding right now. It will be tried again shortly.",
  other: "Microsoft returned an unexpected answer.",
} as const;

export function classifyGraphFailure(info: Pick<ConnectorErrorInfo, "kind" | "http_status" | "retry_after_seconds">): GraphFailure {
  const status = info.http_status;
  const retryAfterSeconds = info.retry_after_seconds;
  if (info.kind === "reconnect_required") return { outcome: "reconnect_required", message: MSG.reconnect, retryAfterSeconds: null };
  if (status === 429 || info.kind === "rate_limited") return { outcome: "retry", message: MSG.rateLimited, retryAfterSeconds };
  if (info.kind === "timeout" || info.kind === "transient" || (status !== null && status >= 500)) return { outcome: "retry", message: MSG.unavailable, retryAfterSeconds };
  if (status === 401) return { outcome: "failed", message: MSG.unauthorized, retryAfterSeconds: null };
  if (status === 403) return { outcome: "failed", message: MSG.forbidden, retryAfterSeconds: null };
  if (status === 404) return { outcome: "failed", message: MSG.notFound, retryAfterSeconds: null };
  if (status === 410) return { outcome: "failed", message: MSG.gone, retryAfterSeconds: null };
  if (status === 400 || status === 409 || status === 422) return { outcome: "failed", message: MSG.badRequest, retryAfterSeconds: null };
  return { outcome: "failed", message: MSG.other, retryAfterSeconds: null };
}

function failedKind(i: ConnectorErrorInfo): ConnectorError["info"]["kind"] {
  if (i.http_status === 401 || i.http_status === 403) return "forbidden";
  if (i.http_status === 404 || i.http_status === 410) return "not_found";
  if (i.http_status === 400 || i.http_status === 409 || i.http_status === 422) return "invalid_input";
  return "provider_error";
}

/**
 * The ConnectorError a Graph API failure leaves as: kind from the outcome, the fixed message above, and the status, code, request id,
 * Retry-After and endpoint kept. Failures that never reached Microsoft (our own checks) are returned unchanged; so is anything
 * that is not a ConnectorError (the caller reduces it).
 */
export function mapGraphError(e: unknown): unknown {
  if (!isConnectorError(e)) return e;
  const i = e.info;
  if (i.http_status === null && i.kind !== "timeout" && i.kind !== "transient") return e;
  const f = classifyGraphFailure(i);
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
