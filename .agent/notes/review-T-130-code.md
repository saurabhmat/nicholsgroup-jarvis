Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**T-130 review: cal.ingest_delta fan-out** (read-only; nothing was run or edited)

I found no BLOCKERs. The fan-out design is sound: lane-bound listing, ids only, deterministic event ids, and one failing lane doesn't stop the others. I read `docs/backlog.md` T-130 and the test files but did not run them.

**HIGH**
- **`packages/core/src/inngest/conn-sync.ts:33,59`: the new `singleton: skip` applies to every `conn.sync` trigger, not only the schedule.**
  - A webhook, `connect` or `manual` request that arrives while any sync of that connection is running is dropped.
  - Only Google calendar connections get the 15-minute backstop. A skipped Stripe, QuickBooks or GoHighLevel webhook sync (T-051 and later) would stay stale until some later event.
  - The comment calls the schedule "the backstop for a skipped webhook/manual request", which is only true for calendar.
  - A skipped initial `connect` sync also leaves a new connection empty for up to 15 minutes.
  - The change is also out of scope for T-130, whose acceptance is "delta updates to `cal.event_index`; retention 180 days".
  - Fix: keep the existing `concurrency` limit of 1, which already prevents overlap, and skip the singleton. If you want skip-on-overlap, restrict it to `schedule`. Otherwise record it as a decision in `docs/plan-review.md` and drop the claim that the schedule covers every provider.

**MEDIUM**
- **`packages/core/src/inngest/events.ts:15`: `trigger` changed from optional to required.**
  - This breaks any event already queued in Inngest without `trigger`. They now fail as `NonRetriableError`.
  - It forced edits to 4 unrelated test files, and it isn't needed for T-130.
  - The only senders of `connSyncRequested` are inside `packages/core/src/inngest` (checked by grep), so nothing else breaks today.
  - Fix: keep it optional, or note the break in the PR.
- **`packages/core/src/inngest/events.test.ts:39`: the edit adds `trigger: "manual"` to a `webhookReceived` payload.**
  - That event is a strict object, so the extra field makes it fail for the wrong reason. The test no longer checks that `connectionId: "nope"` is rejected.
  - Revert this line.
- **`packages/core/src/inngest/cal-ingest.ts:66-72`: a lane that fails to list is recorded as `NonRetriableError` after the fan-out.**
  - A transient failure is never retried within the tick, so `retries: 2` only covers `sendEvent`.
  - Failing the run after sending is reasonable, but the error should be the retryable kind, or retries should be set to 0 to match the behaviour.
  - Failed lane ids go only into the error message. They are not logged or counted anywhere else, so alerting depends on Inngest failure alerts.
- **Missing tests.**
  - `cal-ingest.test.ts` doesn't run the function body. It never checks that `step.sendEvent` gets the right events, that nothing is sent when the list is empty, or that the function throws when a lane fails.
  - Nothing tests that `listCalendarConnectionIds` is exported from `packages/connectors/src/sync/index.ts`, or that the route wires it up.
  - The `singleton` option is asserted, but not its interaction with the `concurrency` option.
  - Acceptance item "retention 180 days" has no test or reference in this diff (retention appears in other tasks). Confirm which task covers it.

**LOW**
- `packages/core/src/inngest/cal-ingest.ts:48`: `event.ts` is typed loosely. The fallback to `Date.now()` weakens the "same tick, same id" guarantee if `ts` is ever missing.
- `packages/connectors/src/sync/targets.ts:13`: `SYNCABLE_STATUSES` duplicates `USABLE` in `job.ts:13`. Export one and import it, so they can't drift.
- `packages/connectors/src/sync/targets.ts:36`: the broad `catch` drops the underlying error. This is fine for secrecy, but there is no log or metric for why listing failed.
- `packages/connectors/src/sync/targets.ts:15` and `packages/connectors/src/sync/index.ts:21`: `MAX_SYNC_TARGETS = 200` silently truncates, and `CALENDAR_PROVIDERS` is exported without being used.
- `packages/core/src/inngest/index.ts:19-29`: the export list is not sorted consistently, which is cosmetic.

**Scope and process**
- `git diff main...HEAD` shows 521 files, because it includes the whole branch (earlier tasks' migrations, `.agent` notes). The working tree has only the 9 modified files for this task plus `.agent/notes/T-130.md`.
- Still needed for the Definition of Done: `.agent/pr/T-130.md`, the `status: done` update in `docs/backlog.md`, and the `security-reviewer` pass.
- No new dependencies and no SQL changes, so `pnpm test:db` is not needed.
