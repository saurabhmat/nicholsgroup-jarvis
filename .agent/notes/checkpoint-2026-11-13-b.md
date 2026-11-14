# Checkpoint for Nov 13, 2026 (b)

**Where things stand:**
- Checkout: `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-243`** (8 commits ahead of origin/main, not pushed).
- origin/main = `3550172`, which has T-195, T-196, T-197, T-238, T-240, T-241 and T-242 merged.

## What is done
| Task | Status | Notes |
|---|---|---|
| T-238 sync freshness | merged | Production parts 18 and 19 |
| T-240 Home top 5, Home polish | merged | Part 19 |
| T-241 QuickBooks full load on connect, normalizer reasons | merged | Production SQL for the PKG cursor reset and full sync: `pkg-qbo-force-full-sync.sql` |
| T-242 normalizer SQLSTATE 21000 | merged | Parts 20 and 21. Root cause: pg-safeupdate (see below) |
| **T-243** Cash from bank balances, Home polish, Date.now fix | **done, ready to push** | Part 22; reviews complete, no BLOCKER/HIGH open |

## T-243 (branch agent/T-243, PR body `.agent/pr/T-243.md`)
1. **Cash (book balance).**
   - New column `fin.accounts.current_balance`, filled by the normalizer from Account.CurrentBalance.
   - Incremental syncs re-emit every account, so balances never freeze.
   - Cash comes only from the current (not disconnected) QuickBooks connections.
   - A tombstoned account (payroll or deleted) loses its balance.
   - `cash_as_of` = least(last sync, last normalize of the current connections). The balance sheet is no longer read.
2. **Home polish.**
   - Login-link subjects are a hard exclusion.
   - The AI summary's `needs_reply` can only remove top-5 rows. It can never remove security-flagged, VIP, money, deadline or repeated-failure rows, and a true wins over a false.
   - The subject is always shown.
   - No sender name is ever built from an address.
3. **Date.now prerender error.**
   - Root cause, from the production log: the layout's first-name lookup called `guards()` without `connection()`. During a runtime-prefetch prerender, `cookies()` resolved and supabase-js read the session (Date.now).
   - Fix: `guards()`, `auth()` and `mfa()` await `connection()` first. Tested: the tests fail without the fix.

## Production steps (human)
1. Part 22 is safe to run **before** the T-243 deploy (backward compatible):
   - run `supabase/core/bootstrap/manual-migrations/part-22-T-243.sql`;
   - then run `check-part-22.sql` (9 rows, all true).
2. Send `fin/qbo-normalize.requested` `{ laneId: "PKG", connectionId: "7f98598e-746e-41e4-b9fb-f6f4d783adc3", trigger: "manual" }` in Inngest Cloud. Cash then shows bank balances even on the current deploy.
3. Push and deploy agent/T-243 (PR body `.agent/pr/T-243.md`). Then:
   - regenerate the summary once (so `needs_reply` appears);
   - check Home: Cash and as-of, no login-link mail, no-reply items gone, subjects shown, no invented names;
   - check the Vercel logs: no Date.now error on /[laneId] or /[laneId]/settings.
4. Check `select rolname, rolconfig from pg_roles where rolname in ('authenticator','service_role')`. Locally, authenticator has statement_timeout=8s and lock_timeout=8s. A normalize longer than 8 s through PostgREST would fail with 57014. This is open and needs your decision.
5. Still open from earlier:
   - H-061: replace the sandbox realm with the real PKG realm at go-live, and adapt `pkg-qbo-entity-mapping.sql`.
   - H-057 to H-060: Inngest app sync, live Sync now/Reconnect checks, the email alert sender.

## Lessons (also in memory)
- **Reset trap:** `node scripts/test-db.mjs` resets the local DB on every call without `--no-reset`, even `--help`. The local DB was reset once on Nov 13 and holds seed data only, no live connections.
- **pg-safeupdate:** PostgREST (`authenticator`) preloads pg-safeupdate. An UPDATE or DELETE without a top-level WHERE fails with 21000, through the API only. pgTAP 315 enforces this. To test as the API runs: `psql postgresql://authenticator:postgres@127.0.0.1:54322/postgres` then `set role service_role`.
- **Insert-only settings:** `core.lane_config` is insert-only. Never seed it outside a rolled-back transaction: a stray version breaks older pgTAP tests.
- **Untrusted AI output:** the summary may only remove items or chips, never protected rows (rules 7 and 9).

## Open LOW items
See `docs/plan-review.md`, the T-242 and T-243 sections. Examples:
- a mapped inactive or deleted bank account drops out of Cash silently;
- the summary judges only the top 5 it was given;
- the `excluded_objects` log count;
- the guards test's 20 ms wait.
