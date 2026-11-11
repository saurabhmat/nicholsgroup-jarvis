# Checkpoint — Nov 11, 2026

Checkout `~/dev/pubk-projects/jarvis/pilot-build`, branch `agent/T-232` at the commit that adds this note. Nothing is pushed: agents cannot push.

`origin/main` ends at `ec15eaa` (T-230). Everything below is local.

## Done today, commits per task
| Task | Branch | Commits |
|---|---|---|
| T-231a Coverage, today's calendar, 7-day look-ahead | agent/T-231 | 55d43ab, 8953013 (review) |
| T-231b Needs your attention + Money card | agent/T-231 | 0ef19d5, 6445b97 (review) |
| T-233 QuickBooks on Home + Settings row | agent/T-231 (merged 6be03ae) | 3731754 |
| T-231c AI daily briefing job + Run now | agent/T-231 | e7d1ce6 |
| D-32 schedule default, next-task `note:` and split ids, part-9 SQL, statuses | agent/T-231 | ce907f8, 16f2077 |
| T-232 Approval Center for email | agent/T-232 | ec96eef, afe5131, 48765a1, 5978189, c00b429, e19be49, ee9de5b, 2d1a0c2 (review) |
| T-231d Reply drafts on Home + proposals | agent/T-232 | 6c80a34, a0bdb18 (review) |

Notes on the table:
- `agent/T-232` was built from `105481b` by an earlier builder, in a worktree under `jarvis/main/.claude/worktrees/agent-a9c232e85980ca39f`. That worktree's HEAD is now detached, so the branch can be checked out here.
- `agent/T-231` is merged into `agent/T-232` (80e464a).
- The backlog marks T-231a, T-231b, T-231c, T-231d, T-232 and T-233 `done`.

Reviews (full security + code review for each app-code task):
- No BLOCKER anywhere. Every HIGH is fixed.
- The MEDIUM and LOW items not fixed are logged in `docs/plan-review.md` under "T-231c review follow-ups", "T-232 review follow-ups" and "T-231d review follow-ups".
- PR notes: `.agent/pr/T-231c.md`, `T-232.md`, `T-231d.md`, `T-233.md`. T-231a and T-231b have none (see the PR text below).

## Test results (agent/T-232, final)
- `pnpm typecheck`, `pnpm lint`: pass (18/18).
- `pnpm test`: pass (18 packages, 216 root script tests).
- `pnpm db:types:check`: ok.
- `pnpm test:db` (local DB reset, approved): 38 files, 2468 tests pass. `290_approvals_email` has 106 assertions.
- `pnpm e2e:brain` (once, full): **17 passed, 1 failed, 12 skipped**. The skips are by design: desktop-only or phone-only specs in the other project.
  - The failure was `shell.spec.ts:92`, "a sidebar click shows the skeleton within 300 ms": 2,892 ms during the full run.
  - Re-run alone it took 522 ms, then **passed** once the machine was idle. This machine has **1 CPU core**; the load average was 3–4 during the full run.
  - So it is load-sensitive, not a regression. Re-check it in CI or on a multi-core machine.
  - `apps/web/.env.local` was restored by the script.
- The local DB was reset several times (approved). Local Google/QuickBooks connections must be reconnected for live testing.

## Production SQL (Supabase SQL Editor; one transaction per file)
The files are in `supabase/core/bootstrap/manual-migrations/`. That folder is **git-ignored**, so run them from this checkout. Each part:
- refuses to run twice ("Part X is already applied");
- refuses to run out of order ("Run part … first");
- records its migration version.

Run order:
1. `part-9a-T-231a.sql` (20261111100000: `core.briefing_coverage` definer, `core.briefing_events` invoker)
2. `part-9b-T-231b.sql` (20261111110000: `core.briefing_threads`)
3. `part-9c-T-231c.sql` (20261111120000: schema `brief`, `brief.briefings` + RLS, save / save_own / latest / purge)
4. `part-9d-T-233.sql` (20261111300000: `core.home_finance_context` definer, `core.home_finance` invoker; no table)
5. `part-10-T-232.sql` (20261111200000: schema `act` + RLS, state machine, `core.act_*`, `core.act_claim_open`, T-231d duplicate check and job cap). It runs after 9d on purpose; the version number only sorts earlier.
6. Read-only checks:
   - `check-part-9.sql`: 22 rows, every one `ok = true`.
   - `check-part-10.sql`: 11 rows, every one `ok = true`. The last row expects PKG's production policy (no drafts, no write types); it reads `false` on the local seed, which is expected.

T-230 needs **no** SQL.

How they were tested: 9a–9d were dry-run on a clone at the part-8 state, and 10 on a clone at the 9d state. Each applied once, refused a re-run and passed its checks. The clones were dropped.

Deploy the app only after part 10: Home and Approvals read `brief.*` and `act.*`.

## Needs human (exact steps in `docs/backlog.md`)
- **H-045:** run the production SQL above, in order, then the two checks.
- **H-002:** set `ANTHROPIC_*` in Vercel (Saurabh). The briefing's "Run now" and the schedule need it.
- **H-046:** after reviewing **two** manual "Run now" briefings in production, switch on the schedule (06:30 America/New_York, Mon–Fri):
  `insert into core.lane_config (lane_id, version, config) select lane_id, version + 1, jsonb_set(config, '{briefing}', coalesce(config -> 'briefing', '{}'::jsonb) || '{"schedule_enabled": true}'::jsonb) from core.lane_config where lane_id = 'PKG' order by version desc limit 1;`
  Check with `select config -> 'briefing' from core.lane_config_current where lane_id = 'PKG';`. To switch it off, run the same insert with `false`.
- **H-047:** email proposals and sending for PKG.
  1. Add the `gmail.compose` scope in GCP.
  2. `store_outbound_drafts = true` and `write_actions_allowed = {email_send, email_draft}` for PKG. Reply drafts and proposals appear from this step.
  3. Reconnect Google, then check `features.gmail_compose`.
  4. First live send to a synthetic recipient: check the `X-Portal-Action-Id` header and the Message-ID.
  5. `approvals_live` only after T-170.
  6. T-192 (reconcile stuck) or a daily check for stuck `executing` rows.
- **H-044** (open from T-230): retake the design screenshots.
- **Open product decision** (plan-review, Nov 11): money amounts in AI text stay masked (rule 7). Revisit after Robert sees it.

## Push / merge order
1. Push `agent/T-231` and open a PR to `main`.
   - It carries 05b7015, da911f9 and 105481b, which are not on any remote yet, plus T-231a–c, T-233, the D-32 schedule and the next-task fixes.
   - PR body: T-231a (Coverage strip, today's calendar, 7-day look-ahead; commits 55d43ab and 8953013) and T-231b (Needs your attention top 5, Money card; 0ef19d5 and 6445b97). Then paste `.agent/pr/T-231c.md` and `.agent/pr/T-233.md`.
   - Merge with a merge commit (keep history: `agent/T-232` contains these commits).
2. Then push `agent/T-232` and open a PR to `main`. After step 1 is merged, its diff is only T-232 + T-231d (11 commits). Body: `.agent/pr/T-232.md` + `.agent/pr/T-231d.md`.
3. Production: H-045 SQL (parts 9a–9d, then 10), then deploy, then H-002. H-046 and H-047 come later.

## Next (no human needed)
Run `node scripts/next-task.mjs --explain`. It now accepts `- note:` lines and split ids. Candidates: T-192 (reconcile stuck actions; wanted before live sending), and the remaining approved tasks.
