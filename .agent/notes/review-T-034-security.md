# T-034 security review (Nov 2, 2026, commit f3b55ed): findings

No BLOCKER. **1 HIGH (must fix):**

- **H1 path traversal through params** (`http/client.ts` buildUrl): `encodeURIComponent` keeps `.`/`..`, and the URL parser collapses dot segments, so `{id} = ".."` turns `/v1/customers/{id}/refunds` into `/v1/refunds`, and `../../../gmail/...` escapes a Google base path. Same host (not SSRF), but the authenticated request hits a different endpoint while logs and errors show the template. Fix: reject empty / `.` / `..` param values (allow-list characters), reject templates with `/./`, `/../`, `//`, assert the final pathname starts with basePath + "/"; tests for `..`, `.`, `%2e%2e`, `a/../b`.

MEDIUM:
- **M1** size cap ineffective without content-length (chunked) and for compressed bodies (content-length is the compressed size): stream with a reader, count bytes, cancel past maxBytes; test with a ReadableStream body.
- **M2** rate-limit buckets keyed `${provider}:${rateLimitKey ?? "*"}` without lane (cross-lane starvation, rule 1); first caller's limit silently wins; `take()` ignores `req.signal`. Fix: laneId required and in the key; throw on a different limit for an existing key; abortable wait.
- **M3** `headers.set("authorization", ...)` outside try: a token with CR/LF makes undici throw a TypeError whose message contains the header value; a foreign error from `auth()` also escapes unwrapped. Fix: try/catch → toConnectorError; optionally validate the revealed value as `^[\x21-\x7e]+$`.

LOW:
- L1 timeout during body read reported as provider_error (should be timeout).
- L2 `code.slice` outside try: a non-string errorCode result throws a raw TypeError.
- L3 `@nichols/connectors/testing*` / `msw` importable from app code: restrict to test files.
- L4 MSW guard is opt-in per file (no global setupFiles); the "never reach a real provider" test uses an unresolvable host.
