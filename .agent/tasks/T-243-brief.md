# T-243 brief: Cash from bank balances, Home polish, Date.now prerender fix

Approved by Saurabh on Nov 13, 2026. His request, verbatim:

> New task from main (after T-242 merges):
> 1. Cash tile: compute Cash (book balance) from the current balances of PKG's mapped QBO bank accounts (Account.CurrentBalance); "as of" = last books sync. Don't pull the balance sheet.
> 2. Home polish: exclude automated/login-link emails (e.g. Stripe "customer portal login link") from the top 5; no "Waiting on you" on items the summary says need no action; items marked "no reply needed" drop out of the top 5; always show the subject; never build sender names from an email address.
> 3. Remove the Date.now() prerender errors on /[laneId] and /[laneId]/settings (seen in Vercel logs).
> Tests with synthetic data, security and code review, any SQL as a manual part with a check.

He is away; make scope decisions yourself and log them in `.agent/notes/T-243.md`.

## Where you work
- Branch: `agent/T-243`, created from origin/main (T-242 merged). Check with `git branch --show-current`.
- Do not switch branches, push, rebase or reset.
- `git add` only your own files. Never `-A`. Never commit `.agent/notes/checkpoint-2026-11-02-b.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit per part.

## LOCAL DATABASE: DO NOT RESET
- `node scripts/test-db.mjs` resets the database on EVERY call without `--no-reset`, including `--help`, and ignores unknown flags. Always pass `--no-reset`.
- Never run `pnpm test:db`, `supabase db reset`, `pnpm test:e2e`, or any Playwright run.
- New migrations: `supabase migration up --local --workdir supabase/core`. If the CLI is missing, run `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)"`.
- pgTAP: `node scripts/test-db.mjs --no-reset`. All 54 files pass today, and they must keep passing.
- Do not seed data into the local DB outside a transaction that you roll back. `core.lane_config` is insert-only: a stray version breaks older tests.
- Production SQL goes in a gitignored manual pair, `supabase/core/bootstrap/manual-migrations/part-22-T-243.sql` and `check-part-22.sql`, in the style of part 21:
  - guarded, schema-qualified, one transaction;
  - the check includes an md5 of any replaced function body.
  - Run both locally.
- **pg-safeupdate:** PostgREST sessions (the `authenticator` role) refuse an UPDATE or DELETE without a top-level WHERE, with SQLSTATE 21000. Every UPDATE or DELETE you write in SQL needs a top-level WHERE; pgTAP 315 enforces this. To test an RPC as the API runs it, connect with `psql postgresql://authenticator:postgres@127.0.0.1:54322/postgres` and run `set role service_role` inside a rolled-back transaction.
- Synthetic data only. No external calls in tests.

## 1. Cash from bank account balances
- **Store the balance.**
  - Add `fin.accounts.current_balance numeric(18,2)`, nullable.
  - The normalizer `core.fin_qbo_normalize` sets it from the raw Account's `CurrentBalance` (`fin.qbo_money(e.payload -> 'CurrentBalance')`) on insert and on update, including the "is distinct from" tuple. The connector already keeps `CurrentBalance` (`packages/connectors/src/quickbooks/entities.ts`).
  - Base the new function body on the LATEST version, `20261120110000_fin_qbo_normalize_safeupdate.sql`. Keep its step markers, key checks and `where p.id is not null`. Change nothing else in it.
- **Cash in `core.home_finance`** (`20261111300000_home_finance.sql`; check whether a later migration replaced it). Replace the balance-sheet section:
  - Sum the `current_balance` of the lane's QuickBooks bank accounts in `fin.accounts` (`is_bank`, active, not deleted).
  - Keep the existing mapping rules (D-18):
    - only accounts listed in `entities.bank_accounts` with owner = own_entity are summed;
    - an account listed under another owner, or also tagged elsewhere, is flagged `shared`;
    - a bank account in no mapping is counted in `cash_unmapped` and not summed.
  - `cash_as_of` = the last books sync, `home_finance_context.last_sync_at`.
  - Reasons:
    - `bank_mapping_missing` when the list is empty;
    - `no_own_bank_accounts`;
    - `balance_unreadable` when an own account's `current_balance` is null, for example normalized before the column existed. Say in the text that a re-normalize fills it.
  - Remove the balance-sheet reasons. The balance sheet is no longer read for cash.
  - Keep the label "book balance" (rule 7).
  - Update the TS reason texts and the tile note (`apps/web/lib/home-finance.ts`, `home-kpi-tiles.ts`), and any test that expects the balance-sheet reasons.
- **pgTAP:**
  - `current_balance` is stored on insert and updated on change;
  - Cash sums only own mapped accounts;
  - unmapped accounts are counted and not summed;
  - shared accounts are flagged;
  - `as_of` = last sync;
  - an unreadable balance gives the reason;
  - cross-lane denial and AAL1 denial;
  - test 315 still passes.
- **Production:** part 22 (column, normalizer, `home_finance`) and its check. In the PR, after part 22, send `fin/qbo-normalize.requested` (trigger `manual`) to fill the balances.

## 2. Home polish
- **a. Login-link and automated mail never in the top 5.**
  - Add generic login-link subject patterns to the lane_config defaults that are already a hard exclusion for everyone (`exclusions.otp_subjects`, `packages/core/src/lane-config/index.ts`), for example "login link", "log in link", "sign-in link", "sign in link", "magic link", "login url", "sign in to".
  - Choose carefully and log the list. "customer portal login link" must be caught.
  - Make sure a VIP or authenticated sender cannot lift it back into the top 5.
  - Tests: Stripe-like "Your customer portal login link" from a synthetic billing domain is excluded; a person's normal mail is unaffected.
- **b. "No reply needed" from the summary.**
  - Add a structured field to the AI briefing's attention items, for example `needs_reply: boolean` ("false when the item needs no reply or action"):
    - in the JSON schema the model must follow (structured output);
    - in the prompt rules;
    - in `checkContent` / `BriefContent.attention` (`packages/modules/briefing/src/domain/compose.ts`);
    - in what is saved.
  - An older briefing without the field means unknown, so nothing changes.
  - Home reads the latest briefing's attention notes. Map each ref to its thread with `BriefRef` (connectionId plus threadKey), at save time if that is cleaner; record the mapping in the saved briefing so Home does not need the refs.
  - For a top-5 thread the summary marks `needs_reply: false`:
    - it drops out of the top 5; the next fresh item moves up;
    - it never shows "Waiting on you".
  - Decide whether it goes to "View all in Inbox" counts or nowhere, and log it.
  - The summary is AI output. It may only REMOVE an item or a chip. It must never add one, change a figure, or reach a permission (rules 7 and 9).
  - Tests: the schema; parsing, with a missing field meaning unknown; Home filtering; the chip; an AI note can never add an item.
- **c. Always show the subject** on Home attention rows: "(no subject)" when there is none, masked as today.
  - Find where it can be hidden today, for example on the phone layout or when the subject equals the reason. Fix it, with a test.
- **d. Never build a sender name from an email address.**
  - `packages/modules/briefing/src/domain/sender.ts` uses `nameFromEmail`.
  - Show the display name when it is real; otherwise show the full address (truncated by CSS, with a title).
  - Remove `nameFromEmail` uses everywhere it builds a person's name: attention rows, the reply drawer, the Inbox and the reason texts ("Unread from ..."). Remove the function too if nothing needs it.
  - Tests.

## 3. Date.now() prerender errors on /[laneId] and /[laneId]/settings
- Next.js 16 (App Router, `cacheComponents`/PPR: check `apps/web/next.config.ts`) reports an error when a server component reads the current time (`Date.now()`, `new Date()`) during prerender before any dynamic data access.
- **Reproduce first:** run a local production build (`pnpm --filter @nichols/web build`) and capture the exact messages and routes. If the build needs env vars, use the repo's e2e or build env helpers (`apps/web/scripts/check-env-build.mjs`, `e2e-server.mjs`) with synthetic values only. Never real credentials.
- **Fix the cause** in the right place, e.g. `await connection()` from `next/server` before reading the time, or moving the time read into the part that is already dynamic. Do not just silence it.
- Likely spots: default params like `now = new Date()` in server components (`coverage-dot.tsx`, `home-page.tsx`, the settings page and its sections).
- Verify the build has no such errors for both routes. Add a regression check if cheap, e.g. a unit test that the page modules call `connection()` first, or a build-log grep script.

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass.
- pgTAP `--no-reset` passes (all files).
- `pnpm --filter @nichols/web build` shows no Date.now prerender error.
- Write `.agent/pr/T-243.md`: changes, tests, risks, production part 22 with the re-normalize step, and Needs human. The Needs human list must include a production look at Home: Cash figure and as-of, no login-link mail, no-reply items gone, subjects shown, no invented names.
- Write `.agent/notes/T-243.md` with the decisions.
- Do NOT set the backlog to done.
- Final message:
  - a summary;
  - the commit list;
  - test results;
  - the build-log result;
  - the decisions you made;
  - anything unfinished.
