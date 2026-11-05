Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I found no BLOCKER or HIGH issues, so T-042 isn't blocked. There are 3 MEDIUM and 5 LOW findings. I read every changed and untracked file but didn't run typecheck, lint or the tests. This was a read-only review and no files were changed. Plan mode asked for a plan file, but I had no tool to write one.

## Checklist results
- **`laneId` and lane router:** every function, event, store call and log line carries a lane id. The new store and settings reader get their database clients from `getLaneJobClient`. The Inngest event uses a strict Zod schema (`retentionPurgeRequested`), and the worker checks it again. The worker skips lanes this deployment doesn't serve, and the SQL refuses disabled or unknown lanes.
- **RLS:** no new table, so there are no new policies to add. pgTAP 190 checks privileges: only `service_role` can run the new functions, `anon` and `authenticated` can't. It also checks that purging one lane never deletes another lane's rows, in both directions, for comms, calendar and raw records.
- **Service-role key:** it only shows up in the server-side job path, behind `server-only`, and nothing here uses `NEXT_PUBLIC_*`.
- **Secrets and logs:** no tokens are involved. Logs hold only lane, table id, class, days and counts. Errors use fixed messages and drop the database cause.
- **Not touched by this change:** AI tools, prompts, external writes, approvals and webhook receipt.
- **Stored bodies:** the change reduces stored bodies, because `core.source_records_purge_bodies` deletes them when the lane's `store_content_bodies` policy is off. The 050 catalog test lists the new SECURITY DEFINER function with a reason.

## MEDIUM

**M1 — A bad `lane_config` stops every purge for the lane, including the ones that don't use it.** `packages/connectors/src/retention/job.ts:26` (settings read), with `packages/connectors/src/vault/lane-config.ts:84-102`.
`deps.settings(laneId)` throws before any table runs. A malformed `lane_config.retention`, or a temporary read error on `lane_config_current`, therefore also skips:
- the comms purge, whose days come only from `lane_policies.retention_days`;
- the raw-body purge, which uses no days at all.

The result is data kept longer than the lane policy allows. The guard is meant to keep too little data from being kept; here it causes too much to be kept.
**Fix:** read the lane policy and `lane_config` separately and keep going when only one fails.
- Always run the `policy` class (raw bodies) and `comms` (as long as `lane_policies` can be read).
- Only skip calendar, conversations and webhooks when `lane_config` is bad, and record them as `error: "settings_invalid"` so the run still fails and retries.
- Add a test: malformed `retention` section → comms and body purges still run.

**M2 — `raw.source_records` has no time-based retention.** `supabase/core/supabase/migrations/20261102080000_raw_source_records.sql:221` says a row marked `deleted` "stays until retention purges it". T-042 never purges those rows, and the raw payloads of non-content providers (QuickBooks, Stripe) or of lanes with bodies allowed are never aged out either.
**Fix:** do one of these:
- add `core.source_records_purge(lane, keep)` (definer, lane-checked, ≥ N-day floor) for `deleted = true` rows older than the window, and maybe for stale `synced_at`, then register it as `raw.source_records_deleted`; or
- record the gap in `docs/plan-review.md` and fix the T-039 comment.

Watch the `fin.*` foreign keys, which are set to null on delete.

**M3 — Stored bodies have no age limit while `store_content_bodies` is on.** `supabase/core/supabase/migrations/20261105180000_retention_purge.sql:71-73`. The body purge only runs when the policy is off. With it on, email and document bodies in `raw.source_records` are kept forever, with no limit tied to `retention_days`. Rule 6 allows storing them, but whether there should be a time limit is a product question.
**Fix:** when the policy is on, delete body-carrying rows older than `lane_policies.retention_days`, or log it as an open decision in `docs/plan-review.md`.

## LOW

- **L1 — The test header claims more than it tests.** `supabase/core/supabase/tests/190_retention_purge.test.sql:5` says "fin rows keep working", and migration line 10 describes `fin.*` rows having `raw_record_id` set to null. No test covers this, and `fin` rows come from QuickBooks/Stripe, which aren't content providers, so the body purge can't reach them. **Fix:** drop the claim, or add one assertion that a `fin` row tied to `pkg-inv` survives.
- **L2 — The body purge scans every payload.** `20261105180000_retention_purge.sql:74-77` runs `raw.payload_has_body_field(payload)` on every content-provider row in the lane, daily, with payloads up to 1 MB. It's harmless while the policy is off, because the trigger already refuses new bodies, but the scan cost grows with the table. **Fix:** check the lane policy before scanning (already done) and add a per-call row `limit`/batch loop, or note the cost.
- **L3 — Bad return values become 0.** `packages/connectors/src/retention/store.ts:32` turns a non-integer RPC result into `0`, so an unexpected return shape looks like "nothing to purge". **Fix:** throw `RetentionStoreError` instead.
- **L4 — Lane checks are inconsistent.** The new wrappers refuse disabled lanes, but `core.webhook_events_purge` (from T-036, called through `webhookStore.purge`) doesn't check that the lane is enabled. **Fix:** log it in `docs/plan-review.md`, or add the same `core.lanes … enabled` check in a follow-up migration.
- **L5 — Day limits are defined twice.** The bounds (30–180, 1–3650, 7–365) appear in both `packages/core/src/lane-config/index.ts:102-110` and `packages/connectors/src/vault/lane-config.ts:98-100`. **Fix:** export the bounds from core and import them in the reader, or add a test that compares the two.

## Notes (no action)
- The worker throws only after every table has run, and retries repeat deletes that are safe to repeat. Per-lane concurrency is 1, and the schedule fans out one event per enabled lane.
- An invalid `retention` value fails with error kind `provider_error`. That's an odd kind for a config error, but it matches how `calendarSettings` and `mailboxes` already handle invalid values.

Since T-042 is app code (data access), the MEDIUM and LOW findings can ship if they're listed in `.agent/pr/T-042.md`. I'd still fix M1 before merging, because it can quietly stop a privacy purge from running.
