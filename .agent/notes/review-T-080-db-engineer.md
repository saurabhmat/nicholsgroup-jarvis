Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**T-080 review: no BLOCKER or HIGH findings.**

I checked the SQL and test logic against the spec and the schema grants. I did not run `supabase test db`. The section 5 text I pulled up in `docs/specs/finance.md` is the data model, so I could not check the calendar rules against a spec section.

**Checked and correct**
- **Week offset:** `(dow+1)%7` gives 0 for Saturday, 1 for Sunday and 6 for Friday. The week runs Sat 00:00 ET to Sat 00:00 ET, end exclusive.
- **DST arithmetic:** all of it is done on plain `timestamp` values before `AT TIME ZONE`. Local midnight is never ambiguous in ET, since transitions happen at 02:00.
- **Session timezone:** nothing reads it. There is no `timestamptz` `date_trunc`, no date-to-`timestamptz` cast and no `::date` on a `timestamptz`.
- **Immutability:** `immutable` is justified. Every operation is the immutable form, and `search_path=''` is set with schema-qualified internal calls.
- **Expected values:** I recomputed every one by hand and they all hold. That covers the Nov 1 and Mar 8 DST days, the 721, 743, 169 and 167 hour spans, the year boundary (Dec 31 2026 is a Thursday), and the Friday 23:59:59 and Saturday 00:00 cases.
- **Test count:** `plan(13)` matches the 13 assertions, and there are 32 `want` rows.
- **Grants:** `fin` already has `usage` granted to `authenticated` and `service_role` in the 20261104 migration, so the function grants are usable.
- **Allow-list:** the 050 entries cover all 8 functions.

**MEDIUM**
1. **Sweep test runs in one timezone.** The 97-minute sweep runs only in whatever timezone is left set after `run_all`, which is America/Los_Angeles. The 32 fixed cases cover the other zones, so the gap is small. You could wrap the sweep in the same four-timezone loop, or compare its result against UTC.
2. **Silent pass if a timezone loses rows.** The per-timezone `is()` checks join `got` to `want`. If a timezone produced fewer rows, the check would pass without noticing. Only UTC has a row-count assertion. Assert `count(*) = 32` for every timezone, or use a full outer join.

**LOW**
3. **`ytd_range` end is the end of `p_d`'s month.** This is documented, but a caller who forgets to cap it at `now()` would count future-dated rows as year to date. Consider a defensive name or comment on the callers' side, or have `ytd_range` take an `as_of` argument.
4. **Functions are never inlined.** The `set search_path` clause stops the planner from inlining these SQL functions. That's fine for scalar calls, but a `where posted_at >= fin.month_start(...)` inside large scans is evaluated once per call, not per row. The table-returning ones won't inline either. No action is needed now.
5. **Property check is name-based.** The `pg_proc` checks match on name only, so a later overload would be judged by the same rules. That is probably the behaviour you want.
6. **No input-edge tests.** There are no tests for `NULL` inputs or for `infinity` dates. `-infinity` and `infinity` pass through `date_trunc` and `at time zone` as infinite values, so they would return infinite bounds silently. This is unlikely to matter for ledger data.
7. **Comment wording.** The header says "never read the session timezone", but the tests prove this only for the timezones tried. That is acceptable.

I made no edits.
