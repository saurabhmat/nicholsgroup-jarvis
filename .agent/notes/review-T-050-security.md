# T-050 security review (commit 44278b8)

Reviewer: security-reviewer subagent, Nov 4, 2026. Scope: `git show 44278b8`, checked against CLAUDE.md rules 1-13, T-050 acceptance, QB-1 to QB-20, `.agent/pr/T-050.md`, plan-review §6 (T-050) and §7 (Oct 28 QuickBooks, Nov 2 Vault tokens). No code was edited.

Result: **0 BLOCKER, 1 HIGH, 4 MEDIUM, 7 LOW.** T-050 is app code (connectors/tokens), so the HIGH has to be fixed before the task is done.

## HIGH

### H1. The QuickBooks connector, token manager and API client never check `conn.provider`. Another provider's tokens can be sent to Intuit and then deleted.
- `packages/connectors/src/quickbooks/connector.ts:64-74` (`loadRow` / `useConnection`, used by `health`, `read`, `disconnect`)
- `packages/connectors/src/quickbooks/token-manager.ts:101-103, 174-185` (`readStored`, `accessToken`, `refreshToken`)
- `packages/connectors/src/quickbooks/api.ts:59`
- `packages/connectors/src/quickbooks/index.ts:55` (the `as Promise<QboConnection>` cast hides the gap from the type checker)
- Scenario: `assertLaneBound` only checks the brand and the lane, and `connectionLoader.loadConnection(lane, id)` returns any provider's row. A future dispatcher, `conn.sync` job or tool that resolves a connector and passes a connection id it was given (for example a Google connection in PKG after T-063) gets past every check:
  - `health`/`read` send the Google access token as `Bearer` to `quickbooks.api.intuit.com`.
  - On a 401, `refresh` posts the Google refresh token to Intuit's token endpoint with the Intuit client credentials.
  - `disconnect` posts the Google refresh token to Intuit's revoke endpoint and then `vault.revokeToken` deletes the Google credential. The T-035 flow stores `{...tokens, obtained_at}` for every provider, so `parseStored` accepts a Google set.
  - For a Stripe API-key credential, `parseStored` fails with `provider_error`. `disconnect` swallows that kind (line ~172) and still deletes the credential.
  - Result: a token is leaked to a third party (rule 4) and another integration is disconnected without anyone asking.
- Fix:
  - In `loadRow`, refuse with `lane_mismatch`/`not_found` unless `row.provider === "quickbooks"` (and also `conn.provider` before the load).
  - Add the same check to `TokenManager.accessToken/refreshToken` and `QboApi.get`, so neither can be used with a non-QuickBooks connection.
  - Remove the cast in `index.ts`.
  - Add a test that passes a lane-bound `google`/test-provider connection to `health`, `read`, `disconnect` and `tokens.*`, and asserts no request reaches the Intuit mock and the Vault entry is untouched. Better still, add that case to the shared contract kit so every connector gets it.

## MEDIUM

### M1. The callback `realmId` is chosen by the user and is never checked against the token that was issued.
- `packages/connectors/src/quickbooks/provider.ts:51-58`; `packages/connectors/src/oauth/flow.ts:202-208`
- Scenario: the lane is configured for realm A and is already connected. An owner or admin_technical (malicious, or following a bad link) authorises company B at Intuit, then edits the callback URL to `realmId=A` before it loads. The state is valid (same user), and `precheck`/`identify` pass because they read only the query string. The code is exchanged for B's tokens. `ensureConnection(lane, quickbooks, A)` returns A's existing row and `storeToken` overwrites A's working tokens with B's. The live connection breaks and needs a reconnect. With no realm configured, the lane is also pinned to a realm id the token does not match. `fetchCompanyInfo` (`c.Id !== realm`) catches this later, but only after the good tokens are gone.
- Fix: in `identify`, call `GET /v3/company/{realm}/companyinfo/{realm}` on `API_BASE[env]` with the new access token. Accept only a 200 whose `CompanyInfo.Id === realm`; otherwise throw (RefusedAccount) and revoke the new grant. Add a test for a tampered `realmId`.

### M2. `connector.connect` is a second way for tokens to reach the Vault, with no state, user, AAL2 or audit actor.
- `packages/connectors/src/quickbooks/connector.ts:82-115`
- Scenario: the acceptance says "tokens enter the Vault only from the callback". `connect` takes a raw `code`. `code_verifier` is optional, so PKCE can be skipped. It does no state check and no role/AAL2 check, and calls `storeToken` without `actorUserId`, so the audit entry has no user. Nothing outside the tests calls it today, and `quickbooks/index.ts` is not in the package `exports`. But any future server action, Inngest job or tool that wires it up would skip T-035's CSRF and user binding.
- Fix (either of):
  - Make `connect` refuse unless it receives an object that only `oauthFlow.callback` can mint (a consumed-state brand, like `mintLaneBoundConnection`) and that carries `userId`. Require `code_verifier`.
  - Or have the contract kit drive the real flow and make `connect` refuse `oauth_code` too.
- Also add a lint `no-restricted-imports` rule for `quickbooks/index` outside `oauth/registry.ts`.

### M3. Disconnect: no authorization or actor, the rule-5 exception is not written down, and a 401/403 from revoke deletes local tokens while the grant stays live.
- `packages/connectors/src/quickbooks/connector.ts:163-195` (especially the catch at ~186-190 and `revokeToken(laneId, row)` at 193 with no actor)
- Who can call it: nothing yet. There is no route and the module is not exported. The connector itself enforces no role, AAL2 or audit actor, so it relies entirely on a future caller.
- Rule 5:
  - The token exchange, the refresh and the revoke are calls to Intuit's OAuth endpoints about our own grant, not writes to QuickBooks data. Treating them like T-035's connect (owner/admin_technical at AAL2, audited with the user, not routed through approvals) is consistent and reasonable.
  - But CLAUDE.md rule 5 has no written exception. That decision belongs to a human: record it in plan-review §7 / architecture ("OAuth token and revocation endpoints of our own grant are not external writes; gated by CONNECT_ROLES + AAL2 + audit").
  - T-195 must put disconnect behind the same `requireRole(owner, admin_technical, aal2)` guard and pass `actorUserId`.
- Revoke error handling: the HTTP client maps 401 to `forbidden`, so a 401 or 403 from Intuit's revoke endpoint is treated as "token already invalid". That is also what happens when our client credentials are wrong (for example a mis-set `INTUIT_CLIENT_SECRET`). We then delete our copy and mark the connection disconnected while the grant stays authorised at Intuit, so QB-8 fails silently. Fix: treat only 400 (`invalid_token`/`invalid_grant`) as "already revoked". On 401/403 stop, keep the tokens and return `connection_unavailable` so the admin sees it. Add a test.

### M4. The refresh assumes a grace period, and the refresh POST has `retry: true`.
- `packages/connectors/src/quickbooks/token-manager.ts:110-118`
- Already logged as MEDIUM in plan-review §6. This adds one path the note does not mention: the HTTP client retries the refresh POST on a timeout or a lost response after Intuit may already have rotated. If Intuit invalidates the previous refresh token at once, a retry or a lost cross-instance race forces a reconnect. The CAS stops lost writes but cannot recover a token Intuit has already invalidated.
- No refresh token is duplicated or lost in our store: the CAS migration is correct (see "Checked and OK").
- Fix:
  - Make the Nov 12 sandbox check (manual step 9) a hard precondition of H-024 in the backlog, not just a risk note.
  - Retry the refresh only on errors where the request was never sent (connect refused or DNS). On a timeout after the request was sent, re-read the Vault instead.
  - If the grace period is absent, add the `refresh_lock_until` lease the note proposes.

## LOW

- **L1. No configured realm means any realm is accepted (fail-open).** `packages/connectors/src/quickbooks/realm.ts:26`. This is already logged. Suggest failing closed when `APP_ENV=production`, or making `lane_config.qbo.realm_id` a checked precondition of H-024. The seed already pins PKG to `1001`.
- **L2. The discovery host allowlist is broad.** `packages/connectors/src/quickbooks/discovery.ts:29-30`. Suffix tricks are rejected correctly: `intuit.com.evil`, `evilintuit.com`, a trailing dot, userinfo, a port and punycode lookalikes all fail. Redirects are not followed, the origin is a constant and the response is capped at 256 KB, so I see no SSRF. Still, any `*.intuit.com` host is accepted for the endpoint that receives the client secret and refresh token. Pin each endpoint to its expected host (`appcenter.intuit.com` for authorization, `oauth.platform.intuit.com` for token and revoke) and fail closed on anything else.
- **L3. The discovery cache is not keyed by lane (rule 1: "every ... cache entry takes laneId").** `discovery.ts:61`. It holds public provider metadata, so this is defensible. Record it as an explicit exception in architecture.md or plan-review §7, or key the map by `(lane, environment)` (the cost is trivial).
- **L4. `NEXT_DIST_DIR` is honoured in every environment.** `apps/web/next.config.ts:6`. Anyone with Vercel env access could set it to `public/x` and get server chunks served as static files. That needs env-write access, which already means compromise, so this is LOW. Accept only `".next-canary"`, and only when `VERCEL` is unset: `process.env.NEXT_DIST_DIR === ".next-canary" && !process.env.VERCEL`.
- **L5. `INTUIT_WEBHOOK_VERIFIER_TOKEN` is optional.** `packages/core/src/env/schema.ts:242`. There is no webhook receiver yet (`apps/web/app/api` has no webhook route), so nothing fails open today. Risk: T-053 reads `requireConnectorEnv("intuit")`, gets `undefined`, and a careless check such as `hmac(undefined, ...)` or an empty-string key accepts forged payloads. Fix: give T-053 its own required shape (for example `requireConnectorEnv("intuit_webhook")`), plus a test that the receiver answers 503 or 401 when the token is unset.
- **L6. A refusal at `identify` after the exchange leaves the grant live at Intuit.** `packages/connectors/src/oauth/flow.ts:202-206`. When `identify` refuses (for example the lane config changed between `precheck` and `identify`, or M1's check fails), the tokens obtained are dropped but never revoked. Revoke them best-effort, without blocking the result.
- **L7. The canary scan covers only `INTUIT_*` and `SUPABASE_SECRET_KEY`.** `apps/web/scripts/client-bundle-check.mjs:84-90`. Add the other server secrets (Stripe restricted key, webhook secret, GHL, Resend, Inngest signing key, Anthropic) so the guard does not cover only QuickBooks. On a build failure, the tail check at lines 153-155 tests only the plain form of each canary; use `forms()` there too. Values are synthetic, so this is cosmetic.

## Checked and OK
- **OAuth `state`:** bound to lane, user and provider in SQL; 10-minute expiry; single use (`DELETE ... RETURNING` is atomic, so a replay returns nothing). The lookup is by SHA-256 hash through a unique index. There is no string comparison of the raw state in app code, so constant-time comparison does not apply and there is no timing oracle.
  - `core.oauth_state_create` and `core.oauth_state_consume`: security definer, `search_path=''`, `authenticated` only (service_role revoked), owner/admin_technical through `has_lane_role`, AAL2 through `may_resolve`.
- **Callback:**
  - The realm `precheck` runs after the state is consumed and before the code exchange.
  - The redirect goes to the fixed `/` with a coarse reason only, with `no-store` and `no-referrer`. There is no open redirect.
  - Error paths log only `ConnectorError` fields (path template, kind, tid). Code, tokens and realm never appear in a message.
  - `start` is POST with an Origin check. The callback GET's side effects are inherent to OAuth and gated by state, user and PKCE.
- **CAS migration `20261104090000`:**
  - Security definer, `search_path=''`, qualified `pg_catalog` calls.
  - Grants: revoked from public, anon and authenticated; service_role only.
  - The lane check and row lock (`connection_for_token(..., true)`) run first. The hash format is validated and the compare happens under the lock.
  - On a mismatch it raises 40001 with fixed text and changes nothing. `vault.update_secret` keeps one secret per connection, so there are never two refresh tokens or none.
  - pgTAP covers the cross-lane denial with the correct hash.
- **Logs:**
  - The HTTP client logs the path template (`{realm}`), never the resolved path, and never request or response bodies. `intuit_tid` is captured on success and on error.
  - `parseStored` never echoes the stored text. Every token-response credential is registered as a SecretValue before anything can log it.
  - CompanyInfo keeps an allowlist with no address, email or phone (rule 6).
- **Read-only:** `QboApi` exposes GET only, and `prepareWrite` is false. The only POSTs are Intuit's token and revoke endpoints (rule 5, see M3).
- **Rules 2 and 10:** no company-specific code (the realm comes from `lane_config`); synthetic values only in tests and the seed.

## Re-review (3527cf8..1b32e2b)

Reviewer: security-reviewer subagent, Nov 4, 2026. Scope: `git diff 44278b8 1b32e2b` (3527cf8 T-050 review fixes, cc9323c D-23, 1b32e2b T-198), checked against CLAUDE.md rules 1-13, D-23, D-24, T-198 acceptance, `.agent/pr/T-050.md` ("Review fixes", "D-23") and `.agent/pr/T-198.md`. No code was edited. `vitest run` re-run at HEAD: connectors 601 pass / 12 skipped, web 78 pass. (HEAD is now 3e47381, which adds the sandbox launcher `apps/web/scripts/qbo-sandbox-dev.mjs`; outside this scope, only skimmed: it reads only the four `INTUIT_*` names, refuses non-sandbox and non-local Supabase, and prints no values.)

Result: **0 BLOCKER, 0 HIGH, 1 MEDIUM, 5 LOW.** Nothing blocks T-050, D-23 or T-198. The MEDIUM must be closed before anything calls the writer (T-193 / T-195).

### Earlier findings

| Finding | Status | Regression test |
|---|---|---|
| H1 provider check | Fixed. `assertQuickbooksConnection` in `connector.ts` (`loadRow`, before and after the reload), `token-manager.ts:208,217`, `api.ts:61`, `company-info.ts`, `writer.ts:63,72`. The `as Promise<QboConnection>` cast is gone. | `connector.test.ts` "another provider's connection is refused..." (google, stripe) for health, read, revoker, `tokens.*`, `api.get`: zero Intuit requests, foreign secret and row untouched. Plus the shared-kit check. Note: `api.get` calls the token manager, so removing only the `api.ts` guard would be hidden by the token-manager guard. The property still holds; only the extra layer is not proven on its own. |
| M1 realm vs token | Fixed. `provider.ts` `identify` calls `fetchCompanyInfoWithToken` with the new token. `parseCompanyInfo` requires `CompanyInfo.Id === realm`. 401, 403, 404 and Id mismatch refuse; 5xx is "unavailable". | `connect.test.ts:301` (edited realmId: existing tokens untouched, no new row), `:325` (other company's Id), `:337` (outage). |
| L6 grant left live | Handled per D-24: no revoke. The tokens are dropped, `connection.connect.grant_not_stored` is audited, and the redirect carries `notice=remove_app_access`. | `connect.test.ts:301,347,356`, asserting `revokeRequests` stays at 0 and no token in logs or audit. |
| M2 second way into the Vault | Fixed. `connector.connect` refuses every input. | `connect.test.ts:463` (all input kinds) and `:479` (source scan: only the wiring calls `storeToken`). |
| M3 disconnect | Fixed per D-24. No `disconnect` on the connector. The revoke lives only in `writer.ts` (`qbo.revoke_grant`). Only a 400 `invalid_token`/`invalid_grant` counts as already revoked; 401, 403, 5xx and timeout keep the tokens. | Revoker fail-closed table and bad-action table in `connector.test.ts`. See W1 below for what the writer still does not check. |
| M4 refresh | Fixed. `retry: false`. On timeout, transient or `invalid_grant` it re-reads the Vault (0/250/500 ms). Only an unchanged store gives `reconnect_required`. | `refresh.test.ts:152` (strict rotation), `:173`, `:193`, `:250`. |
| L1 production realm | Fixed. `requireConfiguredRealm` is wired to `APP_ENV === "production"`. | `connect.test.ts:431-455`, including the wiring test. |
| L2 discovery hosts | Fixed. Exact host per endpoint (`discovery.ts` `ENDPOINT_HOSTS`); no query, fragment, port or userinfo. | `discovery.test.ts` parse table. |
| L4 `NEXT_DIST_DIR` | Fixed. Only `.next-canary`, and never with `VERCEL` set. | `apps/web/tests/next-config.test.ts` (7 rejected values, plus the Vercel case). |
| L3, L5, L7 | Not fixed. Logged in `docs/plan-review.md` §6 (accepted as LOW). | n/a |

### Verify item 2: no external write outside `@nichols/connectors/write` + approvals
- The only POSTs to Intuit are the token exchange (callback), refresh (`token-manager.ts`) and revoke (`revoke.ts`). `revokeGrant` has one caller, `createQuickBooksRevoker` (`writer.ts:89`).
- `quickbooksWriter` (`quickbooks/index.ts:52`) is reachable only through `@nichols/connectors/write` (`write/index.ts:5`). `@nichols/connectors/connection-test` imports `quickbooks/index` but re-exports only `checkQuickBooksConnection`.
- No route, page, job or module imports the write subpath. The source scan (`connector.test.ts:249`) pins the four files allowed to name the writer, the revoker or the subpath. Calling `.executeWrite` anywhere outside `packages/modules/approvals` is already a lint error (`nichols/no-restricted-names` covers member access in apps/web and in modules).
- `disconnectForTest` exists only in `src/testing/quickbooks-harness.ts`. That file is not exported from `@nichols/connectors/testing` (`testing/index.ts`) and not in the package `exports`. The harness directory is a lint test-only boundary (`TEST_HARNESS`), and it runs over in-memory twins. Production code cannot import it.
- The T-198 check route makes one CompanyInfo GET. A 401 can trigger a refresh, which is a token rotation, the same as any read (accepted under D-24). There is no disconnect or revoke control (asserted in `apps/web/tests/connection-test.test.ts`).

### Verify item 3: `POST /api/connection-test/qbo/check`
- Order (`apps/web/lib/connection-test.ts:66-81`):
  1. Origin must equal `url.origin`, else 403. This runs before any session work.
  2. `requireLane`, which runs `requireSession`: no session is 401, AAL1 is 403 `mfa_required`. The lane router then checks membership: forbidden or unknown is 404.
  3. `requireRole(CONNECT_ROLES)` through `has_lane_role`: 403.
  4. The switch, read with the user's own lane client (RLS). It is exactly `true` or off, a read error is off, and off is 404.
  5. The check.
- Correct, and as specified: a viewer gets 403 whatever the switch says, so the switch reveals nothing to them.
- Response: the handler destructures exactly `status`, `checked_at`, `intuit_tid` (`:80-81`). There is no realm, token or company data, and `Cache-Control: no-store` is set. Errors are 503 `unavailable`, logging only `e.name`. The client re-parses with an exact key set (`connection-check-view.ts:97-106`).
- CSRF: POST only, with a strict Origin equality check (a missing Origin fails). The session cookie alone is not enough, and the request has no side effect beyond a possible token rotation.
- Switch: `laneConfigSchema.pilot` is optional and strict, with `connection_test_enabled` defaulting to false. The seed does not set it. Fail-closed tests cover missing, false, "true", 1 and a read error.
- `checkQuickBooksConnection` uses `connectionStore.findConnection`, which validates the lane id and uses the lane router's job client filtered by `lane_id`. It runs only after the route's guard.

### Verify item 4: D-23 index and the 23505 mapping
- Index `connections_one_lane_per_account` on `(provider, external_account_id) where status <> 'disconnected'`. pgTAP 120 covers the index, the second lane refused for every non-disconnected status, other provider or account fine, disconnected frees the account, reactivating the old row is refused, and cross-lane denial.
- `connections.ts` maps 23505 to `forbidden` + `ACCOUNT_IN_USE_MESSAGE`, and `tokens.ts` does the same for reactivation. The flow turns this into `account_refused` with a fixed message that names no lane. Tested: `connect.test.ts:368` asserts no "PKG" in the result; `connections.test.ts` asserts no DB text or realm in the error.
- The refusal does tell an APK owner that the company is connected *somewhere*. Learning that requires authorising that company at Intuit, so it is accepted.

### Verify item 5: `metadataBase`
`apps/web/app/layout.tsx:23-28` reads `NEXT_PUBLIC_APP_URL` (a public value by design) through `readClientEnvFromProcess`, which reads only `NEXT_PUBLIC_*` names. Nothing secret reaches the client, and the bundle positive control proves only that one value is inlined. See R-L4 (cosmetic).

### MEDIUM

#### W1. The QuickBooks writer does not verify the approved payload. `approved_by` is self-asserted, and the target is not bound to the realm.
- `packages/connectors/src/quickbooks/writer.ts:61-70` (and `contract/writer.ts:23-30`, which says every implementation *must* recompute `payload_sha256`)
- What happens:
  - `run` checks the lane, the connection id, `action_type` and that `approved_by` looks like a UUID. It never recomputes `payload_sha256` over the JCS canonical `{lane_id, action_type, connection_id, target, payload, payload_schema_version}`. It does not check `target` against `row.external_account_id`, and does not check `approved_by` against any approval record.
  - The harness proves this: `approvedRevoke` passes `payload_sha256: "0".repeat(64)` and the revoke succeeds (`testing/quickbooks-harness.ts:197-206`).
- Scenario: when T-195 wires the approvals executor, a bug or a forged row in `act.proposed_actions` that has the right lane and connection id but a stale or tampered payload or hash still revokes the grant. The audit then names whatever UUID was supplied as the approver. That breaks rule 5 ("approve exact payload"). It is also a regression trap: today's tests encode "bogus hash accepted", so adding the check later forces test edits that could weaken it.
- Not reachable today (no caller; lint + source scan), hence MEDIUM, not HIGH.
- Fix:
  - Now: either implement the hash check in `run` (JCS + SHA-256, compared in constant time, refused with `invalid_input` before any Vault read), or have `executeWrite` throw `unsupported_op` until T-193 lands the branded `ApprovedAction`.
  - Bind `target` (for example `{ realm_id }`) to `row.external_account_id`.
  - Change the harness to compute a real hash, and add tests for a tampered payload, a tampered hash and another realm in `target`, each with zero revoke requests and the secret intact.
  - Make T-193 / T-195 acceptance say the approver comes from the approval row, not from the caller.

### LOW

- **R-L1. The approvals-only boundary for the write subpath is a regex source scan, not a lint rule.** `packages/connectors/package.json:15` (`./write`), `connector.test.ts:249-272`.
  - Scenario: a production file imports by relative path (`../../packages/connectors/src/write/index`), or a computed key, and the scan misses it.
  - `.executeWrite` member access is still linted, so this is defence-in-depth only.
  - Fix: add `@nichols/connectors/write`, `quickbooks/writer` and `quickbooks/index` to the nichols boundary config now (allow only `packages/modules/approvals` and the connectors wiring), with a `config.test.js` row. Keep the scan.
- **R-L2. Every 23505 from the token functions is reported as "already connected to another company".** `packages/connectors/src/vault/tokens.ts:56`.
  - Any other unique violation (for example a future unique key on Vault secret names) would show a wrong, misleading refusal and send the owner to remove access at Intuit.
  - Fix: have the SQL token function catch `unique_violation` only for `connections_one_lane_per_account` and raise a dedicated SQLSTATE or hint, and map only that. Or check the constraint name in `error.details` before mapping.
- **R-L3. A `pending` row holds the account and can mislead the check.**
  - Index `where status <> 'disconnected'` (`20261104100000_...sql:10-12`); `connections.ts` `findConnection` (newest non-disconnected).
  - If `storeToken` fails after `ensureConnection` (Vault outage), lane A keeps a `pending` row that blocks the realm for every other lane. Clearing it needs the approvals-only disconnect, which does not exist yet.
  - The same newest-first query can return an abandoned `pending` row and report `not_connected` while an older `active` one exists.
  - Fix (either of):
    - Exclude `pending` from the index (`status not in ('disconnected','pending')`). The pending→active update then raises the already-mapped 23505.
    - Or filter `findConnection` to usable statuses before `pending`. Add pgTAP and unit tests.
- **R-L4. pgTAP does not exercise the exact statement `ensureConnection` sends.** `supabase/core/supabase/tests/120_connections_one_lane_per_account.test.sql`.
  - The tests use plain inserts. The connect flow uses `insert ... on conflict (lane_id, provider, external_account_id) do nothing`. The same-lane reconnect relies on the arbiter conflict being found before the partial index raises; that is correct in Postgres, but it is tested only in the in-memory twin.
  - Fix: add two pgTAP cases with that `on conflict` clause: same lane with an active row lives and keeps one row; another lane throws 23505.
- **R-L5. `metadataBase` takes the raw env value, not the validated client env.** `apps/web/app/layout.tsx:25-28`.
  - `URL.canParse` accepts `http:`, or any scheme, so a mis-set preview or production value yields `http://` or odd OG/canonical URLs without failing the build. Cosmetic: the value is public and env-controlled.
  - Fix: use the parsed client env (https in production) for the value, and keep the literal `process.env.NEXT_PUBLIC_APP_URL` read for inlining.

### Rules 1-13
- Rule 1: the check, `findConnection` and the writer take `laneId`, and DB access goes through the lane router. Discovery cache still accepted under L3.
- Rule 2: the switch is in `lane_config`.
- Rule 3: no new table; the D-23 index has pgTAP including cross-lane denial.
- Rule 4: no token in responses, logs, audit or the page; tokens only from the Vault.
- Rule 5: see item 2 and W1.
- Rule 6: CompanyInfo allowlist unchanged, and the check returns no company data.
- Rule 9: the Intuit response is reduced to a fixed shape.
- Rule 10: only synthetic realms and tokens in tests.
- Rule 12: no production touch; the launcher refuses non-local and non-sandbox.
- Rules 7, 8, 11 and 13: not affected.

## Final fixes (ffa0fbd, ea424af)
Reviewed `git diff 3e47381 ea424af`. Read-only; no `pnpm test:db` run (shared local DB in use).

**Result: no BLOCKER, no HIGH.** W1 and R-L1..R-L4 are closed. R-L5 is unchanged (cosmetic, already logged).

### Verify items
- **W1 closed.** `quickbooks/writer.ts` `run` checks things in this order:
  1. `assertLaneBound` and the provider guard.
  2. `action.lane_id === laneId` and `action.connection_id === conn.id`.
  3. `action_type`, then that `approved_by` is a UUID.
  4. `assertPayloadHash`. It recomputes JCS + SHA-256 over the six spec fields. The given hash must be 64 lower-case hex characters, so both buffers are the same length and `timingSafeEqual` cannot throw. An unhashable payload is refused.
  5. `connections.load`, a lane-router DB read with no Vault access.
  6. `assertTargetIsConnection`: the target must be exactly `{realm_id}` and equal `row.external_account_id`.
  7. Only then `tokens.refreshToken` (Vault), discovery and Intuit.

  Tests cover a tampered payload, version, hash and target, and assert zero revoke requests and the secret unchanged. The harness now builds a real hash.
- **`core.connection_token_store` v2 is correct.**
  - It is still `security definer` with `search_path = ''`.
  - `revoke all ... from public, anon, authenticated` and `grant execute ... to service_role` are re-stated. `create or replace` would keep the ACL anyway.
  - The lane check and the row lock (`connection_for_token(p_lane_id, id, true)`, `for update`, `P0002` for another lane) come first, unchanged.
  - `D0023` is raised only when `constraint_name = 'connections_one_lane_per_account'`. Every other `unique_violation` is re-raised as-is: pgTAP shows a Vault-name clash stays 23505.
  - The raise aborts the whole call, so the secret, mapping and audit row roll back (pgTAP confirms).
  - The D0023 text is fixed and generic. `tokens.ts` maps codes to fixed messages, so no DB text from a re-raised 23505 reaches callers.
- **Lint rule.** It covers the package specifier plus deeper paths, type imports, `export ... from`, `export *`, `require`, a static `import()` and relative paths into `src/write` / `dist/write` (including the `write.js` shim and paths from inside connectors). `nichols/*` disables are blocked. `\b` in the source-scan regex does not match `/writer`. Remaining gaps (L1, L2) need a deliberate bypass, and the symbol-name source scan still catches most of them.
- **Excluding `pending` opens no cross-lane takeover.**
  - The account is claimed atomically at the pending -> active update, inside the token function, under the unique index. Two lanes storing at once are serialised by the index: the second blocks on the first's uncommitted tuple, then gets D0023, or succeeds if the first rolled back.
  - `ensureConnection`'s `on conflict (lane_id, provider, external_account_id) do nothing` only ever matches a same-lane row. pgTAP shows the holder's row is untouched.
  - A refused lane's pending row has no secret, so `getToken` and refresh fail, and there is nothing to read or rotate.
  - No code today maps a realm to a lane (no webhooks), so a second pending row for the same realm cannot misroute anything (see L4).
  - The refusal still happens after the code exchange, as before (identify already followed exchange), so the change exposes no extra grant.

### MEDIUM
- **F-M1 (W1 carry-over, tracked T-193/T-195): the hash and approver are integrity checks, not authenticity checks.** `quickbooks/writer.ts:62-72, 101`. `payload_sha256` and `approved_by` both come from the caller, and anyone holding the action can compute the hash: `computePayloadSha256` is exported from `@nichols/connectors/writer`. Only the boundary (lint + scan) keeps this safe today. Fix (T-195 acceptance): the executor reads `payload_sha256` and `approved_by` from the locked `act.proposed_actions` row, compares that stored hash with a recompute over the stored fields, and passes only the branded `ApprovedAction`. Add a shared JCS test vector between the approvals copy and the connector copy.
- **F-M2: every "account in use" refusal now leaves a newest `pending` row that hides the lane's real connection.** `vault/connections.ts` `findConnection` (`.neq('status','disconnected').order('updated_at' desc).limit(1)`) together with the v2 index. Before v2, a refused attempt created no row. Now a lane B admin who tries to connect lane A's realm always leaves a pending row in lane B. `checkQuickBooksConnection` (and any `findConnection` caller) then reports `not_connected` for lane B's real active connection until that connection's row is next updated. This hurts availability and correctness inside the lane only; it does not cross lanes. It is the plan-review §6 item, but the change makes it the normal outcome of a refusal. Fix: order `findConnection` by usable status first (`status <> 'pending'` desc, then `updated_at` desc), or filter out pending when a usable row exists. Test: an active row plus a newer abandoned pending row returns the active row. Optionally delete the lane's own pending, secret-less row on D0023 (an internal row, not an external write).

### LOW
- **F-L1: lint bypass through the apps/web `@/*` path alias and a few module forms.**
  - `import { quickbooksWriter } from "@/../../packages/connectors/src/write"` in apps/web resolves through tsconfig `paths`. It starts with `@/`, not `.`, so neither `no-write-subpath-import` nor `no-cross-package-relative` resolves it.
  - Also not seen: `createRequire(...)("...")`, `module.require`, TS `import x = require("...")` (TSImportEqualsDeclaration), and the type-only `typeof import("...")`.
  - The source scan still catches the writer names.
  - Fix: report any `@/` specifier with a `..` segment, or resolve the alias. Add the TSImportEqualsDeclaration case to `moduleRefVisitor`.
- **F-L2: the approvals module can re-export the write side and open it to everyone.** The allow-list exempts every file under `packages/modules/approvals`, including re-exports. Fix: report `export ... from "@nichols/connectors/write"` even inside approvals, or add a config test that the approvals package's public entry does not expose the writer.
- **F-L3: `canonicalJson` is looser than RFC 8785.** `contract/writer.ts:44-58`. It accepts lone surrogates, which RFC 8785 requires I-JSON to reject. A sparse array produces `[1,,2]`, which is not JSON. Both fail closed (a mismatch means a refusal), but they could disagree with the T-193 copy. Fix: throw on lone surrogates and holes (`Object.keys(a).length !== a.length`), and add the RFC 8785 appendix vectors.
- **F-L4: future realm-to-lane lookups must use the index predicate.** Several lanes can now hold pending rows for the same realm. A QuickBooks webhook (realmId to lane) that looks up by `external_account_id` without the status filter could pick another lane's pending row. Fix: put this in the webhook spec, or add one SQL helper using `lower()` and `status not in ('disconnected','pending')`.
- **F-L5: the per-lane key is case-sensitive while the cross-lane key is not.** `(lane_id, provider, external_account_id)` versus `lower()`. The same lane can hold `Ops@x.com` and `ops@x.com`; storing the second gives D0023, "connected to another company", which is wrong for the same lane. This matters only for mailbox providers, not QuickBooks. Fix: lower-case the id in `ensureConnection` for case-insensitive providers, or key the per-lane constraint on `lower()` too.
- **F-L6: stale comments.** `contract/writer.ts:1-3`, `src/index.ts:1`, `quickbooks/connector.ts:8`, `quickbooks/index.ts:49` and `contract/connector.ts:58,105` call `@nichols/connectors/writer` the approvals-only, lint-restricted subpath. The rule covers `/write`. `/writer` holds only types and the hash function, so it needs no restriction, but the comments should say so.

### Rules 1-13
- Rule 1: the writer, store and check all take `laneId`, and DB access goes through the lane router.
- Rule 3: no new table. The index has pgTAP, including cross-lane denial with a positive control and an aal1 case.
- Rule 4: nothing logs or returns tokens, and the Vault is read only after the checks.
- Rule 5: W1 is closed at the connector; the boundary is now a lint rule plus the scan (F-M1, F-L1, F-L2 remain).
- Rule 9: `intuit_tid` is clamped to 256 characters.
- Rule 10: only synthetic realms and tokens.
- Rule 12: no production touch.
- Rules 2, 6, 7, 8, 11 and 13: not affected.
