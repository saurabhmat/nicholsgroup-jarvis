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

Release A is **115 tasks of up to a day each**, against about **22 working days** (Oct 26 – Nov 25). The pilot security test (T-170) gates approvals, so Release A needs to be feature-complete around **Nov 18–20**. Running tracks in parallel (backlog → "Parallel worktrees") raises throughput, but review stays the bottleneck: every PR needs your merge.

Ways to cut further, roughly by size:
1. **Decide D-1** and drop the other mail provider: removes 3 tasks from Release A (and 1 search task from Release B).
2. **Merge small tasks during the build.** Many platform tasks (e.g. T-014/T-015, T-016/T-017, T-030/T-034) are well under a day each with Claude Code. Re-forecast after T-001 – T-020.
3. **Allow a later PKG approvals go-live** (e.g. Nov 30, the start of Robert's test week) if T-170 slips. Success criterion 2 still holds without skipping the test.

**Tie-out window:** two consecutive weeks before Nov 25 means the live QuickBooks file must be in staging by about Nov 7–10 (H-017, which waits on Intuit approval). If Intuit is late, success criterion 1 slips past the pilot window.

## 5. Most urgent from you

1. **H-020** — Docker permission for your user (blocks T-006 and `pnpm test:db`).
2. **D-1** — the pub-k.org mail provider.
3. **D-8** — Sophie's mapping IDs, plus **D-3** (paid subscriber) and the customer-churn source question in §7, before finance tie-out.
4. **H-016** — Resend account + DNS; **D-15** — design sign-off (blocks T-024).

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

**Questions for the T-075 finance spec (don't block it; the spec lists them as open questions):**
1. **Customer churn source.** Rule 8 makes GoHighLevel the source of subscriber status, and Stripe the source of revenue. Assumed: customer churn % counts GoHighLevel paid subscribers (so it waits on D-3), and revenue churn % uses Stripe. Confirm.
2. **Month boundaries.** "MRR at start of month" = the snapshot at 00:00 America/New_York on the 1st. A subscription that starts and cancels in the same month counts as new and churned.
3. **Expansion/contraction** = MRR change on a subscription that stays active (price, quantity or coupon change), measured month-start vs month-end.
