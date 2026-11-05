// The shared connector HTTP client (T-034). Every connector calls its provider through this, never `fetch` directly,
// so every call gets the same safety: a timeout per attempt (covering the body), retry with backoff on 429/5xx and
// network failures (honouring Retry-After), a per-lane, per-provider rate limit, no redirects, a streamed response
// size cap, and one redacted log line per attempt. Failures leave as ConnectorError only, carrying the endpoint
// TEMPLATE (never the URL with ids or query), the status and the provider's request id — never the response body.
// The one exception is the caller's own cancellation: aborting `signal` rejects with the abort reason (AbortError),
// because it is not a provider failure and must not be recorded or retried as one.
//
// Paths are templates (`/v3/company/{realm}/query`); parameter values fill one segment each and cannot be `.`, `..` or
// empty, so a value from provider data or a tool argument cannot move the request to another endpoint.
//
// A 401 is reported as `forbidden` with `http_status: 401`: that status is the refresh signal for connectors (T-050
// refreshes and retries once; `auth` may be a function so the retry picks up the new token).
//
// Credentials: `auth` is a SecretValue (or a function returning one); it is revealed only into the Authorization header
// of the outgoing request.
import type { LaneId } from "@nichols/core";
import { ConnectorError, toConnectorError } from "../contract/errors";
import type { ConnectorErrorKind } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { isSecretValue, SecretValue } from "../vault/secret";
import { abortError, raceAbort, RateLimiter, type RateLimit } from "./rate-limit";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpClientOptions = {
  /** Provider name for logs and error messages, e.g. "quickbooks". */
  provider: string;
  /** Origin (and optional base path) of the provider API: https, or http on loopback for local mocks. */
  baseUrl: string;
  /** Lane the calls are made for: logged, and part of the rate-limit bucket (rule 1). */
  laneId: LaneId;
  /** Connection the calls are made for (logged). */
  connectionId?: string;
  /** Bucket key within the lane, e.g. the connection id (QuickBooks limits per realm). Default: the whole lane. */
  rateLimitKey?: string;
  rateLimit?: RateLimit;
  /** Per attempt, including reading the body. Default 30 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Backoff base and cap. Defaults 500 ms and 30 s. A Retry-After above the cap ends retrying. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Response header carrying the provider's request id (e.g. `intuit_tid`, `request-id`). */
  requestIdHeader?: string;
  /** Extracts a provider error code from a parsed error body (e.g. Intuit Fault.Error[0].code, OAuth `error`). Redacted after. */
  errorCode?: (body: unknown) => string | null | undefined;
  /** Largest response accepted. Default 20 MB. Enforced while streaming, after decompression. */
  maxResponseBytes?: number;
  logger?: ConnectorLogger;
  /** Injection points for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export type HttpRequest = {
  method: HttpMethod;
  /** Path template relative to baseUrl, e.g. `/v3/company/{realm}/query`. Logged and stored as is. */
  path: string;
  /** Values for `{name}` placeholders; each fills exactly one segment (URL-encoded; `.`, `..` and "" refused). */
  params?: Record<string, string | number>;
  /** An array value repeats the parameter (`a=1&a=2`), e.g. Gmail `metadataHeaders`. */
  query?: Record<string, string | number | boolean | null | undefined | readonly string[]>;
  headers?: Record<string, string>;
  /**
   * A string is sent as is with the caller's content-type (e.g. QuickBooks `application/text` queries); URLSearchParams
   * as a form (OAuth token endpoints); anything else as JSON.
   */
  body?: unknown;
  auth?: { scheme: "Bearer" | "Basic"; secret: SecretValue | (() => Promise<SecretValue>) };
  /** "json" (default): a 2xx with a non-JSON body is a provider_error. "text": the body as a string. */
  responseType?: "json" | "text";
  /**
   * Retry on 5xx, timeouts and network failures. Default: true for GET/PUT/DELETE, false for POST/PATCH (the request
   * may have been processed). A 429 is retried unless this is explicitly false: the provider did not process it.
   */
  retry?: boolean;
  signal?: AbortSignal;
};

export type ConnectorResponse<T = unknown> = {
  status: number;
  headers: Headers;
  data: T;
  providerTid: string | null;
  attempts: number;
};

export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<ConnectorResponse<T>>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const PARAM = /\{([a-z_][a-z0-9_]*)\}/gi;
const TEMPLATE = /^\/[^?#\s]*$/;
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)|\/\//;
/** A credential is printable ASCII without spaces; anything else (CR/LF, NUL) would be refused by the header API with the value in its message. */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;
/** IMF-fixdate (RFC 9110), the only date form Retry-After allows. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function checkBaseUrl(baseUrl: string): URL {
  if (!URL.canParse(baseUrl)) throw new ConnectorError({ kind: "invalid_input", message: "baseUrl is not a URL" });
  const url = new URL(baseUrl);
  const ok = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!ok || url.username || url.password || url.search || url.hash) {
    throw new ConnectorError({ kind: "invalid_input", message: "baseUrl must be https (http on loopback only), without credentials, query or fragment" });
  }
  return url;
}

function checkOptions(o: HttpClientOptions): void {
  const bad = (name: string) => new ConnectorError({ kind: "invalid_input", message: `invalid HTTP client option ${name}` });
  if (typeof o.laneId !== "string" || !/^[A-Z]{1,8}$/.test(o.laneId)) throw bad("laneId");
  const positive = (v: number | undefined) => v === undefined || (Number.isFinite(v) && v > 0);
  if (!positive(o.timeoutMs)) throw bad("timeoutMs");
  if (!positive(o.retryBaseMs)) throw bad("retryBaseMs");
  if (!positive(o.retryMaxMs)) throw bad("retryMaxMs");
  if (!positive(o.maxResponseBytes)) throw bad("maxResponseBytes");
  if (o.maxRetries !== undefined && !(Number.isInteger(o.maxRetries) && o.maxRetries >= 0 && o.maxRetries <= 10)) throw bad("maxRetries");
}

function kindForStatus(status: number): ConnectorErrorKind {
  if (status === 400 || status === 409 || status === 422) return "invalid_input";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  return "provider_error";
}

/** Retry-After as seconds or an IMF-fixdate -> milliseconds from now; null when absent or not one of those forms. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  if (!HTTP_DATE.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** HTTP Basic credentials (`client_id:client_secret`, OAuth token endpoints) as a SecretValue for `auth`. */
export function basicCredentials(username: string, password: SecretValue): SecretValue {
  return new SecretValue(Buffer.from(`${username}:${password.reveal()}`, "utf8").toString("base64"));
}

type FailInit = {
  kind: ConnectorErrorKind;
  message: string;
  http_status?: number | null;
  provider_tid?: string | null;
  provider_error_code?: string | null;
  retry_after_seconds?: number | null;
};

/** What one attempt produced. */
type Attempt =
  | { ok: true; res: Response; data: unknown }
  | { ok: false; error: FailInit; retry: boolean; waitMs?: number };

export function createHttpClient(options: HttpClientOptions): HttpClient {
  checkOptions(options);
  const base = checkBaseUrl(options.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? 20 * 1024 * 1024;
  const provider = options.provider;
  const log = (options.logger ?? connectorLog).child({
    laneId: options.laneId,
    provider,
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
  });
  const limiter = options.rateLimit
    ? RateLimiter.for(`${provider}:${options.laneId}:${options.rateLimitKey ?? "*"}`, options.rateLimit, { now, sleep })
    : null;

  const buildUrl = (req: HttpRequest): URL => {
    if (!TEMPLATE.test(req.path) || DOT_SEGMENT.test(req.path)) {
      throw new ConnectorError({ kind: "invalid_input", message: "path must be a template starting with / (no query, fragment, dot or empty segments)" });
    }
    const filled = req.path.replace(PARAM, (_m, name: string) => {
      const v = req.params?.[name];
      if (v === undefined) throw new ConnectorError({ kind: "invalid_input", message: `missing path parameter ${name}` });
      const s = String(v);
      if (s === "" || s === "." || s === "..") throw new ConnectorError({ kind: "invalid_input", message: `path parameter ${name} is empty or a dot segment` });
      return encodeURIComponent(s);
    });
    const url = new URL(base.origin);
    url.pathname = `${basePath}${filled}`;
    // Defence in depth: the parser must not have rewritten the path (dot segments, unencoded characters).
    if (url.pathname !== `${basePath}${filled}`) {
      throw new ConnectorError({ kind: "invalid_input", message: "path template produced a different path" });
    }
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) for (const item of v as readonly string[]) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    return url;
  };

  const backoff = (attempt: number) => Math.min(retryMaxMs, Math.floor(random() * retryBaseMs * 2 ** attempt));

  return {
    async request<T>(req: HttpRequest): Promise<ConnectorResponse<T>> {
      const url = buildUrl(req);
      const endpoint = req.path;
      const label = `${provider} ${req.method} ${endpoint}`;
      const retryable = req.retry ?? (req.method === "GET" || req.method === "PUT" || req.method === "DELETE");
      const responseType = req.responseType ?? "json";
      const fail = (init: FailInit) => new ConnectorError({ ...init, endpoint });
      const throwIfCancelled = () => {
        if (req.signal?.aborted) throw abortError(req.signal);
      };

      /** Headers and body for one attempt; a refreshed token is picked up on each. Errors carry no header values. */
      const prepare = async (): Promise<{ headers: Headers; body: string | URLSearchParams | undefined }> => {
        let secret: unknown;
        if (req.auth) {
          try {
            secret = typeof req.auth.secret === "function" ? await req.auth.secret() : req.auth.secret;
          } catch (e) {
            // e.g. a refresh that ended in reconnect_required; a foreign error loses its message.
            const { kind, message, http_status, provider_error_code, provider_tid, retry_after_seconds } = toConnectorError(e).info;
            throw fail({ kind, message, http_status, provider_error_code, provider_tid, retry_after_seconds });
          }
          if (!isSecretValue(secret)) throw fail({ kind: "invalid_input", message: "auth must be a SecretValue" });
        }
        try {
          const headers = new Headers(req.headers);
          headers.set("accept", headers.get("accept") ?? (responseType === "json" ? "application/json" : "*/*"));
          let body: string | URLSearchParams | undefined;
          if (req.body instanceof URLSearchParams || typeof req.body === "string") body = req.body;
          else if (req.body !== undefined) {
            body = JSON.stringify(req.body);
            if (!headers.has("content-type")) headers.set("content-type", "application/json");
          }
          if (req.auth) {
            const value = (secret as SecretValue).reveal();
            if (!HEADER_TOKEN.test(value)) throw fail({ kind: "invalid_input", message: "stored credential is not a valid header value" });
            headers.set("authorization", `${req.auth.scheme} ${value}`);
          }
          return { headers, body };
        } catch (e) {
          if (e instanceof ConnectorError) throw e;
          // The Headers API quotes the offending value in its message: never pass it on.
          throw fail({ kind: "invalid_input", message: "request headers are invalid" });
        }
      };

      const attemptOnce = async (attempt: number): Promise<Attempt> => {
        const { headers, body } = await prepare();
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(req.signal ? [req.signal] : [])]);
        let res: Response | undefined;
        try {
          res = await doFetch(url, { method: req.method, headers, body, redirect: "manual", signal });
          const providerTid = options.requestIdHeader ? (res.headers.get(options.requestIdHeader) ?? null) : null;
          const status = res.status;

          if (status >= 300 && status < 400) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, retry: false, error: { kind: "provider_error", message: `${label} redirected (${status}); redirects are not followed`, http_status: status, provider_tid: providerTid } };
          }
          if (RETRY_STATUS.has(status)) {
            const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
            await res.body?.cancel().catch(() => undefined);
            const waitMs = retryAfterMs ?? backoff(attempt);
            const mayRetry = status === 429 ? req.retry !== false : retryable;
            return {
              ok: false,
              retry: mayRetry && waitMs <= retryMaxMs,
              waitMs,
              error: {
                kind: kindForStatus(status),
                message: `${label} failed with ${status}`,
                http_status: status,
                provider_tid: providerTid,
                retry_after_seconds: retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000),
              },
            };
          }
          if (!res.ok) {
            // The error body is read only for the provider's code; a body that is too big or not JSON never changes the kind.
            const data = await readBody(res, maxBytes, "json", signal).catch((e: unknown) => {
              if (e instanceof ConnectorError) return null;
              throw e;
            });
            let code: unknown = null;
            try {
              code = options.errorCode?.(data) ?? null;
            } catch {
              code = null;
            }
            return {
              ok: false,
              retry: false,
              error: {
                kind: kindForStatus(status),
                message: `${label} failed with ${status}`,
                http_status: status,
                provider_tid: providerTid,
                provider_error_code: typeof code === "string" && code ? code.slice(0, 128) : null,
              },
            };
          }
          try {
            return { ok: true, res, data: await readBody(res, maxBytes, responseType, signal) };
          } catch (e) {
            if (!(e instanceof ConnectorError)) throw e;
            return { ok: false, retry: false, error: { kind: e.info.kind, message: `${label}: ${e.message}`, http_status: status, provider_tid: providerTid } };
          }
        } catch (e) {
          // Transport failures, before or during the body: timeouts, resets, DNS. The caller's abort is not one of them.
          throwIfCancelled();
          const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
          return {
            ok: false,
            retry: retryable,
            waitMs: backoff(attempt),
            error: {
              kind: timedOut ? "timeout" : "transient",
              message: `${label} ${timedOut ? "timed out" : "could not be completed"}`,
              http_status: res?.status ?? null,
            },
          };
        }
      };

      let attempt = 0;
      for (;;) {
        throwIfCancelled();
        if (limiter) await limiter.take(req.signal);
        const started = now();
        const result = await attemptOnce(attempt);
        const retrying = !result.ok && result.retry && attempt < maxRetries;
        const fields = {
          method: req.method,
          endpoint,
          attempt: attempt + 1,
          duration_ms: now() - started,
          ...(options.rateLimitKey ? { rate_limit_key: options.rateLimitKey } : {}),
        };
        if (result.ok) {
          const providerTid = options.requestIdHeader ? (result.res.headers.get(options.requestIdHeader) ?? null) : null;
          log.info("connector.http", { ...fields, status: result.res.status, outcome: "ok", provider_tid: providerTid });
          return { status: result.res.status, headers: result.res.headers, data: result.data as T, providerTid, attempts: attempt + 1 };
        }
        const e = result.error;
        const outcome = {
          ...fields,
          status: e.http_status ?? null,
          kind: e.kind,
          provider_error_code: e.provider_error_code ?? null,
          provider_tid: e.provider_tid ?? null,
        };
        if (retrying) {
          const waitMs = result.waitMs ?? backoff(attempt);
          log.warn("connector.http", { ...outcome, outcome: "retry", retry_in_ms: waitMs, final: false });
          await raceAbort(sleep(waitMs), req.signal);
          attempt += 1;
          continue;
        }
        log.error("connector.http", { ...outcome, outcome: "error", final: true });
        throw fail(e);
      }
    },
  };
}

/**
 * The body, streamed with a byte cap (counted after decompression, so content-length alone cannot be trusted). Each
 * read also races the attempt's signal, so a stalled body times out even if the fetch implementation does not tie its
 * stream to the signal.
 */
async function readBody(res: Response, maxBytes: number, type: "json" | "text", signal: AbortSignal): Promise<unknown> {
  const tooBig = () => new ConnectorError({ kind: "provider_error", message: "Response is larger than the limit" });
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await raceAbort(reader.read(), signal);
      } catch (e) {
        await reader.cancel().catch(() => undefined);
        throw e;
      }
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
  }
  if (total === 0) return null;
  const text = new TextDecoder().decode(Buffer.concat(chunks, total));
  if (type === "text") return text;
  if (!/\bjson\b/i.test(res.headers.get("content-type") ?? "")) {
    throw new ConnectorError({ kind: "provider_error", message: "Response is not JSON" });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError({ kind: "provider_error", message: "Response is not valid JSON" });
  }
}
