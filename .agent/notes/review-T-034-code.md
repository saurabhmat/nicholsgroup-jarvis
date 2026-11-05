# T-034 code review (Nov 2, 2026, commit f3b55ed): findings

No BLOCKER. **1 HIGH (must fix):**

- **H1 body-read failures are permanent and lose context** (`client.ts` 228-233, readBody): fetch resolves on headers; a stalled body (per-attempt timeout), a reset mid-body or a caller abort during `arrayBuffer()` becomes `provider_error`/fail with endpoint null, never retried (breaks QB-3); the log line already said `outcome: "ok"`. Fix: read the body inside the attempt, map TimeoutError → timeout, caller abort → cancelled, TypeError → transient, retry when retryable, keep endpoint/status, log after the body; tests for a stalled body and a reset.

MEDIUM:
- M1 caller abort reported as `timeout`/retry; sleep and limiter.take ignore the signal. Abortable waits; distinguishable cancelled error (fail).
- M2 401 = 403 (forbidden); a 401 with unparsable/oversized JSON body becomes provider_error. On !ok, body failures never change the kind; document http_status 401 as the refresh signal; token endpoint needs an errorCode extractor.
- M3 `redirect: "error"` TypeError retried as transient. Use `redirect: "manual"`, 3xx → provider_error, no retry.
- M4 non-JSON 2xx returned as string typed T. `responseType: "json" | "text"`, json mode rejects non-JSON 2xx.
- M5 size cap ineffective without content-length (same as security M1).
- M6 logging: all info; no kind / provider_error_code / retry_in_ms / final; no connectionId option; child() overwrites a bound lane with undefined.
- M7 test gaps: body-read failures, abort mid-flight/backoff, past Retry-After date, 503 over cap, 429 on POST, concurrent take(), toConnectorError path; MSW test uses an unresolvable host.

LOW: L1 unmocked requests become transient ConnectorErrors (caught by connector code) and are retried: record unhandled frames, fail in afterEach. L2 limiter first-caller-wins limit and clock, buckets never freed. L3 Retry-After `Date.parse` lenient ("1.5" → 0 ms): accept IMF-fixdate only. L4 options not validated. L5 JSON body forces content-type, no raw string body (QBO query is application/text); Basic username/password helper; 429 on POST safe to retry. L6 `HttpResponse` name clashes with MSW's.
