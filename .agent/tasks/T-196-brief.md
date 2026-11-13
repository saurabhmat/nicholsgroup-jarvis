# T-196 brief: QuickBooks sync and API error log + export

Approved by Saurabh on Nov 13, 2026: "carry on with quick books connect... complete the code... no need for my approval". He is away. Make scope decisions yourself and log them in `.agent/notes/T-196.md`.

Read first:
- CLAUDE.md
- `docs/backlog.md`: the T-196 entry and QB-9 / QB-15 in the QuickBooks list above T-050
- `docs/plan-review.md`: the T-195 sections
- `.agent/pr/T-195.md`

## Where you work
- Branch `agent/T-196`, which the lead creates from agent/T-195 before you start. Check with `git branch --show-current`.
- Do not switch branches and do not push.
- Run `git add` only on files you changed. Never use `git add -A`, and never commit `.agent/notes/checkpoint-2026-11-02-b.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## LOCAL DATABASE: DO NOT RESET
The local Supabase stack holds Saurabh's live connections.
- Never run `pnpm test:db`, `supabase db reset` or `pnpm test:e2e`.
- Apply new migrations with `supabase migration up --local --workdir supabase/core`.
- Run pgTAP with `node scripts/test-db.mjs --no-reset`.
- These six older files fail only because of live local data; ignore them: 060, 070, 150, 160, 200, 280.
- If the Supabase CLI is missing, run `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)"`.
- Production SQL goes in a new gitignored manual-migration pair: `supabase/core/bootstrap/manual-migrations/part-16-T-196.sql` and `check-part-16.sql`, in the style of part 15. Run both locally.

## What to build
1. **Sync runs.** `core.sync_runs` already exists (`20261102042312_connections_and_sync_runs.sql`). Check that every QuickBooks job records a run per connection, with start, end, status, counts and an error code:
   - conn.sync (initial load and CDC)
   - the webhook-triggered CDC
   - the reports pull
   - the normalizer

   Fill any gaps. Store no content.
2. **`core.connector_api_errors`.**
   - Columns: lane_id, connection_id, at (timestamptz), provider, endpoint, http_status, provider_error_code, provider_message, provider_tid, plus the mapped disposition/kind from the T-195 error map.
   - The shape is already sketched in `packages/connectors/src/contract/schemas.ts` (~line 67). Use it.
   - RLS: read only by the lane's owner and admin_technical; inserts by the service role only. pgTAP must include a cross-lane denial.
   - Retention: keep it bounded. Look at the existing retention/purge job (T-200-ish, `packages/connectors/src/retention`) and add a sensible window, for example 90 days. Log the decision.
3. **Redaction.**
   - `endpoint` is the path template without query values. A realm id in the path is masked or replaced by `{realm}`, and query strings with entity names or SQL-like queries are dropped.
   - `provider_message` comes only from the fixed text of the T-195 error map, never from Intuit's raw Message/Detail.
   - Write a test proving that tokens, emails, personal names and digit runs of 5 or more never reach a row. Use canary values through the whole path.
   - A DB-side guard is welcome if cheap, for example a check refusing an `@` or a Bearer pattern.
4. **Recording.** Every QuickBooks API error from the T-195 error map writes one row through a single sink in the connector. Any failure to write the row is logged, by code only, and never breaks the sync.
5. **Sentry.** T-041 is not built and there is no Sentry SDK in the repo. Do not add the SDK or invent a DSN.
   - Build one scrubbed error-sink interface. It sends the same scrubbed fields that go into the table.
   - Its default transport is the existing redacted connector logger.
   - T-041 plugs Sentry in later; leave a clear seam and a note.
6. **Export for Intuit support.**
   - An authenticated route that is owner or admin_technical of the lane at AAL2. Other roles get 403 and other lanes 404.
   - It exports a date range (max 90 days) of the lane's connector_api_errors, plus sync_runs if useful, as CSV or JSON.
   - It is audited: who, lane, range, format and row count.
   - Use a CSV-injection-safe encoder (prefix `= + - @` cells).
   - The data comes from SQL through the lane router; every function takes `laneId`.
   - No UI is required here; T-197 adds the button on Settings → Connections. You may add a tiny helper for the URL.
7. Write tests for everything above. Make no external calls.

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass.
- pgTAP `--no-reset` passes for the new files.
- Commit in logical steps.
- Write `.agent/pr/T-196.md` (changes, tests, risks, production SQL part 16, needs human) and `.agent/notes/T-196.md`.
- Do NOT set the backlog to done.
- Final message: a summary, the commit list, test results and the decisions you made.
