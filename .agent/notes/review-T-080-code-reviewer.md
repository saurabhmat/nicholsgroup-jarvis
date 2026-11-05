Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**T-080 review: no BLOCKER or HIGH findings.** I read the diff against `docs/specs/finance.md` §5 and the T-080 acceptance text in `docs/backlog.md`. I did not run `pnpm test:db`, so the pgTAP results are unconfirmed. I checked the expected values by hand and they are right: Nov 2026 is 721 hours, Mar 2026 is 743, the DST-end week is 169, the DST-start week is 167, and the year-boundary and Fri/Sat cases are correct.

**BLOCKER:** none.

**HIGH:** none.

**MEDIUM**
1. **Definition-of-done items are not in the working tree.** `git status` shows no `.agent/pr/T-080.md`, and `docs/backlog.md` is unmodified, so T-080 is still `approved`. The CLAUDE.md DoD needs both: the PR body with changes, tests, risks and review findings, and `status: done`. The `review-T-080-*.md` notes exist but are untracked. Make sure they are committed or deliberately left out.
2. **The cross-timezone test can pass when rows are missing.**
   - The per-timezone assertions join `got` to `want`. If a timezone produced fewer rows, the missing cases would not be flagged.
   - Only the UTC run has a row-count check. The "identical across timezones" check is also a join, and it flags only rows present in both runs.
   - Today all 32 rows are inserted in one statement, so this is latent. A cheap fix is to assert `count(*) = 32` for each timezone, or compare `count(distinct tz)` against `count(*)` per label.

**LOW**
3. **The functions are not `strict`.** A null input returns null, and the table-returning functions return one all-null row rather than zero rows. Adding `strict` is cleaner, and a null-input case would be a useful test.
4. **Parameter names differ from the spec.** The spec says `p_month` is any date in the month, but the migration uses `p_d`. This only matters if the T-081 query layer calls with named arguments. Pick one name and keep it.
5. **The `immutable` risk should go in the PR's "Risks" section.** The header comment already notes that a tzdata update is the only thing that can change a result. If a later task uses these functions in an index or generated column, that is where a stale result could appear. Postgres's own `timezone()` has the same property, so it is acceptable.
6. **`ytd_range` ends at the next month start, not the current ET day.** This is documented ("callers cap the end at now()"), but the spec does not define it. Confirm that T-081 and T-083 expect this rather than a through-today end like `mtd_range`.
7. **The privilege test only checks `has_function_privilege`.** It never calls a function as `authenticated`. Schema `usage` on `fin` is granted in the earlier migration, so this is fine in practice. One `set local role authenticated; select fin.et_date(now())` would close the gap.
8. **Rule 1 (every function takes `laneId`) does not apply to these pure helpers.** The catalog allow-list entries say "pure calendar function", which is enough. A single line in the PR body would stop a later reviewer from asking.

**Checks that passed**
- `plan(13)` matches the assertions, and `set_config('timezone', …, true)` is transaction-local.
- The functions have `search_path=''`, invoker rights and a revoke from `public, anon`. The grants go to `authenticated` and `service_role`.
- Nothing is outside the task scope. `types.ts` is regenerated output and the catalog change is an allow-list only.
- No new dependencies.
- There are no new tables, so no RLS or cross-lane test is needed.
