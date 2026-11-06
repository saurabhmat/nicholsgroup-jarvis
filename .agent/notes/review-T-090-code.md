Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**T-090 review (uncommitted diff, read-only). No BLOCKER or HIGH findings.** I read the diff and the two new files and spot-checked `runners.ts` and `targets.ts`. I did not run typecheck, lint or tests.

**What I checked and found correct**
- **Schedule:** the hourly tick uses `hour % interval === 0`. Epoch hours align with UTC, so the default 4-hour interval gives 00/04/08/12/16/20 UTC, and the allowed values all divide 24.
- **Idempotency:** event ids are `fin-sync:<conn>:<hour>`, and the tick time is the cron event time, so retries and replays send the same ids.
- **Lane isolation:** a lane whose interval or connection list fails is recorded by lane id only. The healthy lanes are sent first, and the run then fails with a `NonRetriableError`.
- **Skipped connections:** `targets.ts` filters by `SYNCABLE_STATUSES`, so `reconnect_required` connections are skipped (QB-12).
- **Fail-closed config:** a value outside the allowed set or an unknown key throws a `provider_error` (tested).
- **Normalize skip:** a CDC fallback to a full run returns `kind: "full"`, so it still normalizes.
- **Rules:** the diff has no lane-specific code and no token handling. Events carry ids only.

**MEDIUM**
1. **Unrelated finance settings can stop the backup poll.** `qboSyncIntervalHours` parses the whole `finance` object with `laneConfigSchema.shape.finance`. A malformed `payroll` or `reports` value therefore fails the poll for that lane on every tick. Parse only the `qbo_sync` sub-schema, or extract `qbo_sync` before parsing.
2. **A failed normalize can go unrecovered for up to a day.** If a normalize follow-up fails and later polls write nothing, nothing re-triggers it until the first run with UTC hour < 4. That is the next 00:00 UTC run, which is 19:00 or 20:00 ET, not "first thing in the morning". This is acceptable, but document it. Alternatively, have `conn.sync` return `followUp: "failed"` state that forces the next normalize.
3. **The hour-<4 catch-up window changes with the interval.**
   - An interval of 1 normalizes on four runs a day (00–03 UTC).
   - An interval of 6, 8 or 12 normalizes on one run (00 UTC).
   - It depends on the wall clock at `afterSync` time, not the scheduled slot. A delayed or queued run, since `conn.sync` has concurrency 1, can cross the hour boundary and skip the catch-up.
   - Derive the catch-up from the scheduled hour, or pass the run's start time. The tests don't cover the 03:59/04:00 boundary.

**LOW**
4. **Duplicated allowed-values list.** `FIN_SYNC_INTERVALS` in `fin-sync.ts` repeats `QBO_SYNC_INTERVAL_HOURS` from lane-config, which is in the same package. Import it, or add a test that the two lists match. Also, `finSyncDue` guards the value, so the ugly `as unknown as [...]` cast in the zod union can be replaced with `z.literal` members listed explicitly.
5. **The config test reads Inngest internals.** It uses `fn.opts` with a JSON round-trip, which may break on an `inngest` upgrade. Other schedule tests may do the same, so this is consistent.
6. **Acceptance coverage gaps.**
   - The spec says "plus the pull before `fin.weekly_cash`". The diff only asserts that the nightly report schedule still exists, and the weekly-cash pull is left to T-091. State that explicitly in the PR body.
   - There is no test of the `route.ts` wiring or of `listQuickbooksSyncConnectionIds`.
   - Add a `sync_runs`-logged assertion or note that `conn.sync` covers it.
   - `listQuickbooksSyncConnectionIds` duplicates `listQuickbooksConnectionIds` in `reports/index.ts`. They share one lister, so consider reusing it.
7. **Scope and hygiene.**
   - The `.agent/notes/*` files are untracked and should not be committed unless that is the repo convention.
   - The `afterSync` signature change touches `conn-sync.ts` and `fin-normalize.ts`. That is in scope for the cost note, but the PR body should say so.
   - The PR body at `.agent/pr/T-090.md` and the backlog `status: done` are not in the diff yet.
