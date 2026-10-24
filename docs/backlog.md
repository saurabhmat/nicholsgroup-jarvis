# Backlog — Pub K Group pilot

Status flow: `proposed` → **`approved` (human)** → built by agent → PR sets `done` → **merge (human)**.
Only humans change `proposed` → `approved`. Agents pick the next `approved` task whose dependencies are `done` and whose `needs` are checked.
Board references (PL-xx) point to the Personal Chatbot board in monday.com.

**Releases (see `docs/pilot-scope.md`)**
- **Release A — live Nov 25 (PKG):** platform core, connectors (QuickBooks, Stripe, GoHighLevel, mail/calendar, monday.com), finance, assistant, priority inbox + reply drafts, calendar view, daily briefing, admin/health, basic web push, and the Approval Center for email send + monday.com updates. PKG approvals switch on only after the pilot security test T-170 passes.
- **Release B — Dec 7 – 31:** federated search + opt-in indexing, Notion read/writes, meeting prep packs, calendar actions, commitments, memory, projects view, notification polish, onboarding playbook; action modules for other lanes go live Dec 29.

**Task fields**
- `depends:` other tasks (T-xxx). Enforced by `scripts/next-task.mjs`.
- `needs:` human items (H-xxx) or decisions (D-x). A need is met when its item is checked (`- [x]`) under "Needs human". Enforced by `scripts/next-task.mjs` once T-000 is merged; until then, approve a task only when all its `needs` are checked.
- `acceptance:` what must be true. Every task also has to meet the Definition of Done in `CLAUDE.md` (typecheck, lint, test, test:db, security review, PR body).
- Provider dependencies: tasks that need mail/calendar depend on the **Google** tasks (T-063, T-064) by default. If D-1 = Microsoft 365, replace them with T-066, T-067 before approving.
- IDs are stable and roughly follow build order; the dependency graph is authoritative where they differ.
- Sizing: each task is ≤1 day for one developer with Claude Code. Release A is 120 tasks (T-075 added T-190 – T-194), Release B 23 (see "Schedule risk" in `docs/plan-review.md`).

Standing rules that apply to every task, so they are not repeated in each acceptance:
- Every function, query, job, AI tool, cache entry and memory item takes `laneId`. DB clients come only from the lane router.
- Every new table has `lane_id`, RLS (AAL2 + `core.allowed_lanes`) and pgTAP tests, including a cross-lane denial test.
- Synthetic data, MSW mocks and vendor sandboxes only. No real credentials or records.
- Next.js 16 conventions (`proxy.ts` rather than `middleware.ts`, among others): read `node_modules/next/dist/docs/` before writing Next code.

---

## Parallel worktrees (Release A)

The **spine** runs serially in the main worktree: T-000 → T-001 – T-007 → T-010 – T-017. After that, these tracks can each run in their own `git worktree` (`agent/<task-id>` branches). Merge order follows `depends:`.

| Track | Tasks | Can start after | Notes |
|---|---|---|---|
| Specs | T-075 – T-077 | T-001 | Docs only, no conflicts |
| W1 Auth + app shell | T-018 – T-026, then T-045 – T-047 | T-017 (T-022 after T-002) | T-024 waits on D-15 |
| W2 Connector platform | T-030 – T-042 | T-013 (T-030 after T-002) | |
| W3 Finance/index schemas | T-055, T-057, T-061, T-080 | T-013 | SQL only |
| W4 Assistant core | T-100 – T-103 | T-017 | needs H-002 for T-100 |
| W5 Approvals core | T-110, T-111, T-114, T-193, then T-112 | T-013 + T-030; T-112 after T-020 | |
| W6 QuickBooks | T-050 – T-053, T-056 | W2, T-055 | |
| W7 Stripe | T-054, T-058 | W2, T-057 | needs H-006 |
| W8 GoHighLevel | T-059, T-060 | W2, T-057 | needs H-007, D-3, D-8 |
| W9 Google mail/calendar | T-063 – T-065 | W2, T-061 | drop if D-1 = Microsoft |
| W10 Microsoft mail/calendar | T-066 – T-068 | W2, T-061 | drop if D-1 = Google |
| W11 monday.com | T-069, T-070 | W2 | needs H-009 |
| W12 Finance views + UI | T-081 – T-097, T-190, T-191 | W6, W7, W8 | one worktree only (shared `fin.*` migrations). D-3 blocks T-087 (via T-060) and through it T-089, T-095, T-097. |
| W13 Inbox + calendar | T-120 – T-124, T-130, T-131, T-133 | W9 or W10, W4, T-111 | |
| W14 Approval execution | T-113, T-115, T-116, T-118, T-119, T-192 | W5, W9 or W10, W11 | |
| W15 Assistant finance | T-104 – T-106, T-194 | W4, T-081 | |
| Converge | T-160 – T-163, then T-170 – T-173 | all of the above | serial |

Rules for running tracks in parallel:
- **No more than 3–4 tracks at once.** Every PR still needs your review.
- **Migrations:** at most two SQL-heavy tracks at a time. Before merging, rebase and renumber migration timestamps so they apply in merge order, then re-run `pnpm test:db`.
- **Local Supabase:** each worktree needs its own `project_id` and ports in `supabase/core/config.toml`, or `pnpm test:db` has to run one worktree at a time. Two stacks on the default ports collide.
- **Shared files:** `pnpm-lock.yaml` and the `status:` lines in this file will conflict. Regenerate the lockfile and keep both status changes when rebasing.

---

## Ready for approval
These tasks have all their dependencies done and all their `needs` checked. A human sets `status: approved`.
- T-000 — done (merged).
- T-001 — done (merged).
- T-002, T-006, T-075 — approved Oct 24, 2026.
- Next after T-002 merges: **T-005**, then **T-003** (imports T-005's secret-pattern list).

---

## Needs human

### Credentials and accounts
- [x] H-001 Supabase **staging** project created (Oct 24, 2026): ref `lxjhaxdkqtmkhloqaffb`, East US, public sign-ups off, CLI linked by Saurabh. Agents never apply migrations to it. Details in `docs/plan-review.md` §7 (PL-11)
- [ ] H-002 Anthropic dev API key with a spend limit (PL-13)
- [ ] H-003 Inngest account: event key + signing key for staging (PL-12)
- [ ] H-004 Confirm the pub-k.org mail/calendar/docs provider (D-1). Sign-in needs no OAuth app (D-6). (PL-15)
- [x] H-005 Intuit developer app + sandbox company; production assessment submitted Oct 23, 2026 (PL-16)
- [ ] H-006 Stripe restricted read-only key (test mode first, then live for staging) + webhook signing secret (PL-17)
- [ ] H-007 GoHighLevel Private Integration token (read-only scopes) + location ID (PL-18)
- [ ] H-008 Mail/calendar/docs API permissions for pub-k.org: Google OAuth client (Internal app type) with Gmail/Calendar/Drive scopes, **or** Entra app with admin consent for Mail/Calendars/Files/Sites read (PL-19)
- [ ] H-009 monday.com API token (IT workspace); Notion internal integration shared to the target pages/databases (PL-20)
- [x] H-010 Vercel project linked to the repo (Oct 24, 2026), with **Root Directory = `apps/web`** and **"Include files outside the root directory"** turned on; production branch `main`; a Preview deployment per PR (→ staging Supabase); Vercel Authentication on for Preview and Production; env vars set by Saurabh in the dashboard. Production-domain DNS moved to H-021 (PL-10)
- [ ] H-021 DNS for the production domain once D-5 is decided (split out of H-010)
- [ ] H-011 Sentry project DSN (free tier) for staging
- [ ] H-012 GitHub repo in the Nichols-owned org, with branch protection on `main` and Actions enabled
- [ ] H-013 Google Cloud project for Pub/Sub (Gmail watch), only if D-1 = Google
- [ ] H-014 VAPID key pair for web push, generated and stored in 1Password (agent can generate a **dev** pair only)
- [x] H-015 Planning pack v2 copied into the repo (Oct 23, 2026)
- [ ] H-016 Resend account; sending domain verified (SPF/DKIM DNS records) for sign-in emails; SMTP credentials for staging and prod in 1Password and the Supabase Auth settings
- [ ] H-017 Intuit **production** approval received and the live PKG QuickBooks file connected in staging (needed for tie-out, T-172)
- [x] H-018 Local toolchain (Oct 23, 2026): Node 24.19.0 kept locally (CI stays on 22), pnpm 12.15.0 via corepack, Supabase CLI 2.122.0 (npm global)
- [x] H-020 Docker access for your user (Oct 24, 2026): user is in the `docker` group; `docker info` works in a fresh login. A process started before the group change (e.g. an old VS Code server / Claude Code session) still gets "permission denied" until it is restarted.
- [x] H-019 Agents can read `.env.example` (deny rule narrowed Oct 24, 2026; real env files still blocked). Publishable/secret rename and cleanup applied Oct 24 and mirrored in Vercel Preview (see `docs/plan-review.md` §7).

### Decisions (details and options in `docs/plan-review.md`)
- [ ] D-1 pub-k.org provider: Google Workspace or Microsoft 365 (pilot-scope open decision 1). Both are built behind one interface meanwhile.
- [x] D-2 Pilot KPI list (Oct 24, 2026): cash (book balance), AR total + AR >30 days, AP due ≤14 days, P&L MTD/YTD, MRR, monthly churn, paid subscribers (GoHighLevel, new/cancelled this week), controls (unreconciled >30 days, disconnected feeds, uncategorized transactions). Details in `docs/plan-review.md` §7
- [ ] D-3 GoHighLevel "paid subscriber" definition (tag, pipeline stage or product)
- [x] D-4 Roles: Robert owner, Saurabh admin_technical, Sophie finance_operator (pilot-scope decision 4)
- [ ] D-5 Production domain (default `portal.pub-k.org`)
- [x] D-6 Sign-in: Supabase 6-digit email code (primary; required inside the installed iPhone app) or magic link, plus Supabase TOTP MFA (AAL2) for all users; Resend for delivery
- [x] D-7 Keep Next.js 16 (`proxy.ts`); pnpm workspaces + Turborepo
- [ ] D-8 Sophie supplies the lane_config entity mapping values: the QBO class IDs (and customer IDs where classes are missing), Stripe product IDs, GoHighLevel tags/products and bank-account owners for Ask Pub K and Pub K Institute. Decided: PKG excludes APK and PKI.
- [x] D-9 MRR and churn definitions (Oct 24, 2026); full definitions in `docs/plan-review.md` §7
- [x] D-10 Release A by Nov 25 / Release B Dec 7–31 (see "Releases" above)
- [x] D-11 PKG approvals go live Nov 25 after the pilot security test (T-170); Dec 29 applies to other lanes only
- [ ] D-12 Source of "meeting notes" for meeting prep and Commitments (Google Meet/Gemini notes, Notion, other) — Release B
- [ ] D-13 Embedding provider for opt-in indexing (Anthropic has no embeddings API; e.g. Voyage AI, OpenAI, or Supabase built-in `gte-small`) — Release B
- [ ] D-14 Weekly cash report distribution: email via the Approval Center (recipients?) or in-portal only. Decided: Sophie signs off. Consequences: email needs D-19 and, if the report is sent as a file, either a link (private Storage signed link) or attachment support, which Release A approvals do not have.
- [ ] D-15 Design sign-off for navigation/prototype (PL-26), which blocks T-024
- [x] D-16 Federated search is in Release B
- [x] D-17 GoHighLevel subscriber counts exclude APK and PKI via lane_config tag/product mapping
- [ ] D-19 Rule 6 scope for PKG: may composed outbound email drafts be stored (`store_outbound_drafts`, default false; retention days), and does rule 6 also cover the assistant's own conversation text (`ai.messages`; until decided, assistant text from turns that used mail/document tools is stored redacted)? Blocks T-110, T-111, T-116 (email proposals); see `docs/specs/approvals.md` §8 and `docs/specs/assistant.md` §4
- [x] D-18 Cash book balance shown per account under the legally owning entity, no allocation; shared accounts flagged in controls. P&L/aging split by QBO class, else customer mapping. Stripe payouts at account level; revenue split by product from charges/invoices.

---

# Release A — PKG pilot, live by Nov 25

## Phase A0 — Workflow tooling
### T-000 Make next-task.mjs honour `needs:`
- status: done
- depends: -
- needs: H-015
- acceptance: `scripts/next-task.mjs` skips any approved task whose `- needs:` line lists an `H-\d+` or `D-\d+` item that is not checked (`- [x]`) under "Needs human"; unknown IDs count as unmet; existing `depends:` behaviour unchanged; `node scripts/next-task.mjs --explain` prints each approved task with the reason it is blocked (unmet deps / unmet needs); `node --test scripts/next-task.test.mjs` covers: no needs, met needs, unmet H, unmet D, unknown ID, multiple needs, task with deps and needs; runs on Node 22+ with no dependencies (precedes the monorepo).

## Phase A1 — Repo and tooling (PL-27)
Serial spine (main worktree). T-005 and T-006 can run in parallel once T-001/T-002 are merged.

### T-001 Convert to pnpm + Turborepo monorepo
- status: done
- depends: -
- needs: H-018
- acceptance: `pnpm-workspace.yaml`, `turbo.json`; the existing Next.js 16 app (kept per D-7) moves to `apps/web` and still runs with `pnpm dev`; `package-lock.json` removed; `engines.node` set to `>=22 <25` (local dev runs Node 24, CI runs 22; no `.nvmrc` pin); `packageManager: pnpm@12.15.0` in the root `package.json` (the pack's `ci.yml` uses `pnpm/action-setup` without a version); root scripts `typecheck`, `lint`, `test`, `test:db`, `test:injection` exist (the last two may be no-op placeholders that exit 0 with a message).

### T-002 Package skeletons per architecture §10
- status: done
- depends: T-001
- acceptance: `packages/core`, `packages/connectors`, `packages/ai`, `packages/ui`, `packages/modules/{finance,comms,calendar,commitments,documents,briefing,approvals,notifications,memory,admin,projects}`, each with `domain/ tools/ jobs/ ui/` as relevant, `package.json`, `tsconfig` project refs and one passing Vitest test; `apps/web` imports one package successfully.

### T-003 Strict TS, shared lint config and architectural boundary rules
- status: proposed
- depends: T-002, T-005
- acceptance: strict TS everywhere; shared ESLint flat config; boundary rules fail lint when (a) vendor SDKs or outbound `fetch` to external hosts are used outside `packages/connectors`, (b) `executeWrite` is imported outside `packages/modules/approvals`, (c) the Supabase service client is created outside the lane router, (d) `NEXT_PUBLIC_*` env names match secret patterns (imported from T-005's list in `packages/core/env`, not redefined), or the secret client / `SUPABASE_SECRET_KEY` is imported from a `"use client"` module. Each rule has a failing fixture test.

### T-004 CI green on the pack's workflow
- status: proposed
- depends: T-003
- acceptance: the existing `.github/workflows/ci.yml` (from the pack; agents cannot edit workflows) passes on a PR: install, typecheck, lint, test, test:db, test:injection. Proposed additions (gitleaks secret scan, turbo cache, Lighthouse for T-025) go in the PR body as a ready-to-apply diff for a human.

### T-005 Environment config
- status: proposed
- depends: T-002
- needs: H-019
- acceptance: Zod env modules in `packages/core/env`: a **server** schema (`server-only`) and a **client** schema that contains only `NEXT_PUBLIC_*` names; variable names match `.env.example` (agents can read it but not edit it); owns and exports the **secret-pattern list** (T-003's lint rule imports it); a test fails if a client-schema name lacks `NEXT_PUBLIC_` or a `NEXT_PUBLIC_` name matches a secret pattern; core vars (app, Supabase, Inngest, Anthropic) fail the build when missing; connector credentials are optional at startup and validated when the connector is used (it fails closed), so Preview builds work before every H-item is done; `.gitignore` already covers `.env*`, `.agent/logs` and Supabase temp files (pack); verify only.

### T-006 Local Supabase + pgTAP harness
- status: approved
- depends: T-001
- needs: H-020
- acceptance: `supabase/core` project starts locally, laid out so the pack's `migrate-prod.yml` (which runs the CLI from `supabase/core`) finds `config.toml` and the migrations; check the CLI's expected folder layout first; `pnpm test:db` runs pgTAP in `supabase/core/tests`; `supabase/nl/` exists as a documented placeholder (deferred data plane); README section for local DB.

### T-007 Synthetic seed framework
- status: proposed
- depends: T-006
- acceptance: deterministic seed (fixed RNG) for lanes PKG, APK, PKI, NC, NL, P with only PKG enabled; synthetic users (owner, admin_technical, finance_operator, viewer, outsider); `pnpm db:reset` reseeds; no real names, emails or companies' records beyond lane names.

## Phase A2 — Platform core (PL-28, PL-34)
T-010 – T-017 are the serial spine. After T-017: auth/shell (T-018 – T-026) is **track W1**. T-022 can start right after T-002.

### T-010 Lanes and lane policies
- status: proposed
- depends: T-007
- acceptance: `core.lanes` (code, name, data_plane, enabled) and `core.lane_policies` (fields from architecture §5.3, plus `store_outbound_drafts` default false, D-19) with RLS; pgTAP: only PKG enabled; non-members cannot read other lanes' policies; AAL1 sessions are denied.

### T-011 Lane config (per-lane source settings, no secrets)
- status: proposed
- depends: T-010
- acceptance: `core.lane_config` versioned rows (jsonb validated by a shared Zod schema in `packages/core/lane-config`) for QBO realm + entity mapping (file or file+class), Stripe account, GHL location + paid-subscriber rule, mailboxes, priority senders, KPI list, briefing time, approval rules, enabled modules, and the finance/approvals/assistant keys from the T-075 specs (`kpis` ids, `finance.{accounting_method,weekly_cash_time,monthly_close_trigger}`, `metrics.start_month`, `stripe.livemode`, `controls.*` thresholds, `tieout.tolerance`, `approvals.{approvals_live,approver_roles,step_up_max_age_s,expire_after_hours,payload_retention_days}`, `assistant.*` rate limits), and an **entity mapping** per lane: QBO class IDs, QBO customer IDs (fallback when a class is missing), Stripe product IDs, GoHighLevel tags/products, and bank accounts with their legally owning entity — so PKG excludes Ask Pub K and Pub K Institute; a DB check plus a unit test reject secret-looking keys/values; RLS + pgTAP; seed config for PKG (synthetic IDs).

### T-012 Users, memberships, roles, allowed_lanes()
- status: proposed
- depends: T-010
- acceptance: `core.users`, `core.memberships` (lane, role ∈ owner/finance_operator/viewer/admin_technical, named views for viewer); `core.allowed_lanes(uid, view)` security-definer function; pgTAP proves cross-lane denial, the AAL2 requirement, viewer limited to named views; finance_operator can generate and sign off finance reports, admin_technical has no content views by default.

### T-013 RLS conventions and catalog test
- status: proposed
- depends: T-012
- acceptance: migration template + pgTAP helper for the standard lane policy; a catalog test that fails if any table in lane-scoped schemas lacks `lane_id`, RLS enabled, or a policy; documented in `supabase/core/README.md`.

### T-014 Append-only audit log (SQL)
- status: proposed
- depends: T-012
- acceptance: `audit.events` (lane_id, actor, action, target, metadata, at timestamptz); insert-only grants + trigger blocking update/delete/truncate; `audit.log()` function; pgTAP proves update/delete fail for every role including service.

### T-015 Audit API (TypeScript)
- status: proposed
- depends: T-014, T-005
- acceptance: `audit.log({laneId, actor, action, target, metadata})` in `packages/core`; metadata redactor strips token/secret/body-like fields (unit tests); failures to audit fail the calling action.

### T-016 Lane router
- status: proposed
- depends: T-012, T-005
- acceptance: `getLaneClient(laneId, session)` returns a client for the lane's data plane (registry: `core` only, `nl` slot defined); throws without membership or for disabled lanes; service client only for jobs via `getLaneJobClient(laneId)`; unit tests incl. disabled-lane and non-member cases.

### T-017 Session → allowed lanes helpers
- status: proposed
- depends: T-016
- acceptance: `requireSession()`, `requireLane(laneId)`, `requireRole(laneId, role)` for route handlers/server actions; unit tests; used by a sample protected route.

### T-018 Sign-in (local test IdP)
- status: proposed
- depends: T-017
- acceptance: Supabase Auth email sign-in (D-6): 6-digit email code as the **primary** flow (works inside the installed iPhone app) plus magic link as a secondary option (a link opens in Safari, not the installed app); local Inbucket/Mailpit for tests; sign-in/out pages; session refresh in `proxy.ts` (Next 16); unauthenticated requests redirect; Playwright test.

### T-019 Enforced MFA (AAL2)
- status: proposed
- depends: T-018
- acceptance: Supabase TOTP enrolment + challenge for all users (D-6); recovery procedure documented (admin-assisted factor reset, audited); every data route and RLS rejects AAL1; Playwright: AAL1 user cannot load data; short session lifetime configured.

### T-020 Step-up helper
- status: proposed
- depends: T-019
- acceptance: `requireStepUp(maxAgeSeconds)` forces a fresh TOTP challenge; unit + Playwright tests; used later by approvals.

### T-021 Production auth email delivery (Resend)
- status: proposed
- depends: T-019
- needs: H-016
- acceptance: Resend SMTP configured for Supabase Auth in staging/prod (Supabase default mail is rate-limited), key from env only; redirect URL allowlist per environment; email templates show the OTP code; sign-ups disabled (invite-only users from `core.users`).

### T-022 UI foundation (Tailwind + shadcn/ui + packages/ui)
- status: proposed
- depends: T-002
- acceptance: shadcn/ui set up in `packages/ui`; KPI card, source chip (`as_of`, live/cached/stale), lane chip, empty/error states and a `BookBalance` label component; Storybook-free unit/render tests.

### T-023 App shell and lane switcher (provisional nav)
- status: proposed
- depends: T-017, T-022
- acceptance: authenticated layout, lane switcher limited to allowed lanes, module placeholder routes; current lane in URL; Playwright test that a non-member lane is not listed and its URL returns 404/403.

### T-024 Navigation per approved prototype
- status: proposed
- depends: T-023
- needs: D-15 (PL-26)
- acceptance: navigation and page structure match the signed-off prototype.

### T-025 PWA install (Mac + iPhone)
- status: proposed
- depends: T-023
- acceptance: web manifest, icons, Serwist service worker (verify Next 16 compatibility first; fall back to a hand-written SW if needed); no lane data cached by the SW; Lighthouse installability check runnable locally (`pnpm lighthouse`), with the CI step proposed for a human to add; manual install checklist for Mac Safari/Chrome and iOS.

### T-026 Settings page (user + lane config read view)
- status: proposed
- depends: T-023, T-011
- acceptance: owner can view lane config and policies (read-only in pilot; editing is T-047); others see only their own preferences.

## Phase A3 — Connector platform and jobs (PL-29)
**Track W2**, parallel with W1. T-030 can start after T-002 and T-037 after T-005; the rest follow T-013.

### T-030 Connector contract
- status: proposed
- depends: T-002
- acceptance: `Connector` interface per architecture §6 M2 with Zod types (`Provider`, `Connection`, `ReadOp`, `SourceResult` with `as_of` + freshness, `RawRecord`); reusable contract test kit that any connector must pass.

### T-031 Connections and sync runs tables
- status: proposed
- depends: T-013
- acceptance: `core.connections` (lane, provider, external account id, status, token expiry, last_sync, last_error) and `core.sync_runs`; RLS: admin_technical reads health columns only; pgTAP incl. cross-lane denial.

### T-032 Vault token functions
- status: proposed
- depends: T-031
- acceptance: security-definer `store/read/rotate/revoke` keyed by connection_id; execute revoked from `anon` and `authenticated`; pgTAP proves authenticated users cannot call them or read `vault.*`.

### T-033 Token access + redaction in connectors
- status: proposed
- depends: T-032, T-030
- acceptance: `getToken(conn)` only exported inside `packages/connectors` (lint-enforced); a shared redacting logger; tests prove tokens never appear in logs, API responses, RSC payloads or prompt builders (canary-token test).

### T-034 Connector HTTP client + MSW harness
- status: proposed
- depends: T-033
- acceptance: shared client with timeouts, retry/backoff on 429/5xx with `Retry-After`, per-provider rate limit, redacted logging; MSW handlers directory per provider; tests.

### T-035 OAuth flow framework
- status: proposed
- depends: T-034, T-017, T-015
- acceptance: generic start/callback route handlers with `state` + PKCE bound to lane + user; tokens go straight to Vault; connection row created; audited; tested end-to-end against a mock OAuth server.

### T-036 Webhook receiver framework
- status: proposed
- depends: T-034, T-031
- acceptance: route per provider with raw-body signature verification interface, timestamp tolerance, dedupe table `core.webhook_events` (lane_id, provider, event id) + RLS + pgTAP; unsigned/replayed requests rejected (tests); payloads enqueued as Inngest events, not processed inline.

### T-037 Inngest setup
- status: proposed
- depends: T-005
- acceptance: Inngest client, `/api/inngest` route, typed event schemas where `laneId` is required (type test proves events without it fail to compile); runs against the local dev server.

### T-038 conn.sync skeleton
- status: proposed
- depends: T-037, T-031, T-030
- acceptance: `conn.sync` with concurrency key = connection id, retries, cursor persistence, `sync_runs` start/finish/error logging; tested with a mock provider, including one connection failing without blocking another.

### T-039 Raw source records
- status: proposed
- depends: T-013
- acceptance: `raw.source_records` (lane_id, provider, object_type, external_id, payload jsonb, payload_hash, synced_at) + RLS + pgTAP; upsert helper; a guard rejects records from comms/docs providers that contain body fields unless lane policy `store_content_bodies` is true (test).

### T-040 conn.token_health and subscriptions_renew skeleton
- status: proposed
- depends: T-038
- acceptance: daily job flags tokens expiring within 7 days and failing health checks; renewal job interface for push subscriptions; both update `core.connections` and emit a notification event (T-181 consumes it).

### T-041 Sentry with scrubbing
- status: proposed
- depends: T-005
- needs: H-011
- acceptance: Sentry for server and client; `beforeSend` scrubs tokens, emails, bodies, amounts; test with a canary.

### T-042 Retention purge job
- status: proposed
- depends: T-038
- acceptance: `retention.purge` reads `retention_days` from lane policy per table class (comms 90, calendar 180, conversations 180) and deletes expired rows; tests with time-shifted fixtures. Tables register themselves as they are added.

## Phase A4 — Admin and observability (PL-34)
Joins W1 + W2 (needs T-023 and T-038).

### T-045 Connection health page
- status: proposed
- depends: T-038, T-023
- acceptance: status, last sync, token expiry, last error per connection; admin_technical sees no content or figures (Playwright check).

### T-046 Sync runs, job failures and audit viewer
- status: proposed
- depends: T-045, T-014
- acceptance: paginated sync run history and failures; audit viewer filtered by lane and actor, owner + admin only; no payload bodies shown.

### T-047 Lane policy and config editor (owner only)
- status: proposed
- depends: T-026, T-015
- acceptance: owner edits lane_config/policies with Zod validation and step-up MFA; every change versioned and audited; others are denied (RLS + UI test).

## Phase A5 — Connectors (PL-30 – PL-33)
After W2, one worktree per provider can run in parallel: **W6** QuickBooks (T-050 – T-053, T-056), **W7** Stripe (T-054, T-058), **W8** GoHighLevel (T-059, T-060), **W9** Google (T-063 – T-065), **W10** Microsoft (T-066 – T-068), **W11** monday.com (T-069, T-070). Schema tasks T-055, T-057 and T-061 (**track W3**) can start as soon as T-013 is merged.

Both mail providers are built behind one interface. Once D-1 is confirmed, the unconfirmed provider's tasks (T-063 – T-065 or T-066 – T-068) can move to Release B.

### T-050 QuickBooks OAuth (sandbox) + health
- status: proposed
- depends: T-035
- needs: H-005
- acceptance: Intuit OAuth with rotating refresh tokens persisted atomically on every refresh (test that a concurrent refresh doesn't lose the token); realm from lane_config; health check; contract tests pass.

### T-051 QuickBooks entity sync (CDC)
- status: proposed
- depends: T-050, T-038, T-039
- acceptance: initial load + CDC for Account, Customer, Vendor, Invoice, Payment, Bill, BillPayment, Purchase, Deposit, JournalEntry, Class into `raw.source_records`; MSW fixtures from synthetic data; no bank account numbers stored (field allowlist test).

### T-052 QuickBooks Reports API
- status: proposed
- depends: T-050, T-039
- acceptance: P&L, Balance Sheet, Cash Flow, AR Aging Summary/Detail, AP Aging Summary/Detail fetched with date range, accounting method and optional class from lane_config; stored in `fin.report_cache` (T-055) with params and `as_of`.

### T-053 QuickBooks webhooks
- status: proposed
- depends: T-051, T-036
- acceptance: Intuit signature verified; events trigger targeted CDC for the realm's lane; spoofed payloads rejected (test).

### T-054 Stripe connector
- status: proposed
- depends: T-034, T-038, T-039
- needs: H-006
- acceptance: restricted key read from Vault; health; sync customers, products, prices, subscriptions, invoices, charges, refunds, payouts, balance transactions into raw; pagination + rate limits; contract tests.

### T-055 Finance normalized schema (part 1: ledger and reports)
- status: proposed
- depends: T-013
- acceptance: `fin.accounts`, `fin.transactions`, `fin.invoices`, `fin.payments`, `fin.bills`, `fin.report_cache` with `numeric(18,2)`, `timestamptz`, source refs, entity/class columns; RLS + pgTAP; only finance roles and owner can read.

### T-056 QuickBooks normalizer → fin.*
- status: proposed
- depends: T-051, T-055
- acceptance: idempotent transform from raw to fin.* (re-run produces no diff); tests on synthetic fixtures incl. voided/deleted records; every row tagged with its entity from the lane_config mapping (APK/PKI classes excluded from PKG).

### T-057 Finance normalized schema (part 2: subscriptions)
- status: proposed
- depends: T-055
- acceptance: Spec: `docs/specs/finance.md` §5. `fin.stripe_subscriptions`, `fin.stripe_subscription_items`, `fin.stripe_discounts`, `fin.stripe_invoices`, `fin.stripe_charges`, `fin.stripe_refunds`, `fin.stripe_payouts` (revenue source; `livemode`, `entity_code`, `numeric(18,2)`), and `fin.subscriber_status` + append-only `fin.subscriber_events` (GHL, **no revenue/amount columns**: enforced by a pgTAP column check); the MRR history table is T-190; RLS + pgTAP.

### T-058 Stripe webhooks + normalizer
- status: proposed
- depends: T-054, T-036, T-057
- acceptance: Stripe signature verified; events upsert raw + normalized rows; out-of-order events handled by `created`/version; rows tagged with entity by Stripe product mapping; spoof test.

### T-190 Stripe subscription versions (MRR history)
- status: proposed
- depends: T-058
- acceptance: Spec: `docs/specs/finance.md` §5. `fin.stripe_subscription_versions` (grain subscription × entity, `is_active`/`is_live`/`is_ended`, `mrr` rounded per row and 0 when inactive, `valid_from`/`valid_to`, `is_active`, `mrr` after recurring coupons, interval-normalised) with a no-overlap exclusion constraint including `lane_id`; idempotent builder from `raw.source_records` Stripe events ordered by `created`/event version (out-of-order safe); initial backfill from current state, `start_date` and invoice line history (documents the 30-day limit of Stripe's events list); `fin.mrr_at`/`fin.subscription_state_at` read it; fixtures for upgrades, quantity changes, coupon start/expiry, trial conversion, cancellation, resume and multi-entity items; RLS + pgTAP incl. cross-lane denial.

### T-059 GoHighLevel connector
- status: proposed
- depends: T-034, T-038, T-039
- needs: H-007
- acceptance: Private Integration token from Vault; location from lane_config; contacts, tags, pipelines/opportunities, products, orders/subscriptions read-only; rate limits; contract tests.

### T-060 Paid-subscriber rule engine
- status: proposed
- depends: T-059, T-057, T-011
- needs: D-3, D-8
- acceptance: Spec: `docs/specs/finance.md` §4.3, §5. Rule from lane_config (tag / pipeline stage / product, combinable) evaluated into `fin.subscriber_status` and append-only `fin.subscriber_events` (new, cancelled, trial→paid, failed payment; carries `rule_version`) so point-in-time membership and customer churn can be rebuilt; unit tests per rule type; APK/PKI tags/products excluded via the lane_config mapping (D-17); no amounts copied from GHL; documents the backfill depth available from GHL (spec Q-F7).

### T-061 Comms and calendar index tables
- status: proposed
- depends: T-013
- acceptance: `comms.message_index` (metadata only, per architecture §6 M5, priority fields, optional approved summary) and `cal.event_index`; pgTAP column check proves no body column exists; RLS + pgTAP; registered with retention purge.

### T-062 Mail/calendar/docs provider interfaces + mocks
- status: proposed
- depends: T-030
- acceptance: `MailProvider`, `CalendarProvider`, `DocumentProvider` (metadata sync, live body fetch, live search, watch/renew, prepareWrite/executeWrite stubs); mock implementation; contract tests both real providers must pass.

### T-063 Google: OAuth + Gmail metadata sync + live body
- status: proposed
- depends: T-062, T-061, T-035
- needs: H-008 (Google), D-1
- acceptance: Gmail history-API delta into `comms.message_index` (metadata only); `readBody` fetches live and never persists (test spies on DB writes); mailboxes from lane_config.

### T-064 Google: Calendar sync
- status: proposed
- depends: T-063
- acceptance: Calendar sync tokens into `cal.event_index`; contract tests. Drive search is T-186 (Release B).

### T-065 Google: Gmail watch + renewal
- status: proposed
- depends: T-063, T-040, T-036
- needs: H-013
- acceptance: Pub/Sub push verified (OIDC token), weekly renewal job, polling fallback when watch fails.

### T-066 Microsoft: Entra OAuth + mail delta + live body
- status: proposed
- depends: T-062, T-061, T-035
- needs: H-008 (Microsoft), D-1
- acceptance: same acceptance as T-063 on Graph (`/messages/delta` with `$select` metadata only); per-tenant throttling handling.

### T-067 Microsoft: calendar delta
- status: proposed
- depends: T-066
- acceptance: calendarView delta into `cal.event_index`; contract tests. OneDrive/SharePoint search is T-187 (Release B).

### T-068 Microsoft: change notifications + renewal
- status: proposed
- depends: T-066, T-040, T-036
- acceptance: subscription create/renew before expiry, `clientState` + validation token handling, lifecycle notifications; spoof test.

### T-069 Work tasks index
- status: proposed
- depends: T-013
- acceptance: `work.tasks` (lane, provider, external id, board/database, title, status, owner, due, company, exec_priority, url) + RLS + pgTAP.

### T-070 monday.com connector (read + prepareWrite)
- status: proposed
- depends: T-034, T-038, T-069
- needs: H-009
- acceptance: boards/items/columns from the IT workspace into `work.tasks`, Company and Exec Priority columns mapped via lane_config; `prepareWrite` returns a proposed payload and never executes (test).

## Phase A6 — Module specs (planner)
Docs only. Can run in its own worktree at any time after T-001.

### T-075 Specs batch 1: finance, approvals, assistant
- status: done
- depends: T-001
- acceptance: `docs/specs/{finance,approvals,assistant}.md` with data model, SQL views, tools, UI, tests, open questions and sub-tasks; refines T-080 – T-130 if needed.

### T-076 Specs batch 2: comms, calendar, search, briefing
- status: proposed
- depends: T-075
- needs: D-1, D-12
- acceptance: `docs/specs/{comms,calendar,search,briefing}.md` as above.

### T-077 Specs batch 3: notifications, admin
- status: proposed
- depends: T-075
- acceptance: `docs/specs/{notifications,admin}.md` as above.

## Phase A7 — Finance (PL-35 – PL-37)
T-080 joins W3 early. T-081 – T-097 form **track W12** once W6 – W8 are merged. Keep it to one worktree: the views share `fin.*` migrations.

### T-080 Business calendar SQL
- status: proposed
- depends: T-013
- acceptance: Spec: `docs/specs/finance.md` §5. `fin.business_week(ts)` (Sat–Fri, America/New_York, exclusive end), `fin.month_start(d date)`, `fin.next_month_start(d date)` (conversions in ET, independent of session timezone; pgTAP also runs with `timezone = 'UTC'`), `fin.ytd_start`, `fin.et_date`, MTD/YTD/period helpers; start of month = 00:00 America/New_York on the 1st; pgTAP covers DST transitions (Mar 8 and Nov 1, 2026: Nov is a 721-hour month and 00:00 Nov 1 is still EDT), year boundaries and Friday 23:59:59 vs Saturday 00:00 ET.

### T-081 Finance query layer
- status: proposed
- depends: T-056, T-017
- acceptance: Spec: `docs/specs/finance.md` §7. Lane-scoped server functions in `packages/modules/finance/domain` returning `FinanceResult<T>` (figures with display strings, `sources`, `asOf`, `freshness`, `status` incl. `pending_definition`, `notes`); the only path used by UI and AI tools; requireLane/requireRole + Zod on every function; any `use cache` includes laneId and role; unit tests.

### T-082 Cash book balance view
- status: proposed
- depends: T-081, T-052
- acceptance: Spec: `docs/specs/finance.md` §4.4, §6. SQL view `fin.v_cash_book_balance` of bank-type account balances as **book balance** (column and API field names say `book_balance`; a pgTAP check fails any `bank_balance` name); matches the synthetic Balance Sheet fixture to the cent; each account shown in full under its legally owning entity from lane_config, **no allocation** (D-18).
- needs: D-8

### T-083 AR aging view
- status: proposed
- depends: T-081
- needs: D-8
- acceptance: Spec: `docs/specs/finance.md` §6. `fin.v_ar_aging`: split by QBO class, else customer mapping (D-18); buckets current/1–30/31–60/61–90/90+ on days past due and an AR >30 total (`fin.ar_over_30`); ties to the QBO AR Aging report cache on fixtures; confirms whether the Reports API filters by class (else computed from class-tagged invoices, plan-review §3).

### T-084 AP aging + AP due in 14 days
- status: proposed
- depends: T-081, T-080
- needs: D-8
- acceptance: Spec: `docs/specs/finance.md` §4.1, §6. `fin.v_ap_aging` and `fin.v_ap_due_14d`: split by QBO class, else vendor/customer mapping (D-18); AP aging buckets; bills due on or before `et_date(now())+14` with overdue shown as a sub-line (spec Q-F3); ties to the AP Aging report cache on fixtures.

### T-085 P&L MTD/YTD
- status: proposed
- depends: T-081, T-080, T-052
- needs: D-8
- acceptance: Spec: `docs/specs/finance.md` §4.4. P&L MTD and YTD from the report cache split by QBO class, else customer mapping from lane_config (D-18); accounting method from `lane_config.finance.accounting_method` and shown with the figure; tests incl. a class-mapped entity (for APK/PKI later).

### T-086 MRR and churn
- status: proposed
- depends: T-190, T-080
- needs: D-9, D-8
- acceptance: Spec: `docs/specs/finance.md` §4.2, §6. Revenue side only, Stripe only. SQL `fin.subscription_state_at`, `fin.mrr_at`, `fin.mrr_movements`, `fin.v_mrr_monthly` implementing D-9 plus the Oct 24 decisions exactly: MRR (interval-normalised, after recurring coupons, no trials / 100%-discounted / one-offs, PKG products via lane_config), start of month = 00:00 America/New_York on the 1st, new / expansion / contraction (month-start vs month-end change of an active subscription's MRR) / churned MRR (cancelled/ended subscriptions only; unpaid/paused shown as contraction, spec Q-F2), revenue churn % = churned MRR ÷ start-of-month MRR, same-month start+cancel counts as new and churned; property test `end_mrr = start_mrr + net_new_mrr`; month-to-date rows flagged `is_final = false`; `fin.v_stripe_revenue_month` by product (net of refunds); payouts account-level only, never split (D-18); version rows rounded per row, `mrr = 0` when inactive; fixtures with annual/quarterly plans, percent and amount coupons, once-coupons, trials, 100% discount, refunds, upgrades, same-month cancel, Nov 2026 DST month. Customer churn % is not here (T-087, GoHighLevel).

### T-087 Paid subscribers
- status: proposed
- depends: T-060, T-080
- acceptance: Spec: `docs/specs/finance.md` §4.3. `fin.subscriber_state_at`, `fin.subscriber_movements` and `fin.v_subscribers_week` from `fin.subscriber_events`: paid subscriber counts by product, new/cancelled/trial→paid/failed payments per business week, and **customer churn % = GoHighLevel subscribers cancelled in the month ÷ subscribers active at the start of the month** (same-month start+cancel counts as new and cancelled; returns `pending_definition` while the lane has no paid-subscriber rule, i.e. until D-3); APK/PKI excluded (D-17); no money columns in any subscriber view (pgTAP check).

### T-088 Controls panel SQL
- status: proposed
- depends: T-082, T-087, T-031, T-191
- acceptance: Spec: `docs/specs/finance.md` §4.5. `fin.v_controls` with thresholds from lane_config: unreconciled >30 days (from `fin.reconciliation_status`, T-191), disconnected/stale feeds, uncategorized transactions, period lock status, Stripe-vs-GHL customer count mismatch (flag only, no merging), shared bank accounts (D-18), unmapped-entity rows, unsupported (metered / non-USD) Stripe items; each returns `{code, status, value, threshold, detailRefs, asOf}`; tests per control.

### T-191 Reconciliation status entries
- status: proposed
- depends: T-055
- acceptance: Spec: `docs/specs/finance.md` §4.5, §5. `fin.reconciliation_status` (account, `last_reconciled_on`, entered_by/at, note; insert-only history, latest wins) written only through a security-definer function for finance_operator and owner; audited; feeds the `unreconciled_over_30d` control; first confirms in T-051/T-052 notes whether QBO exposes reconciliation state (spec Q-F5); RLS + pgTAP incl. cross-lane denial and viewer denial.

### T-089 Immutable snapshots + sign-off
- status: proposed
- depends: T-082, T-083, T-084, T-085, T-086, T-087
- acceptance: Spec: `docs/specs/finance.md` §5 Part 3. `fin.snapshots` (weekly/monthly, `version`, payload of figures + source refs + `as_of`, SHA-256) is **insert-only for every role** (update/delete/truncate blocked, pgTAP incl. service role); sign-off is a separate insert-only `fin.snapshot_signoffs` row created only by `fin.sign_off_snapshot(p_lane_id, p_snapshot_id, p_hash_seen)` (finance_operator or owner, AAL2 + fresh TOTP step-up, hash must match, audited; wrong hash / AAL1 / viewer denied); a correction is a new version with `restates_snapshot_id` needing its own sign-off.

### T-090 fin.sync and fin.qbo_reports schedules
- status: proposed
- depends: T-056, T-052, T-058, T-060
- acceptance: scheduled Inngest functions per enabled lane from lane_config; idempotent; sync_runs logged.

### T-091 fin.weekly_cash job + report
- status: proposed
- depends: T-089, T-090
- acceptance: Spec: `docs/specs/finance.md` §9. Saturday run (time from `lane_config.finance.weekly_cash_time`, default 06:00 America/New_York) builds the snapshot for the Sat–Fri week that just ended, storing `period_start`/`period_end` instants in the payload (test with events between Friday 18:00 and Saturday 00:00 ET, and one at Saturday 00:30 that is excluded; confirm timing with Sophie, spec Q-F9) (cash by account as book balance at week start/end, Stripe payouts at account level, AR/AP totals, AR >30, AP due 14d, subscribers new/cancelled, controls summary); refuses to write if sources are stale and emits a notification event; export (PDF/CSV, derived figures only) stored in private per-lane Storage; notifies Sophie to sign off; distribution only via an email proposal (T-110+).
- needs: D-14

### T-092 fin.monthly_close snapshot job
- status: proposed
- depends: T-089, T-090
- acceptance: Spec: `docs/specs/finance.md` §9. Month-end snapshot (figures plus MRR and subscriber movements, `is_final = true`) after the books close, trigger from `lane_config.finance.monthly_close_trigger` (`day_of_month:N` or `manual`); test.

### T-093 fin.controls_daily job
- status: proposed
- depends: T-088, T-090
- acceptance: daily evaluation; red flags emit notification events.

### T-094 Tie-out view
- status: proposed
- depends: T-089
- acceptance: Spec: `docs/specs/finance.md` §5 Part 3, §6. `fin.tieout_reference` (insert-only manual entries, audited) and `fin.v_tieout(p_lane_id, p_week)`: portal figure vs QBO report figure vs manually entered reference figure (from Sophie's report), differences and pass/fail per KPI per week with tolerance from `lane_config.tieout.tolerance` (default 0.00, i.e. to the cent).

### T-095 Finance dashboard UI
- status: proposed
- depends: T-081, T-088, T-024
- needs: D-2
- acceptance: Spec: `docs/specs/finance.md` §10. KPI cards from the lane_config KPI list (ids in spec §4.1) with source chips, freshness and as-of; "Book balance" label visible; customer churn card shows "Pending definition (D-3)" while status is `pending_definition`; MTD figures labelled; Playwright test incl. AAL1 redirect and viewer denial.

### T-096 Finance detail pages
- status: proposed
- depends: T-095
- acceptance: AR/AP aging tables (TanStack Table), P&L, MRR/churn and subscriber charts (Recharts), controls panel; all values from the query layer.

### T-097 Weekly report and tie-out pages
- status: proposed
- depends: T-091, T-094, T-096
- acceptance: Spec: `docs/specs/finance.md` §10. `/finance/reports` and `/finance/tie-out`: view and sign off the weekly snapshot (step-up, shows the hash signed), view tie-out history, enter reference figures and reconciliation dates; finance_operator and owner only.

## Phase A8 — Assistant (PL-38)
T-100 – T-103 are **track W4**, parallel with the connectors (after T-017). T-104 – T-106 follow T-081.

### T-100 LLMProvider interface + Anthropic implementation
- status: proposed
- depends: T-005
- needs: H-002
- acceptance: provider interface (analysis + fast model, configured not hard-coded); Anthropic implementation via `packages/ai` only; mock provider for tests; request logging excludes prompt content.

### T-101 Tool registry + policy gate
- status: proposed
- depends: T-100, T-017, T-015
- acceptance: Spec: `docs/specs/assistant.md` §4. Modules register tools (`name`, `category`, `effect` read|propose, `requiredView`, strict Zod args with no lane field, `resultStore` full|refs_only, `untrustedFields`); the gate checks, in order, AAL2 session, membership and role, lane enabled, `llm_allowed_categories`, required view, rate limit, then audits every call; a registration test fails if a tool imports a connector write path; tests for denied lane, denied category, forged laneId/extra arguments, viewer and admin_technical.

### T-102 Untrusted content wrapping + injection suite
- status: proposed
- depends: T-101
- acceptance: Spec: `docs/specs/assistant.md` §4. Retrieved content (email, documents, web, and external names in QBO/Stripe/GHL results) wrapped as data with provenance and escaped closing tags; system prompt states it has no authority; `pnpm test:injection` runs a fixture corpus (email/doc/web/customer-name/memo injections, nested tags, approve/send and cross-lane requests) against a mock provider scripted to comply and, opt-in, the real model; asserts no tool escalation, no cross-lane calls, no proposals or approvals from injected text, no secrets in output.

### T-103 Conversations storage
- status: proposed
- depends: T-013
- acceptance: Spec: `docs/specs/assistant.md` §4. `ai.conversations`, `ai.messages` (with `citations`, `grounding`) and `ai.tool_calls` (validated args, status, denial reason, result only for `resultStore = full`), all lane-scoped, RLS = AAL2 + lane membership + `user_id = auth.uid()` (own conversations only; admin_technical none) + pgTAP incl. cross-lane and cross-user denial; user can hard-delete (cascade); registered with retention (180 days); no email/doc bodies or tokens stored; assistant text from turns that used `refs_only` tools is stored in redacted form (placeholder text, citations kept) until D-19 allows otherwise.

### T-104 Finance tools
- status: proposed
- depends: T-101, T-081
- acceptance: Spec: `docs/specs/assistant.md` §4. `get_cash_position`, `get_ar_aging`, `get_ap_aging`, `get_pnl`, `get_mrr`, `get_subscribers`, `get_controls_status` (`get_ap_aging` added so AP due ≤14 days is answerable) return pre-formatted display strings, SQL-computed totals, sources and `as_of` straight from the query layer; strict args validated against the lane mapping; book-balance labelling and `pending_definition` pass-through tested; Stripe and GHL figures never merged.

### T-105 Chat route with citations
- status: proposed
- depends: T-104, T-103, T-102
- acceptance: Spec: `docs/specs/assistant.md` §4. SSE chat route (`message.start`, `text.delta`, `tool.start`, `tool.result`, `citations`, `grounding`, `message.done`, `error`) with bounded tool loop (6 iterations), rate limits, abort on disconnect; answers carry source chips; numeric-grounding check flags any figure in the answer not in this turn's tool results, retries once, then replaces the figure and marks `grounding.status = failed` (test); multi-lane questions use per-lane sub-calls + composer that sees only allowed summaries (inactive while one lane is enabled, unit-tested with two fake lanes).

### T-106 Assistant UI
- status: proposed
- depends: T-105, T-024
- acceptance: Spec: `docs/specs/assistant.md` §4. Chat page with lane chip, streaming text, tool-progress line, source chips with freshness, grounding warning chip, conversation list and delete, iPhone layout, disabled state when no categories are allowed; Playwright test.

### T-194 Assistant golden-question eval set
- status: proposed
- depends: T-105
- acceptance: Spec: `docs/specs/assistant.md` §8. Fixture set of finance questions (AR over 30 days, MRR movement for a month, book balance by account, subscribers this week, customer churn before D-3) run against the mock provider asserting the expected tool, args, citations and that every figure is grounded; opt-in run against the real model that only reports (never fails CI).

## Phase A9 — Approval Center: email + monday.com (PL-42)
T-110, T-111 and T-114 are **track W5**, parallel with the connectors. T-112 needs T-020; executors T-116/T-118 need W9/W11.

### T-110 Proposed actions schema + state machine
- status: proposed
- depends: T-013, T-014
- needs: D-19
- acceptance: Spec: `docs/specs/approvals.md` §4. `act.proposed_actions` (full column set in the spec incl. `payload_sha256` over canonical JSON of lane+type+connection+target+payload, `expected_before`, `consequences`, `approved_hash`, `deferred_until`, `expires_at`), insert-only `act.status_history` and `act.execution_claims` (primary key action_id: exactly one claim, no attempt column), allowed transitions enforced in SQL (proposed→approved/rejected/expired/invalidated; approved→executing/expired/invalidated; executing→verified/failed); payload/hash/target immutable after `proposed`; `act.is_allowed_type()` with excluded classes rejected at DB level; `authenticated` has no direct DML; `act.propose` is service-role only (the app computes the JCS hash) and users call security-definer functions (`approve` with in-SQL step-up check of the JWT `amr` or an equivalent single-use token, `reject`, `defer`, `supersede`; every security-definer function sets an explicit `search_path`) and service-only `claim_execution`/`mark_*`/`invalidate_approved`/`purge_content` (purge clears payload, consequences, rationale, source_refs and expected_before); `email.*` refused unless `lane_policies.store_outbound_drafts`; index row `core.action_index`; pgTAP for every illegal transition, tampering, AAL1/stale step-up, viewer/finance_operator/admin_technical denial and cross-lane denial.

### T-111 Proposal service
- status: proposed
- depends: T-110, T-030
- needs: D-19
- acceptance: Spec: `docs/specs/approvals.md` §5. `proposeAction` from `prepareWrite` with canonical JSON (RFC 8785) + SHA-256, rationale and source refs; editing creates a new proposal (`supersedes_id`) and invalidates the old; types allowlisted by lane policy `write_actions_allowed`; excluded classes rejected at service and DB level (tests); per-lane and per-turn pending limits; consequences rendered server-side; `userInitiated` (true only for the direct Draft-reply click or an explicit prepare intent, set by the route) required for assistant-created proposals, with `derived_from_retrieved` set and shown when recipients/targets come from retrieved content (test); only composed text is stored for email, never quoted thread text (canary test); `email.*` refused unless `store_outbound_drafts`; audit + `approval.needed` event.

### T-193 ApprovedAction brand and mint boundary
- status: proposed
- depends: T-111, T-003
- acceptance: Spec: `docs/specs/approvals.md` §5. `ApprovedAction` branded type constructible only by `mintApprovedAction` inside `packages/modules/approvals`; connector `executeWrite` accepts only that type and re-checks `sha256(payload) === payloadSha256`; boundary lint rule fails any import of `executeWrite` or the mint function outside the approvals package (lint fixture test); `prepareWrite` never executes (contract-kit test).

### T-112 Approve/reject API
- status: proposed
- depends: T-111, T-020
- acceptance: Spec: `docs/specs/approvals.md` §5. `approveAction({id, hashSeen})`: approver roles from `lane_config.approvals` (default owner only), `requireStepUp(maxAge)`, hash seen must equal the stored hash, refuses when expired or `approvals_live` is false, emits `action/approved` with ids only; reject (reason) and defer (`deferred_until`); all audited; tests for tampered hash, replayed approve, double approve race, wrong role.

### T-113 action.execute
- status: proposed
- depends: T-112, T-037, T-193
- acceptance: Spec: `docs/specs/approvals.md` §6. Inngest `action.execute` (retries = 0, recovery only via T-192; idempotency key = action id, concurrency per action and connection): claim → revalidate (hash, `approvals_live`, type still allowed, approver still holds role, connection belongs to lane and healthy, `expected_before` drift, mailbox in lane_config) → `executeWrite` (the only caller, via the `ApprovedAction` brand from T-193) → read-back verify → verified/failed; crash after provider accept never re-sends (`outcome_unknown` for a human); executes exactly once under retries, duplicate events and concurrent workers (test with a counting mock connector).

### T-114 action.expire
- status: proposed
- depends: T-110, T-037
- acceptance: Spec: `docs/specs/approvals.md` §6. `action.expire` cron (every 5 min) expires `proposed`/`approved` actions past `expires_at` (defaults from lane_config: email 72 h, monday 168 h); deferred items resurface; also invalidates approved actions whose approver lost the approver role (`act.invalidate_approved`); audited; test.

### T-192 action.reconcile_stuck
- status: proposed
- depends: T-113
- acceptance: Spec: `docs/specs/approvals.md` §6. Cron that finds actions in `executing` longer than N minutes (lane_config), runs the provider marker lookup/read-back, and moves them to `verified` or `failed` (verify-only: never creates a second claim, never re-executes; monday create uses the marker lookup) (`outcome_unknown` when undecidable, never re-sending); audited; test with a mock connector that crashes after accepting a send.

### T-115 Approval Center UI
- status: proposed
- depends: T-112, T-024
- acceptance: Spec: `docs/specs/approvals.md` §10. `/approvals` (Pending, Deferred, History) and `/approvals/[id]` showing the exact content as executed, sending account, recipients with new-recipient/external/bcc flags, target, server-built consequences, the assistant's rationale labelled unverified, short hash and status timeline; approve (step-up modal showing the hash), edit (new proposal + diff), reject, defer; "Not live" banner; works on iPhone width; push deep link; Playwright incl. step-up.

### T-116 Executor: email send
- status: proposed
- depends: T-113, T-063
- needs: D-19
- acceptance: Spec: `docs/specs/approvals.md` §8. `executeWrite` for `email.send` and `email.save_draft` on the confirmed provider (plain text, no attachments, no deletes); `X-Portal-Action-Id` idempotency marker and lookup before any retry; read-back via sent item id; MSW tests incl. crash-after-send.

### T-118 Executor: monday.com
- status: proposed
- depends: T-113, T-070
- acceptance: Spec: `docs/specs/approvals.md` §8. `monday.item.create|update|set_status`; column writes limited to the lane_config allowlist; `expected_before` drift check; `monday.item.create` writes the action id to a `portal_action_id` marker column and looks it up first so recovery never duplicates an item (needs the board column, spec Q-A7); read-back; no deletes (test). Notion writes are T-180 (Release B).

### T-119 Approvals go-live gate
- status: proposed
- depends: T-113
- acceptance: Spec: `docs/specs/approvals.md` §7. Per-lane `approvals_live` flag in lane_config (default false); while false, proposals show "Not live" and **the approve API, `act.approve` and `action.execute` each refuse**; flipping it requires owner + step-up and is audited; pgTAP + unit tests. Humans flip it for PKG only after T-170 passes (D-11).

## Phase A10 — Communications (PL-39)
**Track W13** with Phase A11, after W9 (or W10) and W4.

### T-120 comms.ingest_delta
- status: proposed
- depends: T-063, T-042
- acceptance: push/poll-driven delta updates to `comms.message_index`; per-connection concurrency; tests.

### T-121 comms.classify
- status: proposed
- depends: T-120, T-102
- acceptance: fast model scores priority, needs_reply, category, commitment-candidate flag; priority senders from lane_config boost; only scores/labels stored; injection fixtures included.

### T-122 Priority inbox UI
- status: proposed
- depends: T-121, T-024
- acceptance: list filtered by lane/priority; thread view fetches bodies live (no persistence, `no-store`); Playwright.

### T-123 Comms tools
- status: proposed
- depends: T-121, T-101
- acceptance: `search_email`, `read_email`, `list_priority_threads` registered with category `email`; bodies wrapped as untrusted.

### T-124 Reply drafts → proposals
- status: proposed
- depends: T-122, T-111
- acceptance: Spec: `docs/specs/approvals.md` §9. "Draft reply" (a user click, `userInitiated`) uses `prepare_email` to create an `email.send` proposal with recipients defaulted to the thread participants; nothing sent without approval (test); injected email text cannot create or approve a proposal (injection test).

## Phase A11 — Calendar and meetings (PL-40)
### T-130 cal.ingest_delta
- status: proposed
- depends: T-064
- acceptance: delta updates to `cal.event_index`; retention 180 days.

### T-131 Unified calendar UI
- status: proposed
- depends: T-130, T-024
- acceptance: day/week views across lanes the user may see; Playwright.

### T-133 Calendar tools
- status: proposed
- depends: T-130, T-101
- acceptance: `get_calendar`, `get_meeting_context` registered with category `calendar`. Scheduling proposals are T-181 (Release B).

## Phase A12 — Briefing and basic notifications (PL-44)
T-160/T-161 can run in parallel after T-025. T-162/T-163 wait for W12, W13 and the approvals track to converge.

### T-160 Push subscriptions + web push sender
- status: proposed
- depends: T-025, T-013
- needs: H-014
- acceptance: `notify.push_subscriptions` + RLS + pgTAP; VAPID sender; iOS installed-PWA subscribe flow; test.

### T-161 Notification events + in-app alerts
- status: proposed
- depends: T-160, T-037
- acceptance: events (approval needed, briefing ready, finance red flag, connection failing, commitment due); payload builder allows only template text + lane code (test rejects names, amounts, subjects); in-app via Supabase Realtime.

### T-162 briefing.daily
- status: proposed
- depends: T-104, T-123, T-133, T-112
- acceptance: per-lane fan-out (calendar today, priority mail, finance alerts, pending approvals; commitments added in T-183) within each lane's policy, then a composer; facts separated from recommendations; `brief.briefings` + RLS + pgTAP + retention; schedule from lane_config (default 06:30 America/New_York).

### T-163 Home page
- status: proposed
- depends: T-162, T-095, T-115
- acceptance: briefing, attention queue, today's meetings, approvals waiting, lane tiles; Playwright.

## Phase A13 — Pilot hardening and go-live (PL-45 – PL-50)
Serial. T-171 can start any time after T-004. T-170 is the gate for PKG approvals going live.

### T-170 Security test suite
- status: proposed
- depends: T-119, T-105, T-124, T-118, T-163
- acceptance: catalog-driven cross-lane RLS tests over every table; auth/AAL and step-up; token canaries; webhook spoofing per provider; injection suite; approval tampering (hash change, replay, double execute) for email + monday.com actions; report in `docs/security/pilot-test.md`; no open blocker/high. **Must pass before PKG approvals go live on Nov 25 (D-11).**

### T-171 Staging environment runbook
- status: proposed
- depends: T-004
- needs: H-001, H-010
- acceptance: documented, human-run steps for staging migrations and deploys (agents never run them); a proposed `migrate-staging.yml` mirroring `migrate-prod.yml`, delivered in the PR body for a human to add; env var checklist; seed policy (no real data in preview).

### T-172 Tie-out procedure
- status: proposed
- depends: T-097
- needs: H-017, D-8
- acceptance: `docs/runbooks/tie-out.md`: weekly steps for Sophie/Saurabh, tolerance (to the cent unless agreed), sign-off record; supports success criterion 1.

### T-173 Production deploy runbook + restore drill
- status: proposed
- depends: T-170
- acceptance: `docs/runbooks/production.md`, PITR enabled, restore drill performed by a human and recorded.

---

# Release B — Dec 7 – 31

## Phase B1 — Rollout and specs
### T-174 Lane onboarding playbook + dry run
- status: proposed
- depends: T-090, T-047
- acceptance: `docs/runbooks/onboard-lane.md`; dry run enabling APK on staging with synthetic config only, with zero code changes (PR diff check); timed against the 3-day target.

### T-185 Specs batch 4: commitments, memory, projects
- status: proposed
- depends: T-075
- needs: D-12
- acceptance: `docs/specs/{commitments,memory,projects}.md` with data model, tools, UI, tests and sub-tasks.

## Phase B2 — Remaining actions
### T-117 Executor: calendar changes
- status: proposed
- depends: T-113, T-064
- acceptance: create/move/decline/propose time; read-back verification; tests.

### T-181 Scheduling proposals
- status: proposed
- depends: T-133, T-111, T-117
- acceptance: `prepare_event` creates proposals only (create/move/decline/propose time); executed by T-117 after approval.

### T-180 Executor: Notion
- status: proposed
- depends: T-113, T-071
- acceptance: create/update page via approvals; read-back verification; no deletes (test).

## Phase B3 — Notion read, federated search and meeting prep (PL-41, PL-40)
Search connectors for the unconfirmed mail provider (T-186 or T-187) can be dropped once D-1 is decided.

### T-186 Google Drive live search
- status: proposed
- depends: T-064
- acceptance: Drive `files.list` search within the lane's connection, returning links/metadata only; contract tests.

### T-187 OneDrive/SharePoint live search
- status: proposed
- depends: T-067
- acceptance: Graph Search for drive items within the lane's connection, links/metadata only; contract tests.

### T-071 Notion connector (read + prepareWrite)
- status: proposed
- depends: T-034, T-038, T-069
- needs: H-009
- acceptance: search, pages, databases shared with the integration; task-like databases into `work.tasks`; page content fetched live; `prepareWrite` only.

### T-140 Federated search service
- status: proposed
- depends: T-186, T-071
- acceptance: parallel fan-out to drive search + Notion within allowed lanes; merge, de-dupe, rank; per-source timeouts (partial results labelled); only the query log stored (`docs.query_log` + RLS + pgTAP).

### T-141 Search UI + tools
- status: proposed
- depends: T-140, T-101, T-024
- acceptance: search page with source links; `search_documents`, `read_document` (live fetch, untrusted wrapping).

### T-132 Meeting prep pack
- status: proposed
- depends: T-130, T-123, T-140
- needs: D-12
- acceptance: `cal.meeting_prep` at T-60 and on demand; attendee context, related docs, agenda suggestions (open commitments added in T-183); cited; per-lane; stored only as an approved/derived summary per lane policy.

## Phase B4 — Opt-in indexing
### T-142 Opt-in folder indexing (schema + embeddings interface)
- status: proposed
- depends: T-140
- needs: D-13
- acceptance: `docs.sources` (opted-in folders) and `docs.chunks` (pgvector, ACL snapshot) + RLS + pgTAP; `EmbeddingProvider` interface; indexing blocked unless lane policy `indexing_enabled`.

### T-143 Indexing job + read-time permission recheck + opt-out purge
- status: proposed
- depends: T-142
- acceptance: `index.rebuild` per folder; results re-check source permissions at read time; opt-out deletes chunks (test).

## Phase B5 — Projects, commitments, memory (PL-43, PL-44)
### T-150 Projects rollup
- status: proposed
- depends: T-070, T-024, T-101
- acceptance: view of monday.com items by Company/project with Exec Priority, overdue and owner; `get_tasks` tool.

### T-151 Commitments schema
- status: proposed
- depends: T-013
- acceptance: `commit.candidates`, `commit.commitments` (owner, counterparty, due, status, source refs) + RLS + pgTAP.

### T-152 commit.extract
- status: proposed
- depends: T-151, T-121
- needs: D-12
- acceptance: fast model extracts promises from sent mail (and meeting notes per D-12) with citations; bodies used transiently, not stored; injection fixtures.

### T-153 commit.reconcile
- status: proposed
- depends: T-152, T-069, T-111
- acceptance: matches candidates to `work.tasks`; proposes create/link/dismiss; create goes through approvals; nothing created silently (test).

### T-154 Commitments UI + tool
- status: proposed
- depends: T-153, T-024
- acceptance: list due/overdue; accept/dismiss; `get_commitments` tool; feeds briefing.

### T-155 Memory items + explicit-only write path
- status: proposed
- depends: T-013, T-101
- acceptance: `mem.items` (lane, fact, source, created_at, expires_at) + RLS + pgTAP; written only from explicit user statements or user-confirmed suggestions (tests that retrieved content can't create memory); never read across lanes.

### T-156 Memory settings UI + assistant integration
- status: proposed
- depends: T-155, T-106
- acceptance: view/delete per lane in Settings; assistant reads only current-lane memory; audited deletes.

### T-183 Commitments in briefing and meeting prep
- status: proposed
- depends: T-154, T-162, T-132
- acceptance: briefing adds "due this week / overdue" commitments; prep pack adds open commitments involving the attendees; cited.

## Phase B6 — Notification polish
### T-182 Notification polish
- status: proposed
- depends: T-161
- acceptance: per-user preferences per event type, quiet hours (America/New_York), deep links into the app after auth, badge counts; payload rules from T-161 unchanged.

## Phase B7 — Release B security test
### T-184 Security test for Release B and other lanes
- status: proposed
- depends: T-170, T-156, T-143, T-153
- acceptance: re-run T-170 suite plus commitments, memory and indexing tests; per-lane approval enablement for lanes other than PKG; Dec 17–23 window; actions for other lanes go live Dec 29 only if no blocker/high.
