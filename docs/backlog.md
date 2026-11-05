# Backlog — Pub K Group pilot

Status flow: `proposed` → **`approved` (human)** → built by agent → PR sets `done` → **merge (human)**.
Only humans change `proposed` → `approved`. Agents pick the next `approved` task whose dependencies are `done` and whose `needs` are checked.
Board references (PL-xx) point to the Personal Chatbot board in monday.com.

**Releases (see `docs/pilot-scope.md`)**
- **Release A — live Nov 25 (PKG):** platform core, connectors (QuickBooks, Stripe, GoHighLevel, mail/calendar, monday.com), finance, assistant, priority inbox + reply drafts, calendar view, daily briefing, projects (monday.com, read-only; T-150), admin/health, basic web push, and the Approval Center for email send + monday.com updates. PKG approvals switch on only after the pilot security test T-170 passes.
- **Release B — Dec 7 – 31:** federated search + opt-in indexing, Notion read/writes, meeting prep packs, calendar actions, commitments, memory, projects view, notification polish, onboarding playbook; action modules for other lanes go live Dec 29.

**Task fields**
- `depends:` other tasks (T-xxx). Enforced by `scripts/next-task.mjs`.
- `needs:` human items (H-xxx) or decisions (D-x). A need is met when its item is checked (`- [x]`) under "Needs human". Enforced by `scripts/next-task.mjs` once T-000 is merged; until then, approve a task only when all its `needs` are checked.
- `acceptance:` what must be true. Every task also has to meet the Definition of Done in `CLAUDE.md` (typecheck, lint, test, test:db, security review, PR body).
- Provider dependencies: tasks that need mail/calendar depend on the **Google** tasks (T-063, T-064) by default. If D-1 = Microsoft 365, replace them with T-066, T-067 before approving.
- IDs are stable and roughly follow build order; the dependency graph is authoritative where they differ.
- Sizing: each task is ≤1 day for one developer with Claude Code. Release A is 123 tasks (T-075 added T-190 – T-194; the QuickBooks decisions of Oct 28 added T-195 – T-197), Release B 23 (see "Schedule risk" in `docs/plan-review.md`).

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
| W1 Auth + app shell | T-018 – T-026, then T-045 – T-047 | T-017 (T-022 after T-002) | T-023 – T-026 and T-045 – T-047 wait on D-20 (design sign-off, Nov 5–6); T-018 – T-022 can run now |
| W2 Connector platform | T-030 – T-042 | T-013 (T-030 after T-002) | |
| W3 Finance/index schemas | T-055, T-057, T-061, T-080 | T-013 | SQL only |
| W4 Assistant core | T-100 – T-103 | T-017 | needs H-002 for T-100 |
| W5 Approvals core | T-110, T-111, T-114, T-193, then T-112 | T-013 + T-030; T-112 after T-020 | |
| W6 QuickBooks | T-050 – T-053, T-195 – T-197, T-056 | W2, T-055 | all of QB-1 – QB-20 pass on the sandbox before H-024 |
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

### QuickBooks-first schedule (Oct 28, 2026)
Goal: the live PKG file connected in production on **Fri Nov 13** (H-024), tie-out week 1 by hand on Mon Nov 16, week 2 through T-094 on Mon Nov 23. **At most 3 tracks at once.** Track A is the critical chain in the main worktree; B and C are parallel worktrees for off-chain tasks. `+` = a pair built in one worktree and one PR (both tasks set to done). At most two SQL-heavy tasks (marked SQL) on the same day.

| Day | A — critical chain (main) | B — worktree | C — worktree |
|---|---|---|---|
| Oct 28–29 | T-005 (finish), T-007 | T-030 | T-022 |
| Oct 30 | T-010 (SQL) | T-037 | T-003 |
| Nov 2 | T-012 (SQL) | T-011 (SQL) | T-041 (needs H-011) |
| Nov 3 | T-013 (SQL) | T-014 + T-015 (SQL) | T-016 + T-017 |
| Nov 4 | T-031 + T-032 (SQL) | T-039 (SQL) | T-018 |
| Nov 5 | T-033 + T-034 | T-038 | T-019 |
| Nov 6 | T-035 | T-040 | T-055 (SQL) |
| Nov 9 | T-050 | T-036 (SQL) | T-004 |
| Nov 10 | T-195 | T-051 | T-052 |
| Nov 11 | T-197 | T-053 | T-196 (SQL) |
| Nov 12 | QB-1 – QB-20 sandbox run + fixes | T-090 | T-056 (SQL) |
| Nov 13 | **H-024 connect live PKG file** | T-080 (SQL) | T-081 |
| Nov 16 | week-1 tie-out by hand (T-172) | T-082 (SQL) | T-083 (SQL) |
| Nov 17 | T-084 (SQL) | T-085 (SQL) | — |
| Nov 18 | T-094 (SQL) | T-172 | — |
| Nov 23 | week-2 tie-out through T-094 | | |

Off-chain tasks (any free B/C slot, as long as their own dependencies are merged): T-003, T-004, T-011, T-014 + T-015, T-016 + T-017, T-018, T-019, T-022, T-030, T-036, T-037, T-038, T-039, T-040, T-041, T-051, T-052, T-053, T-055, T-090, T-196. Human items on the path: H-011 (Sentry, by Nov 2, blocks T-041 → T-196), H-023 (Production environment, by Nov 12), H-012 (branch protection on `main`, before the first production deploy), D-8 (Sophie's mapping, by Nov 13). Everything else in Release A fills free slots after Nov 13. Re-forecast weekly; one lost day on track A moves the connection to Mon Nov 16.

Rules for running tracks in parallel:
- **Location:** the main checkout is `~/dev/pubk-projects/jarvis/main`. Create each worktree beside it as `~/dev/pubk-projects/jarvis/<task-id>` (`git worktree add ../<task-id> -b agent/<task-id>`), never inside `main/`. Remove it with `git worktree remove` once its PR is merged.
- **No more than 3 tracks at once** (Oct 28, 2026). Every PR still needs your review.
- **Migrations:** at most two SQL-heavy tracks at a time. Before merging, rebase and renumber migration timestamps so they apply in merge order, then re-run `pnpm test:db`.
- **Local Supabase:** each worktree needs its own `project_id` and ports in `supabase/core/supabase/config.toml`, or `pnpm test:db` has to run one worktree at a time. Two stacks on the default ports collide.
- **Shared files:** `pnpm-lock.yaml` and the `status:` lines in this file will conflict. Regenerate the lockfile and keep both status changes when rebasing.

---

## Ready for approval
These tasks have all their dependencies done and all their `needs` checked. A human sets `status: approved`.
- T-000 — done (merged).
- T-001 — done (merged).
- T-002, T-006, T-075 — done (merged).
- T-010 – T-017 — approved by Saurabh Oct 31, 2026 ("continue with the remaining code"); built on the combined branch `agent/pilot-build`.
- T-031 – T-035 (connector chain) and T-039 (raw source records) — approved by Saurabh Nov 2, 2026 ("approve the connector chain"); built on `agent/pilot-build`.
- T-005, T-007, T-030, T-022 — approved Oct 28, 2026. Build order: T-005 first, then T-007 in the main worktree, with T-030 and T-022 in parallel worktrees.
- T-038, T-040, T-061, T-062 (sync skeleton, token health, comms/calendar index tables, mail/calendar/docs interfaces) — approved by Saurabh Nov 4, 2026; built on `agent/pilot-build`.
- T-050, T-055, T-036 (QuickBooks OAuth, finance schema part 1, webhook receiver) — approved by Saurabh Nov 4, 2026 ("yes"); built on `agent/pilot-build`.
- T-023, T-024 (app shell, navigation) — approved by Saurabh Nov 4, 2026 ("approved all points", D-20 batch 1); built on `agent/pilot-build`.
- T-003 (imports T-005's secret-pattern list) — approved Oct 24, 2026; in progress in its own worktree.

---

## Needs human

### Credentials and accounts
- [x] H-001 Supabase **staging** project created (Oct 24, 2026): ref `lxjhaxdkqtmkhloqaffb`, East US, public sign-ups off, CLI linked by Saurabh. Agents never apply migrations to it. Details in `docs/plan-review.md` §7 (PL-11)
- [ ] H-002 Anthropic dev API key with a spend limit (PL-13)
- [ ] H-003 Inngest account: event key + signing key for production (PL-12). Scope them to the Vercel **Production** environment only: a PR Preview build refuses Inngest keys (T-037 review M2). Use Inngest's Vercel integration or the dashboard for app sync (unsigned sync is disabled).
- [ ] H-004 Confirm the pub-k.org mail/calendar/docs provider (D-1). Sign-in needs no OAuth app (D-6). (PL-15)
- [x] H-005 Intuit developer app + sandbox company (PL-16). Done Oct 28, 2026: one Intuit app "Jarvis" (QuickBooks Online and Payments, scope `com.intuit.quickbooks.accounting` only) serves every company; each company file connects separately through the in-app OAuth flow (own realmId + tokens per lane). Sandbox keys and `INTUIT_ENVIRONMENT=sandbox`, `INTUIT_REDIRECT_URI=http://localhost:3000/api/connect/qbo/callback` are in `.env.local`; a sandbox company exists. Details in `docs/plan-review.md` §7 (Oct 28)
- [ ] H-006 Stripe restricted read-only key (test mode first, then live for staging) + webhook signing secret (PL-17)
- [ ] H-007 GoHighLevel Private Integration token (read-only scopes) + location ID (PL-18)
- [x] H-008 Done Nov 5, 2026 by Saurabh: Cloud project under the pub-k.org org; Gmail/Calendar/Drive APIs on; Google Auth Platform Internal; scopes `gmail.readonly`, `calendar.readonly`, `drive.readonly`; Web client with redirect `http://localhost:3000/api/connect/google/callback`; app Trusted in Admin → API controls; values in `.env.local` (format checked). A separate production client is added with H-023. Original item: Mail/calendar/docs API permissions for pub-k.org (Google, D-1 decided Nov 4, 2026): Google OAuth client (Internal app type) in the pub-k.org Google Cloud project with read-only Gmail, Calendar and Drive scopes; client ID and secret into `.env.local` as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (never in chat) (PL-19)
- [ ] H-009 monday.com API token (IT workspace); Notion internal integration shared to the target pages/databases (PL-20)
- [x] H-010 Vercel project linked to the repo (Oct 24, 2026), with **Root Directory = `apps/web`** and **"Include files outside the root directory"** turned on; production branch `main`; a Preview deployment per PR (no real-data secrets since Oct 28, 2026; see H-023); Production is the only real-data environment since Oct 31, 2026 (no staging); Vercel Authentication on for Preview and Production; env vars set by Saurabh in the dashboard. Production-domain DNS moved to H-021 (PL-10)
- [ ] H-021 DNS for the production domain once D-5 is decided (split out of H-010)
- [ ] H-023 Vercel **Production** as the only real-data environment (decided Oct 31, 2026: no staging; `docs/plan-review.md` §7 "Production only, no staging"). Do all of these, then check this box:
  - Production variables (the only place real-data secrets live): `APP_ENV=production`, `ENABLED_LANES=PKG`, `NEXT_PUBLIC_APP_URL` (the https production address), the Supabase `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (project `lxjhaxdkqtmkhloqaffb`), the **production** Intuit keys from 1Password, `INTUIT_ENVIRONMENT=production`, `INTUIT_REDIRECT_URI=https://<production domain>/api/connect/qbo/callback` (the fixed `*.vercel.app` production domain until H-021). `ANTHROPIC_*` and `INNGEST_*` are optional: leave a group out entirely, or set all of it (a partial group fails the build).
  - Preview (PR deployments): `APP_ENV=preview`; remove all three Supabase values (the URL, publishable key and secret key go together: all three or none, or the build fails) and any `SUPABASE_NL_*`; keep only sandbox Intuit keys (`INTUIT_ENVIRONMENT=sandbox`). A Preview that needs a database uses synthetic data only (H-025).
  - If a custom environment "Staging" was created in Vercel, delete it and its variables.
  - Keep "Automatically expose System Environment Variables" on.
  - GitHub: protect branch `main` (changes only by PR with review, no direct or force pushes; see H-012). Anything merged to `main` runs with the real-data secrets.
  - Supabase: turn on backups or point-in-time restore for `lxjhaxdkqtmkhloqaffb` before production migrations are applied.
  - Intuit app → Production → Redirect URIs: add the production callback above. Replace it with `https://portal.pub-k.org/api/connect/qbo/callback` with H-021.
- [ ] H-026 Supabase production API and auth settings (T-016/T-017, Oct 31, 2026; `docs/plan-review.md` §7 "Core and audit schemas over the API"):
  - Project Settings → API → Exposed schemas: `public`, `graphql_public`, `core`, `audit` (nothing else).
  - Authentication → JWT: access token expiry 900 seconds; switch to asymmetric JWT signing keys.
- [ ] H-027 Bot protection for sign-in (T-018 review, Oct 31, 2026): create a Cloudflare Turnstile site (free) for the production domain, put the site key in Vercel as `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the secret in Supabase → Authentication → Bot and Abuse Protection (CAPTCHA, Turnstile). An agent then adds the widget to the sign-in form (small follow-up task).
- [ ] H-028 Supabase production MFA settings (T-019, Oct 31, 2026; `docs/plan-review.md` §7 "MFA attempt guard"): Authentication → Multi-Factor → TOTP enrol and verify on; Auth Hooks → "MFA verification attempt" → Postgres function `core.mfa_verification_attempt` (check the plan includes this hook; if not, decide upgrade vs accepted risk); Emails → security notifications "MFA factor enrolled" and "MFA factor unenrolled" on.
- [ ] H-025 (optional) A database for Preview deployments with synthetic data only: a separate Supabase project seeded by T-007, or Supabase branching. Until then Previews run without a database (static pages and sign-in screens only).
- [ ] H-024 Connect the live Pub K Group QuickBooks file in production (needed for tie-out, T-172; no staging since Oct 31, 2026). Only after T-050 – T-053 and T-195 – T-197 are merged and QB-1 – QB-20 pass on the sandbox company, and H-023 is done:
  - Intuit app → Production → Webhooks: endpoint `https://<production domain>/api/webhooks/qbo` for the entities in QB scope; copy the verifier token into the Vercel Production environment as `INTUIT_WEBHOOK_VERIFIER_TOKEN`.
  - Set the PKG realm ID (QBO → Settings → Additional info → Company ID) in the production `lane_config`, then Saurabh (QBO admin) connects from Settings → Connections at the production URL.
  - Confirm the first sync, the Preferences check (class tracking on) and a report pull on Settings → Connections. Data stays in the production Supabase project.
- [ ] H-022 Guardrails **before** re-linking the Supabase CLI from `supabase/core` (T-006 review, Oct 24, 2026). Do one or both:
  - (preferred) Link from a **separate clone** that agents never use (for example `~/ops/jarvis-link`), so no agent-visible worktree ever contains `supabase/**/.temp/project-ref`. Run migrations to staging from that clone only.
  - Harden `.claude/`: add these to the `guard-bash.sh` patterns and the settings deny list: `--linked`, `--project-id`, `--project-ref`, `--db-url`, `--include-seed`, `--include-all`, `config push`, `db pull`, `db dump`, `migration repair`, `migration up`, `migration fetch`, `inspect `, `branches `, `projects `, `functions deploy`, and the staging ref `lxjhaxdkqtmkhloqaffb`. Narrow the allow list to `supabase db reset --local`, `supabase test db --local` and `supabase gen types typescript --local` (plus `supabase start`, `supabase stop`, `supabase migration new`).
  - Agents cannot do either (they may not edit `.claude/*`).
- [ ] H-011 Sentry project DSN (free tier) for staging
- [ ] H-012 GitHub repo in the Nichols-owned org, with branch protection on `main` and Actions enabled
- [ ] H-013 Google Cloud project for Pub/Sub (Gmail watch), only if D-1 = Google
- [ ] H-014 VAPID key pair for web push, generated and stored in 1Password (agent can generate a **dev** pair only)
- [x] H-015 Planning pack v2 copied into the repo (Oct 23, 2026)
- [ ] H-016 Resend account; sending domain verified (SPF/DKIM DNS records) for sign-in emails; SMTP credentials for staging and prod in 1Password and the Supabase Auth settings
- [x] H-017 Intuit **production** approval (Oct 28, 2026): app assessment submitted, production keys issued and kept in 1Password only (never in `.env.local`). Connecting the live PKG file moved to H-024
- [x] H-018 Local toolchain (Oct 23, 2026): Node 24.19.0 kept locally (CI stays on 22), pnpm 12.15.0 via corepack, Supabase CLI 2.122.0 (npm global)
- [ ] H-029 App icon for the installable app (T-025): a square master at least 1024×1024 px (PNG or SVG, no transparency for iOS), approved by Robert, saved as `docs/design/app-icon.png` (or `.svg`). The agent generates the manifest sizes from it.
- [x] D-23 One provider account per lane (T-035 security M1). Decided Nov 4, 2026 by Saurabh: a provider account (QuickBooks realm, and likewise Stripe account, GoHighLevel location) connects to **one lane only**, never shared. Enforced by a partial unique index on `core.connections` (provider + external account id, active connections) with pgTAP, in the T-050 follow-up.
- [x] D-24 Rule 5 has no exception for provider connections (Nov 4, 2026, Saurabh: "no"). Revoking our access at a provider (QuickBooks disconnect, and likewise every other connector) is an external write and runs only through the Approval Center (T-195 depends on T-113). Connecting stays the T-035 flow (owner or admin_technical at AAL2, audited). A refused connect discards the new tokens without calling the provider, and tells the owner to remove the app's access in the provider's settings if needed.
- [ ] D-25 Payroll in the P&L (T-055 security review M2, Nov 4, 2026). Spec §2 says payroll and compensation are never stored. Decide how the P&L shows payroll: (a) aggregate payroll as one line, with individual pay never stored; or (b) payroll accounts excluded entirely ("Payroll: not shown"). **Default until decided: (b), excluded**, so nothing sensitive is stored. Affects T-052 (report projection) and T-056 (payroll-provider journal entries; transactions on payroll accounts). Payroll account ids/subtypes come from `lane_config`, not code (rule 2).
- [ ] H-030 (optional; screenshots of every page are already in `docs/design/batch1/`) Save the batch-1 prototype PDF as `docs/design/Jarvis_Pilot_Prototype_Batch1_v2.pdf` and make the canvas link readable by the Claude Code account (it returned "not found" on Nov 4, 2026). D-20 is closed on Saurabh's approval; this keeps the signed-off record in the repo.
- [ ] H-031 (T-050 code review R1, Nov 4, 2026) Two edits in files agents may not change: (1) in `.github/workflows/ci.yml`, add after the `pnpm test` step: `- name: Client bundle canary scan (QB-17)` with `run: pnpm test:bundle` (exact YAML in `.agent/pr/T-050.md`, "Risks and needs a human"); (2) add one Definition-of-done line to `CLAUDE.md` for tasks that touch env, connectors or `next.config.ts`: run `pnpm test:bundle`. Until then the real-build canary scan runs only when someone remembers.
- [ ] D-26 Which Google calendars the pilot syncs (T-064, Nov 5, 2026). **Default implemented, no decision needed unless it is wrong:** the primary calendar plus calendars the user owns or can write to AND shows in Google Calendar ("selected"); holidays, subscribed and other people's read-only calendars are left out. To change it, edit `lane_config.calendar` for PKG: `calendar_ids` (explicit list of raw Google calendar ids; replaces the default), `include_read_only` (add selected read-only calendars), `forward_days` (look-ahead, default 365). Confirm with Robert whether his assistant's or shared calendars should be added (they would be read-only or delegated: set `calendar_ids`). Max 10 calendars per connection.
- [ ] H-033 (T-064, Nov 5, 2026) Live check of the Google Calendar sync with Saurabh's own account, human present, after H-032. Steps in `.agent/notes/T-064.md` ("Live check"). Nothing is connected to a real account until you do this.
- [ ] H-032 (T-063, Nov 5, 2026) Live check of the Google connect and Gmail sync with Saurabh's own mailbox, human present. Steps in `.agent/notes/T-063.md` ("Live check"). Before it: set `lane_config.mailboxes` for PKG to include the mailbox you will connect (the connect is refused otherwise), and add `GOOGLE_REDIRECT_URI=http://localhost:3000/api/connect/google/callback` to `.env.local` (optional locally; the default is the same value). Nothing is connected to a real account until you do this.
- [x] D-22 Brand wordmark (T-023 reviews, rule 2). Decided Nov 4, 2026 by Saurabh: the wordmark is the product name **"Jarvis"** with "Executive Portal" for every company; Pub K is one company of several and its name appears only in the company switcher (from the lane record). Applied in `apps/web/lib/brand.ts`.
- [x] H-020 Docker access for your user (Oct 24, 2026): user is in the `docker` group; `docker info` works in a fresh login. A process started before the group change (e.g. an old VS Code server / Claude Code session) still gets "permission denied" until it is restarted.
- [x] H-019 Agents can read `.env.example` (deny rule narrowed Oct 24, 2026; real env files still blocked). Publishable/secret rename and cleanup applied Oct 24 and mirrored in Vercel Preview (see `docs/plan-review.md` §7).

### Decisions (details and options in `docs/plan-review.md`)
- [x] D-1 pub-k.org provider (pilot-scope open decision 1). Decided Nov 4, 2026 by Saurabh: **Google Workspace for Pub K Group**. Release A builds the Google tasks (T-063 – T-065, search T-186); the Microsoft tasks (T-066 – T-068, T-187) move to Release B or later and stay behind the same interface for companies on Microsoft 365. The provider is per lane in `lane_config`, never in code (rule 2). Next human items: H-008 (Google OAuth client) and H-013 (Pub/Sub for Gmail watch).
- [x] D-2 Pilot KPI list (Oct 24, 2026): cash (book balance), AR total + AR >30 days, AP due ≤14 days, P&L MTD/YTD, MRR, monthly churn, paid subscribers (GoHighLevel, new/cancelled this week), controls (unreconciled >30 days, disconnected feeds, uncategorized transactions). Details in `docs/plan-review.md` §7
- [ ] D-3 GoHighLevel "paid subscriber" definition (tag, pipeline stage or product)
- [x] D-4 Roles: Robert owner, Saurabh admin_technical, Sophie finance_operator (pilot-scope decision 4)
- [ ] D-5 Production domain (default `portal.pub-k.org`)
- [x] D-6 Sign-in: Supabase 6-digit email code (primary; required inside the installed iPhone app) or magic link, plus Supabase TOTP MFA (AAL2) for all users; Resend for delivery
- [x] D-7 Keep Next.js 16 (`proxy.ts`); pnpm workspaces + Turborepo
- [ ] D-8 Sophie supplies the lane_config entity mapping values: the QBO class IDs (and customer IDs where classes are missing), Stripe product IDs, GoHighLevel tags/products and bank-account owners for Ask Pub K and Pub K Institute. Decided: PKG excludes APK and PKI. Partly answered Nov 4, 2026 (Saurabh): **Pub K Group, Ask Pub K and Nichols Law each have their own QuickBooks file**; each connects to its own lane only. Still open: whether Pub K Institute and Nichols Capital are classes inside the PKG file or separate files; for a separate file, Sophie grants Saurabh access or connects it herself.
- [x] D-9 MRR and churn definitions (Oct 24, 2026); full definitions in `docs/plan-review.md` §7
- [x] D-10 Release A by Nov 25 / Release B Dec 7–31 (see "Releases" above)
- [x] D-11 PKG approvals go live Nov 25 after the pilot security test (T-170); Dec 29 applies to other lanes only
- [ ] D-12 Source of "meeting notes" for meeting prep and Commitments (Google Meet/Gemini notes, Notion, other) — Release B
- [ ] D-13 Embedding provider for opt-in indexing (Anthropic has no embeddings API; e.g. Voyage AI, OpenAI, or Supabase built-in `gte-small`) — Release B
- [ ] D-14 Weekly cash report distribution: email via the Approval Center (recipients?) or in-portal only. Decided: Sophie signs off. Consequences: email is allowed under D-19 (body deleted after sending) and, if the report is sent as a file, either a link (private Storage signed link) or attachment support, which Release A approvals do not have.
- [ ] D-15 Superseded by D-20 (Oct 24, 2026); no task needs it
- [x] D-20 Design sign-off, **batch 1** (PL-26). Closed Nov 4, 2026: Saurabh approved all review points for Robert's batch-1 prototype (`Jarvis_Pilot_Prototype_Batch1_v2`; canvas https://claude.ai/artifact/FuyFYrgeWUsgCscdB3tsgA). Covers the sitemap and navigation, Home (desktop and iPhone), Finance overview and Approvals (desktop and iPhone). Record, required changes and final tokens: `docs/design/README.md`; decisions in `docs/plan-review.md` §7 (Nov 4, 2026). Unblocks T-023, T-024, T-095, T-115, T-163 (T-025 also needs H-029).
- [ ] D-21 Design sign-off, **batch 2**: Robert signs off Inbox, Calendar, Assistant, Projects and Settings (including connection health, sync/audit viewer and lane config editor), plus the Finance detail and weekly report pages. **To close:** record the screens in `docs/design/README.md` the same way as batch 1, then check this box. Blocks T-026, T-045 – T-047, T-096, T-097, T-106, T-122, T-131; Release B T-141, T-150, T-154, T-156.
- [x] D-16 Federated search is in Release B
- [x] D-17 GoHighLevel subscriber counts exclude APK and PKI via lane_config tag/product mapping
- [x] D-19 Rule 6 scope for PKG (Oct 24, 2026): (a) outbound email drafts are stored only while pending approval; the body is deleted on any terminal state, and the record keeps hash, recipients, subject and timestamps; (b) rule 6 does not cover the assistant's own conversation text: stored per lane, 180-day retention, user-deletable, with email/document content only as short cited snippets with links. Details in `docs/plan-review.md` §7
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
- status: approved
- depends: T-002, T-005
- acceptance: strict TS everywhere; shared ESLint flat config; boundary rules fail lint when (a) vendor SDKs or outbound `fetch` to external hosts are used outside `packages/connectors`, (b) `executeWrite` is imported outside `packages/modules/approvals`, (c) the Supabase service client is created outside the lane router, (d) `NEXT_PUBLIC_*` env names match secret patterns (imported from T-005's list in `packages/core/env`, not redefined), or the secret client / `SUPABASE_SECRET_KEY` is imported from a `"use client"` module. Each rule has a failing fixture test. Notes from the T-005 review: import `@nichols/core/env/secret-patterns` (plain `.js`, loads under Node 22) after adding `"@nichols/core": "workspace:*"` to the root devDependencies (the root ESLint config cannot resolve it otherwise); call `isSecretLikeName`, not `SECRET_NAME_PATTERNS` directly, so the public-by-design allowlist applies; rule (c) also covers `getSupabaseSecretKey()` from `@nichols/core/env/server` (lane router and connector token vault only). Also flag spreading, `Object.assign`/`structuredClone` or logging of the results of `requireConnectorEnv`, `getAnthropicEnv` and `getInngestEnv`: their redaction (`toJSON`/`inspect`) is defence in depth only and a copy drops it (T-005 security review N5). Connectors read credentials only via `requireConnectorEnv` (not `parseConnectorEnv`), and app code must not read the Vercel free-text variables in `FREE_TEXT_VALUE_NAMES` (they skip the build-time value scan).

### T-004 CI green on the pack's workflow
- status: proposed
- depends: T-003
- acceptance: the existing `.github/workflows/ci.yml` (from the pack; agents cannot edit workflows) passes on a PR: install, typecheck, lint, test, test:db, test:injection. Proposed additions (gitleaks secret scan, turbo cache, Lighthouse for T-025) go in the PR body as a ready-to-apply diff for a human.

### T-005 Environment config
- status: done
- depends: T-002
- needs: H-019
- acceptance: Zod env modules in `packages/core/env`: a **server** schema (`server-only`) and a **client** schema that contains only `NEXT_PUBLIC_*` names; variable names match `.env.example` (agents can read it but not edit it); owns and exports the **secret-pattern list** (T-003's lint rule imports it); a test fails if a client-schema name lacks `NEXT_PUBLIC_` or a `NEXT_PUBLIC_` name matches a secret pattern; core vars (app, Supabase) fail the build when missing in every environment except `APP_ENV=preview`; Anthropic and Inngest optional everywhere with a startup warning and "not configured" accessors, but a partial group fails in production (human decisions Oct 24 and Oct 31, 2026, `docs/plan-review.md` §7 "Env strictness (T-005)" and "Production only, no staging"); connector credentials are optional at startup and validated when the connector is used (it fails closed), so Preview builds work before every H-item is done; `APP_ENV` gains `preview` for PR deployments (Vercel Preview without real-data secrets: Supabase optional there, all three variables or none) and `staging` is accepted on Vercel only for the custom environment `staging` (`VERCEL_TARGET_ENV`); the app refuses `INTUIT_ENVIRONMENT=production` unless `APP_ENV` is `staging` or `production`, at build, at boot and when the connector is used (tests); `.gitignore` already covers `.env*`, `.agent/logs` and Supabase temp files (pack); verify only.

### T-006 Local Supabase + pgTAP harness
- status: done
- depends: T-001
- needs: H-020
- acceptance: `supabase/core` project starts locally, laid out so the pack's `migrate-prod.yml` (which runs the CLI from `supabase/core`) finds `config.toml` and the migrations; check the CLI's expected folder layout first; `pnpm test:db` runs pgTAP in `supabase/core/supabase/tests`; `supabase/nl/` exists as a documented placeholder (deferred data plane); README section for local DB.

### T-007 Synthetic seed framework
- status: done
- depends: T-006
- acceptance: deterministic seed (fixed RNG) for lanes PKG, APK, PKI, NC, NL, P with only PKG enabled; synthetic users (owner, admin_technical, finance_operator, viewer, outsider); `pnpm db:reset` reseeds; no real names, emails or companies' records beyond lane names.

## Phase A2 — Platform core (PL-28, PL-34)
T-010 – T-017 are the serial spine. After T-017: auth/shell (T-018 – T-026) is **track W1**. T-022 can start right after T-002.

### T-010 Lanes and lane policies
- status: done
- depends: T-007
- acceptance: `core.lanes` (code, name, data_plane, enabled) and `core.lane_policies` (fields from architecture §5.3, plus `store_outbound_drafts` default false, true for PKG per D-19) with RLS; pgTAP: only PKG enabled; non-members cannot read other lanes' policies; AAL1 sessions are denied.

### T-011 Lane config (per-lane source settings, no secrets)
- status: done
- depends: T-010
- acceptance: `core.lane_config` versioned rows (jsonb validated by a shared Zod schema in `packages/core/lane-config`) for QBO realm + entity mapping (file or file+class), Stripe account, GHL location + paid-subscriber rule, mailboxes, priority senders, KPI list, briefing time, approval rules, enabled modules, and the finance/approvals/assistant keys from the T-075 specs (`kpis` ids, `finance.{accounting_method,weekly_cash_time,monthly_close_trigger}`, `metrics.start_month`, `stripe.livemode`, `controls.*` thresholds, `tieout.tolerance`, `approvals.{approvals_live,approver_roles,step_up_max_age_s,expire_after_hours,payload_retention_days}`, `assistant.*` rate limits), and an **entity mapping** per lane: QBO class IDs, QBO customer IDs (fallback when a class is missing), Stripe product IDs, GoHighLevel tags/products, and bank accounts with their legally owning entity — so PKG excludes Ask Pub K and Pub K Institute; a DB check plus a unit test reject secret-looking keys/values; RLS + pgTAP; seed config for PKG (synthetic IDs).

### T-012 Users, memberships, roles, allowed_lanes()
- status: done
- depends: T-010
- acceptance: `core.users`, `core.memberships` (lane, role ∈ owner/finance_operator/viewer/admin_technical, named views for viewer); `core.allowed_lanes(uid, view)` security-definer function (replaces T-010's fail-closed placeholder with `create or replace`, same signature; `search_path = ''`, schema-qualified, stable; returns no lanes unless `uid = auth.uid()` or the caller is service_role, and only at aal2, so nobody can list another user's lanes; decide whether disabled lanes are excluded; pgTAP re-asserts anon cannot execute it and its search_path; rewrite T-010's stand-in membership tests in `020_lanes.test.sql` against real memberships, including a non-PKG member who cannot read the PKG policy — T-010 security review M2, L2); pgTAP proves cross-lane denial, the AAL2 requirement, viewer limited to named views; finance_operator can generate and sign off finance reports, admin_technical has no content views by default.

### T-013 RLS conventions and catalog test
- status: done
- depends: T-012
- acceptance: migration template + pgTAP helper for the standard lane policy; a catalog test that fails if any table in lane-scoped schemas lacks `lane_id`, RLS enabled, or a policy; documented in `supabase/core/README.md`. Control-plane tables without `lane_id` by design (`core.lanes`, keyed by `code`; `core.users`) go on an explicit, reviewed allowlist (T-012 review L4). Policies call `core.allowed_lanes(uid, '<view>')` with a name from `core.view_names()`; actions that a view does not imply (e.g. sign-off) use `core.has_lane_role()`.

### T-014 Append-only audit log (SQL)
- status: done
- depends: T-012
- acceptance: `audit.events` (lane_id, actor, action, target, metadata, at timestamptz); insert-only grants + trigger blocking update/delete/truncate; `audit.log()` function; pgTAP proves update/delete fail for every role including service.

### T-015 Audit API (TypeScript)
- status: done
- depends: T-014, T-005
- acceptance: `audit.log({laneId, actor, action, target, metadata})` in `packages/core`; metadata redactor strips token/secret/body-like fields (unit tests); failures to audit fail the calling action.

### T-016 Lane router
- status: done
- depends: T-012, T-005
- acceptance: `getLaneClient(laneId, session)` returns a client for the lane's data plane (registry: `core` only, `nl` slot defined); throws without membership or for disabled lanes; service client only for jobs via `getLaneJobClient(laneId)`; unit tests incl. disabled-lane and non-member cases. The lane router entry module must `import "server-only"`, with a test that reads the source and fails without it (T-003 lint review M2). It lives at `packages/core/src/lane-router`, the only path allowed to create Supabase clients or touch the secret key besides the token vault (`packages/connectors/src/vault`) and `packages/core/src/env`.

### T-017 Session → allowed lanes helpers
- status: done
- depends: T-016
- acceptance: `requireSession()`, `requireLane(laneId)`, `requireRole(laneId, role)` for route handlers/server actions; unit tests; used by a sample protected route.

### T-018 Sign-in (local test IdP)
- status: done
- depends: T-017
- acceptance: Supabase Auth email sign-in (D-6): 6-digit email code as the **primary** flow (works inside the installed iPhone app) plus magic link as a secondary option (a link opens in Safari, not the installed app); local Inbucket/Mailpit for tests; sign-in/out pages; session refresh in `proxy.ts` (Next 16); unauthenticated requests redirect; Playwright test.

### T-019 Enforced MFA (AAL2)
- status: done
- depends: T-018
- acceptance: Supabase TOTP enrolment + challenge for all users (D-6); recovery procedure documented (admin-assisted factor reset, audited); every data route and RLS rejects AAL1; Playwright: AAL1 user cannot load data; short session lifetime configured.

### T-020 Step-up helper
- status: done
- depends: T-019
- acceptance: `requireStepUp(maxAgeSeconds)` forces a fresh TOTP challenge; unit + Playwright tests; used later by approvals.

### T-021 Production auth email delivery (Resend)
- status: proposed
- depends: T-019
- needs: H-016
- acceptance: Resend SMTP configured for Supabase Auth in production (Supabase default mail is rate-limited), key from env only; Supabase auth rate limits reviewed for requests that all arrive from the app server (T-018 review M2: one attacker must not exhaust the shared budget); redirect URL allowlist per environment; email templates show the OTP code; sign-ups disabled (invite-only users from `core.users`).

### T-022 UI foundation (Tailwind + shadcn/ui + packages/ui)
- status: done
- depends: T-002
- acceptance: shadcn/ui set up in `packages/ui`; theme from the **provisional design tokens** in `docs/plan-review.md` §7 (CSS variables / Tailwind theme only, so the D-20 sign-off changes values, not components; tabular numbers for figures); KPI card, source chip (`as_of`, live/cached/stale), lane chip, empty/error states and a `BookBalance` label component; Storybook-free unit/render tests.

### T-023 App shell and lane switcher (provisional nav)
- status: done
- depends: T-017, T-022
- needs: D-20 (design sign-off batch 1)
- acceptance: authenticated layout, lane switcher limited to allowed lanes, module placeholder routes; current lane in URL; Playwright test that a non-member lane is not listed and its URL returns 404/403.

### T-024 Navigation per approved prototype
- status: done
- depends: T-023
- needs: D-20 (design sign-off batch 1)
- acceptance: navigation and page structure match the signed-off prototype.

### T-025 PWA install (Mac + iPhone)
- status: proposed
- depends: T-023
- needs: D-20 (design sign-off batch 1), H-029 (app icon)
- acceptance: web manifest, icons, Serwist service worker (verify Next 16 compatibility first; fall back to a hand-written SW if needed); no lane data cached by the SW; Lighthouse installability check runnable locally (`pnpm lighthouse`), with the CI step proposed for a human to add; manual install checklist for Mac Safari/Chrome and iOS.

### T-026 Settings page (user + lane config read view)
- status: proposed
- depends: T-023, T-011
- needs: D-21 (design sign-off batch 2)
- acceptance: owner can view lane config and policies (read-only in pilot; editing is T-047); others see only their own preferences.

## Phase A3 — Connector platform and jobs (PL-29)
**Track W2**, parallel with W1. T-030 can start after T-002 and T-037 after T-005; the rest follow T-013.

### T-030 Connector contract
- status: done
- depends: T-002
- acceptance: `Connector` interface per architecture §6 M2 with Zod types (`Provider`, `Connection`, `ReadOp`, `SourceResult` with `as_of` + freshness, `RawRecord`); reusable contract test kit that any connector must pass. Every connector entry module and `packages/connectors/src/vault/**` must `import "server-only"`, with a test that fails without it (T-003 lint review M2). Writes are exposed only via `@nichols/connectors/write` (an approvals-only import; boundary lint fails any other importer) and `executeWrite` requires the branded `ApprovedAction`. Inside `packages/connectors` a connector may define `executeWrite` and re-export it without renaming, but never import and call it (T-003 lint review H6).

### T-031 Connections and sync runs tables
- status: done
- depends: T-013
- acceptance: `core.connections` (lane, provider, external account id, status, token expiry, last_sync, last_error) and `core.sync_runs`; RLS: admin_technical reads health columns only; pgTAP incl. cross-lane denial. The provider check constraint lists real providers only (no `mock`).

### T-032 Vault token functions
- status: done
- depends: T-031
- acceptance: security-definer `store/read/rotate/revoke` keyed by connection_id; execute revoked from `anon` and `authenticated`; pgTAP proves authenticated users cannot call them or read `vault.*`.

### T-033 Token access + redaction in connectors
- status: done
- depends: T-032, T-030
- acceptance: `getToken(conn)` only exported inside `packages/connectors` (lint-enforced); `@nichols/connectors/internal` (`mintLaneBoundConnection`, `buildProviderSchemas`) importable only from `packages/connectors` and the connection loader (lint rule with a failing fixture; from the T-030 review); a shared redacting logger; tests prove tokens never appear in logs, API responses, RSC payloads or prompt builders (canary-token test). The token vault code lives under `packages/connectors/src/vault/**`: that is the only path outside the lane router and `packages/core/src/env` allowed to call `getSupabaseSecretKey` (T-003 lint rule).

### T-034 Connector HTTP client + MSW harness
- status: done
- depends: T-033
- acceptance: shared client with timeouts, retry/backoff on 429/5xx with `Retry-After`, per-provider rate limit, redacted logging; MSW handlers directory per provider; tests.

### T-035 OAuth flow framework
- status: done
- depends: T-034, T-017, T-015
- acceptance: generic start/callback route handlers with `state` + PKCE bound to lane + user; tokens go straight to Vault; connection row created; audited; tested end-to-end against a mock OAuth server.

### T-036 Webhook receiver framework
- status: done
- depends: T-034, T-031
- acceptance: route per provider with raw-body signature verification interface, timestamp tolerance, dedupe table `core.webhook_events` (lane_id, provider, event id) + RLS + pgTAP; unsigned/replayed requests rejected (tests); payloads enqueued as Inngest events, not processed inline.

### T-037 Inngest setup
- status: done
- depends: T-005
- acceptance: Inngest client, `/api/inngest` route, typed event schemas where `laneId` is required (type test proves events without it fail to compile); runs against the local dev server.

### T-038 conn.sync skeleton
- status: done
- depends: T-037, T-031, T-030
- acceptance: `conn.sync` with concurrency key = connection id, retries, cursor persistence, `sync_runs` start/finish/error logging; tested with a mock provider, including one connection failing without blocking another.

### T-039 Raw source records
- status: done
- depends: T-013
- acceptance: `raw.source_records` (lane_id, provider, object_type, external_id, payload jsonb, payload_hash, synced_at) + RLS + pgTAP; upsert helper; a guard rejects records from comms/docs providers that contain body fields unless lane policy `store_content_bodies` is true (test).

### T-040 conn.token_health and subscriptions_renew skeleton
- status: done
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
- acceptance: `retention.purge` reads `retention_days` from lane policy per table class (comms 90, calendar 180, conversations 180) and deletes expired rows; tests with time-shifted fixtures. Tables register themselves as they are added. Registered by T-061 (call these per lane, never delete directly; they cap the interval at the lane policy / 180 days): `comms.message_index_purge(lane, keep)` and `cal.event_index_purge(lane, keep)`.

## Phase A4 — Admin and observability (PL-34)
Joins W1 + W2 (needs T-023 and T-038).

### T-045 Connection health page
- status: proposed
- depends: T-038, T-023
- needs: D-21 (design sign-off batch 2)
- acceptance: status, last sync, token expiry, last error per connection; admin_technical sees no content or figures (Playwright check).

### T-046 Sync runs, job failures and audit viewer
- status: proposed
- depends: T-045, T-014
- needs: D-21 (design sign-off batch 2)
- acceptance: paginated sync run history and failures; audit viewer filtered by lane and actor, owner + admin only; no payload bodies shown.

### T-047 Lane policy and config editor (owner only)
- status: proposed
- depends: T-026, T-015
- needs: D-21 (design sign-off batch 2)
- acceptance: owner edits lane_config/policies with Zod validation and step-up MFA; every change versioned and audited; others are denied (RLS + UI test).

## Phase A5 — Connectors (PL-30 – PL-33)
After W2, one worktree per provider can run in parallel: **W6** QuickBooks (T-050 – T-053, T-056), **W7** Stripe (T-054, T-058), **W8** GoHighLevel (T-059, T-060), **W9** Google (T-063 – T-065), **W10** Microsoft (T-066 – T-068), **W11** monday.com (T-069, T-070). Schema tasks T-055, T-057 and T-061 (**track W3**) can start as soon as T-013 is merged.

Both mail providers are built behind one interface. Once D-1 is confirmed, the unconfirmed provider's tasks (T-063 – T-065 or T-066 – T-068) can move to Release B.

### QuickBooks connector acceptance (QB-1 – QB-20)
Decided Oct 28, 2026 (`docs/plan-review.md` §7, spec `docs/specs/finance.md` §8.1). These come from the Intuit app assessment. **All of them must pass on the sandbox company before any real company file is connected (H-024).** Each QuickBooks task below names the items it owns. QuickBooks tasks are app code (connectors/tokens): full security + code review, fix all BLOCKER and HIGH.

Scope: read-only, Accounting API only (no Payments, no Payroll); never create, update or delete QuickBooks data. Entities: Account, Invoice, Bill, Payment, BillPayment, Purchase, Deposit, JournalEntry, Customer, Vendor, Class, CompanyInfo, Preferences. Reports: ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables.

1. Connect, disconnect and reconnect work end to end against the sandbox company (tests, plus a manual checklist in the PR body).
2. The access token is refreshed proactively before expiry (about 1 h) and on a 401; every refresh stores the new rotating refresh token in the Vault and discards the old one.
3. Transient errors (5xx, network, 429 honouring `Retry-After`) are retried with capped exponential backoff; `invalid_grant` is never retried.
4. On `invalid_grant` or a revoked or expired refresh token: connection status `reconnect_required`, syncing stops, the admin is notified, and Settings → Connections shows "Reconnect QuickBooks".
5. OAuth endpoints come from Intuit's OpenID discovery document (cached), not hard-coded.
6. Handled and tested: expired access token, expired refresh token, `invalid_grant`, CSRF (per-request `state` stored server-side, verified on callback, mismatch rejected).
7. No OAuth Playground or offline tokens: tokens only come from the in-app connect flow.
8. Disconnect calls Intuit's revoke endpoint and deletes the stored tokens.
9. `intuit_tid` is logged from every API response; tokens are never logged.
10. Company Preferences are read on connect and on each sync to detect edition-dependent features (class tracking, location tracking, multicurrency). If class tracking is off or unavailable, figures are shown unsplit with a warning instead of failing; re-checked when the edition changes.
11. Webhooks: endpoint with `intuit-signature` verification (verifier token), idempotent processing, then a CDC fetch for the changed entities.
12. CDC for incremental sync with a stored last-changed timestamp per company; full report pull nightly; backup CDC poll every 4 hours.
13. No dependency on multicurrency or sales-tax features.
14. Intuit API errors handled and tested with recorded sandbox fixtures: 400 validation/syntax (Fault/Error codes), 401/403, 404, 429 (`Retry-After`), 5xx and timeouts; each mapped to retry, `reconnect_required`, or failed-with-message.
15. Error logging: per-company sync runs and API errors (timestamp, endpoint, HTTP status, Intuit error code/message, `intuit_tid`), with no tokens or personal data; sent to Sentry; admin export (CSV/JSON) for Intuit support.
16. In-app support: a "Contact support" link (`mailto:it@pub-k.org`) in Settings → Connections and on every QuickBooks error banner.
17. `INTUIT_*` secrets live only in server-side env vars (never `NEXT_PUBLIC_`, never logged, never in client bundles); the secret guard has a test for `INTUIT_*`.
18. MFA (TOTP, AAL2) before any QuickBooks data is visible.
19. No WebSockets or Supabase Realtime for QuickBooks-derived data; finance views fetch over HTTPS only.
20. QuickBooks data is visible only to members of that company's lane (RLS); cross-company only in the owner's consolidated summary (not in the pilot).

### T-050 QuickBooks OAuth (sandbox) + health
- status: done
- depends: T-035, T-011
- needs: H-005
- acceptance: Owns QB-2, QB-5, QB-6 (CSRF, expired access token), QB-7, QB-9, QB-17, QB-18. Intuit OAuth on the T-035 framework with scope `com.intuit.quickbooks.accounting` only; authorization, token and revocation endpoints read from Intuit's OpenID discovery document for `INTUIT_ENVIRONMENT` and cached; `state` stored server-side per request and bound to lane + user, mismatch or replay rejected (test); connect allowed only for owner or admin_technical of the lane at AAL2, audited; callback `realmId` must equal the lane_config QBO realm when one is set (mismatch rejected, test); tokens enter the Vault only from the callback (no import path for Playground or offline tokens); proactive refresh before expiry and refresh on 401, rotating refresh token stored atomically on every refresh with the old one discarded (test that a concurrent refresh doesn't lose the token); `intuit_tid` captured from every response into the redacted log; a test that every `INTUIT_*` name is server-only, `INTUIT_CLIENT_SECRET` and `INTUIT_WEBHOOK_VERIFIER_TOKEN` match T-005's secret patterns, and a canary value never reaches the client bundle; health check reads CompanyInfo; contract tests pass.

### T-051 QuickBooks entity sync (CDC)
- status: proposed
- depends: T-050, T-038, T-039
- acceptance: Owns QB-10 (detection), QB-12 (CDC cursor), QB-13. Initial load + CDC for Account, Customer, Vendor, Invoice, Payment, Bill, BillPayment, Purchase, Deposit, JournalEntry, Class, plus CompanyInfo and Preferences into `raw.source_records`; last-changed timestamp stored per connection and advanced only after a successful run; a cursor older than Intuit's CDC look-back (30 days) triggers a full reload instead of a gap (test); Preferences read on connect and on every sync, and class tracking, location tracking and multicurrency flags stored on the connection, with a change recorded and audited; nothing depends on multicurrency or sales-tax fields (test with both off); the QuickBooks client exposes read and query calls only (a test fails on any create, update, delete or batch call); MSW fixtures from synthetic data; no bank account numbers stored (field allowlist test).

### T-052 QuickBooks Reports API
- status: proposed
- depends: T-050, T-039, T-055
- acceptance: Owns QB-10 (reports). ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables and AgedPayables fetched with date range, accounting method and class from lane_config; the class filter is used only when the connection's class-tracking flag is on, otherwise the report is fetched unsplit and marked so; stored in `fin.report_cache` (T-055) with params and `as_of`; records whether AgedReceivables/AgedPayables honour a class filter (plan-review §3) and whether reconciliation state is exposed (spec Q-F5). Review additions (T-055 reviews, Nov 4, 2026): cache only the summary reports allowed by the `fin.report_cache` check (`pnl`, `balance_sheet`, `cash_flow`, `ar_aging_summary`, `ap_aging_summary`); project each QuickBooks report to an allowlist with strict Zod (top-level `Header`, `Columns`, `Rows` only; no memo, description or name columns; keep the report flat enough for the 16-level key scan of the DB payload guard); keep the account Id on each row (the cash view matches rows to `fin.accounts.source_id`); put the accounting-method and class markers in `params` (`method`, `class`, unsplit = no `class`); follow the payroll policy (D-25; default: payroll accounts excluded). Value checks in `fin.report_cache_guard` (T-055 final security review M4): refuse any string value containing a letter and a run of 5+ digits; a non-object payload raises instead of falling through to an echoing table check; payroll handled per D-25 with a fixture test; realistic BalanceSheet fixture within the depth limit (rows flattened in the connector); jobs set `statement_timeout`.

### T-053 QuickBooks webhooks
- status: proposed
- depends: T-051, T-036
- acceptance: Owns QB-11. `intuit-signature` verified with `INTUIT_WEBHOOK_VERIFIER_TOKEN` (fails closed when unset) over the raw body; realm resolved to its lane through `core.connections`, unknown realms dropped and logged; processing is idempotent (dedupe key from realm, entity, id, operation and last-updated time in `core.webhook_events`), then a targeted CDC fetch for the changed entities; no sync for a connection in `reconnect_required`; spoofed, replayed and duplicate payloads tested.

### T-195 QuickBooks disconnect, reconnect and error mapping
- status: proposed
- depends: T-050, T-038, T-040, T-113
- acceptance: Owns QB-1 (server side), QB-3, QB-4, QB-6 (expired refresh token, `invalid_grant`), QB-8, QB-14. Disconnect is an **approvals action** (D-24): an owner or admin_technical proposes `qbo.disconnect` for the lane's connection, it is approved with step-up, and the T-113 executor (an `executeWrite` on the approvals-only write path built in the T-050 follow-up) calls Intuit's revoke endpoint once, verifies, deletes the Vault tokens and marks the connection disconnected, audited with proposer and approver; the executor reads `payload_sha256` and `approved_by` from the locked `act.proposed_actions` row (never from the caller), passes only the branded action, and shares one JCS test vector with `computePayloadSha256` (T-050 final security review F-M1); reconnect reuses the connect flow and the existing connection row for the same realm; `invalid_grant`, revoked or expired refresh token set `reconnect_required`, stop `conn.sync` for that connection and emit the admin notification event; an error map from recorded sandbox fixtures (synthetic values) covers 400 Fault/Error codes, 401, 403, 404, 429 with `Retry-After`, 5xx and timeouts, each to retry (capped exponential backoff), `reconnect_required` or failed-with-message; `invalid_grant` is never retried (test).

### T-196 QuickBooks sync and API error log + export
- status: proposed
- depends: T-050, T-031, T-041
- acceptance: Owns QB-9 (storage), QB-15. Per-connection sync runs (`core.sync_runs`) and a lane-scoped `core.connector_api_errors` (lane_id, connection_id, at, endpoint, http_status, provider_error_code, provider_message, provider_tid) with RLS + pgTAP incl. cross-lane denial; redaction test proves no tokens, emails or names are stored; errors also sent to Sentry with the same scrubbing; owner and admin_technical can export a date range as CSV or JSON for Intuit support, audited.

### T-198 Temporary QuickBooks connect and health controls (pilot sandbox run)
- status: done
- depends: T-050
- acceptance: Approved by Saurabh Nov 4, 2026 for the Nov 12 QB-1 – QB-20 sandbox run, until T-045 (connection health page, D-21) replaces it. On the lane's Settings page, visible only to owner and admin_technical at AAL2 and labelled "Temporary: connection test": a "Connect QuickBooks" button (starts the existing T-050 connect flow) and a "Check connection" button that calls a new authenticated route running the T-050 CompanyInfo health check for that lane's connection. The route returns only status (`ok` / `reconnect_required` / `not_connected` / `error`), checked-at time and the Intuit request id, never tokens, realm id or company data; it requires `requireRole(lane, owner|admin_technical)` at AAL2; other roles and other lanes get 403/404 (tests); no external write (rule 5); behind `lane_config` or an env flag so it can be switched off. Removed or folded into T-045 when that ships.

### T-197 Settings → Connections (functional)
- status: proposed
- depends: T-195, T-019, T-022, T-199
- acceptance: Owns QB-1 (UI and manual checklist), QB-4 (UI), QB-16. Functional page (restyled after D-20, like the sign-in pages) at Settings → Connections listing the lane's connections with status, last sync and the class-tracking flag; Connect, Disconnect (confirm) and Reconnect QuickBooks for owner and admin_technical at AAL2; a `reconnect_required` banner with "Reconnect QuickBooks"; a "Contact support" link (`mailto:it@pub-k.org`) on the page and in the shared QuickBooks error banner component; no figures shown; data fetched over HTTPS only; Playwright test plus the QB-1 manual checklist against the sandbox company in the PR body.
  The page itself (route, layout, role gating) is created by T-199; this task adds the QuickBooks section to it. Google is covered by T-199 (split out Nov 5, 2026 so the Google button does not wait on T-195).

### T-199 Settings → Connections page with the Google connection
- status: done
- depends: T-019, T-022, T-063, T-064
- acceptance: Approved by Saurabh Nov 5, 2026 (split from T-197 so it does not wait on T-195). Creates the functional Settings → Connections page (restyled after D-20, like the sign-in pages; T-197 later adds the QuickBooks section, T-045 replaces it after D-21) with the lane's Google connection: the connected mailbox address (from the connection record, matched against `lane_config.mailboxes`; never tokens), status, and last mail and calendar sync times (or "not synced yet"). "Connect Google" starts the existing T-063 flow (`/api/connect/google/start`); "Reconnect Google" appears with a `reconnect_required` banner when the refresh token is revoked or expired; No Disconnect button yet: under D-24 revoking the grant is an approvals action (T-113, not built), so the page shows how to remove access at Google instead (the user's Google Account → Security → Third-party connections, or the Workspace Admin console app access controls); a "Disconnect Google" approvals action is added when T-113 ships. The page makes no external writes (rule 5). Visible and usable only by owner and admin_technical at AAL2; other roles see no buttons and the server routes/actions return 403, other lanes 404 (tests). No message subjects, senders or event titles on the page. Wording makes clear this connects mail, calendar and Drive read-only and is not how anyone signs in to the portal. Data comes from SQL via the lane router; every function takes `laneId`. Vitest for the server logic plus a Playwright test for connect start, the connected state and the reconnect banner using the MSW Google mocks; no real Google calls. H-032 is the manual live check.

### T-054 Stripe connector
- status: proposed
- depends: T-034, T-038, T-039
- needs: H-006
- acceptance: restricted key read from Vault; health; sync customers, products, prices, subscriptions, invoices, charges, refunds, payouts, balance transactions into raw; pagination + rate limits; contract tests.

### T-055 Finance normalized schema (part 1: ledger and reports)
- status: done
- depends: T-013
- acceptance: `fin.accounts`, `fin.transactions`, `fin.invoices`, `fin.payments`, `fin.bills`, `fin.report_cache` with `numeric(18,2)`, `timestamptz`, source refs, entity/class columns; RLS + pgTAP; only finance roles and owner can read.

### T-056 QuickBooks normalizer → fin.*
- status: proposed
- depends: T-051, T-055
- acceptance: idempotent transform from raw to fin.* (re-run produces no diff); tests on synthetic fixtures incl. voided/deleted records; every row tagged with its entity from the lane_config mapping (APK/PKI classes excluded from PKG); when the connection's class-tracking flag is off, rows fall back to the customer mapping or `unmapped` and the run records the fallback (QB-10). Review additions (T-055 reviews, Nov 4, 2026): mask digit runs of 5 or more in every name before insert (`fin.accounts.name`, `customer_name`, `vendor_name`; the database refuses them); load order is accounts before transactions and invoices before payments, with a rule for a payment whose invoice is unknown (store it unapplied with `invoice_id` null, link it later in place on `(connection_id, source_id, alloc_no)`); when a QuickBooks transaction loses lines, tombstone the stale posting lines (`deleted = true`); set `multi_class` and a null `class_id` when an invoice's or bill's lines carry more than one class; set `currency_code` and flag non-USD rows (views exclude them); never hard-delete (service_role has no DELETE on ledger tables); payroll accounts per D-25; set `raw_record_id` only from the matching object type. Before T-056 writes any row (T-055 final security review M3): the name digit-run checks move into a BEFORE trigger that raises a constant message with no DETAIL (pgTAP asserts the error detail is empty), so a refused account number never reaches Postgres or job logs; the masker normalises digits (NFKC) and strips separators before matching; reallocations are logged (ids only), and links to voided or deleted invoices are refused or flagged.

### T-057 Finance normalized schema (part 2: subscriptions)
- status: proposed
- depends: T-055
- acceptance: Spec: `docs/specs/finance.md` §5. `fin.stripe_subscriptions`, `fin.stripe_subscription_items`, `fin.stripe_discounts`, `fin.stripe_invoices`, `fin.stripe_charges`, `fin.stripe_refunds`, `fin.stripe_payouts` (revenue source; `livemode`, `entity_code`, `numeric(18,2)`), and `fin.subscriber_status` + append-only `fin.subscriber_events` (GHL, **no revenue/amount columns**: enforced by a pgTAP column check); the MRR history table is T-190; RLS + pgTAP.

### T-058 Stripe webhooks + normalizer
- status: proposed
- depends: T-054, T-036, T-057
- acceptance: Stripe signature verified; events upsert raw + normalized rows; registers its `fin.sync` schedule on the T-090 pattern; out-of-order events handled by `created`/version; rows tagged with entity by Stripe product mapping; spoof test.

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
- acceptance: Spec: `docs/specs/finance.md` §4.3, §5. Rule from lane_config (tag / pipeline stage / product, combinable) evaluated into `fin.subscriber_status` and append-only `fin.subscriber_events` (new, cancelled, trial→paid, failed payment; carries `rule_version`) so point-in-time membership and customer churn can be rebuilt; unit tests per rule type; APK/PKI tags/products excluded via the lane_config mapping (D-17); no amounts copied from GHL; documents the backfill depth available from GHL (spec Q-F7); registers its `fin.sync` schedule on the T-090 pattern.

### T-061 Comms and calendar index tables
- status: done
- depends: T-013
- acceptance: `comms.message_index` (metadata only, per architecture §6 M5, priority fields, optional approved summary) and `cal.event_index`; pgTAP column check proves no body column exists; RLS + pgTAP; registered with retention purge.

### T-062 Mail/calendar/docs provider interfaces + mocks
- status: done
- depends: T-030
- acceptance: `MailProvider`, `CalendarProvider`, `DocumentProvider` (metadata sync, live body fetch, live search, watch/renew, `prepareWrite` on the provider; execution only through a `ConnectorWriter` from `@nichols/connectors/writer`, per the T-030 split); mock implementation; contract tests both real providers must pass.
- note: `DocumentProvider` is live search and live read only (no sync, no watch), per T-186/T-187. Interfaces live at `@nichols/connectors/comms`; the reusable suite is `describeCommsContract` in `@nichols/connectors/testing`.

### T-063 Google: OAuth + Gmail metadata sync + live body
- status: done
- depends: T-062, T-061, T-035
- needs: H-008 (Google), D-1
- acceptance: Gmail history-API delta into `comms.message_index` (metadata only); `readBody` fetches live and never persists (test spies on DB writes); mailboxes from lane_config.

### T-064 Google: Calendar sync
- status: done
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
- acceptance: Spec: `docs/specs/finance.md` §7. Lane-scoped server functions in `packages/modules/finance/domain` returning `FinanceResult<T>` (figures with display strings, `sources`, `asOf`, `freshness`, `status` incl. `pending_definition`, `notes`); the only path used by UI and AI tools; requireLane/requireRole + Zod on every function, AAL2 required (QB-18); any `use cache` includes laneId and role; when the QuickBooks connection has class tracking off, figures are returned unsplit with a warning note instead of failing (QB-10); unit tests.

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
- depends: T-051, T-052
- acceptance: scheduled Inngest functions per enabled lane from lane_config; idempotent; sync_runs logged; QuickBooks first (needed for QB-12 before H-024), Stripe and GoHighLevel schedules are added by T-058 and T-060 on the same pattern; QuickBooks per connection: backup CDC poll every 4 hours and a nightly full report pull (plus the pull before `fin.weekly_cash`), skipped for connections in `reconnect_required` (QB-12).

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

### T-094 Tie-out view (QuickBooks first)
- status: proposed
- depends: T-082, T-083, T-084, T-085, T-014, T-019, T-022
- acceptance: Spec: `docs/specs/finance.md` §5 Part 3, §6. `fin.tieout_reference` (insert-only manual entries, audited) and `fin.v_tieout(p_lane_id, p_week)`: portal figure vs QBO report figure vs manually entered reference figure (from Sophie's report), differences and pass/fail per KPI per week with tolerance from `lane_config.tieout.tolerance` (default 0.00, i.e. to the cent). QuickBooks first (decided Oct 28, 2026): cash book balance, AR total, AR >30, AP due ≤14 days and P&L MTD/YTD are tied out from the live views (T-082 – T-085) and the report cache, not from snapshots; Stripe and GoHighLevel KPIs join once T-089 snapshots exist (T-097). A functional page at `/finance/tie-out` (restyled after D-20, like T-197) shows the comparison and lets finance_operator and owner enter reference figures at AAL2.

### T-095 Finance dashboard UI
- status: proposed
- depends: T-081, T-088, T-024
- needs: D-2, D-20 (design sign-off batch 1)
- acceptance: Spec: `docs/specs/finance.md` §10. KPI cards from the lane_config KPI list (ids in spec §4.1) with source chips, freshness and as-of; "Book balance" label visible; data fetched over HTTPS only, no Realtime (QB-19); the shared QuickBooks error banner (T-197, with "Contact support") and the class-tracking-off warning shown when they apply; customer churn card shows "Pending definition (D-3)" while status is `pending_definition`; MTD figures labelled; Playwright test incl. AAL1 redirect and viewer denial.

### T-096 Finance detail pages
- status: proposed
- depends: T-095
- needs: D-21 (design sign-off batch 2)
- acceptance: AR/AP aging tables (TanStack Table), P&L, MRR/churn and subscriber charts (Recharts), controls panel; all values from the query layer.

### T-097 Weekly report and tie-out pages
- status: proposed
- depends: T-091, T-094, T-096
- needs: D-21 (design sign-off batch 2)
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
- acceptance: Spec: `docs/specs/assistant.md` §4. `ai.conversations`, `ai.messages` (with `citations`, `grounding`) and `ai.tool_calls` (validated args, status, denial reason, result only for `resultStore = full`), all lane-scoped, RLS = AAL2 + lane membership + `user_id = auth.uid()` (own conversations only; admin_technical none) + pgTAP incl. cross-lane and cross-user denial; user can hard-delete (cascade); registered with retention (180 days); no email/doc bodies or tokens stored; per D-19 assistant text is stored in full, but email/document content may appear only as short cited snippets with links (server-side cap on quoted length, test with a canary body), never full bodies.

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
- needs: D-21 (design sign-off batch 2)
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
- acceptance: Spec: `docs/specs/approvals.md` §4. `act.proposed_actions` (full column set in the spec incl. `payload_sha256` over canonical JSON of lane+type+connection+target+payload, `expected_before`, `consequences`, `approved_hash`, `deferred_until`, `expires_at`), insert-only `act.status_history` and `act.execution_claims` (primary key action_id: exactly one claim, no attempt column), allowed transitions enforced in SQL (proposed→approved/rejected/expired/invalidated; approved→executing/expired/invalidated; executing→verified/failed); payload/hash/target immutable after `proposed`; `act.is_allowed_type()` with excluded classes rejected at DB level; `authenticated` has no direct DML; `act.propose` is service-role only (the app computes the JCS hash) and users call security-definer functions (`approve` with in-SQL step-up check of the JWT `amr` or an equivalent single-use token, `reject`, `defer`, `supersede`; every security-definer function sets an explicit `search_path`) and service-only `claim_execution`/`mark_*`/`invalidate_approved`/`purge_content` (purge clears payload body, consequences, rationale, source_refs and expected_before, keeping hash, recipients, subject and timestamps; per D-19 it runs in the same transaction as every transition into a terminal state, and pgTAP proves no terminal action keeps a body); `email.*` refused unless `lane_policies.store_outbound_drafts`; index row `core.action_index`; pgTAP for every illegal transition, tampering, AAL1/stale step-up, viewer/finance_operator/admin_technical denial and cross-lane denial. Write exposure: connector writes are reachable only via `@nichols/connectors/write` (approvals-only import) and `executeWrite` requires the branded `ApprovedAction` (T-003 lint review H6).

### T-111 Proposal service
- status: proposed
- depends: T-110, T-030
- needs: D-19
- acceptance: Spec: `docs/specs/approvals.md` §5. `proposeAction` from `prepareWrite` with canonical JSON (RFC 8785) + SHA-256, rationale and source refs; editing creates a new proposal (`supersedes_id`) and invalidates the old; types allowlisted by lane policy `write_actions_allowed`; excluded classes rejected at service and DB level (tests); per-lane and per-turn pending limits; consequences rendered server-side; `userInitiated` (true only for the direct Draft-reply click or an explicit prepare intent, set by the route) required for assistant-created proposals, with `derived_from_retrieved` set and shown when recipients/targets come from retrieved content (test); only composed text is stored for email, never quoted thread text (canary test), and only until the action is terminal (D-19); `email.*` refused unless `store_outbound_drafts`; audit + `approval.needed` event.

### T-193 ApprovedAction brand and mint boundary
- status: proposed
- depends: T-111, T-003
- acceptance: Spec: `docs/specs/approvals.md` §5. `ApprovedAction` branded type constructible only by `mintApprovedAction` inside `packages/modules/approvals`; connector `executeWrite` accepts only that type and re-checks `sha256(payload) === payloadSha256`; boundary lint rule fails any import of `executeWrite` or the mint function outside the approvals package (lint fixture test); `prepareWrite` never executes (contract-kit test). Writes are exposed only via `@nichols/connectors/write` (approvals-only import) and `executeWrite` requires the branded `ApprovedAction`; renaming re-exports of `executeWrite` or `mintApprovedAction` is also a lint failure.

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
- needs: D-20 (design sign-off batch 1)
- acceptance: Spec: `docs/specs/approvals.md` §10. `/approvals` (Pending, Deferred, History) and `/approvals/[id]` showing the exact content as executed, sending account, recipients with new-recipient/external/bcc flags, target, server-built consequences, the assistant's rationale labelled unverified, short hash and status timeline; approve (step-up modal showing the hash), edit (new proposal + diff), reject, defer; "Not live" banner; works on iPhone width; push deep link; Playwright incl. step-up.

### T-116 Executor: email send
- status: proposed
- depends: T-113, T-063
- needs: D-19
- acceptance: Spec: `docs/specs/approvals.md` §8. `executeWrite` for `email.send` and `email.save_draft` on the confirmed provider (plain text, no attachments, no deletes); `X-Portal-Action-Id` idempotency marker and lookup before any retry; read-back via sent item id; the body is deleted when the action becomes `verified` or `failed` (D-19); MSW tests incl. crash-after-send.

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
- needs: D-21 (design sign-off batch 2)
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
- needs: D-21 (design sign-off batch 2)
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
- acceptance: events (approval needed, briefing ready, finance red flag, connection failing, commitment due); payload builder allows only template text + lane code (test rejects names, amounts, subjects); in-app via Supabase Realtime, which never carries QuickBooks-derived data (QB-19).

### T-162 briefing.daily
- status: proposed
- depends: T-104, T-123, T-133, T-112
- acceptance: per-lane fan-out (calendar today, priority mail, finance alerts, pending approvals; commitments added in T-183) within each lane's policy, then a composer; facts separated from recommendations; `brief.briefings` + RLS + pgTAP + retention; schedule from lane_config (default 06:30 America/New_York).

### T-163 Home page
- status: proposed
- depends: T-162, T-095, T-115
- needs: D-20 (design sign-off batch 1)
- acceptance: briefing, attention queue, today's meetings, approvals waiting, lane tiles; Playwright.

## Phase A13 — Pilot hardening and go-live (PL-45 – PL-50)
Serial. T-171 can start any time after T-004. T-170 is the gate for PKG approvals going live.

### T-170 Security test suite
- status: proposed
- depends: T-119, T-105, T-124, T-118, T-163
- acceptance: catalog-driven cross-lane RLS tests over every table; auth/AAL and step-up; token canaries; webhook spoofing per provider; injection suite; approval tampering (hash change, replay, double execute) for email + monday.com actions; report in `docs/security/pilot-test.md`; no open blocker/high. **Must pass before PKG approvals go live on Nov 25 (D-11).**

### T-171 Staging environment runbook
- status: proposed
- note (Oct 31, 2026): there is no staging environment ("Production only, no staging", `docs/plan-review.md` §7). Re-scope to a production deploy and migration runbook before approval.
- depends: T-004
- needs: H-001, H-010
- acceptance: documented, human-run steps for staging migrations and deploys (agents never run them); a proposed `migrate-staging.yml` mirroring `migrate-prod.yml`, delivered in the PR body for a human to add; env var checklist per Vercel environment (decided Oct 28, 2026): the custom environment **Staging** (branch `staging`, `staging.portal.pub-k.org`, `APP_ENV=staging`) is the only place real-data secrets live (staging Supabase secret key, production Intuit keys, production redirect URI); **Preview** (PR deployments, `APP_ENV=preview`) gets sandbox Intuit keys only and no staging Supabase values; **Production** at go-live; seed policy: real PKG data only in the staging Supabase project and only through the Staging environment, Previews use synthetic data (H-025) or no database; how code reaches `staging` (fast-forward from `main` by a human). The proposed `migrate-staging.yml` must not use `--include-seed` (the T-007 seed is local-only synthetic data).

### T-172 Tie-out procedure
- status: proposed
- depends: T-094
- needs: H-024, D-8
- acceptance: `docs/runbooks/tie-out.md`: weekly steps for Sophie/Saurabh, tolerance (to the cent unless agreed), sign-off record; supports success criterion 1. Week 1 (business week ending Fri Nov 13) is done by hand: the QBO report cache figures from the staging connection against Sophie's weekly cash report, recorded in the runbook's sign-off table; from week 2 (ending Fri Nov 20) the T-094 view; Stripe/GoHighLevel KPIs join when T-097 lands.

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
- needs: D-21 (design sign-off batch 2)
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
- needs: D-21 (design sign-off batch 2)
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
- needs: D-21 (design sign-off batch 2)
- acceptance: list due/overdue; accept/dismiss; `get_commitments` tool; feeds briefing.

### T-155 Memory items + explicit-only write path
- status: proposed
- depends: T-013, T-101
- acceptance: `mem.items` (lane, fact, source, created_at, expires_at) + RLS + pgTAP; written only from explicit user statements or user-confirmed suggestions (tests that retrieved content can't create memory); never read across lanes.

### T-156 Memory settings UI + assistant integration
- status: proposed
- depends: T-155, T-106
- needs: D-21 (design sign-off batch 2)
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
