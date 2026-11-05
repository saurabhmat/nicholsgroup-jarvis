# T-035 code review (Nov 2, 2026, commit d5f469e): findings

No BLOCKER. **1 HIGH (must fix).**

Checks run: `pnpm -C packages/connectors test` (213 passed, 5 skipped, all skips from before this commit), `typecheck` and `lint` for connectors and apps/web, `pnpm -C packages/eslint-plugin test`, `node scripts/test-db.mjs --no-reset` (11 files / 368 tests pass, including 100_oauth_states), `db:types:check` (ok: `types.ts` matches the migration). All pass.

The flow itself is correct. The state is 32 random bytes and only its SHA-256 is stored. PKCE is S256 with a 43-character verifier. Consume uses an atomic `delete ... returning` bound to user, lane and expiry, and re-checks role and aal2. The state is consumed before the `error`/`code` check, so a declined consent also spends it. The token exchange uses `retry: false` and the stored redirect URI. The route handlers follow Next 16 conventions: `RouteContext<...>`, awaited `params`, POST + 303 for start, and a relative `Location` on the callback. The session cookie is SameSite=Lax, so it reaches the cross-site GET callback. `getAudit` and `getLaneJobClient` are lazy, so importing `oauthFlow` at module scope does not read env at build time. Not repeated here: security review M1, M2 and L1–L8 (`review-T-035-security.md`).

## HIGH

- **H1 The acceptance criterion "generic start/callback route handlers … tested end-to-end against a mock OAuth server" is only half met** (`apps/web/app/api/connect/[provider]/start/route.ts:8-25`, `callback/route.ts:8-24`, `packages/connectors/src/oauth/state.ts:16-37`, `oauth/index.ts:14-20`).
  - What is tested: `flow.test.ts` drives `createOAuthFlow` against MSW. It uses an in-memory twin of the state store, a fake `ensureConnection` and a fake `storeToken`.
  - What runs in no test at all:
    - the route handlers: Origin check (CSRF control), 404 for an unknown slug, 403/429/503 mapping on start, the 303 to the provider, and the callback's 303 `Location` (`/?connect=<reason>&provider=`) with `no-referrer`/`no-store`;
    - `dbStateStore`: the 42501→forbidden and 54000→rate_limited mapping that the start route depends on, and row parsing;
    - the real wiring in `oauth/index.ts`.
  - Also, `OAUTH_PROVIDERS` is empty, so the routes cannot be exercised by e2e either.
  - Failure scenario: someone changes the Origin comparison (e.g. to `referer`, or drops it when refactoring), or `dbStateStore` maps 54000 to `transient`. Every test stays green. A cross-site form can then start connects, or a user who hit the cap sees 503 instead of 429.
  - Fix:
    - Move the handler bodies into testable functions, e.g. `handleConnectStart(request, provider, flow, authorizer)` in `apps/web/lib/connect.ts`, with a flow injected. Unit-test them with a flow from `createOAuthFlow` plus the MSW token endpoint: Origin missing, `null` and foreign → 403; unknown slug → 404; forbidden / rate_limited / outage → 403/429/503; success → 303 to the authorize URL; callback ok/denied/invalid_state → 303 to the right relative `Location`; AuthError → 401/403.
    - Add `state.test.ts` for `dbStateStore` with a fake RPC client (error-code mapping, null/partial rows → null).
    - apps/web has no vitest yet. Either add it, or put the handler functions in `packages/connectors/src/oauth/routes.ts` and test them there.

## MEDIUM

- **M1 Any `identify` failure is reported as `account_refused`, including outages** (`packages/connectors/src/oauth/flow.ts:188-192`).
  - The contract invites `identify` to call the provider ("May call the provider with `http`"). Any throw, including a `transient`/`timeout` ConnectorError or a TypeError, is wrapped in `RefusedAccount`.
  - Failure scenario: QuickBooks CompanyInfo times out during identify. The UI says the account was refused, the admin picks a different company file, and the log shows `reason: account_refused`, so on-call cannot tell an outage from a mismatch.
  - Fix: treat only ConnectorError kinds `invalid_input`/`forbidden` (or a dedicated `AccountRefused` error the adapter throws) as `account_refused`. Report everything else as `unavailable`. Add a test with a transient identify failure.

- **M2 A failed success-audit after the token is stored reports failure for a connect that succeeded** (`flow.ts:184-205`, with `withAudit` in `packages/core/src/audit/index.ts:202`).
  - `withAudit` writes `.succeeded` after `storeToken` returns, outside its try. If that insert fails, the callback returns `unavailable` and logs `oauth_callback_failed`, but the connection is already `active` with a stored token (the SQL also wrote `connection.token_stored`).
  - Failure scenario: an audit outage during the callback. The admin sees "unavailable" and retries the whole consent, which for Intuit rotates or duplicates grants. Or they assume the file is not connected while syncs start.
  - Fix: after `storeToken`, return success even when the `.succeeded` log fails (log the audit failure via `connectorLog`), or catch around the post-store audit only. Add a test where the audit sink fails only on `.succeeded`.

- **M3 `core.connections.created_by` is never set by the connect flow** (`packages/connectors/src/vault/connections.ts:23-28`, `flow.ts:193`).
  - The T-031 schema documents `created_by` as "Who started the connect flow (verified session); null for service-created rows". `ensureConnection` inserts without it, and it runs on the service client, so every OAuth-created row looks service-created.
  - Failure scenario: Settings → Connections (T-197) or an incident review cannot tell who connected the PKG QuickBooks file from the row. It only shows up in the audit log.
  - Fix: `ensureConnection(laneId, provider, externalAccountId, createdBy?: string)` sets `created_by` on insert (ignored on conflict). Pass `userId` from the callback. Extend `connections.test.ts` and the flow test.

- **M4 The `http` client handed to `identify` is bound to the token endpoint's origin** (`flow.ts:186`).
  - The real account checks run on other hosts:
    - Intuit CompanyInfo runs on `quickbooks.api.intuit.com`, not `oauth.platform.intuit.com`.
    - Google userinfo/Gmail profile runs on `openidconnect.googleapis.com`/`gmail.googleapis.com`, not `oauth2.googleapis.com`.
    - Microsoft Graph is on `graph.microsoft.com`, not `login.microsoftonline.com`.
  - Failure scenario: T-050/T-063 adapters cannot use the provided client for the identity check that security L4 requires. Each one builds its own client ad hoc, or worse, trusts the callback `realmId`.
  - Fix: give `OAuthProvider` an optional `apiBaseUrl` (or let `identify` receive `httpFor(baseUrl)`), and document which host it is for. Add a test where identify calls a mock API host.

- **M5 Errors in a top-level browser navigation are returned as raw JSON** (`start/route.ts:16-23`, `callback/route.ts:43-47`).
  - Both routes are reached by navigation (form POST, provider redirect), but AuthError, forbidden, 429 and outages answer `{"error": ...}` JSON. Only callback flow results become a redirect.
  - Failure scenario: an admin's session dropped to aal1, or the lane was disabled during consent. They land on a bare `{"error":"mfa_required"}` page with the code and state still in the URL bar, and the unconsumed state cannot be resumed.
  - Fix: redirect both routes to `/?connect=<reason>` (`unauthenticated`, `mfa_required`, `forbidden`, `too_many_connects`, `unavailable`), and for 401 to `/sign-in?next=/`. Keep JSON only for non-navigation requests if needed. Cover it in the H1 tests.

## LOW

- **L1 Start creates the state and audits `connect_started` before validating the authorization endpoint** (`flow.ts:133-141`). A non-https endpoint leaves a live state row and a "started" audit entry for a connect that never left the server. The test "does not start a connect it cannot audit" passes, but the state row it leaves is never mentioned. Fix: build and validate the URL (https, parse) before `states.create`, then audit, then return.
- **L2 Token-set size and shape can fail after the code is spent** (`flow.ts:43-51`, `:194`; vault limit `connection_token_check_secret` 16384).
  - `access_token` ≤ 8192 + `refresh_token` ≤ 8192 + unbounded `.loose()` extras (`id_token`) + `obtained_at` can exceed the Vault's 16384. `storeToken` then fails with 22023 → `unavailable`, after a pending row was inserted (security L6).
  - `expires_in` must be a JSON number, but some providers send it as a string. That gives `exchange_failed`.
  - Fix: check the serialized length against 16384 before `ensureConnection` (→ `exchange_failed`), and accept a numeric string for `expires_in` (`z.coerce.number()` with `int().positive()`).
- **L3 Vacuous pgTAP assertion** (`supabase/core/supabase/tests/100_oauth_states.test.sql:62-63`). `code_verifier = 's-admin'` can never be true (verifiers are `rpad('verifier-…', 43)`), so "the state itself is not stored, only its hash" passes whatever is stored. Fix: assert `not exists (select 1 from core.oauth_states where state_hash = 's-admin' or code_verifier = 's-admin' or redirect_uri like '%s-admin%')`, and `exists (… where state_hash = pg_temp.h('s-admin'))`.
- **L4 Duplicate-slug rejection is untested, and there is dead code** (`packages/connectors/src/oauth/flow.test.ts:314-318`). The test is named "refuses duplicate or malformed provider slugs" but checks only a malformed slug, and `const base = setup(); void base;` does nothing. Fix: call `createOAuthFlow` with two providers that share a slug and expect TypeError. Drop `base`.
- **L5 Audit action names are inconsistent** (`flow.ts:137` vs `:175`). `connection.connect_started` sits next to `connection.connect.requested/.succeeded/.failed`. Queries filtering on `connection.connect.%` miss the start. Fix: use `connection.connect.started` (or route start through the same `entry`).
- **L6 The provider list is duplicated in SQL** (`supabase/core/supabase/migrations/20261102070000_oauth_states.sql:15-16`). The CHECK copies `core.connections`' provider list, so adding a provider (e.g. T-06x) needs both changed or the connect start fails with 23514 → 503. Fix: a shared domain/function (e.g. `core.is_provider(text)`) used by both tables, or a comment in both places pointing at the other plus a pgTAP test that the two lists match.
- **L7 apps/web now depends on all of `@nichols/connectors`** (`apps/web/package.json`, `scripts/dependency-allowlist.test.mjs:17`). The intent is the `/oauth` subpath only, but the root contract and `/writer` are now importable from the app, guarded only by restricted names. Fix (optional): a lint rule allowing `@nichols/connectors/*` in apps/web only for `/oauth` (and `/redact` already used by instrumentation).

## Verified, no finding
- `packages/core/src/db/types.ts`: `oauth_states` Row/Insert/Update and the two RPC signatures match the migration (`db:types:check` ok).
- `next.config.ts`: adding `@nichols/connectors` to `transpilePackages` is required because the package exports TS source. `server-only` (via lane-router) keeps `/oauth` out of client bundles.
- `packages/connectors/package.json`: the `./oauth` export matches the other subpaths. No new third-party dependency, and the lockfile only re-resolves next's existing `@opentelemetry/api` peer.
- ESLint restricted names (`connectionStore`, `createConnectionStore`, the `forgetSecretsForTests` exception) are correct and tested.
- pgTAP 100_oauth_states covers the privileges, the role/aal/lane/disabled-lane matrix on create, other-user/aal1/cross-lane/replay/unknown/demoted/expired on consume, and the 10-in-flight cap. Gaps besides L3: consume on a disabled lane, and the `redirect_uri` CHECK.
