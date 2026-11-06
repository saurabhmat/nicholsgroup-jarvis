Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
Review of T-052 (working tree on `agent/T-052`). I read the diff, the new files and the migration. I did not run `pnpm typecheck`, `lint`, `test` or `test:db`, so those still need a pass.

**BLOCKER:** none found.

**HIGH:** none found.

**MEDIUM**

1. **Retries create duplicate cache rows (`reports-job.ts:111-114`, `report-store.ts`, migration `:74`).**
   - `asOf` is Intuit's `Header.Time`, which changes on every fetch. The upsert key is `(lane, connection, report, params_hash, as_of)`.
   - A retry therefore inserts new rows instead of replacing them. The comments in `reports-job.ts` (lines 6-7), the migration and `fin-reports.ts` all claim the run is idempotent.
   - The test at `reports.test.ts:122` only passes because the fake returns a fixed `Time`.
   - Inngest retries up to 3 times, and a failed report makes the run retry all five. That could leave up to 20 rows per connection per night.
   - Fix, either one:
     - Set `as_of` to the business-day start or the fetch day, and keep `Header.Time` in the payload.
     - Keep `as_of = Time`, but fix the comments and add a purge or retention entry (your own note, `T-052.md:15`, says T-042 has none).
   - Whichever you pick, make the idempotency test use a different `Time` on the second pull.

2. **A permanent failure can hide a retryable one (`reports-job.ts:122`, `firstError ??= err`).**
   - If the first failure is a refused report (non-retryable) and a later one is a transient store error, the run is reported as non-retryable and the transient failure is never retried.
   - Fix: prefer the first retryable error when picking `firstError`, and add a test with one report of each kind failing.

3. **`alter role service_role set statement_timeout = '60s'` (migration `:53`) is global.**
   - It applies to every service-role job: bulk upserts, retention purges and any future backfills, not just the report job.
   - There is no pgTAP assertion for it. A role setting only applies to new sessions.
   - Fix: add a pgTAP check that `pg_roles.rolconfig` contains the setting, and note the blast radius in the PR. Alternatively, set the timeout inside `core.fin_report_cache_put` and the other writers with `set statement_timeout`.
   - The PR body should also say why the function-level `SET` was rejected.

**LOW**

4. **`SAFE_ID` allows letters (`reports.ts:168`).** An id like `AB12345` has a letter and 5 or more digits, so the database value guard (22023) would reject the whole report. Intuit ids are numeric, but one odd id would make a report permanently unstorable. Fix: restrict ids to digits, or run them through `maskLabel`, and add a test.

5. **No test for the case where one report in a run fails the database guard.** `report-store.test.ts` covers the error mapping. I saw no test where the store refuses with 22023 and the other four reports are still stored and the run is non-retryable. Fix: add that test in the job.

6. **`planReports` sends no `accounting_method` for CashFlow.** The spec says to fetch all five with the method. This is flagged as unverified in H-035 and `REPORT_DEFS`, so it is acceptable. Make sure H-035 stays open until the Nov 12 sandbox run.

7. **`isPayrollLabel` runs on every non-aging first cell (`reports.ts:233`).** Labels such as "Payroll Taxes Payable" are removed along with their section even when no payroll account matches. The comment calls this a safety net. Mention the false-positive risk in the PR.

**Optional suggestions**

- `listQuickbooksConnectionIds` reuses `SYNCABLE_STATUSES` and `MAX_SYNC_TARGETS`. State in a comment that more than the cap of connections per lane would be silently dropped.
- The new `core.fin_report_cache_put` is not covered by the lane-config or RLS tests in this diff. Confirm that `210_report_cache_value_guard.test.sql` includes a cross-lane denial and an anon/authenticated denial.
- The `targets.ts` refactor is behaviour-preserving. Its test does cover the new lister, but I did not confirm the QuickBooks one-lane case.
- The `.agent/notes/review-T-052-*.md` and `checkpoint-*` files are untracked. Decide whether they belong in the commit.

**Scope:** the changes to `entities.ts` (`isPayrollLabel`), `sync.ts` (exports `entityQuery` and `MAX_PAGES`) and `targets.ts` are small and needed. I saw nothing out of scope or any unnecessary dependency. The new `./reports` export follows the existing `./sync` and `./retention` pattern.
