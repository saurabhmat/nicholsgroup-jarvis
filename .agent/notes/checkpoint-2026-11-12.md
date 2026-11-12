# Checkpoint — Nov 12, 2026 (T-234 Home v2 done)

Checkout `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-234`**. Not pushed: agents can't push. This replaces the "next steps" of `checkpoint-2026-11-11-b.md`.

## Branches and push/merge order
Each branch contains the one before it:
1. `agent/T-232` (ends `8ecf816`): T-231a-d, T-232, T-233. See `checkpoint-2026-11-11.md`.
2. `agent/T-192` (ends `cbb66a4`): action.reconcile_stuck. See `checkpoint-2026-11-11-b.md`.
3. **`agent/T-234`** (ends at the commit that adds this note): T-234 Home v2, parts 0–5, all reviewed. PR body: `.agent/pr/T-234.md`.

Push and merge in that order, with merge commits, so the history is kept.

## T-234 commits (after `cbb66a4`)
| Part | Build | Review / re-check fixes |
|---|---|---|
| Brief and backlog entry | `e85b347` | |
| 0: Run now and env hardening | `09255a8` | `3206321`, `9868356` |
| 1: layout | `ca17c30` | `78f5af4` |
| 2: Needs your attention | `bd7e524` | `bbf0242`, `25e0ba6` (auth pass can't be forged; money mail only from authenticated senders) |
| 3: Reply drawer | `e8e0cb4` | `c214a84` (duplicate-send guard in SQL), `ea93130` (uncertain sends are unknown; `already_replied`) |
| 4: GovCon news | `3f2119a` | `b9a8f0c`, `b5030ae`, `d1461db` |
| 5: auto-refresh | `349fc5b` | `0f7fa01` |
| Test hardening | `2313e3c`, `9c2190a` | The mail-sync rate-limit test checks the invariant, not a timing bound that flaked under load. |
| Docs | `dc195d7` (PR body, plan-review), `7175aff` (T-234 done) | |

Reviews:
- Every part had a full security review and a code review.
- Parts 2, 3 and 4 also had a security re-check of their fixes.
- No BLOCKER, HIGH or MEDIUM finding is open. Accepted LOW items are in `docs/plan-review.md` under "T-234 part 1 review", "T-234 part 3 review fixes: open items" and "T-234 parts 2–5: re-check items logged, not fixed".

## Test results (agent/T-234, final tree)
- `pnpm typecheck`, `pnpm lint`: 18/18 tasks.
- `pnpm test`: 18/18 tasks plus the 216 root script tests. Web 790, connectors 1426, ai 162, approvals 74, briefing 60.
- `pnpm test:db` (local reset, approved): 44 files, all pass. New: 303 message flags, 304 reply state (28 tests), 305 news (128 tests).
- `pnpm db:types:check`: ok.
- `pnpm e2e:brain`: see "e2e" below.

## Production SQL (Saurabh runs it in the Supabase SQL Editor, in order)
The files are in `supabase/core/bootstrap/manual-migrations/`. They are git-ignored, so run them from this checkout.
1. Parts 1–10 and their checks (earlier checkpoints).
2. `part-11-T-192.sql`, then `check-part-11.sql`. It refuses to run unless part 10 is recorded.
3. **`part-12-T-234.sql`**, then **`check-part-12.sql`**. All 31 rows must be true.
   - One transaction.
   - It refuses to run unless part 11 (`20261112100000`) is recorded.
   - Re-runnable: `create or replace`, `if not exists`, version rows `on conflict do nothing`.
   - Migrations, each copied verbatim (checked programmatically):
     - `20261113100000` briefing_failure_reason
     - `20261113110000` approvals_withdraw_proposed
     - `20261113120000` message_flags_and_thread_ref: the five header flags; `briefing_threads` and `inbox_message_ref` return them.
     - `20261113130000` reply_state: `act_reply_state`, `act.approve` with `check_sent_first` and `already_replied`, `insert_proposal` with `reply_already_pending` and the job rules.
     - `20261113140000` news: the `web` category, `brief.news_digests`, reserve and cap functions, the guard.
   - Ran twice against the local DB; every check row was true both times.
4. Deploy the app only after part 12. Home, Approvals and the drawer read the new functions.

## Needs human (exact steps in `docs/backlog.md`)
- **H-047:** live sending (GCP compose scope, the PKG policy, reconnect, a first test send, then `approvals_live` after T-170). It now also needs parts 11 and 12.
- **H-048 (REQUIRED after part 12):**
  - One full Gmail resync. Until then old rows have no flags and no auth pass, so priority senders get no priority treatment.
  - Put PKG's own newsletter senders in `briefing.exclusions.org_newsletter_senders`.
- **H-049:** turn on GovCon news for PKG: add `web` to `llm_allowed_categories` and set `lane_config.news.enabled`, using the SQL in the backlog. Then make the **first live web-search call by hand** (Refresh) and record the response. The response shapes have only been tested against fakes.
- **H-050:** verify the per-search price and token prices against Anthropic's current price list. Set `news.monthly_cap_usd` (default 20; one fetch reserves about $0.81 with the defaults).
- **H-051:** sync `news-daily` in Inngest Cloud after the deploy, along with `action.reconcile_stuck` from T-192 if not done.
- **H-002:** `ANTHROPIC_*` in Vercel (unchanged).
- **Open product decisions** (plan-review):
  - money amounts in AI text stay masked;
  - there is no "I checked Sent" override of the 24 h `check_sent_first` block;
  - one undated news item is allowed per digest.

## e2e (`pnpm e2e:brain`, local DB reset approved)
1. **First full run: interrupted** when the session ended. It left `apps/web/.env.local` (a symlink) stashed. Restored with the guard script's own `guard_restore`; the file contents were never read.
2. **Second full run: 16 passed, 2 failed, 12 skipped.** The skips are by design (desktop-only or phone-only specs).
   - **Real regression, fixed in `db96a25`:** `onboarding.spec.ts:181` (axe at iPhone width) found two T-234 accessibility issues.
     - The KPI "No figure" `aria-label` was on a `<p>` (aria-prohibited-attr). It is now screen-reader text.
     - The news card's Settings link stood out by color only (link-in-text-block). It is now underlined.
   - **Not a regression:** `shell.spec.ts:94`, the 300 ms skeleton timing check. This machine has 1 CPU core and the load average was about 4.
3. **Re-run of the two failed specs on a fresh build: 9 passed, 1 failed, 6 skipped.** The axe test passed. The skeleton check took 436 ms.
4. **Skeleton check alone: passed.** As on Nov 11, the 300 ms check is load-sensitive on this machine. Re-check it in CI or on a multi-core machine.
- Not covered by e2e: the Reply drawer's send path (it needs a mailbox with compose) and the first live web-search call (H-049).
- `apps/web/.env.local` is back in place (symlink to `../../.env.local`).

## Next
Run `node scripts/next-task.mjs --explain`. Wanted before live sending: H-047 with parts 11 and 12 applied. Follow-ups logged in plan-review:
- a SQL-backed AI-draft limiter;
- a recorded web-search fixture after the first live call;
- e2e for the drawer once a test mailbox with compose exists.
