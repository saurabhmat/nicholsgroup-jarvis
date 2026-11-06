Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**T-080 review: no BLOCKER or HIGH findings.** The change can be finished as it stands. There are a few MEDIUM and LOW items to fix or note in the PR.

I ran the pgTAP file `190_fin_business_calendar.test.sql` against the local DB inside a transaction that was rolled back, with pgTAP loaded. All 13 assertions pass. I also checked the expected values by hand: DST ends Nov 1, 2026 and starts Mar 8, 2026, which gives months of 721 and 743 hours and weeks of 169 and 167 hours.

**Security checklist: nothing found**
- **Lane rule:** the functions read no tables and no lane data. The spec's signatures for them take no `laneId`, so the rule isn't broken. Say so in the PR.
- **Grants:** the functions run with the caller's rights and an empty `search_path`. Access is revoked from PUBLIC and anon and granted to authenticated and service_role. Test 12 covers the PUBLIC case.
- **Catalog allow-list:** the 8 entries in `050_catalog.test.sql` are justified because the functions are pure.
- **Other checks:** there are no secrets, no external writes, no stored message or document content, no webhooks and no AI tools. No new tables, so no RLS or cross-lane test is needed.

**MEDIUM**
1. **`20261105170000_fin_business_calendar.sql`, `fin.mtd_range` (and `ytd_range`): these aren't in the spec and disagree with it.** Spec §5 only defines `business_week`, `month_start`, `next_month_start`, `ytd_start` and `et_date`. Spec line 74 says the current month's end instant is **now**. `mtd_range(p_ts)` instead ends at the next ET midnight after `p_ts`.
   - If this is used for point-in-time MRR or counts with a past `p_ts`, it pulls in events from later the same day.
   - `ytd_range` has the same problem: it runs to the end of the month and relies on callers to cap it at now.
   - **Fix:** either have `mtd_range` return `[month_start(et_date(p_ts)), p_ts)`, or remove `mtd_range` and `ytd_range` until T-081 needs them. Whichever you choose, add the helpers you keep to finance.md §5 with their exact end semantics.

**LOW**
2. **Migration header: the functions are marked `immutable`, but their results depend on the time-zone database.** That matches Postgres's own built-in function, but an index or generated column built on them would go stale after a time-zone data update. **Fix:** add one line to the header saying "not for use in index or generated-column expressions". Or mark them `stable`; the speed cost is negligible.
3. **Test 190, assertion 2: only the UTC run has its row count checked.** **Fix:** assert `count(*) = 32` for each time zone, or 128 rows in total. The impact is small because each run inserts all its rows in a single statement, so it either succeeds fully or errors.
4. **Spec and code use different parameter names.** Spec §5 says `p_month` and `ts`/`d`; the code uses `p_d` and `p_ts`. **Fix:** update the spec text so both use the same names. Calls by position are unaffected.
5. **Test 190 sets the time zone differently from the spec.** The spec asks for `set timezone = 'UTC'` and `'Asia/Tokyo'`; the test uses `set_config('timezone', …, true)` and covers four zones. That is equivalent and goes further, so no fix is needed. Mention it in the PR so it doesn't look like a gap.

The plan file wasn't written because no write tool was available in this session, so the review is only in this reply.
