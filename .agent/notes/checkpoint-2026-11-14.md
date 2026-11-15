# Checkpoint for Nov 14, 2026

**Where things stand:**
- Checkout: `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-247`**, 10 commits ahead of origin/main, not pushed.
- origin/main = `ae38845`, with T-243, T-244, T-245 and T-246 merged.

## Done today
| Task | Status | Production |
|---|---|---|
| T-244 Finance page and Net income from live QuickBooks (week/month/year P&L windows) | merged | part 23 + check, then the `fin/qbo-reports.requested` event |
| T-245 hotfix: Finance crash (`PERIODS` came from a "use client" module), directive-export check, per-card error boundaries, finance error.tsx | merged | deploy only |
| T-246 Home and Finance read only the current QuickBooks connection, plus the go-live checklist | merged | part 24 + check (safe before the deploy, needed before go-live) |
| **T-247** per-user mail privacy and mailbox ownership | **ready to push** | part 25, run together with the deploy (see below) |

## T-247 (branch agent/T-247, PR body `.agent/pr/T-247.md`)
- **Plan and decisions:** `.agent/plans/T-247-privacy-multi-mailbox-plan.md`.
  1. Every member sees only their own mail, admin_technical included.
  2. Allowed domains are pub-k.org and pubkgroup.com, through native Google. pubkgroup.com is in the pub-k.org Workspace. gmail.com comes later through Composio, after H-041.
  3. D-33 is amended as **D-47**: Robert may connect his own gmail.com later, visible only to him. Saurabh's personal and SimpliAutomated mail stays out.
  4. Saurabh's pub-k.org mailbox and its data become his only.
  - Recorded as D-43 to D-47 in the backlog.
- **What it does:**
  - `core.connections.owner_user_id` is the person who connected the mailbox, and it never changes. A new view, `own_mail`, goes to owner, admin_technical and viewer.
  - Mail and calendar access (RLS and every reader function), the assistant tools, briefings (per person, from the job's owner filter) and email drafts and approvals are all limited to the mailbox owner.
  - `lane_config.mail.allowed_domains` is checked at connect, on every Google call and in the email writer; an empty list refuses everything. `mail.self_connect_domains` is unused for now.
  - Composio mail connect is off in lanes with domains set.
  - Daily caps are per owner.
  - Settings has "Your Google accounts".
- **Reviews:** a full security and code review, plus a security recheck. All BLOCKER and HIGH findings are fixed, and every MEDIUM and the cheap LOW items too. The rest is logged in the T-247 section of `docs/plan-review.md`.
- **Tests:**
  - Typecheck, lint and the full test run passed after the first round of review fixes. The builder reports them passing again after the recheck fixes.
  - pgTAP: 58 files, 3304 tests (319 has 94 assertions).
  - The web build succeeds.
  - **The E2E/Playwright tests have not been run.** The Settings wording changed, so `settings-google.spec.ts` probably needs updating.
- **Production order:** part 25 and the new app must go live together.
  1. Merge, and let Vercel build without promoting.
  2. Run step 1 of `pkg-mail-mailboxes-helper.sql`, then `part-25-T-247.sql`, then `check-part-25.sql`.
     - Part 25 aborts when an owner's email differs from the mailbox address. Override by connection id with `v_confirmed_owner_mismatches`.
     - Read the owner listing at the end of the check.
     - If the old exact `mailboxes` list would block Robert, run the helper's insert-only block.
  3. Promote the app.
  - Between steps 2 and 3, nobody sees mail. Old briefings are deleted (derived data), and pending drafts made by jobs or by someone other than the owner are cancelled. No mail, calendar or connection data is deleted.
  - Then Robert connects his own accounts in Settings.
  - Before all this, run `users-signin-email-check.sql` (read-only) for both users. The in-place email change steps are in the PR.
- **Open question for Saurabh:** should the assistant's mail tools be turned on for admin_technical, for his own mail only? The assistant is still off for that role.
- **Not exercised:** the owner-mismatch override path in part 25. Part 25 was tested only on a scratch database.

## QuickBooks go-live (H-061), not started
- Checklist: `.agent/notes/golive-pkg-qbo-checklist.md` (committed with T-246).
- Gitignored SQL in `supabase/core/bootstrap/manual-migrations/`:
  - `golive-0`: sandbox disconnect fallback;
  - `golive-1`: realm, needs the real id plus the other two company ids;
  - `golive-2`: mapping, with PART A preview, a company-name check and confirmed Cash account ids;
  - `golive-timeout-a`/`-b`/`-c`: check, apply, undo. b reverses the T-052 decision; use it only with a go-ahead.
- Redirect URI: `https://nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app/api/connect/qbo/callback`. `main` must be the Vercel Production branch.
- Saurabh deletes the old sandbox scripts himself. GCC and Microsoft 365 are out of scope.
- `pkg-report-cache-list.sql` is read-only and lists PKG's cached reports.

## Production steps still pending (human)
1. If not done yet: part 23 + check, part 24 + check, the reports event for PKG.
2. T-247: the order above.
3. H-061 go-live, following the checklist.
4. The earlier open items: H-057 to H-060, and the authenticator 8 s timeout decision.

## Lessons this session
- **Client references:** a constant exported from a `"use client"` module reaches a server component as a client reference, not a value. Vitest ignores the directives, so only the static check `apps/web/tests/directive-exports.test.ts` catches it.
- **Suspense fallbacks:** React streams large Suspense boundaries after the shell, so a Suspense fallback can flash on a healthy page. Use a neutral "Loading…", never an error text.
- **pgTAP outside the runner:** pgTAP is not installed outside `scripts/test-db.mjs`. For an ad-hoc run, `create extension pgtap` inside a rolled-back transaction. test-db.mjs needs the Supabase CLI on PATH (the Node v24 bin).
- **"Current" connections:** the current QuickBooks connection means `status <> 'disconnected'`; `reconnect_required` still counts as current. Every finance reader must filter on it.
- **Account ids per company:** QuickBooks account ids are per company file. A sandbox account id can name a different real account, so bank mappings must be rebuilt at a company switch.
- **Derived data at a privacy cut-over:** stored derived data (briefings, drafts) built under the old, wider rules must be removed at the cut-over, not only the readers narrowed.

## Untracked, never commit
`.agent/notes/checkpoint-2026-11-02-b.md`, `.agent/tasks/T-244-brief.md`
