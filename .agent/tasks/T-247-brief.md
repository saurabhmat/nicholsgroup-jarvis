# T-247 brief: per-user mail privacy and several Google accounts per user

Approved by Saurabh on Nov 14, 2026. Read the full plan with the decisions first: `.agent/plans/T-247-privacy-multi-mailbox-plan.md` (the "Decisions" section overrides anything older in the plan). Then CLAUDE.md, and `docs/plan-review.md` entries for T-195..T-246 where they touch mail, briefing or approvals.

Make scope decisions yourself within the plan, and log them in `.agent/notes/T-247.md`. Stop and write to `docs/backlog.md` "Needs human" only for a real blocker.

## Scope (what to build)
1. **Mailbox ownership.**
   - Add `core.connections.owner_user_id uuid references core.users`.
     - Required for Google mail/calendar connections, both native and Composio rows.
     - Null for QuickBooks and other non-mail providers. Use a check constraint by provider, written so the existing rows pass.
   - Backfill from `created_by` for Google and Composio rows.
   - Make it immutable: extend the `connections_identity_immutable` trigger.
   - Set it at connect time to the signed-in user (`ensureConnection` / `ensurePending` already get the user id; check `packages/connectors/src/vault/connections.ts`, `oauth/flow.ts`, `composio/store.ts`).
   - RLS: a member sees their own mailbox connection rows. Owner and admin_technical keep seeing connection HEALTH (status, last sync, error, provider, account address) for the lane's connections, as today. That needs no content: keep the existing `connections` view behaviour, so Settings health still works.
2. **New view `own_mail`.**
   - Grant it to owner, admin_technical and viewer (`core.allowed_lanes` view mapping, migration `20261031043014_users_memberships_allowed_lanes.sql`, plus any later changes).
   - It means "my own mailboxes only".
   - Mail and calendar content is readable only through mailbox ownership. A lane role never grants another user's mail; the old `comms` / `calendar` / `briefing` views no longer grant other people's content.
   - Keep non-mail uses of those views working. Check every use of `allowed_lanes(..., 'comms' | 'calendar' | 'briefing')` and decide case by case; log the decisions.
3. **Mail and calendar privacy in RLS and every reader.**
   - Tables: `comms.message_index` and `cal.event_index` RLS becomes AAL2 + the lane check + `connection_id` in the caller's own connections (`owner_user_id = auth.uid()`).
   - Readers: every reader function and view must apply the same rule. Definer functions need the filter explicitly. The list:
     - `core.home_mail_attention`
     - `core.briefing_threads`, `core.briefing_events`
     - `core.home_meetings`
     - `core.briefing_coverage` (definer)
     - `core.inbox_messages`, `core.inbox_message_ref`
     - `core.act_reply_state`
     - anything else you find; grep the migrations for `comms.message_index` and `cal.event_index`.
   - Use the LATEST body of each function: find the newest migration that defines it.
   - The assistant's mail and calendar tools (`packages/ai/src/tools/catalog.ts` and its readers) must return only the caller's own mail.
   - Admins never see content.
4. **Briefings per person.**
   - The scheduled job runs per user who owns at least one active mailbox in the lane, not per lane owner (`packages/modules/briefing/src/jobs/index.ts`, `apps/web/lib/briefing-schedule.ts`, `briefing-run.ts`).
   - Every job-client (service role) read filters by `owner_user_id` explicitly.
   - The `brief.briefings` guard trigger currently requires the owner role (`20261111120000_brief_briefings.sql`). Change it to "owns a mailbox in the lane or holds own_mail".
   - Test: user A's briefing never contains user B's threads or events.
5. **Drafts and email approvals private to the mailbox owner.**
   - `act.proposed_actions` email rows (all email action types) are readable only by the owner of the row's connection (`owner_user_id = auth.uid()`). `act.status_history` and `act.execution_claims` follow the same rule for email rows.
   - `act.approve` (and any reject or cancel path) for email types requires `connection.owner_user_id = auth.uid()` on top of the existing checks.
   - Non-email types, such as `qbo.disconnect`, keep today's lane rules.
   - Email proposals created by jobs (briefing drafts) set `proposer_user_id` to the mailbox owner.
   - Tests:
     - Robert, a lane owner, cannot see or approve Saurabh's draft.
     - Saurabh, admin_technical, can see and approve his own.
6. **Connect flow (native Google only in this task).**
   - Any lane member with `own_mail` may connect their OWN Google account; today only owner and admin_technical can.
     - Update `CONNECT_ROLES` handling for the google provider only, both the TS side and `core.oauth_state_create` / `consume`.
     - QuickBooks connect stays owner/admin_technical.
   - Add a domain allow-list in lane_config: `mail.allowed_domains` (array of lower-case domains, default `[]` = fail closed).
     - Production PKG gets `["pub-k.org", "pubkgroup.com"]` in a manual part.
     - Check it at connect (identify) and on every Google call (`google/guard.ts`), in addition to D-23.
     - Keep the exact `mailboxes` list as an optional extra allow-list: if non-empty, the address must also be in it. Decide and log how the two combine; fail closed.
   - Add `mail.self_connect_domains` to the schema (default `[]`), for the later gmail.com route. Nothing enables it now.
   - Do NOT change Composio (per-user and multi-account is a later task, after H-041). Make sure the Composio path cannot be used to break the new rules: it must set the owner, and its rows follow the same RLS. If it can't comply cheaply, gate Composio mail connect off for lanes with `mail.allowed_domains` set, and log that.
   - Settings UI: a "Your Google accounts" section lists and connects the signed-in user's own accounts. Admin health stays as today.
   - Several accounts per user: native already allows it. Verify, and test that two accounts of one user both show for that user only.
7. **lane_config schema** (`packages/core/src/lane-config/index.ts`): the new `mail` keys, with tests.
8. **Decision log.** Add D-33 amended (Nov 14, 2026, Saurabh) to `docs/backlog.md` decisions, near D-33:
   - Robert (owner) may connect his own personal gmail.com account, visible only to him and connected by himself only.
   - Saurabh's personal and SimpliAutomated mail stays excluded.
   - Not possible until the Composio route exists (after H-041).
   - Also add the four T-247 decisions from the plan.
9. **Sign-in email check (no code change).**
   - A gitignored manual file `supabase/core/bootstrap/manual-migrations/users-signin-email-check.sql`: READ-ONLY queries for both users. Find the auth users for rnichols@pub-k.org, rnichols@pubkgroup.com, saurabh@pub-k.org and saurabh@pubkgroup.com (case-insensitive). Show `id`, `email`, `email_confirmed_at`, `last_sign_in_at`, the MFA factor count, the membership roles and the display name.
   - The step-by-step in-place change procedure as comments, from the plan:
     - dashboard or admin API `updateUserById` with `email_confirm`;
     - never SQL on `auth.users`;
     - sign out sessions;
     - test with the person;
     - stop if both addresses exist.
   - The steps also go in the PR body.

## Production SQL
- A gitignored manual pair `part-25-T-247.sql` + `check-part-25.sql` in `supabase/core/bootstrap/manual-migrations/`, in the style of parts 22–24:
  - guarded, schema-qualified, one transaction;
  - md5s of every replaced function body in the check;
  - the migration recorded in `supabase_migrations.schema_migrations`.
- Include the backfill and the PKG lane_config version with `mail.allowed_domains`, through an insert-only new version (copy the current config, change only `mail`). Insert-only `lane_config`, as in the golive files.
- Say in the PR whether part 25 is safe before the deploy. It probably is NOT, because the RLS narrows what the running app reads. Then state the exact order: deploy and part 25 together, which first, and what users see in between.
- Run both locally.

## Rules
- Branch `agent/T-247` in `~/dev/pubk-projects/jarvis/pilot-build`, created from origin/main. Do not switch branches, push, rebase or reset. `git add` only your files, never `-A`. Never commit `.agent/notes/checkpoint-2026-11-02-b.md` or `.agent/tasks/T-244-brief.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit per part.
- **LOCAL DATABASE: DO NOT RESET.**
  - `node scripts/test-db.mjs` resets on EVERY call without `--no-reset`, even `--help`. Always pass `--no-reset`.
  - Never run `pnpm test:db`, `supabase db reset`, `pnpm test:e2e` or Playwright.
  - Migrations: `supabase migration up --local --workdir supabase/core`. The Supabase CLI needs `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)"`, for test-db.mjs too.
- Never seed data outside a rolled-back transaction. `core.lane_config` is insert-only.
- **pg-safeupdate:** every UPDATE or DELETE in a function needs a top-level WHERE (pgTAP 315). Test as the API runs: `psql postgresql://authenticator:postgres@127.0.0.1:54322/postgres`, `set role service_role` or authenticated with claims, in a rolled-back transaction.
- **"use client" / "use server" files:** export only components / async functions; constants go in plain modules (`apps/web/tests/directive-exports.test.ts` enforces this).
- Server components must not read the clock before dynamic data (T-243).
- Synthetic data only. No external calls in tests. Never touch production. No secrets in logs or prompts.
- **Every new or changed RLS policy gets pgTAP with cross-user AND cross-lane denial.** Key case: two users in the SAME lane (an owner and an admin_technical), each with their own mailbox. Neither can read the other's mail, events, briefing, drafts or approvals, through tables, reader functions and the assistant tools.

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass; pgTAP `--no-reset` passes (all files); `pnpm --filter @nichols/web build` succeeds with no prerender error.
- `.agent/pr/T-247.md`: changes, tests, risks, production steps (part 25 order and what users see), the sign-in email procedure, and Needs human.
- `.agent/notes/T-247.md` with the decisions.
- Do not set the backlog to done. Do not run the security or code reviews: the lead runs them.
- Final message:
  - a summary;
  - the commit list;
  - the test results;
  - the decisions;
  - anything unfinished, and anything you could not do safely.
