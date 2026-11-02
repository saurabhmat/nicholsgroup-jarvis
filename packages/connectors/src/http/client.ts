// The shared connector HTTP client (T-034). Every connector calls its provider through this, never `fetch` directly,
// so every call gets the same safety: a timeout, retry with backoff on 429/5xx (honouring Retry-After), a
// per-provider (and optionally per-connection) rate limit, no redirects, a response size cap, and one redacted log
// line per attempt. Failures leave as ConnectorError only, carrying the endpoint TEMPLATE (never the URL with ids or
// query), the status and the provider's request id — never the response body.
//
// Credentials: `auth` is a SecretValue (or a function returning one, so a refreshed token is picked up on retry); it
// is revealed only into the Authorization header of the outgoing request.
import type { LaneId } from "@nichols/core";
import { ConnectorError, toConnectorError } from "../contract/errors";
import type { ConnectorErrorKind } from "../contract/schemas";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { isSecretValue, type SecretValue } from "../vault/secret";
import { RateLimiter, type RateLimit } from "./rate-limit";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpClientOptions = {
  /** Provider name for logs and error messages, e.g. "quickbooks". */
  provider: string;
  /** Origin (and optional base path) of the provider API: https, or http on loopback for local mocks. */
  baseUrl: string;
  /** Lane the calls are made for (logged). */
  laneId?: LaneId;
  /** Bucket key for the rate limit, e.g. the connection id (QuickBooks limits per realm). Default: the provider. */
  rateLimitKey?: string;
  rateLimit?: RateLimit;
  /** Per attempt. Default 30 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Backoff base and cap. Defaults 500 ms and 30 s. A Retry-After above the cap ends retrying. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Response header carrying the provider's request id (e.g. `intuit_tid`, `request-id`). */
  requestIdHeader?: string;
  /** Extracts a provider error code from a parsed error body (e.g. Intuit Fault.Error[0].code). Redacted after. */
  errorCode?: (body: unknown) => string | null | undefined;
  /** Largest response accepted. Default 20 MB. */
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
  /** Values for `{name}` placeholders; URL-encoded. */
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  /** JSON body (serialised) or a URLSearchParams form body (OAuth token endpoints). */
  body?: unknown;
  auth?: { scheme: "Bearer" | "Basic"; secret: SecretValue | (() => Promise<SecretValue>) };
  /** Retry this request on 429/5xx/timeouts. Default: true for GET/PUT/DELETE, false for POST/PATCH. */
  retry?: boolean;
  signal?: AbortSignal;
};

export type HttpResponse<T = unknown> = {
  status: number;
  headers: Headers;
  data: T;
  providerTid: string | null;
  attempts: number;
};

export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const PARAM = /\{([a-z_][a-z0-9_]*)\}/gi;
const TEMPLATE = /^\/[^?#\s]*$/;

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

function kindForStatus(status: number): ConnectorErrorKind {
  if (status === 400 || status === 409 || status === 422) return "invalid_input";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  return "provider_error";
}

/** Retry-After as seconds or an HTTP date -> milliseconds from now; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
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
  const log = (options.logger ?? connectorLog).child({ laneId: options.laneId, provider: options.provider });
  const limiter = options.rateLimit
    ? RateLimiter.for(`${options.provider}:${options.rateLimitKey ?? "*"}`, options.rateLimit, { now, sleep })
    : null;

  const buildUrl = (req: HttpRequest): URL => {
    if (!TEMPLATE.test(req.path)) {
      throw new ConnectorError({ kind: "invalid_input", message: "path must be a template starting with / (no query or fragment)" });
    }
    const filled = req.path.replace(PARAM, (_m, name: string) => {
      const v = req.params?.[name];
      if (v === undefined) throw new ConnectorError({ kind: "invalid_input", message: `missing path parameter ${name}` });
      return encodeURIComponent(String(v));
    });
    const url = new URL(base.origin);
    url.pathname = `${basePath}${filled}`;
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    return url;
  };

  const backoff = (attempt: number) => Math.min(retryMaxMs, Math.floor(random() * retryBaseMs * 2 ** attempt));

  return {
    async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
      const url = buildUrl(req);
      const endpoint = req.path;
      const retryable = req.retry ?? (req.method === "GET" || req.method === "PUT" || req.method === "DELETE");
      const fail = (init: { kind: ConnectorErrorKind; message: string; http_status?: number | null; provider_tid?: string | null; provider_error_code?: string | null; retry_after_seconds?: number | null }) =>
        new ConnectorError({ ...init, endpoint });

      let attempt = 0;
      for (;;) {
        if (req.signal?.aborted) throw fail({ kind: "timeout", message: `${options.provider} ${req.method} ${endpoint} was cancelled` });
        if (limiter) await limiter.take();

        const headers = new Headers(req.headers);
        headers.set("accept", headers.get("accept") ?? "application/json");
        let body: string | URLSearchParams | undefined;
        if (req.body instanceof URLSearchParams) body = req.body;
        else if (req.body !== undefined) {
          body = JSON.stringify(req.body);
          headers.set("content-type", "application/json");
        }
        if (req.auth) {
          const secret = typeof req.auth.secret === "function" ? await req.auth.secret() : req.auth.secret;
          if (!isSecretValue(secret)) throw fail({ kind: "invalid_input", message: "auth must be a SecretValue" });
          headers.set("authorization", `${req.auth.scheme} ${secret.reveal()}`);
        }

        const started = now();
        const signals = [AbortSignal.timeout(timeoutMs), ...(req.signal ? [req.signal] : [])];
        let res: Response | undefined;
        let transportKind: "timeout" | "transient" | null = null;
        try {
          res = await doFetch(url, { method: req.method, headers, body, redirect: "error", signal: AbortSignal.any(signals) });
        } catch (e) {
          transportKind = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "transient";
        }

        const providerTid = options.requestIdHeader ? (res?.headers.get(options.requestIdHeader) ?? null) : null;
        log.info("connector.http", {
          method: req.method,
          endpoint,
          status: res?.status ?? null,
          outcome: transportKind ?? (res && res.ok ? "ok" : "error"),
          duration_ms: now() - started,
          attempt: attempt + 1,
          provider_tid: providerTid,
        });

        // ---- transport failure (timeout, DNS, reset, refused redirect)
        if (!res) {
          if (req.signal?.aborted) throw fail({ kind: "timeout", message: `${options.provider} ${req.method} ${endpoint} was cancelled` });
          if (retryable && attempt < maxRetries) {
            await sleep(backoff(attempt));
            attempt += 1;
            continue;
          }
          throw fail({
            kind: transportKind ?? "transient",
            message: `${options.provider} ${req.method} ${endpoint} ${transportKind === "timeout" ? "timed out" : "could not be reached"}`,
          });
        }

        // ---- retryable status
        if (RETRY_STATUS.has(res.status)) {
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
          await res.body?.cancel().catch(() => undefined);
          const wait = retryAfterMs ?? backoff(attempt);
          if (retryable && attempt < maxRetries && wait <= retryMaxMs) {
            await sleep(wait);
            attempt += 1;
            continue;
          }
          throw fail({
            kind: kindForStatus(res.status),
            message: `${options.provider} ${req.method} ${endpoint} failed with ${res.status}`,
            http_status: res.status,
            provider_tid: providerTid,
            retry_after_seconds: retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000),
          });
        }

        // ---- body (size-capped), then success or a non-retryable error
        let data: unknown;
        try {
          data = await readBody(res, maxBytes);
        } catch (e) {
          throw e instanceof ConnectorError ? new ConnectorError({ ...e.info, endpoint }) : toConnectorError(e);
        }
        if (!res.ok) {
          let code: string | null = null;
          try {
            code = options.errorCode?.(data) ?? null;
          } catch {
            code = null;
          }
          throw fail({
            kind: kindForStatus(res.status),
            message: `${options.provider} ${req.method} ${endpoint} failed with ${res.status}`,
            http_status: res.status,
            provider_tid: providerTid,
            provider_error_code: code ? code.slice(0, 128) : null,
          });
        }
        return { status: res.status, headers: res.headers, data: data as T, providerTid, attempts: attempt + 1 };
      }
    },
  };
}

async function readBody(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  const tooBig = () => new ConnectorError({ kind: "provider_error", message: "Response is larger than the limit", http_status: res.status });
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw tooBig();
  if (buf.byteLength === 0) return null;
  const text = new TextDecoder().decode(buf);
  const type = res.headers.get("content-type") ?? "";
  if (/\bjson\b/i.test(type)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError({ kind: "provider_error", message: "Response is not valid JSON", http_status: res.status });
    }
  }
  return text;
}
