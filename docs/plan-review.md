# Pilot plan review — Pub K Group

Open conflicts, gaps and risks in the planning docs. Resolved items are removed; the decisions themselves are in `docs/pilot-scope.md` → "Decided" and `docs/backlog.md` → "Needs human".
Last reviewed **Oct 23, 2026** against `CLAUDE.md`, `docs/pilot-scope.md`, `docs/architecture.md` (incl. "Read this first" items 1–10), `docs/architecture-v0.3-sponsor.pdf` and the pack in `.claude/`, `.github/`, `scripts/`.

## 1. Conflicts still open

1. **The sponsor PDF (v0.3, Oct 18) is behind everything else.** It still says:
   - Nichols Law fully in scope through Integris (M365 email, Teams, SharePoint) with its own Supabase project
   - Microsoft sign-in
   - All action modules switch on Dec 29, and a Dec 22 go-live
   - No GoHighLevel and no PKG-first pilot

   `architecture.md` and `pilot-scope.md` now disagree with all of these. Robert should get an updated PDF before signing.
2. **monday.com / Notion auth.** Pilot scope: API token and internal integration. Architecture §6 (not covered by "Read this first"): OAuth app / OAuth per workspace. The backlog follows the pilot scope; the connector contract keeps OAuth possible later.
3. **Email digest.** Architecture M11 lists an email digest; pilot scope and the backlog don't. Assumed out unless asked for.
4. **Downeaster (DE)** appears only in architecture §5.1 ("confirm whether in scope"). It isn't seeded.
5. **Basic notifications in Release A.** The pilot-scope Release A list doesn't name notifications; Release B has "notification polish". The backlog keeps basic web push (T-160/T-161) in A, because approvals on iPhone rely on a push. Say so if you want it moved.
6. **H-021 id.** The QuickBooks note asked for a "new H-021" for the staging URL, but H-021 is already production-domain DNS. The staging URL is **H-023**; connecting the live file is **H-024**.

## 2. Pack vs. backlog (handled in the backlog, listed for awareness)

- **Protected files:** `.claude/hooks/guard-files.sh` blocks agent edits to `.github/workflows/*` and `.env*`, and `settings.json` denies reading real env files (`.env.example` is readable since Oct 24). T-004, T-025 and T-171 now deliver workflow changes as diffs in the PR body for you to apply; `.env.example` changes are proposed the same way.
- **Stop hook before the monorepo:** resolved Oct 23. `.claude/hooks/check-on-stop.sh` now skips when pnpm is missing or `package.json` has no `typecheck` script, so it starts checking once T-001 lands.
- **Toolchain:** local Node 24.19.0 (kept on purpose), CI Node 22 (`ci.yml`, `agent-build.yml`). T-001 sets `engines` to `>=22 <25` so both work. Code must not use Node 24-only APIs, because CI would catch them only after the push. Docker isn't usable by your user yet (H-020).
- **`ci.yml`** uses `pnpm/action-setup@v4` without a version, so T-001 must set `packageManager` in `package.json`.
- **`migrate-prod.yml`** runs the Supabase CLI from `supabase/core`. T-006 must use a folder layout that matches what the CLI expects there. There is no staging migration workflow yet (T-171 proposes one).
- **`agent-build.yml`** allows one agent at a time in CI. The parallel worktrees in the backlog are for local runs only.
- **`guard-bash.sh` matches substrings of the whole command line**, e.g. any command whose text contains `db push`, `curl ` or `PROD_`, even inside a heredoc or a docs edit. Expect occasional false positives; writing scripts to a file first avoids them.

## 3. Gaps

- **Paid-subscriber rule (D-3).** The GoHighLevel paid-subscriber rule isn't written down. It drives success criterion 1. (D-9 decided Oct 24, see §7.)
- **Entity mapping values (D-8).** The approach is decided (classes → customer mapping fallback, Stripe products, GHL tags/products, bank-account owners), but the actual IDs come from Sophie and are needed before tie-out.
- **AR/AP aging by class.** It isn't confirmed that the QuickBooks Reports API filters aging reports by class. T-052 should check this. If it can't, aging is computed from class-tagged invoices/bills in `fin.*` (T-083/T-084) and tied out to a class-filtered report Sophie runs in QBO.
- **Tie-out reference data.** The format of Sophie's manual weekly cash report isn't specified. T-094 assumes the reference figures are entered by hand.
- **TOTP recovery.** Magic link/email code gives AAL1 to whoever controls the mailbox, so TOTP is the real second factor and resets must not be self-service. Decide whether a reset needs the owner's approval; admin_technical alone shouldn't be able to reset Robert's factor.
- **Meeting notes source (D-12)** and **embedding provider (D-13)** are open but only block Release B.
- **iOS push** works only for an installed PWA on iOS 16.4+. Robert's iPhone needs checking.
- **Gmail restricted scopes:** an Internal-type OAuth app inside the pub-k.org Workspace avoids Google verification. That only applies if D-1 = Google.

## 4. Schedule risk

Release A is **123 tasks of up to a day each**, against about **22 working days** (Oct 26 – Nov 25). The pilot security test (T-170) gates approvals, so Release A needs to be feature-complete around **Nov 18–20**. Running tracks in parallel (backlog → "Parallel worktrees") raises throughput, but review stays the bottleneck: every PR needs your merge.

Ways to cut further, roughly by size:
1. **Decide D-1** and drop the other mail provider: removes 3 tasks from Release A (and 1 search task from Release B).
2. **Merge small tasks during the build.** Applied Oct 28 (see below). Re-forecast after T-001 – T-020.
3. **Allow a later PKG approvals go-live** (e.g. Nov 30, the start of Robert's test week) if T-170 slips. Success criterion 2 still holds without skipping the test.

**Tie-out window (updated Oct 28, 2026):** Intuit production keys are issued (H-017), so Intuit is no longer the constraint; the code is. The tie-out runs Nov 16–25. Before the recovery plan, connecting the live file waited on a 12-task chain (earliest Fri Nov 13 with no slack) and the full tie-out chain ran 19 tasks through Stripe, GoHighLevel and D-3.

**Recovery plan, all three options applied (decided Oct 28, 2026):**
- **Pairs.** On the critical chain: T-031 + T-032 and T-033 + T-034 (one worktree, one PR each). Off the chain, to cut review load: T-014 + T-015 and T-016 + T-017. The chain to H-024 is now 10 build days plus a sandbox QB-1 – QB-20 run.
- **QuickBooks-first tie-out.** T-094 depends on T-082 – T-085 instead of T-089 and ties out cash, AR, AR >30, AP due ≤14 days and P&L from the live views and the report cache. It includes a functional entry page (pre-D-20). Stripe and GoHighLevel KPIs join with snapshots (T-089, T-097). T-090 is QuickBooks-first too, because QB-12 (4-hourly CDC poll, nightly reports) must pass before H-024. T-172 now depends on T-094.
- **Week 1 by hand.** Week ending Fri Nov 13: QBO report cache figures from the staging connection against Sophie's report, recorded in the T-172 runbook. Week ending Fri Nov 20: through T-094 on Mon Nov 23.

Day-by-day plan with 3 tracks: `docs/backlog.md` → "QuickBooks-first schedule". Target: connect Fri Nov 13, week-1 tie-out Nov 16, week-2 Nov 23. Human items on the path: H-011 by Nov 2, H-023 by Nov 12, D-8 by Nov 13. One lost day on the critical track moves the connection to Mon Nov 16; week 1 then still works, because QuickBooks reports can be pulled for a past period.

## 5. Most urgent from you

1. **H-020** — Docker permission for your user (blocks T-006 and `pnpm test:db`).
2. **D-1** — the pub-k.org mail provider.
3. **D-8** — Sophie's mapping IDs, plus **D-3** (paid subscriber, which also gates customer churn %), before finance tie-out.
4. **H-016** — Resend account + DNS; **D-20** — design sign-off, due Nov 5–6 (blocks the app shell and all screen tasks).

## 6. Follow-ups from reviews (not blocking)

Under the review policy (dev tooling: one security review, fix BLOCKERs only), these are logged rather than fixed.

- **T-000 `scripts/next-task.mjs`:** the third security round was stopped before it finished. Edge cases not yet probed:
  - Unicode lookalikes in `T-`/`H-`/`D-` ids or in `approved`
  - NBSP or tab variants in field lines and `- [x]`
  - a BOM at the start of the file
  - `####  T-001` headings
  - setext headings inside Needs human

  The allowlist grammar should reject most of these, since anything that isn't an exact ASCII field line blocks the task. This hasn't been verified.

- **T-001 monorepo** (security review Oct 23, 2026; no BLOCKER or HIGH):
  - **M1 `package.json`:** `test:db` and `test:injection` are placeholders that exit 0, and CI labels them "pgTAP RLS tests" and "prompt-injection suite". A task that adds SQL or AI tools before T-006 or T-102 would pass with no tests run. Fix: make the placeholders exit 1 once `supabase/**/migrations/*.sql` (or `packages/ai/**`) exists, or have T-006 and T-102 replace them before any such task merges.
  - **M3 `.gitignore`:** `supabase/.temp/` only matches at the root. T-006 uses `supabase/core`, whose `.temp/` (project ref, pooler URL) and `.branches/` would not be ignored. Fix in T-006: `supabase/**/.temp/` and `supabase/**/.branches/`.
  - **L1:** root devDependency `turbo: ^2` is a range; the lockfile pins 2.11.10. Pin it exactly, like the other pinned dependencies.
  - **L2:** Turbo and Next telemetry are on by default. Set `TURBO_TELEMETRY_DISABLED=1` and `NEXT_TELEMETRY_DISABLED=1` in CI (human-owned `ci.yml`), and note `pnpm turbo telemetry disable` for local setup.
  - **L3 `turbo.json`:** the cached `.next/**` outputs can contain build-time env values (`NEXT_PUBLIC_*`, or anything server code reads at build). Before enabling a remote cache (Vercel or CI), keep secrets runtime-only and declare only non-secret variables in `env`.
  - **L4 `apps/web/next.config.ts`:**
    - Confirm `experimental.agentFeedback` is inert in `next build`/`next start`, or gate it to non-production before the first Vercel deploy.
    - With `cacheComponents: true`, every `"use cache"` function must take `laneId` (and the user or role where relevant) as an argument, so it is part of the cache key (rule 1). Enforce this from the first data-access task.
  - **L5 `.gitignore`:** `.claude/settings.local.json` isn't ignored, and it can hold per-user permissions and env values. Add it.
  - **L6:** `pnpm-lock.yaml` and `pnpm-workspace.yaml` are mode 0600 locally. Git records 0644, so this only matters if a local tool complains.
  - **M2** (release-age exemption for next@16.4.3): resolved in T-001 by pinning Next 16.4.2 and removing the exemption.

- **T-002 package skeletons** (security + code review Oct 24, 2026; no BLOCKER or HIGH). The subpath-export and `packages/ui` tsconfig findings and the typecheck cache outputs were fixed in T-002; the rest:
  - **T-003:** boundary rules must also apply inside `apps/web` (the root eslint config ignores `apps/**`); put them in a shared config both import, with a fixture test that fails lint inside `apps/web`.
  - **T-003:** `scripts/**` is ignored by lint; lint it or record why not.
  - **T-003:** ban `process.env` outside `packages/core/env`.
  - **T-003:** ban importing `@nichols/core/env/server` (and later the lane router and service client) from `"use client"` files.
  - **T-003:** replace the T-002 stub `eslint.config.mjs`.
  - **T-005:** publish the secret-pattern list as a plain JSON/JS file behind its own subpath export. An `.mjs` ESLint config cannot import `.ts` on Node 22 (CI), so otherwise the T-003 rule works locally and breaks in CI.
  - **T-016:** make `LaneId` a branded type minted only by the lane router / membership code (it is a plain `string` now).
  - **T-006:** generate types with `--local` only, write to a temp file then move it, add the generated file to ESLint ignores, and export via `@nichols/core/db`.
  - **Later / any task:** `transpilePackages` in `apps/web/next.config.ts` must list every `@nichols/*` package web imports (derive it from `apps/web/package.json` deps or add a test).
  - **Later / any task:** align `apps/web` devDeps (`typescript`, `eslint`, `@types/node`) and root `turbo` to exact pins.
  - **Later / any task:** remove `data-core={PACKAGE_ID}` from `apps/web/app/layout.tsx` once a real import of core exists.
  - **Later / any task:** `@types/node` is 20 while `engines` is `>=22`.

- **T-006 local Supabase** (security + code review Oct 24, 2026; no BLOCKER, HIGHs fixed or turned into human items):
  - pgTAP runs as the superuser, so an RLS "allowed" test would pass even with broken policies. Before T-010/T-013, add helpers (`set local role authenticated` plus `request.jwt.claims`) so tests exercise RLS as a real user. **Assigned to T-013.**
  - Docker publishes the local stack ports (Postgres, Studio, Mailpit) on all interfaces, reachable from the LAN. Human, host config: set `"ip": "127.0.0.1"` in Docker's `daemon.json` or use a firewall.
  - Remaining `env()` placeholders in `config.toml` (OAuth, SMTP, etc.) are CLI defaults and are left as is.
  - Re-link guardrails are tracked as H-022 in `docs/backlog.md`; the CI start step is a proposed `ci.yml` diff in `.agent/pr/T-006.md`.

- **T-007 review** (security + code review Oct 28, 2026; no BLOCKER or HIGH in the diff; required fixes applied in `T-007: review fixes`):
  - **HIGH (human-owned, H-022):** `.claude/settings.json` allows `Bash(supabase db reset:*)`, and `guard-bash.sh` does not block `--linked`, `--db-url` or `--project-ref`. Today nothing is linked from an agent worktree, so it is latent; it becomes live the moment `supabase/core` is linked (then `supabase db reset --linked` would wipe staging and apply the synthetic seed). The seed's fence aborts when it is applied to a database that already has a non-`example.test` user (e.g. `db push --include-seed` or `psql -f`), but it does **not** help after a reset: the reset wipes the database first, so the fence then passes. Close H-022 (patterns now include `--project-ref`, `--include-seed`, `--include-all`) before any re-link. Agents may not edit `.claude/*`.
  - **Not fixed (suggestion):** type-check the plain JS in `supabase/core/seed/` and `scripts/` (`checkJs` with a small tsconfig, or move the seed framework into a TS package once Node 22 type stripping is reliable in CI). Fits T-003 (which already has to decide about linting `scripts/**`).
  - **Not fixed (note):** `node --test supabase/core/seed` (directory form) fails on Node 24, so the root `test` script lists the files with a shell glob (`supabase/core/seed/*.test.mjs`). Keep it that way when adding test files.

- **T-031 / T-032 review** (security + code review Nov 2, 2026; one HIGH, fixed: sync_runs cross-lane/AAL1/anon tests; required fixes in `T-031, T-032: review fixes`):
  - **Assigned to T-033:** a lint rule that only `packages/connectors/src/vault/**` may reference `vault.` or `connection_token_` (service_role can reach `vault.*` directly; see §7 Nov 2). The vault module passes secrets as bind parameters only, never as SQL literals (a failing statement is logged with its text); test it.
  - **Assigned to T-038:** the sync cursor lives in a private per-(connection, stream) table, not on `core.connections` (mail, calendar and drive streams advance separately; targeted runs advance some). Consider a partial unique index on `sync_runs (connection_id) where status = 'running'` as a backstop to the concurrency key, and an `object_types` column for targeted runs (T-053).
  - **Note for readers of `core.connections`:** the table also exposes `created_at` / `updated_at`, which the strict `ConnectionSchema` does not list; select only the schema's columns when parsing.
  - **Accepted:** the secret scan on `external_account_id` refuses a mailbox whose local part starts with a vendor key prefix (e.g. `secret_...@`).

- **T-033 review** (security + code review Nov 2, 2026; 4 HIGH and the MEDIUMs fixed in `T-033: review fixes`):
  - **Assigned to T-050 (code M5, decision proposed, Saurabh to confirm):** concurrent refresh must not lose a rotating refresh token. Use a compare-and-swap in `core.connection_token_rotate` (a `p_expected` version or hash of the secret being replaced; a mismatch raises a distinct code and the loser re-reads the token) rather than an Inngest concurrency key alone: refresh-on-401 also runs inline in request handlers on several serverless instances, which a job-level key does not serialise. Needs a T-032 migration; T-050's "concurrent refresh doesn't lose the token" test covers it.
  - **Assigned to T-035 (security M3, second half):** the first connector code that calls `requireConnectorEnv` wraps it inside packages/connectors so every returned credential (`INTUIT_CLIENT_SECRET`, `STRIPE_RESTRICTED_KEY`, ...) is registered with the redactor (wrap in `SecretValue`). Nothing in packages/connectors reads connector env yet.
  - **Assigned to T-035 (review note):** the OAuth callback lives in packages/connectors (`storeToken` is restricted there) with apps/web routes as thin wrappers, and needs a create-connection-row-and-mint path before `storeToken`.
  - **Assigned to T-041 (code M6):** Sentry `beforeSend` uses `@nichols/connectors/redact` (`redactText`, `redactFields`), added in the review fixes.
  - **LOW, not fixed:** nested token-set fields are not registered (L2); the 8-character minimum for exact-match scrubbing is not documented for connector authors (L3); `reveal` and `getToken` are generic names that could clash (L4/L6: consider `revealForProvider`); `export * from` the vault is only caught by the relative-import rule, not by name (L5); `actorUserId` is not validated as a UUID, so a bad value maps to `transient` instead of `invalid_input` (L6/L3); tests for PostgREST `PGRST202` and the logger's sink/child edge cases (code L1/L2); the RSC and prompt-builder canary tests are approximations (L9).
  - **Deployment (security L8, human):** production Postgres must not log statement parameters (`log_min_duration_statement`, `auto_explain`, `pgaudit` parameter logging): the token functions take the secret as a bind parameter.

- **T-034 review** (security + code review Nov 2, 2026; both HIGHs and all MEDIUMs fixed in `T-034: review fixes`):
  - **Contract note for connectors (T-050 – T-070):** a 401 is `forbidden` with `http_status: 401`; that status is the refresh signal (refresh once, retry once; pass `auth` as a function). A caller's own abort rejects with the abort reason (AbortError), not a ConnectorError: it is not a provider failure and must not be written to `sync_runs.error`. Path parameters fill one segment and cannot be `.`, `..` or empty.
  - **Assigned to T-050:** the OAuth token endpoint needs an `errorCode` extractor reading `body.error`, so `invalid_grant` reaches `provider_error_code` and maps to `reconnect_required` (T-195).
  - **LOW, not fixed:** rate-limit buckets are never freed and keep the first caller's clock (code L2; a few dozen connections per process, so bounded in practice); the MSW guard is per test file (`useMockServer`), not a global vitest setup (security L4; unmocked requests are blocked and fail the test in files that use it).

- **T-050 QuickBooks OAuth + health** (self-review Nov 4, 2026; reviewers run by the coordinator; nothing below is BLOCKER or HIGH):
  - **Decided in the build:** `core.connection_token_rotate` is now a compare-and-swap (`p_expected_hash`, SQLSTATE 40001; closes the T-033 code M5 assignment). Refreshes are also single-flight per connection inside a process. `INTUIT_WEBHOOK_VERIFIER_TOKEN` is optional in the connector env (T-053 fails closed when it is unset).
  - **MEDIUM, open (cross-instance refresh):** two instances can still both call Intuit's refresh endpoint with the same refresh token before either stores. The compare-and-swap keeps the winner's set and the loser discards its own, which is safe only if Intuit keeps the previous refresh token valid for a grace period after issuing a new one (the build assumes it does, and the MSW fake models it). Confirm in the Nov 12 sandbox run (manual step 9). If Intuit invalidates the old token at once, add a short per-connection lease (a `refresh_lock_until` column checked in the same function) before calling Intuit.
  - **Closed by D-23 (T-035 security M1):** one provider account is connected to one lane at a time (partial unique index on `core.connections (provider, lower(external_account_id))` for usable connections; see the final review fixes below).
  - **MEDIUM, open (PKCE with Intuit):** the T-035 framework always sends `code_challenge` / `code_verifier`. Intuit's documentation does not require PKCE; if its token endpoint rejects the extra parameter in the live run, add a provider flag to skip it. Checked in manual step 4.
  - **LOW:** a refresh token that Intuit rejects (`invalid_grant`) surfaces as `reconnect_required` from the call but the connection row is not moved to `reconnect_required`, no admin is notified and syncing is not stopped: that is T-195. `connector.disconnect` here is the minimum the contract kit needs (revoke at Intuit, delete the Vault tokens); T-195 adds the audit actor, error map and the UI.
  - **LOW:** the realm check uses `lane_config.qbo.realm_id` only when set. A lane without one accepts whichever company the signed-in owner or admin authorises on first connect; set the realm in `lane_config` before connecting a real file (H-024).
  - **LOW:** the client-bundle check runs a real `next build` (about 50 to 90 s) into `.next-canary` (`NEXT_DIST_DIR`). Since the review fixes it is **not** part of `pnpm test`: the scanner unit test stays in `apps/web/tests/client-bundle.test.ts`, the real build is `apps/web/tests/bundle/client-bundle-build.test.ts` run by `pnpm test:bundle`. CI does not run it yet and the Definition of Done does not name it (human step H-031 in `docs/backlog.md`). The Next.js build inlines only `NEXT_PUBLIC_*`, and no client code reads any yet; the positive control is one `NEXT_PUBLIC_` value found in server output, so the canary scan proves no leakage today and guards later changes.
  - **LOW:** the discovery cache is per process (24 h, stale copy up to 7 days); a cold serverless instance fetches it once. Intuit's discovery host is a hard-coded constant (`developer.api.intuit.com`), not company-specific.
  - **LOW:** `OAuthProvider.endpoints` now takes the lane (the HTTP client logs and rate-limits per lane); an optional `precheck` runs before the code exchange so a refused realm never obtains a token. T-063 and T-066 can use both.
  - **Review fixes (Nov 4, 2026; security H1, M1 – M4, L1, L2, L4, L6; code M1 – M3, L3; client-bundle placement):** fixed in `T-050: review fixes`; see `.agent/pr/T-050.md`. Decided on the way: D-23 (one provider account per lane, enforced by a partial unique index) and D-24 (no rule-5 exception: revoking a grant at Intuit is an external write, so it exists only as the approvals-only `ConnectorWriter` action and a refused connect never revokes automatically; the owner is told to remove the app in Intuit).
  - **LOW, not fixed (T-050 reviews):** the discovery cache is not keyed by lane (security L3; public provider metadata, record as an exception in architecture.md or key it by `(lane, environment)`); `INTUIT_WEBHOOK_VERIFIER_TOKEN` is optional (security L5): T-053 must give the receiver its own required shape (for example `requireConnectorEnv("intuit_webhook")`) and test a 401/503 when unset; the client-bundle canary set covers only `INTUIT_*` and the Supabase secret key (security L7: add the Stripe, GoHighLevel, Resend, Inngest and Anthropic secrets once their env shapes allow a synthetic value in a build); the positive control is a `NEXT_PUBLIC_` value found in server output because no client code reads `NEXT_PUBLIC_*` yet (re-point it at a client chunk when one does).
  - **Final review fixes (Nov 4, 2026; T-050 / D-23 / T-198 re-reviews; commits `T-050: ...`, `D-23: ...`):** fixed: writer verifies `payload_sha256` (JCS + SHA-256, constant-time) and binds `target.realm_id` to the connection's account before any Intuit request or Vault change (security W1); `@nichols/connectors/write` and relative imports into `packages/connectors/src/write` are lint-restricted to `packages/modules/approvals` (R-L1, rule `nichols/no-write-subpath-import`); D-23 index is now `(provider, lower(external_account_id))` and excludes `pending` (DB MEDIUM, R-L3), the token function raises SQLSTATE `D0023` for that index only and the connector maps only that (R-L2); contract kit fails a connector with neither the foreign-provider hooks nor a reasoned opt-out (code L2); `intuit_tid` is cut to 256 characters server-side (L3); stale `pnpm test` build text corrected (R1).
  - **Still open after the final fixes:** (1) `approved_by` is still carried by the caller and checked only as a UUID; the approvals executor (T-193 / T-195) must take it from the approval row. T-193 must also share one JCS/hash implementation with `contract/writer.ts` `computePayloadSha256` (add a shared test vector). (2) R-L3, second half: `findConnection` returns the newest non-disconnected row, so an abandoned `pending` row for one account can still hide an older `active` one for another account in the same lane (the T-198 check reports `not_connected`); fix with a status-ordered query when T-045/T-195 land. (3) Because `pending` no longer holds the account, a second lane learns the account is taken when the credential is stored (after the Intuit code exchange; the owner sees the "remove the app's access" notice), not when the row is made; an abandoned `pending` row remains in the losing lane (harmless, no credential). (4) The lint rule covers the write directory and the package specifier, not relative imports of `quickbooks/writer` or `quickbooks/index` from other connector folders; the source scan in `connector.test.ts` still pins those. (5) The mock connector opts out of the foreign-provider kit check with a reason (it has no provider-keyed Vault). (6) pgTAP is single-session: the lost race between two lanes is tested sequentially. (7) The D-23 migration was written without the db-engineer subagent (not available in this run); the local `pnpm test:db` (13 files) passes.
  - **H-031 (human):** add `pnpm test:bundle` to CI and a DoD line to CLAUDE.md (see `docs/backlog.md`).
  - **LOW, not fixed (T-050 code review):** the in-memory twin of `core.oauth_state_*` in the QuickBooks harness has no pointer to pgTAP `100_oauth_states` as the authority (L1); `connect-authorizer.test.ts` does not assert AAL2 itself (L2, it relies on `requireRole`'s default and T-023/T-033 tests); the `as_of` clamp should move to a shared helper in `contract/` with its own unit test (L4); `StoredTokens.refreshExpiresAt` is only used to carry the old expiry when Intuit omits it (L7); connector tests print JSON log lines to stdout (L8: inject a silent logger); T-053 needs a "fails closed when unset" test for the verifier token (L9); confirm the security-definer list still names `core.connection_token_rotate` (L10). DB review LOWs: a lone-surrogate string would hash differently in `connection_token_rotate`; a genuine Postgres serialization failure (40001) is treated like a lost race (correct); pgTAP lacks upper-case and 63/65-character hash cases, a `hasnt_function` for the old four-argument signature, and a check that a refused stale rotate leaves `rotated_at` unchanged; concurrency is exercised sequentially only.

- **T-023 app shell (Nov 4, 2026; no BLOCKER or HIGH):**
  - M: `proxy.ts` now checks lane membership (one extra session read + one `core.lanes` query per page request) only to answer a refused lane with a real 404 before streaming; pages and layout still gate. If latency matters, cache the verdict per request or drop the proxy check and accept a streamed 200 with the not-found UI.
  - M: the proxy treats every first path segment other than `/sign-in`, `/auth`, `/mfa`, `/api` as a lane id, so a signed-in request for a future root file (T-025 `/manifest.webmanifest`, `/robots.txt`) would 404 unless the matcher excludes it. T-025 must extend the matcher or `NON_LANE_SEGMENTS`.
  - L: the proxy's 404 body is plain HTML (a rewrite to the styled page is proxied by origin and fails when `next dev` listens on 127.0.0.1); the styled not-found shows when the page's own check refuses.
  - L: `/` redirects to the first lane while streaming (status 200 plus in-document redirect), not a 307.
  - L: the theme choice lives in `localStorage` (this browser only), applied by an inline head script; a strict CSP (later) needs a nonce or hash for it.
  - M (fixed, D-22): the brand wordmark was "Pub K" for every lane (rule 2). Saurabh decided Nov 4, 2026: the wordmark is "Jarvis" (product name); company names come only from lane records.
  - Independent reviews (Nov 4, 2026; `.agent/notes/review-T-023-security.md`, `review-T-023-code.md`), no BLOCKER or HIGH. **Fixed:** the Approvals placeholder said "Nothing waiting for approval" before the module exists (now "Approvals are not set up yet"); `/` sent a `forbidden` user to `/sign-in` (possible loop), now shows the no-access notice. **Open:**
    - M (security M1): every e2e 404 is answered by the proxy, so nothing tests the page-level `loadLane` check on its own. If the proxy check is ever removed or a new page skips `loadLane`, the tests would still pass. Add unit tests for `loadLane` (forbidden, no session, AAL1, outage, allowed but not listed) and a static test that every `app/[laneId]/**/page.tsx` reaches it. Needs a unit-test runner in `apps/web` (Vitest), not there yet. Do this before or with T-024.
    - M (security M3 / code M2): a page request does about three session reads in the proxy plus one `core.lanes` query, then the same in the page, and nav-link prefetches multiply it (Auth rate-limit budget, T-018 review). Reuse the claims from `refreshSession`, skip the lane check for prefetch requests, drop the duplicate `requireLane` in `loadLane` (the `listLanes` result applies the same rule), and confirm asymmetric JWT signing keys so tokens verify locally.
    - M (security M4 / code M3): the proxy treats any unknown first segment as a lane, so signed-in users get 404 for `/.well-known/*`, `/sitemap.xml`, root files and `/_next/*` paths other than static and image. Fails closed. Only treat `^[A-Z]{1,8}$` as a lane (keeping `/pkg` a 404), or exclude those paths in the matcher, with tests; T-025 at the latest.
    - L: `/%50KG` is a 404 in the proxy but the page alone would render PKG (same user and lane, nothing leaks): refuse non-canonical segments. Response time shows which lane ids this deployment serves (accept and document). The proxy 404 lacks `cache-control: private, no-store` and `vary: cookie` unless the session was refreshed. `e2e-reset.mjs` continues silently without the publishable key (throw instead). `listLanes` could also filter codes with the router's `LANE_ID` pattern.
    - M (security follow-up M1): no test covers a return path other than the entry page. A regression in `mfaPath` or `landingPath` that drops `next` would pass every e2e test. Add Vitest tests for both (with the `apps/web` runner above) and one e2e test: open `/PKG/inbox` signed out, expect to land there after the email code and TOTP. Optionally check that `next=//evil.example` ends at `/mfa` with no `next`.
    - L (security follow-up): the entry page would show "no company access" for `step_up_required` (unreachable today; `listLanes` never throws it); the email-link flow carries no return path (never did). Fixed: an AAL2 user opening `/mfa` now also lands on their first lane.
    - L (code): derive the More tab's `covers` from `MORE_ITEMS`; test the `THEME_INIT` script text and listen for the `storage` event in `ThemeToggle`; the empty Suspense fallback shows a blank page while auth loads; the HTTP spec hard-codes port 3100 and depends on its `zz-` file name for ordering.
  - First browser run (Nov 4, 2026) found two sign-in redirects that showed the right page under the wrong address. Fixed: the email code now goes straight to `/mfa` (every user has MFA), the email-link handler answers with a relative `Location` (next dev reports `localhost` for `127.0.0.1`, so the cookie did not follow), and after the authenticator code the user lands on their first company (`apps/web/lib/landing.ts`) instead of `/` redirecting mid-stream. Also raised the root ESLint-config test timeout to 30 s (it timed out at random under turbo's parallel load).
  - **T-024 (Nov 4, 2026; security and code review: no BLOCKER or HIGH, notes in `.agent/notes/review-T-024-*.md`; full Playwright suite 31 passed, 5 skipped):** page structure and iPhone chrome per the signed-off prototype. Closed from the T-023 list: apps/web Vitest runner with `loadLane`, `landingPath`, `mfaPath` and a static every-page-calls-`loadLane` test; proxy lane check narrowed (root files and dotted paths pass through; `/pkg`, `/%50KG`, `/PKG;--` and malformed encodings are refused); proxy 404 always `cache-control: private, no-store` + `vary: cookie`; More tab `covers` is `MORE_ITEMS`. **Open:**
    - M: the proxy session-read / `core.lanes` query reduction and prefetch skipping from T-023 are not done.
    - L: Home says "Good morning" with no name; the session carries no first name (`VerifiedSession` has only the user id). The title and the iPhone band take an optional name (`homeHeading`, `AppShell.firstName`); a profile/display-name source is needed (Robert's name is not in code).
    - L: the greeting is fixed text ("Good morning"), not time-of-day aware.
    - L: `tokens.test.ts` bans `text-gold`; the iPhone band's gold italic accent (navy in light and dark mode, as in the prototype) needed one exception, limited to `app-shell.tsx` and exactly one use. Revisit if the tokens gain a gold-on-navy text token.
    - L: root files such as `/robots.txt` now reach the `[laneId]` route and are answered by the page check (404 UI, status may be 200 because the page streams); T-025 should add real files/routes for them.
    - L: the e2e check that tab icons are hidden and the band shows the title is browser-only; the Finance period toggle is UI state and does not change any card yet.
    - L: Playwright specs were updated but not run by the builder (port 3100 in use); the coordinator runs the browser suite.
  - **T-024 review items (open, none above MEDIUM):**
    - M (code M1, M2), for T-163 and T-115: on iPhone the band reads "Approvals waiting for you" where p7 shows "Approvals" with the sub-line "3 waiting · <company>", and Home's date line sits below the band where p6 has it inside. Add a mobile heading (no accent) and a band sub-line to `AppShell`.
    - M (code M3): heading strings are duplicated between `nav.ts` and the Finance and Approvals pages. Read `navItem(...).heading` everywhere and test that they match.
    - M (security M1): the static every-page-calls-`loadLane` test only collects `page.tsx`, matches comments and constants, and ignores `route.ts`, `template.tsx`, `default.tsx` and nested layouts under `[laneId]`. Allow only page and layout files there (fail on any other kind), require `requireLane`/`requireRole` in any `route.ts`, and use an AST or ESLint rule.
    - L (security L1, L2): any first segment with a dot skips the proxy's lane check, including Next prefetch paths such as `/APK.segments/...`. The page still refuses, but with a soft 404 (status 200). Replace the dot rule with an explicit list of root files in T-025.
    - L: the `text-gold` exception matches `endsWith("app-shell.tsx")` (use an exact file name). The token, raw-gold and HTML-injection checks don't scan `apps/web/components`. `finance-page.tsx` names QuickBooks, Stripe and GoHighLevel in its copy (take the source names from `lane_config` with T-095). The sign-in/MFA redirects don't set `private, no-store` + `vary: cookie`. `proxy.test.ts` checks `vary` with an exact match.
    - L (code): the greeting is "Good morning" at all hours. The mobile eyebrow repeats the company name from the band chip. The "at least 9 pages" count is brittle. `PeriodToggle` should become a URL parameter with T-095.
    - L: next dev logs "Could not validate `instant`… NEXT_HTTP_ERROR_FALLBACK;404" for refused lanes. This is dev-only noise from the intended 404.
    - Fixed in the e2e run: helpers wait up to 30 s for first compiles (`/mfa`, `/`), the lane-home check matches the new "Good morning" H1, the iPhone eyebrow check is scoped to the visible eyebrow, and the root-file check now proves the app (not the proxy) answered (`/_next/` assets).

  - **T-050 / D-23 final reviews (Nov 4, 2026; security, code and DB: no BLOCKER or HIGH; full Playwright suite 31 passed, 5 skipped):** T-050 and T-198 set to done. **Open:**
    - M (DB): the custom SQLSTATE `D0023` is in a class the SQL standard reserves (A–H). Move it to `Z0023` in the migration, `vault/tokens.ts`, its test and pgTAP 120, together, before the next migration on `core.connection_token_store`.
    - M (DB): the "other 23505 stays 23505" pgTAP cases never reach the new exception block (the Vault name clash and the `connection_secrets_pkey` insert happen outside it), so the `raise;` branch is untested. Add a comment that the final update can only hit this index, or test it with a temporary second unique index.
    - M (security F-M1): the writer's hash and approver come from the caller. This is now in the T-195 acceptance: read both from the locked approval row.
    - M (security F-M2): a refused connect leaves a newer secret-less `pending` row, and `findConnection` returns the newest non-disconnected row, so the lane's real active connection shows as `not_connected`. Order usable statuses before `pending` (test: an active row plus a newer abandoned pending row), or delete the lane's own pending row on D0023.
    - L (security): lint rules miss `@/..` alias paths, `createRequire` and TS `import x = require()`; the approvals module could re-export the write side; `canonicalJson` accepts lone surrogates and sparse arrays (reject them, add the RFC 8785 vectors); any realm-to-lane lookup (webhooks, T-053) must apply the index filter and `lower()`; same-lane case-differing mailbox ids get a misleading refusal; several comments name `/writer` where the rule covers `/write`.
    - L (DB): the index build would fail on an existing database with case-differing duplicates across lanes (fresh and local databases are fine); the index-shape regex tests are loose.
    - e2e: sign-out waits raised to 30 s (first compile of the sign-out action).
- **T-055 (Nov 4, 2026; finance schema part 1, SQL by the builder, db-engineer/security/code reviews pending with the coordinator):** open items, all MEDIUM or lower:
  - M: `fin.report_cache.payload` has no database-side forbidden-key guard (raw.source_records has one). The T-052 connector must project reports to an allowlist; consider calling `raw.payload_has_forbidden_field` from a reviewed security-definer trigger.
  - M: `fin` is not exposed to PostgREST (`config.toml` `api.schemas` and `scripts/supabase-config.test.mjs` unchanged). T-081 (query layer) must expose it deliberately; RLS and the catalog test already cover it. Types for `fin` are generated now.
  - M: sign convention of `fin.transactions.amount` and the `posted_at` rule are left to T-056 (documented in the migration comments); T-056 must pin both in a test.
  - L: extra columns beyond the spec list: `connection_id`, `provider`, `raw_record_id`, `source_updated_at`, `deleted` (ledger tables), `line_no` (transactions), `created_at`/`updated_at`. `report_cache` uniqueness includes `connection_id`. Reviewers may veto.
  - L: bill payments (QuickBooks BillPayment) have no table in part 1; the spec lists none. AP uses `fin.bills.balance`.
  - L: `entity_code` has a shape check only (`^[A-Za-z0-9_]{1,32}$`); membership of the lane's entity list is the normalizer's job (rule 2: lists live in lane_config).
  - L: two unique indexes were added to other tables to carry composite foreign keys: `core.connections (id, lane_id, provider)` and `raw.source_records (id, connection_id)`.
  - L: viewers who hold the named `finance` view read every row of all six tables, including cached report payloads (spec §5). A narrower viewer scope would need views in T-080+.
  - T-055 review-fix pass (Nov 4, 2026; migration `20261104130000_fin_ledger_review_fixes.sql`): fixed HIGH db H1 (currency_code) and code H1 (payments key `alloc_no`, mutable `invoice_id`), and the MEDIUM items: raw_record and query indexes, report_cache report allowlist, frozen cache key and payload guard (the earlier report_cache guard item above is now closed in the database; the T-052 allowlist projection is still required), names and the digit-run check, `multi_class`, no DELETE for service_role on ledger tables, identity-freeze SQLSTATE `Z0055`. Added to the T-052 and T-056 acceptance text in the backlog; payroll handling is the open decision D-25 (default: excluded).
  - Not fixed, logged: M (code M4) money is typed `number` in the generated types, so T-081 must cast money to text in views or queries and never `select *` into JS arithmetic. M (code M6) the `period_lock` control has no source in part 1 (probably Preferences/CompanyInfo via T-052 or lane_config); settle it before T-196/T-094. L: `report_cache` has no retention (each new `as_of` is a new row of up to 4 MB; add keep-latest-N before T-052 schedules frequent pulls). L: offboarding or a connect-replace flow must archive or tombstone fin rows in dependency order (payments, transactions, invoices, bills, accounts, report_cache) before a connection or lane can go (`ON DELETE RESTRICT`). L: `raw_record_id` is not tied to the raw object type (T-056 sets it only from the matching type). L: `fin.accounts` has no income/expense classification column beyond free-text `type`/`subtype`. L: `alter default privileges in schema fin revoke execute ... from public` cannot remove the built-in PUBLIC EXECUTE default (schema-level defaults add to global ones), so the 050 catalog test stays the net for future fin functions. L: the digit-run name check misses separated numbers ("000-123-456"); masking in T-056 covers them. L: T-081 views must filter `currency_code = 'USD'`, `not deleted` and `not voided`, and be `security_invoker`.
  - **T-055 final security review (0e93648; no BLOCKER or HIGH):** T-055 set to done. M3 (constant-message name checks, no DETAIL echo) is in the T-056 acceptance; M4 (value checks in the report guard, payroll per D-25) is in the T-052 acceptance. LOW L9–L13 (depth limit vs real reports, raw error text naming the wrong table, scan timeout, reallocation history, full-width or separated digits) are in `.agent/notes/review-T-055-security.md`.
- **T-036 webhook receiver framework** (Nov 4, 2026; self-review, reviewers run by the coordinator; nothing below is BLOCKER or HIGH):
  - M: retention is not registered anywhere yet (T-042 does not exist). `core.webhook_events_purge(lane, keep)` and `WebhookStore.purge` are ready; T-042 must call them per lane (default 30 days, minimum 7).
  - M: the `WebhookVerifier` interface is synchronous. A Google-signed JWT (T-065, Pub/Sub push) may need key fetching; make `verify` return `VerifyResult | Promise<VerifyResult>` then.
  - M: T-053 must give the receiver a required env shape for the Intuit verifier token (T-050 review L5) and test 503 when unset; the framework refuses an unset secret, but only if `getSecret()` returns null or throws.
  - L: no per-source rate limit on the route (a signed flood is bounded by the 1 MiB cap and the 200-event cap; an unsigned flood costs one HMAC). Vercel firewall rules are the place if needed.
  - L: an unknown-account event is dropped with a 200; if a connection is created moments later that single event is lost (sync catches up). Accepted.
  - L: `received` rows are re-claimable after 2 minutes; the Inngest event id (`wh:<lane>:<provider>:<hash>`) covers the double send inside Inngest's dedupe window only.
  - L: the in-memory store in `testing/mock-webhook.ts` is pinned to the migration only by hand (pgTAP 140 is the authority).
  - L: `webhook/received` carries `provider` as a free-form token (core does not import the connector provider list); the connectors store only accepts the database's provider list.
  - L: ambiguous accounts (same account in two lanes) can only occur across separate lane databases; it is treated as unknown and logged as `ambiguous_account`.

## 7. Decisions log

### Oct 24, 2026 — Infrastructure (human-owned; closes H-001, H-010)

**Supabase**
- Staging project: ref `lxjhaxdkqtmkhloqaffb` (`https://lxjhaxdkqtmkhloqaffb.supabase.co`), East US. Public sign-ups disabled (invite-only). CLI linked by Saurabh. Production project (`jarvis-prod`) is created at go-live.
- Environments:
  - Local dev and **all tests**: local Supabase via `supabase start` (Docker), never the cloud project. Seeds are synthetic only.
  - Vercel Preview deployments → staging project.
  - Production → `jarvis-prod` (later).
- Schema changes only as SQL migrations in `supabase/**/migrations`, created with `supabase migration new`, applied locally with `supabase db reset`, tested with pgTAP. **Agents never apply migrations to any cloud project.** Saurabh applies them to staging/prod, manually or through the approval-gated migrate workflow.
- Types are generated from the local DB (`supabase gen types typescript --local`) into a shared package, and the generated file is committed.
- Next.js 16 integration uses `@supabase/ssr`:
  - The browser client uses only the URL and the publishable/anon key.
  - Server components, route handlers and server actions use the cookie-based server client.
  - Session refresh runs in `proxy.ts`, not `middleware.ts`.
- The secret/service_role key is server-only: used only where RLS must be bypassed (jobs, connector token vault), never imported into client components, never in a `NEXT_PUBLIC_` variable, never logged. A lint/test guard must fail if it appears in a client bundle.
- Auth (later tasks): email 6-digit code / magic link + TOTP MFA (AAL2), invite-only, SMTP via Resend (H-016). Saurabh adds the redirect URLs for `localhost:3000` and the Vercel URLs.

**Vercel**
- Project connected to the GitHub repo. Root Directory `apps/web` with "include files outside root" on. Production branch `main`. Every PR gets a Preview deployment. Vercel Authentication (deployment protection) is on for Preview and Production.
- Env vars are set by Saurabh in the Vercel dashboard (Preview = staging values, Production = prod values). **Agents never run the `vercel` CLI and never deploy.**
- Code reads config only from env vars, validated at startup by Zod with **separate server and client schemas**, so a missing or misplaced variable fails the build with a clear message.
- `.env.example` is the canonical list of variable names. Supabase now calls the keys "publishable" and "secret". A task that wants `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` instead of the current ANON/SERVICE_ROLE names proposes the exact `.env.example` diff in its PR body. Saurabh applies it and mirrors it in Vercel.
- Server routes that use Node-only libraries (connectors, the Inngest endpoint later) run on the Node.js runtime, not Edge.

**Where this lands in the backlog**
- **T-003:** boundary rule (d) also covers the client-bundle guard for the secret key (import of the service client or secret env name from a `"use client"` module, or the value in built client chunks).
- **T-005:** server and client Zod schemas (acceptance updated). H-019 done; see the env review below.
- **T-006:** type generation from the local DB into a shared package. Fix the `.gitignore` gap from §6 M3. The CLI link Saurabh made isn't inside this repo (there is no `supabase/` folder yet). After T-006 creates `supabase/core`, Saurabh re-links from there (`supabase link --workdir supabase/core`, or run it inside that folder), because `migrate-prod.yml` runs the CLI from `supabase/core`.
- **T-018 – T-021 (auth):** `@supabase/ssr` clients and session refresh in `proxy.ts`.
- **T-171:** staging runbook now has its inputs (H-001, H-010 done).
- Production-domain DNS is split out as **H-021** (waits on D-5).

### Oct 24, 2026 — `.env.example` review (closes H-019)

Saurabh applied these changes to `.env.example` on Oct 24 and renamed the Vercel Preview variables to match. `.env.local` is filled after T-006 (local Supabase). T-005 owns the secret-pattern list; T-003 imports it.

| Change | Why |
|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY` (and `SUPABASE_NL_SECRET_KEY`) | Matches Supabase's current key model (`sb_publishable_` / `sb_secret_`), which can be rotated independently of the JWT secret. Recommended now, before any code reads the old names. |
| Remove `AUTH_PROVIDER`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | They describe Microsoft/Google sign-in, which D-6 replaced. Leaving them invites code to use them. |
| Keep `GOOGLE_OAUTH_*` under the mail connector; `AZURE_TENANT_ID` → `GRAPH_TENANT_ID` | The connector (H-008) still needs them; one `GRAPH_*` family for Microsoft. |
| Remove `SUPABASE_DB_PASSWORD` | The app never uses it. The CLI/migrate workflow reads `SUPABASE_*_DB_PASSWORD` from GitHub secrets. It shouldn't be in Vercel. |
| `VAPID_PUBLIC_KEY` → `NEXT_PUBLIC_VAPID_PUBLIC_KEY`; add `VAPID_SUBJECT` | The browser needs the public key to subscribe (T-160); `web-push` requires a subject. |
| `SENTRY_DSN` → `NEXT_PUBLIC_SENTRY_DSN` | T-041 reports from client and server; a DSN isn't a secret. |

Client schema after the diff: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `NEXT_PUBLIC_SENTRY_DSN`. Everything else is server-only.

No Resend variable in the app: Supabase Auth sends sign-in mail through Resend SMTP configured in the Supabase dashboard (T-021), and local tests use Mailpit.

### Oct 24, 2026 — Env strictness (T-005)

Decided by Saurabh (supersedes "core vars (app, Supabase, Inngest, Anthropic) fail the build" in T-005):

- **Required in every environment:** `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, plus `APP_ENV` and `ENABLED_LANES` (app config, not credentials).
- **Optional in production too (changed Oct 31, 2026, "Production only, no staging" below):** `ANTHROPIC_*` and `INNGEST_*`. An absent group means the feature is off ("not configured", one startup warning). A partially set group is still an error in production (`APP_ENV=production` or `VERCEL_ENV=production`) and fails the build and boot.
- **Local, staging and Preview:** both groups are optional. If missing or partial, the server logs one startup warning (variable names only, never values) and `getAnthropicEnv()` / `getInngestEnv()` return `{ configured: false, missing }`, so AI and job features report "not configured" instead of crashing.
- **Build gate:** validation runs on deployment builds (`VERCEL=1`, which must come with `VERCEL_ENV`), when `APP_ENV` is `preview`, `staging` or `production` (so self-hosted builds are covered too), or with `NICHOLS_VALIDATE_ENV=1`; CI typecheck, lint and test need no env. A missing core variable on a deployment stops the build, and the same check at server start (`instrumentation.ts`) stops the server at boot.
- **Vercel setting:** "Automatically expose System Environment Variables" must stay ON (`VERCEL`, `VERCEL_ENV`, `VERCEL_TARGET_ENV`, `NEXT_PUBLIC_VERCEL_*`). `APP_ENV` must agree with the platform, and URLs must be https outside local. Updated Oct 28, 2026 for the Staging environment decision (§7 "Staging environment and real data"):

  | Vercel deployment | `VERCEL_ENV` / `VERCEL_TARGET_ENV` | `APP_ENV` |
  |---|---|---|
  | Production | `production` / `production` | `production` |
  | Custom environment Staging (branch `staging`) | `preview` / `staging` | `staging` |
  | PR Preview | `preview` / `preview` | `preview` |

  `local` is accepted on Vercel only for `vercel dev` (`VERCEL_ENV=development`), `staging` only with `VERCEL_TARGET_ENV=staging`, and `preview` nowhere but a Vercel Preview. A PR Preview may not hold the Nichols Law data plane (`SUPABASE_NL_*`). The connector-time Intuit check applies the same target rule, so `APP_ENV=staging` on a PR Preview is never a real-data environment. Consequences: `vercel dev` needs `APP_ENV=local`; `vercel build` locally needs the values of the target it imitates. A local `next dev` with `APP_ENV=staging` (e.g. against the staging Supabase project) needs https URLs.
- **PR Preview (`APP_ENV=preview`):** the Supabase variables are optional, all three or none (a synthetic-data project, H-025). Without them, `getSupabaseSecretKey()` and `requireSupabasePublicEnv()` throw, naming the variables, and the server logs "No database in this preview deployment".
- **Intuit guard:** `INTUIT_ENVIRONMENT=production` is refused unless `APP_ENV` is `staging` or `production` (or `VERCEL_ENV=production`). It is checked at build and boot in every environment (also local, where the rest of the gate is off), by the server schema, and again by `requireConnectorEnv("intuit")` from the real process env.
- **Also decided in review:** the Supabase secret key is read only through `getSupabaseSecretKey()` (not in the general env object); `NEXT_PUBLIC_*` values are allow-pattern checked and every `NEXT_PUBLIC_*` variable present at build is scanned against the secret-pattern list.

Where this lands: backlog T-005, T-003 rule (c)/(d) imports `@nichols/core/env/secret-patterns`, T-041/T-171 (set Preview vars; Anthropic/Inngest needed only for production).

### Oct 24, 2026 — Pilot KPIs and metric definitions (closes D-2, D-9)

**D-2 — pilot KPI list (PKG)**
- Cash, labelled "book balance" (per account under the owning entity, D-18)
- AR total and AR >30 days
- AP due in ≤14 days
- P&L MTD and YTD
- MRR
- Monthly churn
- Paid subscribers (GoHighLevel), with new and cancelled this week
- Controls: unreconciled items >30 days, disconnected feeds, uncategorized transactions

**D-9 — MRR and churn (Stripe; months in America/New_York)**
- **MRR** = sum of active Stripe subscriptions, normalised to monthly (annual ÷ 12, quarterly ÷ 3), after recurring coupons. Excludes trials, 100%-discounted subscriptions and one-off charges. PKG products only, via `lane_config`.
- **Churned MRR** = MRR of subscriptions cancelled or ended in the month.
- **Revenue churn %** = churned MRR ÷ MRR at the start of the month.
- **Customer churn %** = subscribers cancelled in the month ÷ subscribers active at the start of the month.
- **Net new MRR** = new + expansion − contraction − churned.

**Decided Oct 24, 2026** (confirmed by Saurabh; implemented in `docs/specs/finance.md`):
1. **Customer churn %** counts GoHighLevel paid subscribers, so it waits on D-3. **Revenue churn %** uses Stripe. Customer churn is cancelled ÷ start-of-month subscribers, unclamped, so it can exceed 100% (same-month start+cancel counts in the numerator only).
2. **Start of month** = 00:00 America/New_York on the 1st.
3. A subscription that **starts and cancels in the same month** counts as both new and churned.
4. **Expansion/contraction** = the change in an active subscription's MRR (price, quantity or coupon change), measured month-start vs month-end.

### Oct 24, 2026 — Rule 6 scope for PKG (closes D-19) and weekly snapshot timing (Q-F9)

**D-19 (a) — outbound email drafts.** PKG may store a drafted outgoing email **only while it is pending approval** (`proposed`, `approved` or `executing`). The body is deleted as soon as the action reaches any terminal state (`verified`/sent, `failed`, `rejected`, `expired`, `invalidated`, or superseded). After that the approval record keeps only the payload hash, recipients, subject and timestamps (plus type, target ids, status and audit), never the body. `lane_policies.store_outbound_drafts` = true for PKG (default false for other lanes); there is no retention window for bodies.

**D-19 (b) — assistant conversations.** Rule 6 does not cover the assistant's own conversation text. Conversations are stored per lane, kept 180 days, and can be deleted by the user. Email and document content appears in them only as short cited snippets with links to the source, never full bodies.

**Snippet limit (decided Oct 24, 2026).** Each quote of email/document content in a stored assistant message is capped at 300 characters by default, configurable per lane (`lane_config.assistant.max_snippet_chars`), with a citation link to the source.

**Q-F9 — weekly snapshot timing.** Default accepted for now: Saturday 06:00 America/New_York for the Sat–Fri week just ended. Saurabh is confirming with Sophie.

Where this lands: `docs/specs/approvals.md` §4, §6, §8, §13, §14; `docs/specs/assistant.md` §4, §8, §9; backlog T-010, T-103, T-110, T-111, T-116, D-14.

### Oct 24, 2026 — Design gating (opens D-20, supersedes D-15) and provisional design tokens

Design is being done in a separate prototype (Claude Design canvas) for Robert's sign-off on **Nov 5–6** (PL-26). Until then:
- The app shell and every screen task wait on **D-20**: T-023 – T-026, T-045 – T-047, T-095 – T-097, T-106, T-115, T-122, T-131, T-163 (Release A) and T-141, T-150, T-154, T-156 (Release B). D-15 (which only blocked T-024) is folded into D-20.
- Platform work carries on: T-003, T-005, T-006, T-007 (synthetic seed, *not* a screen task), the data model (T-010 – T-017), auth (T-018 – T-021) and T-022 (UI components on the provisional tokens below). The sign-in and MFA pages from T-018/T-019 are functional and get restyled after sign-off.

**Provisional design tokens** — v2, Oct 24, 2026: the prototype was restyled to match pub-k.org (final after D-20; implement as CSS variables / Tailwind theme so only values change):

| Token | Value |
|---|---|
| Heading font | Source Serif 4 (`Georgia, serif` fallback); italic for accent words |
| Body font | Inter (`system-ui` fallback); tabular numbers (`font-variant-numeric: tabular-nums`) for all figures |
| Ground (page background) | `#F7F4EC` (cream) |
| Surface (cards, panels) | `#FFFFFF` |
| Border | `#E7E1D3` |
| Divider | `#F1ECE0` |
| Text | `#111827` |
| Muted text | `#4B5563` |
| Primary (navy) | `#0E2A47`; hover `#081A2E`; tint `#E4ECF5` |
| Accent italic text | `#1F4A7A` |
| Accent gold | `#D4AF5A`, decoration only; gold **text** on cream uses `#8A6A1F` for contrast |
| Alert | `#B45309`; alert text `#92400E` on `#FCEFD9` |
| Success | `#166534` on `#DCFCE7` |
| Radius | 8px controls, 12px cards |

**Side menu (desktop):**

| Token | Value |
|---|---|
| Background | `#0E2A47` (navy) |
| Item text | `#D5DEEA` |
| Section labels | `#A9B8CC` |
| Active item | `#1F4A7A` with a 3px gold left edge `#D4AF5A` |
| Company switcher | `#143559`, border `#2C4F78` |

Contrast (WCAG 2.x) checked for every text pair above: all ≥ 4.5:1. Tightest: gold text `#8A6A1F` on cream 4.59:1, alert `#B45309` on cream 4.57:1. Raw gold `#D4AF5A` on cream is 1.9:1, so it never carries text on light backgrounds (on navy it is 7.0:1, fine for the iPhone header accent word).

**Provisional layout:**
- Desktop: left side menu with the company (lane) switcher at the top; content max-width 1200px.
- iPhone: bottom tabs **Home · Approvals · Inbox · Ask · More**.
- iPhone header: navy band (`#0E2A47`) with a white title and a gold accent word.
- Book balances are always labelled "book balance" (rule 7).

Not yet decided: dark mode and chart palette (Recharts). Raise both at the sign-off. **Settled Nov 4, 2026** (D-20 batch 1): tokens final as above; light and dark mode (dark set and chart palette in `docs/design/README.md`).

Where this lands: backlog D-15, D-20, T-022 and the screen tasks listed above; parallel-worktrees table (W1).

### Oct 28, 2026 — QuickBooks Online (closes H-005, H-017; opens H-023, H-024)

**Status**
- **H-005 done.** One Intuit app, "Jarvis" (QuickBooks Online and Payments; scope `com.intuit.quickbooks.accounting` only). One app serves every company. Each company file connects separately through OAuth with its own realmId and tokens per lane.
- Sandbox keys in `.env.local`: `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET`, `INTUIT_ENVIRONMENT=sandbox`, `INTUIT_REDIRECT_URI=http://localhost:3000/api/connect/qbo/callback`. A sandbox company exists.
- **H-017 done.** App assessment submitted; production keys issued. They are kept in 1Password only, never in `.env.local`.
- **New H-023:** the Vercel Staging environment at `staging.portal.pub-k.org` (see the staging entry below) and the Intuit production redirect URI `https://staging.portal.pub-k.org/api/connect/qbo/callback`; later `https://portal.pub-k.org/api/connect/qbo/callback` (with H-021).
- `INTUIT_WEBHOOK_VERIFIER_TOKEN` is added when the webhook endpoint exists (H-024).

**Environments**
- Local/dev and all tests: sandbox keys and the sandbox company only; recorded fixtures (synthetic values) in tests.
- Staging (fixed URL): **production** Intuit keys, used to connect the real Pub K Group file for the tie-out, Nov 16–25. Data stays in the staging Supabase project, reachable only from the Vercel Staging environment (staging entry below).
- Production: production keys at go-live.
- Companies: PKG now (Saurabh is QBO admin); Nichols Law later (Saurabh is admin). For Ask Pub K, Pub K Institute and Nichols Capital, either Sophie grants Saurabh access or connects them herself, or they are classes inside the PKG file (D-8, waiting on Sophie).

**Scope of use**
- Read-only: never create, update or delete QuickBooks data. Accounting API only (no Payments, no Payroll).
- Entities: Account, Invoice, Bill, Payment, BillPayment, Purchase, Deposit, JournalEntry, Customer, Vendor, Class, CompanyInfo, Preferences.
- Reports: ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables. The aging **detail** reports are dropped from T-052; drill-down comes from `fin.invoices` / `fin.bills`.
- Sync: webhook-triggered CDC fetch of changed entities, a backup CDC poll every 4 hours per company, and a nightly full report pull (replaces the 2×/day report default). Book balances are always labelled "book balance".
- PKG figures exclude Ask Pub K and Pub K Institute through the `lane_config` class/customer mapping (D-8).

**Connector acceptance criteria.** QB-1 – QB-20 from the Intuit assessment are listed in `docs/backlog.md` Phase A5. All must pass on the sandbox company before any real company is connected. The QuickBooks tasks are app code: full security + code review, fix all BLOCKER and HIGH.

Where this lands:
- backlog H-005, H-017, H-023, H-024, D-8; T-050 – T-053, T-056, T-081, T-090, T-095, T-161 and T-172 (now needs H-024);
- new **T-195** (disconnect, reconnect, error mapping), **T-196** (sync/API error log + export; needs Sentry, H-011, through T-041) and **T-197** (Settings → Connections, functional before D-20 like the sign-in pages);
- T-052 now also depends on T-055 (it writes `fin.report_cache`); T-050 on T-011 (the realm lives in `lane_config`);
- `docs/specs/finance.md` §8.1 and §9.

### Oct 28, 2026 — Staging environment and real data (resolves the real-data conflict; defines H-023)

- **Vercel custom environment "Staging"**, bound to branch `staging`, domain `staging.portal.pub-k.org`. This is H-023.
- **Real-data secrets live only there:**
  - the staging `SUPABASE_SECRET_KEY` (and the staging Supabase URL and publishable key)
  - the production Intuit keys
  - the production redirect URI `https://staging.portal.pub-k.org/api/connect/qbo/callback`
- **Vercel Preview (PR deployments) gets no real-data secrets.** Sandbox Intuit keys only, no staging secret key. A Preview that needs a database uses synthetic data (H-025, optional); until then Previews run without a database.
- **Guard (T-005).** The app refuses `INTUIT_ENVIRONMENT=production` unless `APP_ENV` is `staging` or `production`. It checks at build, at boot and when the connector is used. `APP_ENV` gains a `preview` value for PR deployments. On Vercel, `APP_ENV=staging` is accepted only when `VERCEL_TARGET_ENV=staging` (the custom environment).
- **Supersedes:**
  - H-010's "Preview → staging Supabase"
  - T-171's "no real data in preview", which now applies by construction
  - the Oct 24 env review note that Vercel Preview = staging values
  - architecture §11's "staging uses the QBO sandbox", for QuickBooks only
- **`.env.example` (human-owned).** The `APP_ENV` comment becomes `local | preview | staging | production`. T-005 proposes the exact diff in its PR body.

Where this lands: backlog H-010, H-023, H-025, T-005, T-171; `docs/specs/finance.md` §8.1.

### Oct 31, 2026 — Production only, no staging (supersedes the Staging environment above)

Decided by Saurabh. The pilot has three users (Robert, Saurabh, Sophie), so there is no separate staging site.
- **Vercel Production (branch `main`) is the only real-data environment.** It holds the Supabase project, the production Intuit keys and `INTUIT_ENVIRONMENT=production`. There is no custom environment "Staging" and no `staging` branch.
- **The existing Supabase project `lxjhaxdkqtmkhloqaffb` becomes the production database.** No second project for now. (Its old label "staging" stays in older entries.)
- **PR Previews stay free of real data**, as decided Oct 28: `APP_ENV=preview`, sandbox Intuit keys, no Supabase values unless a synthetic-data project exists (H-025).
- **Anthropic and Inngest are optional in production** (env strictness above), so production can deploy before H-002 and H-003.
- **Guardrails that replace staging:** branch protection on `main` (H-012, now urgent: every merge reaches the live books); migrations tested locally with `pnpm test:db` and, when possible, on a throwaway project before they are applied to production; Supabase backups or point-in-time restore on; QB-1 – QB-20 pass on the sandbox company before the live file is connected (H-024).
- **Intuit redirect URI:** the stable production address, `https://<production domain>/api/connect/qbo/callback`. Until H-021 (DNS) that is the project's fixed `*.vercel.app` production domain, never a per-deployment URL.
- **Code:** T-005 keeps accepting `APP_ENV=staging` (unused, harmless). Nothing else changes.
- **Development mode:** for now the in-progress tasks (T-003, T-005, T-007, T-022, T-030) are worked on together and split into per-feature PRs later.

Where this lands: backlog H-010, H-023 (now Production), H-024, T-005, T-171, QuickBooks-first schedule.

### Oct 31, 2026 — Finance operator uses the assistant

Decided by Saurabh: the finance operator (Sophie) has the `assistant` view in her lanes (resolves assistant spec Q-S3; architecture §5.4 listed the finance module only). The assistant's tool policy gate still limits what she can query: each tool's required view (e.g. `finance`) must be one her role holds, so she cannot reach approvals or other content through the assistant. Lands in `core.role_views` (T-012).

### Oct 31, 2026 — Core and audit schemas over the API; session lifetime (T-016/T-017 security review)

- **`core` and `audit` are exposed to PostgREST** so server code reaches them through supabase-js (lane router). A signed-in AAL2 user (or script in their browser tab) can therefore query these schemas directly; RLS is the boundary, which the pgTAP suites and the catalog test enforce (no anon access, no user DML, reviewed definer and callable functions). Module data that must only flow through the policy gate (for example assistant tool results) goes in schemas that stay unexposed or behind server routes. An NL-plane schema is never exposed this way (architecture §5.2). `scripts/supabase-config.test.mjs` pins the exposed list.
- **Access tokens live 15 minutes** (`jwt_expiry = 900`), so a revoked session or removed MFA factor stops working within 15 minutes; membership and role changes apply immediately through RLS. Approval and step-up paths (T-119, T-193) verify with `auth.getUser()` (server-checked) rather than local claim verification. Production should use asymmetric JWT signing keys (claims verified locally, no auth round trip per request).
- **Job client restricted:** `getLaneJobClient` (bypasses RLS) is a restricted name: Inngest client and route, approvals executor and token vault only; module jobs are added to `JOB_RUNNERS` deliberately when written.

Where this lands: backlog H-026; `.agent/pr/T-016.md`, `.agent/pr/T-017.md`.

### Oct 31, 2026 — Sign-in risks accepted for now (T-018 security review)

- **Account discovery against Supabase directly.** The app's form answers the same for known and unknown addresses, but Supabase's public `/otp` endpoint (publishable key) answers differently. Accepted until production CAPTCHA (H-027): the account list is three people, and the second factor (TOTP, T-019) is mandatory.
- **Email-code guessing.** Supabase does not cancel a code after wrong guesses; its limits are per IP. The app allows 5 wrong codes per emailed code; mandatory TOTP limits what a guessed code gives. Production: CAPTCHA on send (H-027) and a review of Supabase's per-IP limits for traffic that arrives from the app server's addresses (T-021), so one attacker cannot exhaust everyone's sign-in budget.
- **Email links sign in on a plain GET.** Link scanners may use up a link; the 6-digit code is the primary flow and is unaffected.
- **Session cookies** are httpOnly and Secure (outside local); nothing in the browser reads them.

Where this lands: backlog H-027, T-021; `.agent/pr/T-018.md`.

### Oct 31, 2026 — MFA attempt guard (T-019 security review)

- An attacker who gets past the email code holds an AAL1 session and can call Supabase's MFA endpoints directly, so the limit on authenticator codes lives in the database: the Auth hook `core.mfa_verification_attempt` rejects every attempt after 5 failures in 15 minutes and audits lockouts and new authenticators. Supabase also emails the user when an authenticator is added or removed.
- **Plan check (H-028):** Supabase offers the MFA verification hook only on some plans. If the production plan lacks it, the alternatives are a plan upgrade or accepting the risk with alerting on repeated failures (the email code, CAPTCHA H-027 and the 15-minute token lifetime remain).
- Future server actions are callable from any page, so every data action calls `requireLane` / `requireRole` / `requireStepUp` itself; the proxy is never the gate (module tasks inherit this rule).

Where this lands: backlog H-028; `.agent/pr/T-019.md`; `docs/runbooks/mfa-recovery.md`.

### Oct 31, 2026 — Background jobs (T-037 security review)

- Inngest runs only where the code is reviewed: never on PR Previews (the env refuses Inngest keys there; the route answers 503), and outside local development every request must be signed (unsigned app sync disabled, app URL pinned to `NEXT_PUBLIC_APP_URL`). Dev mode needs `APP_ENV=local` and a development build.
- Events are sent only through `sendLaneEvent` (validated against the registered schema, lanes limited to `ENABLED_LANES`); the SDK and the client are importable only from `packages/core/src/inngest` and the route (lint). Functions validate events again on receipt.
- Nichols Law (later rollout): its jobs get their own Inngest environment and keys (architecture §2), chosen by lane in the Inngest client; until then NL is not in `ENABLED_LANES`.

Where this lands: backlog H-003; `.agent/pr/T-037.md`.

### Nov 2, 2026 — Connector tokens in the Vault (T-032 review)

- A connection's credential is one Vault secret, reached through `core.connection_token_store/read/rotate/revoke` (service_role only, lane-checked, serialised per connection by a row lock). Store is connect/reconnect and sets the connection active; revoke is the disconnect and sets it disconnected; both are audited with the acting user when there is one, rotate (hourly token refresh) is not.
- `core.connections.token_expires_at` is the expiry of the credential whose loss forces a reconnect (refresh token, API key), not the access token's. T-040 warns on it.
- **Known limit, accepted:** Supabase's vault extension grants service_role direct read/write on `vault.*`. The grant comes from `supabase_admin`, so our migrations cannot revoke it (tried Nov 2, 2026). Lane isolation of tokens therefore holds in the database for every API user, but for server code it also relies on code discipline: only `packages/connectors/src/vault/**` may use the Vault (lint rule, T-033). A pgTAP test pins the current grant so a platform change is noticed.

Where this lands: `.agent/pr/T-031.md`, `.agent/pr/T-032.md`; follow-ups in §6.

### Nov 2, 2026 — Raw source records guards (T-039 second-round security review)

- The content-body and forbidden-data guards are **denylists and only a backstop** (key names, not values). Every adapter must project each provider/object_type to a strict allowlist of fields before storing, and use `stripForbidden()` from `@nichols/connectors/raw` for anything it still copies wholesale. Key-name matching will always miss a new provider field with an unexpected name.
- Forbidden-data rules are word-aware (camelCase, `_`, `-`, `.` boundaries plus the joined form): whole words ssn/sin/ein/tin/pin/iban/swift/bic; contained socialsecurity, taxid, acctnum, accountnum, accountno, routing, salary, wage, compensation, payroll, password, passwd, secret, apikey, privatekey, credential (and billrate/costrate/payrate/hourlyrate); words ending in `token` except SyncToken/pageToken/nextPageToken/deltaToken; `rate` next to bill/cost/pay/hourly; bare `rate` for timesolv. Known gaps: all-caps run-together names such as `EMPLOYEESSN` (no word boundary) and `accountNotes`-style false positives from `accountno` are accepted.
- **Open decision (owner: Saurabh / Robert):** do monday `column_values` and Notion `plain_text` titles count as content under rule 6? Today a monday `column_values`/`values` key and Notion `plain_text` (contains `text`) are treated as body fields, so they are stored only when the lane policy allows content bodies. If titles and column values are metadata for the pilot, the monday and Notion adapters need an explicit, documented allowlist and the guard a narrower safe list.
- Guard cost is bounded: one walk, one normalisation per distinct key, 20000 distinct keys per payload (22023), 1 MB per payload in the database and 680000 bytes of JSON in TypeScript; a statement timeout (57014) is mapped to `invalid_input`.
- A record without `source_updated_at` is skipped (not written) when the stored row has one; it can only replace a row that has none.

### Nov 2, 2026 — Raw source records, round 3 (T-039)

- **Custom-field arrays bypass the key guards.** QuickBooks `CustomField: [{Name, StringValue}]` and GoHighLevel `customFields: [{id, value}]` carry the field name as a value, so a field called "SSN" or "Bank account" is not seen by the key-name guards. Every adapter's allowlist projection must drop these arrays or allowlist the field names/ids it keeps.
- Remaining known gaps: guards are denylists on key names only; run-together names (`EMPLOYEESSN`, `employeessn`, `sSNLast`) and cross-script look-alikes are missed; substring terms fein, itin, wage refuse caffeine, itinerary, sewage; stored bodies persist after the policy turns off (T-042 purge); monday/Notion content decision above is still open.

### Nov 4, 2026 — Design sign-off, batch 1 (closes D-20, opens D-21, H-029, H-030)

Saurabh approved every point of the batch-1 design review ("approved all points") and then answered the open choices the same day.
- **Tokens:** the provisional v2 tokens above are final.
- **Light and dark mode** both ship in Release A. The app follows the device setting with a user override. The dark set is derived from the light one (the prototype shows light only) and is in `docs/design/README.md` and `packages/ui/src/styles/theme.css`; every text pair is ≥ 4.5:1 (tested).
- **Chart palette** (`--chart-1` … `--chart-4`): light navy `#0E2A47`, blue `#3B6EA5`, orange `#B45309`, brown `#7C2D12` (each ≥ 4.5:1 on white and cream); dark `#9DB9DC`, `#5B8FCB`, `#F0A35E`, `#E8590C` (each ≥ 3:1 on dark cards). Blue vs orange is colour-blind safe, and every bar carries a text label, so colour is never the only cue.
- **Required changes to the prototype** (apply in the screen tasks): "book balance" in full on iPhone; the approval card shows the exact payload; Edit on iPhone approvals; a source/freshness chip on every figure card. Details in `docs/design/README.md`.
- **Projects is in Release A**, read-only from monday.com: side-menu entry (T-023), Projects page (T-150, moved to Release A; page design in batch 2, D-21) and "Projects at a glance" on Home (T-163). This supersedes the sitemap's Release B marking. **Schedule:** T-150 adds one task to Release A; it depends on T-070 (monday.com connector, H-009) and T-101, both already in Release A.
- **"All companies (owner)"** comes after the pilot. A combined view across lanes needs its own design (every query is per lane) and its own decision. The pilot switcher lists only enabled, allowed lanes.
- **Fonts:** Source Serif 4 and Inter confirmed (the PDF renders with fallbacks).
- **Meeting provider:** "Teams" on the prototype is sample text; D-1 remains open.

Where this lands: backlog D-20, D-21, H-029, H-030, T-023 – T-026 and the screen tasks' `needs`; `docs/design/README.md`.


### Nov 5, 2026 — T-061 review findings (MEDIUM and below)

- **M1 summary vs lane policy. Fixed after review:** trigger `comms.message_summary_guard` rejects a summary unless the lane's `llm_allowed_categories` includes `email`, and requires a new approval time when the summary changes. The writer (classifier job) must still use the approvals path before setting it.
- **M2 free-text metadata.** `subject`, `title`, `location`, display names are stored as provided (length and control-character checked only). They can hold sensitive text; the Release B retention/redaction rules apply, and the AI layer must treat them as untrusted data (rule 9).
- **L1 approver not lane-checked. Fixed after review:** the same trigger requires `summary_approved_by` to be a member of the row's lane.
- **L2 direct deletes.** service_role may delete index rows directly (sync deletions); only the purge functions enforce the retention floors. The T-042 job must use the purge functions.
- **L3 `comms` view is owner-only.** `comms` is not in `viewer_view_names()`, so a viewer cannot be granted message metadata (events: `calendar` is grantable). Decide with the T-120 inbox design.
- **L4 schemas not exposed / types.** `comms` and `cal` are not in the API exposed schemas (like `fin`), so `packages/core/src/db/types.ts` (core only) is unchanged. When the inbox/calendar UI needs PostgREST access, a human adds the schemas in Supabase settings and the config file in that task.
- **L5 events age by `end_at`; messages by `received_at`.** A long recurring series master is kept until its last end.
- **Review additions (T-061 real reviews, no BLOCKER/HIGH):** (a) Graph message ids must be requested with `Prefer: IdType="ImmutableId"` (T-066), or ids change when a message moves folders. (b) T-064 must call events with `singleEvents=true`, store `syncToken`/`historyId` per connection (not per row), and upsert only when `excluded.source_updated_at >= existing`. (c) Free-text metadata (subject, title, location, names) is untrusted when sent to prompts (rule 9). (d) Direct service_role deletes bypass the purge floors; T-042 must call `comms.message_index_purge` and `cal.event_index_purge` (added to its acceptance).

### Nov 5, 2026 — T-062 review follow-ups (mail/calendar/docs provider interfaces)

Logged, not built in T-062:
- **`reveal()` call-site lint rule:** allowlist the modules that may call `UntrustedBody.reveal()` (assistant context builder, UI render); follow-up lint task.
- **Phase-4 `changes` bounds:** `CalendarWriteIntent.changes` and `DocumentWriteIntent.changes` are unbounded JSON records; add size and depth limits before T-117/T-181.
- **`persistedContentWrites` must be real in real harnesses:** T-063 backs it with a DB-write spy plus log capture, not a constant like the mock.
- **Decision: `watch`/`renew`/`stop` are acceptable under rule 5** on these conditions: the callback URL/topic comes from server config only; only jobs (T-065, T-068) call them; `renew`/`stop` act only on channels recorded server-side for the same (lane, connection). The channel token (Google) / clientState (Graph) lives in the Vault, never in `WatchInfo`.
- **Approvals:** also check `lane_config.mailboxes` / `approvals.allowed_mailboxes` at propose time (the provider only checks `fromMailbox` equals the connection's mailbox).
- **T-063:** set `core.connections.external_account_id` to the verified primary address of the mailbox.
- **Folder/label/importance mapping** (documented in `comms/schemas.ts`): `folder` = primary container (Gmail INBOX label, Graph parent folder), `labels` = Gmail labels / Graph categories, `is_important` = Gmail IMPORTANT / Graph importance high. Graph needs `Prefer: IdType="ImmutableId"`.
- **Parameter ids:** call parameters use a conservative id charset (no `/ ? # ..`), so Google holiday calendar ids containing `#` need an encoded form decided in T-064.

### Nov 5, 2026 — T-063 design notes and limits (Google OAuth + Gmail metadata sync)

- **Account identity without extra scopes.** The mailbox is the `emailAddress` of Gmail's own `users/me/profile` read with the new access token (needs only `gmail.readonly`), lower-cased, into `core.connections.external_account_id`. The Workspace hosted domain (`hd`) would need an id_token and OIDC scopes the H-008 client does not request, and `lane_config` has no hosted-domain field, so `lane_config.mailboxes` is the only allowlist (both pubkgroup.com and pub-k.org addresses). A lane with no mailboxes refuses to connect, before any code is exchanged.
- **Scopes verified on the callback:** the token response `scope` must be exactly gmail/calendar/drive `.readonly` (OpenID extras tolerated); any other scope, a missing one (granular consent) or a missing refresh token refuses the account and nothing is stored (the owner is told to remove the app's access at Google, D-24).
- **Revoke at Google is approvals-only** (`googleWriter` in the write subpath, action `google.revoke_grant`, same shape as the QuickBooks writer). Nothing calls it yet.
- **`has_attachments` is a header heuristic** (`Content-Type: multipart/mixed`): metadata responses carry no MIME parts. The sync therefore requests `Content-Type` as a sixth metadata header. Calendar invites and some inline-image mail can be misclassified; refine when the inbox UI needs it.
- **First load** covers 90 days (`fullSyncDays`, default = PKG retention) and takes the profile `historyId` before listing, so mail arriving mid-load is caught by the first incremental sync. A forced full resync (history older than about a week) re-upserts but does not reconcile messages deleted during the gap; the retention purge removes them. Add reconciliation if the inbox shows stale rows.
- **Sync persistence is SQL:** `core.sync_cursors` (new, RLS + pgTAP) and `core.comms_mail_apply_page` (page + cursor in one transaction). `comms`/`cal` are not PostgREST-exposed (T-061 L4), so the writer is a `core` definer function like `raw.source_records`. Calendar (T-064) and Graph reuse the cursor table with their own stream names (the apply function is mail-specific).
- **Not wired to Inngest.** There is no connector sync job in the repo yet (T-038 skeleton); `mailSync.run(laneId, conn)` is exported from `@nichols/connectors/google` for it, and for T-065 (push) to call.
- **HTTP client:** `query` values may now be arrays (repeated parameter) for Gmail `metadataHeaders`. Google calls go through `createGoogleHttp`, which refuses any host outside gmail.googleapis.com, oauth2.googleapis.com, accounts.google.com and www.googleapis.com.

T-063 review follow-ups (logged, not fixed):
- **`has_attachments` is a header heuristic** (`Content-Type: multipart/mixed`) (code L4); revisit when the inbox UI needs exact attachment flags.
- **`mapLimit` in-flight workers** (code L7): when one metadata fetch fails, the other workers of that page keep running to completion before the error surfaces (bounded by the concurrency of 8); harmless, but they still consume quota.
- **A forced full resync does not reconcile deletes made during the gap** (messages deleted at Gmail after the old cursor expired stay indexed until the retention purge).
- **The revoke writer (`googleWriter`, action `google.revoke_grant`) stays in T-063** as D-24 infrastructure; nothing calls it yet (approvals tasks will).
- Fixed in the review round (for the record): HTML/header parsing is linear and capped; `lane_config.mailboxes` is re-checked on every sync/read/search; the first load is bounded by the lane's `retention_days`; page apply takes a per-connection advisory lock with a cursor compare-and-swap (SQLSTATE D0409 = conflict, a normal outcome), large pages are applied in chunks of 500 with the cursor on the last, and an upsert only clears `deleted` for a fresh page; Gmail 403 rate limits are retried (3 attempts); TRASH/SPAM read as removals; `GOOGLE_REDIRECT_URI` must be on the app's own origin outside local.
- **T-063 re-review LOW:** `core.comms_mail_apply_page` stores any `p_cursor` without checking the `g1.<connection_id>.` prefix. service_role-only caller and `parseCursor` makes a foreign cursor a resync; add a database check if other writers appear.


### Nov 5, 2026 — T-064 design notes and limits (Google Calendar sync)

- **Calendar id encoding (decided).** Google calendar ids can hold `#` (holiday, contacts) and other characters the T-062 id-parameter rule refuses. Stored and parameter form: keep `A-Z a-z 0-9 _ @ . + : -`, write every other UTF-8 byte as `=` plus two upper-case hex digits (`#` is `=23`, a literal `=` is `=3D`). Reversible, always passes `ProviderIdParamSchema`, at most 200 characters (a longer id is skipped and logged). The primary calendar is stored as the alias `primary` (stable, no mailbox address in every row). Only the connector decodes it, to put the raw id in the request path (percent-encoded by the HTTP client).
- **Which calendars (default, D-26).** Primary plus selected owner/writer calendars. Holidays and read-only calendars are out unless `lane_config.calendar.include_read_only`; `lane_config.calendar.calendar_ids` replaces the default with an explicit list (raw ids); `forward_days` sets the look-ahead (default 365). Settings are read on every sync and malformed ones fail closed. At most 10 calendars (the composite cursor must stay under 16 KB; the largest allowed state is about 14 KB). `readBody` opens only calendars in the current selection (one extra calendarList call), so a shared calendar outside the selection cannot be read through the connector.
- **Cursor.** One per connection, `g1.<connection id>.c:<base64url JSON>`: the position in the calendar list plus, per calendar, its syncToken, an in-progress page token and the window of its full load. Stored in `core.sync_cursors` stream `calendar`. One API page per `sync` call; discovery (calendarList) at the start of every run, so a new calendar is loaded in full and an unselected one is dropped from the cursor (its rows stay until the retention purge). A syncToken keeps the window of the request that created it, so a calendar whose forward horizon has run down to half is reloaded in full (365 days ahead means about every six months).
- **410 Gone (decided):** `fullResyncRequired` for the WHOLE connection (the interface has no way to clear one calendar's rows). The run discards the cursor and reloads every calendar, once per run; a 410 on an initial load is an error. A 400 on a request that carried a syncToken or page token counts the same. A 404 for one calendar drops only that calendar.
- **Full loads ask for `showDeleted=true`**, so a reload after a gap also cancels what was deleted meanwhile (partly closing the T-063 "no delete reconciliation" gap for events; Google keeps deleted events for a limited time). The price: stub rows for events never seen before (status cancelled, no times); downstream queries must filter `status <> 'cancelled'`.
- **Deletions are cancelled stubs, not `removals`** (Google reports a deleted event as `status: cancelled`); `removals` stays empty. The contract harness got `removedEventsAreStubs` for providers like this. The apply function still honours `removals` (sets status cancelled) for Graph.
- **Stub merge and versions (SQL).** A cancelled stub changes `status` (and `source_updated_at` when it has one) only; the stored title, times, attendees stay. A stub applies when its version is not older OR missing (Google's minimal deletion stub has no `updated`; replay safety comes from the cursor compare-and-swap). A normal event replaces the row only when `updated` is not older; a missing version counts as oldest.
- **Fields mask.** Every events call sends `fields=` listing only what the index keeps (no description, attachments, creator, reminders). The description is read only by `readBody` (`fields=id,description`), converted with the linear HTML-to-text, bounded, wrapped in `UntrustedBody`.
- **Free-text metadata is untrusted (rule 9)**, as in T-061/T-063: titles, locations, names and the meeting link are written by other people. They are clipped before cleaning, stripped of control and bidi characters and bounded; a bad part is dropped, not the event. The meeting link is `https` only and is an attacker-controllable link: the UI must show it as a link, never open it automatically. Attendee lists are capped at 500 entries and 100 kB.
- **All-day events** use the calendar's own time zone from the events.list response (all-day events carry none); an all-day event without a usable zone is skipped and logged, never guessed. Wall-clock times without an offset are resolved in the event zone.
- **Limits / follow-ups (logged, not fixed):** (1) no calendar push (`events.watch`), polling only; (2) a calendar that leaves the selection keeps its rows until the retention purge; (3) the calendarList discovery adds one request per run and per `readBody`; (4) events whose id is longer than 512 characters (Google allows 1024) are skipped and logged; (5) a calendar with more than ~25,000 events in the window needs several runs (page cap 500 per run; the cursor resumes); (6) the sync job (Inngest) wiring is still T-038; `calSync.run(laneId, conn)` is exported from `@nichols/connectors/google`.

T-064 review round (security + code, 0 BLOCKER/HIGH). Fixed: selection re-checked per page (the cursor carries a fingerprint of the selection settings and a "discovered this run" flag; a change triggers a new discovery before any events request); rows of calendars that left the selection are deleted in the apply (`p_drop_calendars`, only after a complete calendarList read; a partial list is an error); a permanent failure on one calendar (non-rate-limit 403, 400 on an initial load, 404, malformed page or token) skips that calendar instead of wedging the connection; the 404-at-position-0 loop is gone; `decodeCalendarId` is a bijection; the shared www.googleapis.com client allows only the Calendar templates and token/Gmail-profile clients use narrower host sets; an equal or older copy cannot un-cancel; the calendar cursor must carry this connection's `g1.<id>.c:` prefix (22023); `calendar_ids: []` is refused; the fake Calendar rejects `showDeleted=false`/`orderBy` with a syncToken and a page token used with different parameters.
Logged, not done:
- **Mail cursor prefix check (sec L4)** was done for calendar only: the mail apply function (T-063, merged migration) would need a full rewrite and ~60 pgTAP fixtures; add with the next change to that function.
- **service_role write grants on `cal.event_index` / `comms.message_index` (sec L5)** are kept: the T-061 purge functions are security invoker and the T-061 tests write rows directly. Revoking needs definer purge functions plus a catalog update; the migration header now says so. The apply function is the sync path, not the only possible writer.
- **Settings are read on every page** (one `lane_config_current` read per `sync` call); needed for the per-page selection check; cache later if it shows in load.
- **eventType** (outOfOffice, workingLocation, focusTime, birthday) is indexed as an ordinary event, with no self-response or transparency (free/busy) fields; the calendar consumer task (T-114 area) must decide how to show them.
- The T-064 migration was written without the `db-engineer` subagent but has had security and code review.

### Nov 5, 2026 — T-199 review findings (MEDIUM and below, not fixed)
- **"Last sync" is the cursor write time** (code M6). `core.sync_cursors.updated_at` moves only when a page is applied, so a healthy sync that finds nothing new looks stale. `core.connections.last_sync_at` is one value per connection, not per stream. Fix: record a per-stream "last successful run" time (T-038 sync runs) that owner/admin_technical can read, and show that instead.
- **The reconnect banner does not name the mailbox** when a lane has several Google connections (code LOW). The badge on each row shows which one; name it in the banner when multi-mailbox lanes appear.
- **`core.sync_cursors` is missing from the generated DB types** (code LOW). A narrow local cast is used in `apps/web/lib/google-connection.ts`; remove it after the next `db:types` regeneration.
- **The e2e SQL helper trusts the Docker context** (sec L1). `apps/web/scripts/e2e-sql.mjs` runs as the `postgres` superuser in the container `supabase_db_nichols-jarvis-core` on whatever daemon `DOCKER_HOST`/`DOCKER_CONTEXT` points to. Callers pass only constant synthetic SQL. Add a refusal when `VERCEL_ENV` or a remote `DOCKER_HOST` is set if the helper is reused.
- **Timezone formatting** (`America/New_York`, "ET") is checked only in e2e (a November date); add unit tests with summer and winter dates if the formatter is shared (code LOW).
- `guards()` is called twice in `settings-page.tsx` (code LOW); harmless, tidy up when T-197 adds the QuickBooks section.


## Nov 5, 2026 — T-038

- **T-038 review** (security + code review Nov 5, 2026; no BLOCKER or HIGH. Fixed: code M1-M3 (finish zero-row check, a log failure never retries a finished sync and a permanent failure's open row is cancelled, `recordOutcome` separate and skipped when the run row was not closed), M5 (tests for takeover, log failure, zero rows), Google runner prefers a retryable failure, security M1 (the function re-validates the event), security L2 (no `recordOutcome` after a lost finish), migration closes stray `running` rows before the unique index). Logged, not fixed:
  - **MEDIUM (code M4):** a legitimate run longer than `STALE_RUN_MS` (30 min) is cancelled by the next start and a second sync could start. The whole job runs in one handler (bounded by the route's serverless duration, not yet set). Before the first full Gmail load in staging: set `maxDuration` on `/api/inngest` (not as route segment config under `cacheComponents`) and keep `STALE_RUN_MS` above it, or add an `updated_at` heartbeat to the stale check.
  - **LOW:** no scheduler/fan-out sends `conn/sync.requested` yet; whoever adds it (or a "Sync now" button) must check membership and AAL2 server-side, make `trigger` required, and set an `idempotency`/`singleton` on `connectionId` so duplicates do not queue back-to-back syncs. `trigger` "manual" is only a label.
  - **LOW:** `080_connections` fixture changed (APK run inserted as finished): the unique index fires before the cross-lane FK in that case; add a pgTAP case with a running APK run asserting a PKG insert on the APK connection raises (either code).
  - **LOW:** a failed run's `kind` is guessed from `last_sync_at`; `received` for Google counts written + skipped + removed; `createConnectorSyncRunner`, `syncCursorStore` and `sync_cursor_put` have no production provider yet (QuickBooks T-051, Stripe, GoHighLevel add theirs to `runners`); the config test reads Inngest's `fn.opts`.
  - **Note:** the builder wrote the migration and pgTAP directly; a separate `db-engineer` review and a second `security-reviewer` pass followed (below).
- **T-038 second review round** (Nov 5, 2026: `security-reviewer` + `db-engineer`, no BLOCKER or HIGH). Fixed: `core.sync_cursor_put` writes only the generic stream `default` (it could overwrite the Gmail `mail` / Calendar `calendar` cursors, which must move only with their pages; the calendar apply also uses a different lock key); the advisory lock is taken before the usable-connection check; corrected the lock comment; a cancelled run after a log failure records `full` or `incremental` like the failed path; pgTAP 180 now also covers mail/calendar refused, null stream, degraded accepted, a disabled lane refused, APK/PKG cursor isolation and two connections running at once. `packages/core/src/db/types.ts` regenerated (it was stale since T-063/T-064: `sync_cursors`, the apply functions and the cursor functions were missing). Logged, not fixed:
  - **LOW:** the migration closes stray `running` rows and then builds the unique index without an explicit table lock (the migration runner opens no transaction block, so `LOCK TABLE` fails). A run starting in between would only make the index build fail; no sync job runs before this ships.
  - **LOW:** pgTAP checks anon/authenticated execute with `has_function_privilege`, not an attempted call (same as tests 160/170); no concurrency test of the lock.
  - **LOW:** the T-199 local cast for `core.sync_cursors` in `apps/web/lib/google-connection.ts` can now be removed (types regenerated).

## Nov 5, 2026 — T-042

- **T-042 design and review** (retention.purge; `security-reviewer`, `code-reviewer`, `db-engineer` run read-only; no BLOCKER or HIGH). Daily cron 03:00 America/New_York fans out `retention/purge.requested` per enabled lane; the per-lane worker (concurrency key = laneId, 3 retries) calls each registered table's SQL purge function and throws only after every table ran. Retention days: comms = `lane_policies.retention_days` (the SQL function also caps at it), calendar/conversations/webhooks = `lane_config.retention` (defaults 180/180/30, bounds 30-180 / 1-3650 / 7-365). New SQL: `core.retention_comms_purge` / `core.retention_cal_purge` (invoker wrappers: `comms`/`cal` are not exposed to PostgREST) and `core.source_records_purge_bodies` (definer). Fixed after review: a bad `lane_config.retention` or unreadable policy no longer stops the other classes or the body purge (classes without days are reported `settings_unavailable`, the run fails and retries); an unexpected RPC result throws instead of reading as 0; the table-failed log carries the error class name; the untested "fin rows" claim was removed from the pgTAP header and migration comment.
  - **Registering later tables:** `retentionRegistry.register({ id: "schema.table", class, purge })` from `@nichols/connectors/retention`; `purge` must call a SQL purge function. **T-103 must register the assistant `ai.*` tables as class `conversations`** (180 days; no table exists yet, so the job reports `conversations` in `emptyClasses` and returns ok). Approvals payload purge (`act.purge_content()`, `payload_retention_days`) is registered by T-112 (no `act` schema yet).
  - **MEDIUM (needs a decision):** `store_content_bodies = true` lets stored bodies in `raw.source_records` live forever; the purge only removes them when the policy is turned off. Decide whether bodies should also age out at `retention_days`.
  - **MEDIUM:** `raw.source_records` has no time-based retention at all (`deleted = true` rows "stay until retention purges them" per the T-039 comment, and non-content payloads are never aged). Add `core.source_records_purge(lane, keep)` before the table grows; mind the `fin.*` `on delete set null (raw_record_id)` foreign keys.
  - **MEDIUM:** the body purge deletes whole rows of content providers (including `gohighlevel`) that carry a body-like key, when the policy is off. Fail-closed per the T-039 note, but a GoHighLevel record with a `description`/`notes` key loses the whole record until the next sync (the guard then refuses it again). Decide: delete (now) or redact the keys; the GHL adapter (T-060) must project to an allowlist anyway.
  - **MEDIUM:** a permanently invalid `lane_config.retention` is retried like a transient fault (3 retries, then Inngest marks the run failed); there is no `onFailure` alert, Sentry hook or audit row for a purge that finally fails, so data could stay past its window unnoticed. Add an alert with T-041/T-045. Deletion counts are logged only (not in the audit log).
  - **LOW:** the bounds (30-180, 1-3650, 7-365) live in `laneConfigSchema.retention` and again in `LaneConfigReader.retentionConfig`; pin them with a shared constant or test. The reader uses error kind `provider_error` for a bad config (same as calendar/mailboxes).
  - **LOW:** `core.webhook_events_purge` (T-036) does not check that the lane is enabled (the new wrappers do); the job client only reaches enabled served lanes anyway. The body purge scans every content-provider payload (up to 1 MB each) daily; add a batch limit if the table grows.
  - **LOW:** the SQL body purge treats a missing policy row as "off" (deletes), while the job reads days from `lane_policies` and reports comms as `settings_unavailable` for a missing row; the body purge still runs. No pgTAP case for a missing policy row. `schedule`'s plan step reads `ENABLED_LANES` from env, same as conn.sync.
- **T-042 second review** (Nov 5, 2026, `security-reviewer`; no BLOCKER or HIGH). Confirmed:
  - there is no cross-lane delete on the SQL or the TS path;
  - the T-061 floors and caps hold through the wrappers;
  - bad `lane_config` values cannot over-delete, because the database enforces the bounds;
  - the body purge matches the write trigger exactly.

  Fixed:
  - **M2:** the registry contract is now written down in `retention/types.ts`. Every registered purge's SQL function must enforce its own floor and cap, filter `lane_id = p_lane`, refuse disabled lanes and be `service_role` only, with a floor test and a cross-lane pgTAP test. **T-103 and T-112 must follow it** when they register the `ai.*` and approvals tables.
  - **L1:** a unit test for the settings wiring.
  - **L2:** pgTAP for a missing policy row. Bodies are purged and the comms purge is refused.
  - **L4:** the note now points at the right file. The pgTAP file was renumbered 190 → 200 so it doesn't clash with T-080's `190_fin_business_calendar`.

  Logged:
  - **L3:** `core.webhook_events_purge` (T-036) has no enabled-lane check. The worker's served-lane gate covers it; add the check the next time that function changes.

## Nov 5, 2026 — T-130

- **T-130 cal.ingest_delta** (security + code review Nov 5, 2026; no BLOCKER). Built: cron `*/15 * * * *` fan-out (`packages/core/src/inngest/cal-ingest.ts`) that sends `conn/sync.requested` (trigger "schedule", event id `cal-ingest:<connectionId>:<slot>`) for each enabled lane's usable Google connections; no SQL. Delta sync (T-064 + T-038) and 180-day retention (T-042) already existed. `trigger` is now required on `conn/sync.requested` (T-038 note); an already-queued event without it fails permanently (dev/pilot queues only).
  - **Fixed (code HIGH, security M2):** the `singleton: skip` first added to conn.sync would have dropped webhook/connect/manual requests for every provider; removed. Duplicate protection is the per-tick event id plus concurrency 1 per connection. If skip-on-overlap is wanted, restrict it to the scheduled path.
  - **Fixed:** testable `handleCalIngest` with tests of the exact events, the empty case, a failed lane (healthy lanes sent first, then the run fails) and a missing schedule time (no guessing a tick); an accidental edit of the `webhookReceived` test was reverted.
  - **T-038 M4 (duration vs STALE_RUN_MS), not changed:** `maxDuration` can only be set as route segment config, which `cacheComponents` forbids. The default function duration is far below 30 minutes, so a run cannot outlive the stale limit today. Before raising the limit (first full Gmail load in staging), use a platform setting (vercel.json `functions`) or add an `updated_at` heartbeat to the stale check.
  - **MEDIUM:** a lane that cannot be listed fails the run with a non-retried error after the other lanes were sent (the next tick is the retry); the failed lane ids appear only in Inngest's run, not in a metric. Alerting depends on Inngest failure alerts.
  - **LOW:** `SYNCABLE_STATUSES` (targets.ts) duplicates `USABLE` in job.ts; `MAX_SYNC_TARGETS` (200) truncates silently (log an overflow); `CALENDAR_PROVIDERS` must gain the Microsoft provider when its calendar sync lands; `listConnections` failures are not logged (a generic transient error); the cron has no jitter (all connections of a tick start together; the connector rate limiter spaces them); a Google grant without the Calendar scope fails the whole conn.sync run each tick after mail has synced (calendar permanent error) — T-199/T-195 reconnect flow should surface it; the fan-out was not exercised against a live Inngest server.
