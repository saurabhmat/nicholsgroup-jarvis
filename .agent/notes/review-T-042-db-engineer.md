Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I found no BLOCKER or HIGH issues in the T-042 changes. I read the code only: I didn't run `supabase test db`, `pnpm test` or the typecheck, and I didn't use the security-reviewer subagent. I did count the pgTAP assertions, and they come to 34, which matches `plan(34)`.

Foreign-key behaviour, checked separately: `on delete set null (raw_record_id)` nulls only that column (`fin_ledger_and_reports.sql:78`, `:110`, `:141`), so the composite `connection_id` stays non-null when a raw record is deleted.

## MEDIUM

1. **The fin-row claim is untested** (`190_retention_purge.test.sql:5`, `migrations/20261105180000_retention_purge.sql:11`). The header here and the migration comment both say fin rows keep working after a raw delete. The test file contains no `fin.*` fixture. A fin row pointing at a purged raw record should be inserted, and the test should assert its `raw_record_id` becomes null and the row survives.

2. **The body purge deletes whole rows, including GoHighLevel records** (`migrations/20261105180000_retention_purge.sql:74-77`).
   - `raw.is_content_provider` includes `gohighlevel`, and GoHighLevel is the source of subscriber status (rule 8).
   - A GoHighLevel payload with a field like `description` or `notes` would be deleted entirely when the lane policy has `store_content_bodies` off.
   - That is fail-closed and matches the T-039 note.
   - I couldn't tell from this review whether deleting is wanted over redacting. Please confirm that, or record it in `docs/plan-review.md`.

3. **A missing lane policy deletes bodies, and nothing logs it** (`migrations/20261105180000_retention_purge.sql:71`). With no `lane_policies` row, the `coalesce(..., false)` treats the policy as off and deletes. That is the safe direction. But `readRetentionDays` throws for a missing policy, so the job fails the lane before the `policy` class ever runs. Missing policy therefore never reaches the body purge in the job path. That is fine, but it's worth a comment and a test, since the SQL and the job disagree.

## LOW

4. **Retention defaults and bounds are written twice.**
   - The Zod defaults and bounds are in `packages/core/src/lane-config/index.ts:102-109`.
   - The same numbers are hard-coded in `packages/connectors/src/vault/lane-config.ts` as `DEFAULT_RETENTION` and the `days(...)` calls (30/180, 1/3650, 7/365).
   - They can drift apart. Import the shared constants or add a test that pins them to each other.

5. **Misconfigured retention reports the wrong error kind** (`vault/lane-config.ts`, in `retentionSettings`). `bad()` returns `provider_error` for a bad lane config. Please check which kind `calendarSettings` and `readConfig` use for the same case, so error handling is consistent.

6. **An out-of-range comms setting fails the whole lane.** `lane_policies.retention_days` outside 1–3650 throws in `readRetentionDays`, so the calendar, webhook and raw-body purges don't run. That fails closed, and it is logged. If that is deliberate, note it in `.agent/notes/T-042.md`.

7. **The schedule step list can go stale** (`packages/core/src/inngest/retention-purge.ts:60`). `step.run("plan")` reads `ENABLED_LANES` from the environment. The SQL `core.lanes.enabled` check is a second gate, so a lane disabled in the database only fails at purge time. This is the same pattern as `conn-sync`, so it's acceptable.

8. **`webhooks.purge` has a test gap.** `tables.ts` calls it with `need(days)`, and the database refuses under 7 days. `retentionSettings` enforces ≥7 first. A test that passes through the real bounds would pin the two layers together.

## Checked and fine

- **Privileges:** the three new functions have `revoke all ... from public, anon, authenticated` and a grant to `service_role` only.
- **Search path and definer status:** all three use `set search_path = ''`, and only the body purge is `security definer`. It is lane-checked and listed in `050_catalog.test.sql`.
- **Cross-lane denial:** it is tested for comms, calendar and raw.
- **Existing SQL used:** the new code calls `comms.message_index_purge` (`comms_cal_index.sql:281`), `cal.event_index_purge` (`:316`) and `core.webhook_events_purge`. The caps and floors stay enforced there.
- **Logging and errors:** the job logs counts only. Store errors carry fixed messages with no database text.
- **Failure handling:** one table failing doesn't stop the others, and the run then fails so it retries.
- **Event handling:** the event schema is strict and `laneId` is required. The worker validates the event again and checks the lane is served.
- **Concurrency:** the key is `event.data.laneId`, limit 1, as in `conn-sync`.
- **Lane router and rule 1:** DB access goes through `getLaneJobClient`, which is the lane router. Every function takes a lane.
- **Rule 5:** the job only deletes the job's own retained data through SQL functions. It doesn't write to any external system.
