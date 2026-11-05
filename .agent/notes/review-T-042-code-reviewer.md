Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I reviewed the uncommitted T-042 changes by reading the code. I did not run any tests: typecheck, lint, vitest and pgTAP are all unrun. There are no BLOCKER or HIGH findings.

## Required fixes (MEDIUM)

1. **Conversations are never purged, and the acceptance criterion isn't met.**
   - The criterion says "comms 90, calendar 180, conversations 180".
   - `retention/tables.ts:9-16` registers no conversations table. It shows up only in `emptyClasses` (`retention/job.ts:31-34`).
   - The notes defer it to T-103. That is reasonable, because no table exists yet.
   - Record the gap where a human will see it: a line in `docs/plan-review.md`, and a "T-103 must register ai.* with the retention registry" note in `.agent/pr/T-042.md`. Without that, the job returns `ok: true` while a class is unenforced.

2. **`.agent/pr/T-042.md` is missing.**
   - The definition of done requires it: changes, tests, risks and anything needing a human. `.agent/pr/` has only T-063, T-064, T-075, T-198 and T-199.
   - It should record the security-review findings. The `security-reviewer` run is not evidenced in the diff.

3. **A malformed config is retried like a transient fault.**
   - `packages/connectors/src/vault/lane-config.ts:~88-100` throws `provider_error` from `retentionSettings` for invalid values, and `connection_unavailable` for a missing policy.
   - `handleRetentionPurge` (`packages/core/src/inngest/retention-purge.ts:41`) calls `purgeLane` directly with no error mapping, so every thrown error is retried 3 times.
   - Permanent configuration errors will burn retries and never surface distinctly.
   - Map non-transient `ConnectorError` kinds to `NonRetriableError` in the Inngest function, or in the `purgeLane` wiring in `route.ts`.

4. **Nothing reports a purge that has finally failed.**
   - `retention/job.ts:41-44` logs only `table` and `class` on failure. There is no error kind.
   - `retention-purge.ts:43-44` throws a count-only message. There is no `onFailure` handler, Sentry or audit entry.
   - A permanently failing purge would leave data past its retention window with no signal.
   - Add the error name or kind to the log, and an `onFailure` hook or alert. It is acceptable to log this as a follow-up in `docs/plan-review.md`.

5. **The pgTAP header claims coverage the test lacks.**
   - `190_retention_purge.test.sql:5` says "fin rows keep working".
   - The migration comment (lines 14-15) says fin rows get `raw_record_id` set to null when a raw row is deleted.
   - There is no fixture for this, and the plan of 34 tests contains none. The foreign key does exist (`fin_ledger_and_reports.sql:77-78`, `on delete set null (raw_record_id)`).
   - Either add a test, or delete the claim from the header. Content providers are unlikely to be referenced by `fin.*`, so a short test is enough.

## Optional suggestions (LOW)

- **Destructive policy toggle.** `core.source_records_purge_bodies` (`20261105180000_retention_purge.sql:70`) deletes whole rows when `store_content_bodies` is false or the policy row is missing. It fails closed, which matches the T-039 note, but a mistaken toggle loses data irrecoverably. Say so under "Risks" in the PR.
- **Silent zero.** `retention/store.ts:32` turns a non-integer RPC result into `0`. A malformed result would then look like a clean success. Throw instead.
- **No audit trail.** Deletion counts go to logs only. If retention deletions should be auditable, write a per-lane audit row. Check this against the audit rules.
- **Unrelated file.** `.agent/notes/checkpoint-2026-11-02-b.md` is untracked and not part of T-042. Keep it out of the commit.
- **Unused setting.** `retentionSettings` reads `conversationsDays` and nothing uses it yet. That is fine, but the unit tests exercise it only through `DAYS`.
- **Test gaps.** The function-config test reaches into Inngest internals through `opts`. The schedule's `step.sendEvent` fan-out also looks untested (my read of the test file was partial).

## Checked and fine

- **Rule 1:** lane ids are validated, and the lane router supplies the clients.
- **Rule 2:** day counts come from `lane_policies` and `lane_config`, not from code.
- **Rule 3:** the migration adds no new table, so there is no new RLS surface.
- **Rules 4 and 5:** only connectors call the database, and nothing writes to an external system.
- **Rule 6:** only counts are logged, with no row text.
- **Error text:** `store.ts` drops the database error text.
- **SQL entry points:**
  - The comms and calendar wrappers are SECURITY INVOKER and `service_role` only.
  - The body purge is lane-checked and has a pinned `search_path`.
  - It is added to the `050_catalog` allowlist of SECURITY DEFINER functions.
  - The wrappers add lane-enabled checks and explicit intervals, and the underlying floors and caps still apply.
- **pgTAP:** the plan of 34 matches the 34 assertions I counted. The tests use time-shifted fixtures at the boundary in two lanes, and include cross-lane denial and disabled-lane tests.
- **Wiring:**
  - The 03:00 America/New_York cron, with a per-lane fan-out.
  - Concurrency keyed on `laneId`, limit 1.
  - Retries.
  - A lane-served check.
  - Event validation re-run in the handler.
  - `route.ts` wiring.
  - The refactor that extracts `readRetentionDays` leaves `retentionDays` behaviour unchanged.
- **Dependencies:** no new ones.
- **Config schema:** the `retention` section is a `prefault({})` with strict bounds that match the database floors and caps.
