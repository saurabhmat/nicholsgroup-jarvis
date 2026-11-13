// What may be stored about a provider API error (T-196, QB-9 / QB-15): one row of core.connector_api_errors and the same fields
// for any other sink (the redacted log today, Sentry with T-041). Pure.
//
// Rules, in order of how much they matter:
//  - `provider_message` is NEVER the provider's own text (Intuit's Message/Detail can echo customer names, amounts, emails). It is
//    the connector's fixed text for that error (the T-195 error map), passed in by the caller. If even that fixed text looks like
//    it carries an `@`, a Bearer value or a run of 5+ digits it is replaced by a generic sentence.
//  - `endpoint` is a path TEMPLATE: query string and fragment dropped, the company segment replaced by `{realm}`, any other
//    segment that is not a plain word, a `{template}` or a version (v3) replaced by `{id}`. A value that is not a path becomes null.
//  - `provider_error_code` and `provider_tid` are kept only when they have the shape of a code / request id.
// The database repeats the shape checks (migration 20261117100000), so a bug here is refused there, not stored.
import type { ConnectorErrorInfo } from "../contract/schemas";

export const GENERIC_MESSAGE = "The provider returned an error.";

export type ScrubbedApiError = {
  provider: string;
  endpoint: string | null;
  http_status: number | null;
  provider_error_code: string | null;
  provider_message: string;
  provider_tid: string | null;
  kind: ConnectorErrorInfo["kind"];
  disposition: ConnectorErrorInfo["disposition"];
  retry_after_seconds: number | null;
};

const MAX_ENDPOINT = 255;
const DIGIT_RUN = /[0-9]{5,}/;
const CODE = /^(?:[0-9]{1,6}|[A-Za-z][A-Za-z0-9_.-]{0,63})$/;
const TID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PROVIDER = /^[a-z][a-z0-9_]{1,31}$/;
/** A segment kept as written: a word (reports, query, ProfitAndLoss), a version (v3) or a `{template}` name. */
const SEGMENT = /^(?:\{[a-z_]{1,32}\}|[A-Za-z][A-Za-z0-9_-]{0,63}|v[0-9]{1,2})$/;

/** `/v3/company/9130350000/query?query=select * from Customer` -> `/v3/company/{realm}/query`. */
export function templateEndpoint(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  if (!bare.startsWith("/")) return null;
  const parts = bare.split("/").slice(1);
  const out: string[] = [];
  parts.forEach((segment, i) => {
    if (segment === "") return;
    const after = parts[i - 1];
    if (after === "company") out.push("{realm}");
    else out.push(SEGMENT.test(segment) && !DIGIT_RUN.test(segment) ? segment : "{id}");
  });
  const joined = `/${out.join("/")}`;
  return joined.length > MAX_ENDPOINT ? joined.slice(0, MAX_ENDPOINT) : joined;
}

/** The fixed message, or a generic one if it looks like it carries something personal or a credential. */
export function safeFixedMessage(message: string): string {
  const m = message.trim();
  if (m.length === 0 || m.length > 300 || m.includes("@") || /bearer/i.test(m) || DIGIT_RUN.test(m)) return GENERIC_MESSAGE;
  return m;
}

export function scrubApiError(provider: string, info: ConnectorErrorInfo, fixedMessage: string): ScrubbedApiError {
  const status = info.http_status;
  const code = info.provider_error_code;
  const tid = info.provider_tid;
  const retry = info.retry_after_seconds;
  return {
    provider: PROVIDER.test(provider) ? provider : "unknown",
    endpoint: templateEndpoint(info.endpoint),
    http_status: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    provider_error_code: code !== null && CODE.test(code) ? code : null,
    provider_message: safeFixedMessage(fixedMessage),
    provider_tid: tid !== null && TID.test(tid) ? tid : null,
    kind: info.kind,
    disposition: info.disposition,
    retry_after_seconds: retry !== null && Number.isInteger(retry) && retry >= 0 && retry <= 86_400 ? retry : null,
  };
}
