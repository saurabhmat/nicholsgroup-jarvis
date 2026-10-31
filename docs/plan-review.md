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

Not yet decided: dark mode and chart palette (Recharts). Raise both at the sign-off.

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
