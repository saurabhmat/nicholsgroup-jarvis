# T-050 code review (commit 44278b8)

Verdict: no BLOCKER, no HIGH. 3 MEDIUM that should be fixed or logged before merge, plus LOW items.
Reviewer did not edit code.

## Commands
- `pnpm typecheck && pnpm lint && pnpm test`: all pass (turbo 17/17 each). connectors 557 passed + 10 skipped (contract kit n/a: sync, subscribe, prepareWrite); core 277; web 43 (client-bundle test alone 137 s under turbo load; web run 145 s); ui 270; eslint-plugin 404.
- `node --test scripts/*.test.mjs`: 138 pass, 0 fail. (The root `pnpm test` script also ran its own node:test set: 196 pass.)
- `pnpm test:db` not re-run (not requested); the PR reports 664 passing.

## Acceptance clause coverage (each would fail if the behaviour broke)
- Discovery cached: discovery.test.ts counts requests (1 across lanes/concurrent, TTL edge 23 h/25 h, stale 7 d). Real. OK.
- Endpoints from the document for the environment: connect.test.ts start URL, sandbox vs production. SSRF host allowlist table. OK.
- State binding and replay: connect.test.ts forged / malformed / other user / other lane / replay / expired. They run on an in-memory twin of `core.oauth_state_*` (quickbooks-harness.ts:183), so they prove the flow's wiring, not the SQL. The SQL is covered by T-035's pgTAP 100_oauth_states. Acceptable; note it (L1).
- Role and AAL2 gate: connect-authorizer.test.ts proves the roles passed to `requireRole` are exactly owner/admin_technical; AAL2 itself is not asserted here, it relies on `requireRole`'s default (T-023/T-033) and pgTAP. Acceptable (L2).
- Realm match: strong (before token request, two realms, malformed, outage is not a refusal, per-lane). OK.
- Vault-only entry: refuses `vault_secret`; a source-grep that only connector.ts and index.ts call `storeToken`. Weak-ish by nature (grep), but fine. See M2 about `connector.connect`.
- Proactive and 401 refresh: refresh.test.ts at the 5 min boundary, once-only retry, second 401 final. OK.
- Rotation concurrency: refresh.test.ts "two instances" asserts both instances hit Intuit with the same old token, exactly one rotation and one lost race, both callers hold the stored token, the stored refresh token is still valid at the fake, and the next refresh works. Plus a direct CAS test and pgTAP (7 new). Real, not vacuous. But it passes only because the fake keeps the two newest refresh tokens valid (handlers.ts issue()); see M1.
- intuit_tid logging: connector.test.ts for 200, 401, token, 400, and no tokens in logs. OK.
- Env tests: intuit-env.test.ts. Server-only, secret-name patterns, redaction. OK. Note it asserts `.env.example` text and schema membership, which is what the clause asks.
- Canary: client-bundle.test.ts, real `next build`, scans client, HTML, RSC and server output in four encodings; scanner proven on planted files. No positive control on a real build (M3).
- CompanyInfo health: ok, refresh on the way, reconnect_required, 5xx degraded, foreign company refused, unusable status skips the call. OK.
- Contract kit: connector.contract.test.ts, real connector, 15 pass.

## Shared framework changes (T-035 compatibility)
Backward compatible. `endpoints(laneId)` gains a parameter (zero-arg implementations still type-check and run); `precheck` and `requestIdHeader` are optional; `defaultOAuthHttp` is the old default factory plus two optional fields; `exchangeAuthorizationCode` is the old `exchange` body moved, still wrapped in `ExchangeFailed` by the flow. Two small behaviour differences, both safe: the token response is registered for redaction before the scope check (better than before), and `code_verifier` is omitted when undefined (the flow always passes one). T-035 tests and the whole suite pass. `rotateToken` now requires `replaces` and returns boolean: only quickbooks and vault code call it, so no other caller broke.

## Findings

### MEDIUM
M1. packages/connectors/src/quickbooks/token-manager.ts:105-118 (`refresh` catch) and testing/msw/quickbooks/handlers.ts:~95 (grace of 2 tokens).
The cross-instance race is only safe if Intuit keeps the previous refresh token valid. If it does not, the loser's call with the old token gets `invalid_grant`, which is converted to `reconnect_required` even though the winner has just stored a valid set. When T-195 persists that status it forces a needless reconnect. The fake hides this. Fix (cheap, independent of Intuit's behaviour): on `invalid_grant`, re-read the stored set; if `stored.raw !== the raw we used`, return the stored set (another refresh won) instead of throwing; only throw `reconnect_required` when the stored set is unchanged. Add a test with a strict fake (`validRefresh` = newest only) and two instances. Keep the manual step 9 as well.

M2. packages/connectors/src/quickbooks/connector.ts:79-117 (`connect`).
This is a second way for a token set to enter the Vault with no `state`, no PKCE verifier (optional here), no AAL2 check and no audit. Nothing but the contract kit calls it today, which is why the QB-7 text still holds, but nothing prevents a future route or job from calling it. Fix: document at the function and in the file header that it is not reachable from any route, and add a test (like the `storeToken` grep) that no file under apps/ or other packages imports `quickbooksConnector.connect`; or require `code_verifier` and return `invalid_input` without it. Log it in plan-review if left as is.

M3. apps/web/tests/client-bundle.test.ts:30-46 (test strength) and runtime cost (see below).
The real-build scan has no positive control: if `next build` stopped bundling server code the way the test assumes, or the env never reached the build, it would still pass. Fix: in the same build add a `NEXT_PUBLIC_CANARY_CONTROL=<known value>` and a page or the existing client env reader that inlines it, and assert the scan finds exactly that one (and none of the secrets). Without it the test cannot fail for "scan looked at the wrong thing".

### LOW
L1. packages/connectors/src/testing/quickbooks-harness.ts:183-198. State create/consume is a twin of the SQL. Add a comment pointing to pgTAP 100_oauth_states as the authority, so the two do not drift unnoticed.
L2. apps/web/tests/connect-authorizer.test.ts. Does not assert AAL2. Add one assertion that the real `requireRole` default refuses AAL1 (or reference the existing T-023 test in a comment).
L3. connector.ts:~175-200 `disconnect`. A 401/403 from the revoke call (wrong client secret) is swallowed and the local tokens are deleted, leaving a live token at Intuit. Continue on `invalid_grant`/400 only; for 401/403 stop and report. It is also beyond strict T-050 scope (T-195 owns it) but the contract kit requires `disconnect`, so keeping the minimum is defensible; no audit actor is passed.
L4. connector.ts:~155 `as_of` clamp. Reasonable, but the same clock-skew will hit every provider; put the clamp in a shared helper in `contract/` (or the result builder) rather than per connector, and add a direct unit test (today only the contract kit exercises it).
L5. connector.ts `health` returns `status: "active"` on success even when the row is `degraded`; nothing updates the row (T-195/T-196). Add a comment so it is not mistaken for persistence.
L6. discovery.ts:25 `checked(name, value, allowQuery)`: `allowQuery` is always false (dead parameter). Remove it.
L7. token-manager.ts:39,80 `StoredTokens.refreshExpiresAt` is only used to carry the old expiry when Intuit omits it. Fine, but name it in the doc comment, or drop the field.
L8. Connector tests print JSON log lines to stdout (visible in `pnpm test`). Silence with an injected logger in `connect.test.ts` and discovery tests, to keep CI output readable.
L9. packages/core/src/env/schema.ts: `INTUIT_WEBHOOK_VERIFIER_TOKEN` made optional. Justified (connect needs only four variables) and tested, but it drifts from the backlog wording; T-053's "fails closed when unset" test must exist (add a note in T-053). Tell the human in the PR (already in Changes).
L10. SQL migration review: correct (lock via `connection_for_token(..., true)`, hash compared under the lock, 40001 with no secret in message, same grants). Ensure `docs/security-definer-list` or equivalent still names the function; the PR says it does.

## Client-bundle test in `pnpm test`: recommendation
Not acceptable as is. It measured 137 s in the full run (the PR says 50-90 s), it makes the whole web suite 145 s, it fails on a machine with `apps/web/.env*` present, it contends with `next dev`, and turbo re-runs it on every web change. Recommend:
1. Keep the scanner unit test in the default `vitest run`.
2. Move the real-build test to `apps/web` script `test:bundle` (vitest with an include of `tests/bundle/**`, excluded from the default config), not part of `pnpm test`.
3. Add `pnpm test:bundle` as its own step in `.github/workflows/ci.yml` (after `pnpm test`, same job so deps are cached) and add it to the DoD list in CLAUDE.md for tasks touching env, connectors or next.config (one line). Add a turbo task with `inputs` limited to `apps/web/**`, `packages/core/src/env/**`, `next.config.ts`, so it is cached.
4. Raise in the PR that CI must be edited (a human-owned file change if workflows are protected).

## Re-review (3527cf8..1b32e2b)

Verdict: no BLOCKER, no HIGH. M1, M2 and M3 are fixed with real tests. 1 MEDIUM (the real-build guard runs nowhere automatic, and docs are stale) and several LOW.
Reviewer did not edit code.

### Commands
- `pnpm typecheck && pnpm lint && pnpm test`: exit 0 (includes the root node:test set, 196 pass, 0 fail).
- `node --test scripts/*.test.mjs`: 138 pass, 0 fail.
- `pnpm test:bundle`: 1 test passed, 78 s (turbo run, uncached); the control was found.

### Earlier findings
- M1 fixed. token-manager.ts `refresh` no longer retries the POST (`retry: false`), and on `invalid_grant`, timeout or transient it re-reads the Vault (0/250/500 ms) and uses the stored set if it changed; only an unchanged store becomes `reconnect_required`. refresh.test.ts has a strict-rotation two-instance test (fake keeps only the newest refresh token; both Intuit calls use the same old token; one rotation; both callers hold the stored token; stored refresh token still valid; lost-race log once), a lost-response test (store moved during the POST, one POST only) and a timeout-with-unchanged-store test. Not vacuous: handlers.ts `strictRotation` keeps `slice(-1)`.
- M2 fixed by refusing: `connector.connect` refuses every input, the contract kit drives `connectVia` (real callback), and the doc on `Connector.connect` says so. Sound.
- M3 fixed. layout.tsx reads `NEXT_PUBLIC_APP_URL` literally; the build test asserts exactly that control is found and that `scanned > 50`. The build test fails if the env or scan breaks. See L1 below for what it does not cover.
- Also done: bundle script restores `next-env.d.ts` in `finally`, handles a stale backup, checks the tail for canaries in all encodings; `NEXT_DIST_DIR` honoured only for `.next-canary` and never on Vercel.

### test:bundle split and turbo task
Correct: `apps/web` script `test:bundle`, `vitest.bundle.config.ts` includes only `tests/bundle/**`, default config excludes it, root `pnpm test:bundle` runs `turbo run test:bundle`. Turbo inputs cover app, components, lib, proxy, next.config, package.json, the script and `packages/*/src/**`; outputs `[]`. Gaps are below (R1, L5).

### T-198 acceptance
Met: section titled "Temporary: connection test", shown only to owner/admin_technical at AAL2 when `lane_config.pilot.connection_test_enabled === true`; route `requireLane` (404 for foreign or unknown lane) then `requireRole(CONNECT_ROLES)` (403/401), flag off is 404 after the role check, response is exactly three fields, no-store, read-only (one GET), no disconnect control. RLS check: `lane_config_current` is `security_invoker`, readable by owner and admin_technical (pgTAP 040), so the flag read works for the intended roles. Tests are mostly real: handlers are driven with fake guards that record calls, so 401/403/404 ordering, "no check run" and the three-field copy are asserted by behaviour. Page-source greps (tokens only, no disconnect control, `loadLane` first) are string tests, weak but acceptable.

### Contract kit changes
Sound. `disconnect` optional with `disconnectForTest` as the only alternative (the kit fails if neither exists); `connectVia` defaults to `connector.connect`; the foreign-provider check calls health, read and disconnect with a same-lane connection of another provider, asserts a lane_mismatch/not_found/invalid_input error, zero provider requests, zero writes and the foreign credential still stored. `src/testing` is not in the package `exports`, so production cannot import the harness.

### Findings

MEDIUM
R1. .github/workflows/ci.yml:15 and CLAUDE.md (Definition of done); docs/plan-review.md:144; .agent/pr/T-050.md:31, 40, 57.
`pnpm test:bundle` is not run by CI or named in the DoD, so QB-17's real-build canary now runs only when someone remembers (my earlier recommendation 3 was not done and not logged as a human step). Stale text also still says the real build is in `pnpm test` and makes it slower. Fix: add `- run: pnpm test:bundle` after `pnpm test` in ci.yml (list it under "Needs human" in docs/backlog.md if workflows are protected), add one DoD line in CLAUDE.md for tasks touching env, connectors or next.config, and correct plan-review.md:144 and the three PR lines.

LOW
L1. apps/web/app/layout.tsx:23-28 and tests/bundle/client-bundle-build.test.ts:25-31. The control is read in a server component, so it proves the env reached the build and that the scan walks server output, but not that the `.next/static` scan can find an inlined value (already stated in plan-review.md:148). Cheap fix when any client component reads a `NEXT_PUBLIC_*` value: assert the control is also under `static/`. layout.tsx also ships a behaviour change (`metadataBase`, silently skipped on an unparseable URL) to serve a test; fine, but mention it in the PR.
L2. packages/connectors/src/testing/contract-kit.ts:214-235. `foreignProviderConnection` is optional and `applies` silently skips, so a future connector can pass the kit without the provider-guard check. Fix: make it required for connectors whose Vault is keyed by connection id (all of them), or print a skipped-check warning and list it in the connector checklist in the spec.
L3. packages/connectors/src/quickbooks/connection-check.ts:35 and apps/web/lib/connection-test.ts:70. The route returns `intuit_tid` unbounded; the client (connection-check-view.ts:15) refuses anything over 256 characters and would show "Could not check" for a good result. Clamp or drop it (`null`) at the check, in the same place as the other reduction.
L4. packages/connectors/src/quickbooks/refresh.test.ts (lost-response test, `void intuit;`) leftover; drop the unused `intuit` destructure.
L5. turbo.json `test:bundle` inputs omit `.env*` and `../../packages/*/supabase` is not needed, but also omit `../../pnpm-lock.yaml`; turbo hashes the workspace dependency graph, so this is fine today. Note only: a cache hit skips the build, so after changing the canary script's inputs list keep it in sync.
L6. token-manager.ts `newerStored`: every `invalid_grant` for a genuinely revoked connection now waits 750 ms (0+250+500) before reporting `reconnect_required`. Acceptable for a rare path; cache the `reconnect_required` outcome once T-195 persists the status so a revoked connection does not wait on every call.
L7. apps/web/tests/connection-test.test.ts: real `requireRole` (AAL2) is not exercised; the tests use fake guards. Already covered by T-023/T-033; add a one-line comment pointing at that test.
