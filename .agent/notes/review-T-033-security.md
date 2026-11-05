# T-033 security review (Nov 2, 2026, commit 689b2b4): open findings to fix

No BLOCKER. **2 HIGH (must fix before T-033 is done):**

- **H1 `vault/secret.ts`:** `knownSecrets()` returns the live Set of every plaintext token (all lanes); `rememberSecret`/`forgetSecretsForTests` are exported and unrestricted (a relative import from apps/web lints clean). Fix: keep the Set private, export only `scrubKnownSecrets(text, mark)`; test reset via a test-only entry; add these names to RESTRICTED_NAMES (TOKEN_VAULT + packages/connectors/src/log) with config.test fixtures.
- **H2 lint bypass via relative paths:** `../../../packages/connectors/src/contract/internal`, `.../contract/lane-bound` (forge lane-bound connections) and `.../vault/index` (connectionLoader with the job client) lint clean from apps/web. Fix: restrict `mintLaneBoundConnection`, `buildProviderSchemas` (CONNECTORS) and `connectionLoader`/`createConnectionLoader` by name; add a rule that resolves relative specifiers and flags imports into `packages/<pkg>/src` from outside `packages/<pkg>`; failing fixtures for apps/web and modules.

MEDIUM:
- M1 encoded forms of known secrets not scrubbed (URL-encoded, base64, hex, JSON-escaped): register variants in rememberSecret; canary cases.
- M2 no-vault-access misses SQL text (`select * from vault.decrypted_secrets`): match `(^|[^\w])vault\s*\.` plus `decrypted_secrets`, `create_secret`, `update_secret` anywhere; SQL fixtures.
- M3 pattern gaps: `X-API-Key:`, `Authorization: Token`, `?apikey=`, camelCase JSON keys (accessToken, refreshToken, clientSecret), single-quoted/unquoted `access_token: x`, JWE with empty 2nd segment (Intuit shape). Also register connector env secrets with the redactor.
- M4 `ConnectorError.endpoint` not redacted/validated: redactText it; null if it fails `/^\/[^?#\s]*$/`.

LOW: L1 registry eviction (re-register on reveal, TTL); L2 nested token-set fields; L3 document <8-char limit; L4 rename `reveal` (e.g. `revealForProvider`); L5 `export * from` vault not flagged, test every subpath; L6 validate actorUserId as UUID (22P02 currently maps to transient); L7 tests: React Flight / prompt builder, encoded variants, relative imports, endpoint, eviction; L8 deployment: production Postgres must not log statement parameters (log_min_duration_statement, auto_explain, pgaudit).
