Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I read the full diff and ran no tests, so everything below comes from reading the code. I found no BLOCKER or HIGH issues, but there are a few MEDIUM semantic gaps worth fixing before merge.

## MEDIUM

1. **`finish()` can silently do nothing** (`store.ts:55-77`, `job.ts:73-77`).
   - The update is filtered on `status = 'running'` and the code never checks that a row changed.
   - If a concurrent `start()` cancelled the row as stale (30 minutes) or as the same `job_run_id`, `finish` affects zero rows.
   - The job then reports success while the log row says `cancelled`.
   - Fix: add `.select("id")` and treat zero rows as a log failure, or log a warning.

2. **A failed log write blocks the connection for 30 minutes** (`job.ts:86-90`).
   - If `finish` throws on a failure outcome, the row stays `running`.
   - A retryable outcome recovers on retry, because the next attempt has the same `job_run_id` and cancels the open row.
   - A non-retryable outcome is not retried, so every later schedule or manual trigger returns `already_running` until the stale limit.
   - The comment at `job.ts:87` only holds for retryable cases.
   - Fix: on `finish` failure, make a best-effort `cancelled` update. Alternatively, return `retryable: true` when the row is still open.

3. **A failed `recordOutcome` re-runs a sync that already succeeded** (`job.ts:75-78`, `job.ts:89`).
   - `finish(succeeded)` has already committed, but a `recordOutcome` error is turned into a retryable failure.
   - Inngest then repeats the whole sync and writes a second row.
   - Fix: wrap `recordOutcome` separately. Log a warning and still return success, since only `last_sync_at` is stale.

4. **The stale-run takeover can start a second live sync** (`store.ts:12`).
   - A legitimate run longer than 30 minutes, such as a first Google full sync, gets cancelled by the next start. Two syncs then run at once, which defeats the "one at a time" guarantee.
   - The whole job also runs in one handler with no `step.run`, so it is bounded by the serverless duration.
   - Fix: check `maxDuration` on the Inngest route, and set `STALE_RUN_MS` above it. Alternatively, add a heartbeat on `updated_at` and stale-check on that.

5. **Two weak tests** (`job.test.ts`, `conn-sync.test.ts:20-22`).
   - "A retry … takes over an open row of the same job run" never creates an open row. The first attempt finishes as `failed`. The takeover path, and `STALE_RUN_MS`, are only checked as call shapes in `store.test.ts`.
   - Fix: make `finish` throw once on the first attempt so the row stays `running`, then assert the retry cancels it and succeeds. Also add a stale-row case to `memoryRuns`.
   - The config test reads Inngest's private `fn.opts`, so an SDK upgrade could break it. The exported constants plus a check that `connSyncFunction` passes them would be sturdier.
   - Missing cases: `finish` affecting zero rows (item 1) and `recordOutcome` failing after a successful `finish` (item 3).

## LOW

- **Google runner hides the retryable error** (`runners.ts:54-57`). It rethrows the first failure. A permanent mail error (`reconnect_required`) masks a retryable calendar error, so calendar is never retried. Prefer a retryable failure if any stream has one, or only rethrow the first when all failures are permanent.
- **`received` counts skipped and removed items** (`runners.ts:60`). `received` = written + skipped + removed, which may not match the meaning in other runners. Document it.
- **Failed-run `kind` is a guess** (`job.ts:81`). It uses `last_sync_at`, not whether a cursor existed, so it can be wrong when the cursor is missing or was reset.
- **Dead code until a provider uses it.** `syncCursorStore`, `createConnectorSyncRunner` and `sync_cursor_put` are not wired to any provider (`vault/index.ts:40`, `index.ts`). This is defensible for a skeleton, but say so in the PR.
- **Duplicate events queue instead of dropping.** Inngest concurrency queues them, so a scheduled fan-out sending duplicates will run back-to-back syncs. Consider `idempotency` or a `singleton` on `connectionId` once the scheduler lands.
- **Migration `20261105160000`: the unique index can fail on existing data.** The index fails to create if any connection already has more than one `running` row. Harmless for the pilot, but a one-line `update … set status='cancelled'` before the index would make it safe.
- **Scope and Definition of Done:**
  - `.agent/notes/checkpoint-2026-11-02-b.md` is staged but unrelated to T-038.
  - The two untracked `review-T-038-*.md` notes should be committed or dropped.
  - There is no `.agent/pr/T-038.md` and no `docs/backlog.md` status change in the diff.

## Checked and fine

- The lane is passed through every call, and `assertLaneBound` is used on every store method.
- Errors are redacted before they are stored, with a canary test for this.
- There are no new dependencies.
- The migration function is `security definer`, service_role only, lane-checked, and has a cross-lane pgTAP denial test. The catalog allow-list is updated.
- The `080_connections` fixture change is justified by the new unique index.
- Retry translation (`NonRetriableError`, `RetryAfterError` capped at 15 minutes, plain `Error`) is correct.
- `retries: 4` means up to 5 attempts, which matches the notes.

## Verdict

**Approve after fixing MEDIUM 1–3 and the weak retry-takeover test (item 5).** Items 4 and the LOW ones can be logged in `docs/plan-review.md`.
