# T-062 security review: findings and resolution

0 BLOCKER, 0 HIGH, 3 MEDIUM. All fixed.

1. Foreign-provider connection could be refused after a token read or request. Fixed: the mock refuses with `forbidden` before the token read; the contract now pins `forbidden` and asserts `externalRequestCount`/`tokenReads` do not move across every guard failure. A self-check (provider that "fetches" then throws `provider_error`) must fail the suite.
2. `renew`/`stop` trusted the caller's `WatchInfo`. Fixed: documented that real providers verify against server-side state keyed by (lane, connection); the mock does; the contract proves connection B cannot renew or stop A's channel (`not_found`, A's channel untouched). Guard lists now cover renew/stop and calendar/document `prepareWrite`.
3. Unvalidated ids and spoofing characters. Fixed: `ProviderIdParamSchema` for every id parameter (rejects `""`, `a/b`, `..`, `x?y`, `x#y`, control chars, 513 chars; contract-tested without reaching the API); C1, U+2028/2029 and bidi controls rejected in subjects and display names; recipients lower-cased and de-duplicated.

Also: cursors are bound to their connection (foreign cursor -> `fullResyncRequired`); WatchInfo never carries the channel token.
