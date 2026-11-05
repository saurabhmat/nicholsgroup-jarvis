# T-033 code review (Nov 2, 2026, commit 689b2b4): open findings to fix

No BLOCKER. **2 HIGH (must fix before T-033 is done):**

- **H1 logger loses error detail** (`log/redact.ts` scrub + redactMetadata): a ConnectorError becomes `{error_name, error_summary}` (kind, http_status, provider_tid, provider_error_code... lost); the audit key policy drops `provider_error_code`, `external_account_id`, `token_expires_at`; strings cut at 200. Breaks T-034/T-040/T-195/T-196. Fix: `isConnectorError(v) → v.toJSON()` before the Error case; a logger-specific key policy (drop only credential-named keys; keep ConnectorErrorInfo fields, `*_expires_at`, `*_error_code`); tests.
- **H2 `ConnectorError.endpoint` not redacted** (`contract/errors.ts`): use the redactor, and null it when it fails `/^\/[^?#\s]*$/` (same as security M4). Canary test with a secret in the path and `?access_token=`.

MEDIUM:
- M1 false positives: "Basic plan…", `code=6000`, `key=CustomerRef`, `re_authorization_required`, Stripe code `secret_key_required` all redacted. Fix: bearer/basic only after `(Proxy-)?Authorization:` or for long values; query pattern anchored to `[?&#]` and/or value length ≥ 8 for code/key/sig; provider_error_code/provider_tid get exact-match + whole-value check only; negative tests.
- M2 rememberSecret registers every string field of a token set (scope, expires_at get redacted everywhere): register credential-named fields only.
- M3 false negatives (overlaps security M3): split words on `:`/`=` too; camelCase keys; `apikey`, `x-api-key`; `Token` scheme; encoded forms.
- M4 loader maps an unavailable lane to `transient` (vault: `connection_unavailable`): own try around clientFor in the loader; test.
- M5 rotateToken has no compare-and-swap; T-050 needs "concurrent refresh doesn't lose the token". Decide now (per-connection Inngest concurrency key for refresh, or `p_expected` in `connection_token_rotate`) and record in plan-review §6.
- M6 the redactor is unreachable outside connectors, but Sentry (T-041/T-196) needs the same scrubbing: expose `@nichols/connectors/redact` (redactText, redactFields only) or decide where beforeSend lives.

LOW: L1 logger tests (event fallback, throwing sink, child context with undefined overriding, console routing); L2 tests for 22004/42883 (PostgREST missing function is PGRST202), loader asserts schema("core"); L3 validate actorUserId, map 22P02 → invalid_input; L4 rename `id` → `redactId`, `schema("core")` called twice, effective depth 4; L5 dedicated message for the internal-subpath restriction, update the no-restricted-names header; L6 hint that `reveal`/`getToken` are generic names; L7 `knownSecrets()` returns the live Set (see security H1), LRU eviction; L8 cap message size (64 KB) before redacting; L9 note in `.agent/pr/T-033.md` that the RSC/prompt canary tests are approximations.

Notes for downstream: T-035's callback must live in packages/connectors (storeToken is restricted there), with apps/web routes as thin wrappers; T-035 needs a create-connection-row-and-mint path before storeToken.
