# Review T-036 DB (commit b67e25c), SQL only

Files: supabase/core/supabase/migrations/20261104140000_webhook_events.sql, supabase/core/supabase/tests/140_webhook_events.test.sql, 050_catalog change.
Nothing was run (no reset, no test:db). Static review only.

Result: no BLOCKER, no HIGH. 2 MEDIUM, 5 LOW.

## Verified clean
- Columns: no payload/body column; payload_hash is a 64-hex check; unique (lane_id, provider, event_id) at :36; status check (:32); all times timestamptz.
- Lane-consistent FK (connection_id, lane_id) -> connections (id, lane_id) (:38), target unique exists.
- RLS enabled; policy uses aal2 + core.allowed_lanes(..., 'health') in the standard form (:52-57). Column grant omits payload_hash (:60); all table privileges revoked from service_role/anon/authenticated (:59).
- All four functions: security definer, search_path = '', pg_catalog-qualified, execute revoked from public/anon/authenticated, granted to service_role only; registered in 050_catalog.
- Claim race (two concurrent claims, same new event): INSERT ON CONFLICT DO NOTHING blocks on the first uncommitted insert, then returns nothing; the guarded UPDATE sees status 'received' with fresh updated_at, so it returns no row, so 'duplicate'. Two concurrent re-claims of a failed row: the second UPDATE re-evaluates its WHERE after the first commits (READ COMMITTED) and no longer matches. Only one 'process'. Correct.
- Resolve: query filters provider + lower(external_account_id) + status not in (...), matching the partial unique index connections_one_lane_per_account (provider, lower(external_account_id)) where status not in ('disconnected','pending') (migration 20261104110000). The predicate is syntactically identical, so the planner can use it; lane_id and lanes.enabled are applied as filters on the single matching row. Fine.
- Indexes: claim/mark use the unique key; purge uses (lane_id, received_at); connection_idx supports the FK. Adequate.
- Purge floor of 7 days enforced (:200), lane-bound, null-safe.

## MEDIUM

M1. No race simulation in pgTAP (140_webhook_events.test.sql:67-93). The claim tests are sequential only; "two concurrent deliveries cannot both get 'process'" (migration :102) is asserted nowhere. A single pgTAP transaction cannot interleave, but the guarded-UPDATE half is testable: after a 'process' claim, a second claim must return 'duplicate' (covered at :71), and after a stale re-claim a third immediate claim must return 'duplicate' (NOT covered: a fresh row after reclaim, :92 is followed by no duplicate check). Fix: add after :93 a `duplicate` assertion for evt-2 and for the failed-retry reclaim at :82. For true concurrency add a dblink/two-psql script outside the pgTAP suite (or document it as not tested) and say so in the PR.

M2. Stale re-claim can double-enqueue; mark has no claim token (migration :145 and :176-178). Receiver A claims, stalls past 2 minutes; receiver B re-claims (updated_at reset) and enqueues; A then wakes, enqueues and marks 'enqueued'; B's mark returns false. Two Inngest events for one provider event. Also a stale A marking 'failed' can overwrite B's in-flight 'received'. Fix (either): (a) have claim return attempts (or add an attempt column check) and make mark take p_attempt and match `w.attempts = p_attempt`; and/or (b) require the receiver to send the Inngest event with a deterministic id (hash of lane:provider:event_id) so Inngest dedupes, and note downstream handlers must be idempotent. At minimum document in the PR that handlers must be idempotent. Note attempts is capped at 1000, so it is not a perfect token after the cap; use a separate uuid claim_token column if strict.

## LOW

L1. Claim fallthrough returns 'conflict' when the row vanished (migration :151-154). If purge deletes the row between the ON CONFLICT and the SELECT, v_hash is null and `is distinct from` yields 'conflict' for a legitimate event. Only possible for rows older than 7 days, so practically unreachable, but wrong. Fix: if v_hash is null return 'process' via a retry insert (loop once) or raise a retryable error.

L2. Conflict on reclaim silently overwrites the stored hash (:142). A body change on a failed/stale retry is intended (documented), but the first hash is lost, so a later "different content" signal is lost. Acceptable; consider an `original_hash` or log from the receiver (the receiver cannot see the old hash, as claim returns only 'process'). Optionally return 'process_changed'.

L3. Test gaps (140_webhook_events.test.sql). Missing: claim on a disabled lane refused; mark with wrong provider returns false; service_role direct `select` on the table actually throws (only has_table_privilege is used, :28); attempts reaches expected value after the stale reclaim (only checked =2 once, :85); purge null lane / null keep; purge of a row with status 'received'; a unique-key violation asserted directly (cross-lane no-collision at :96 is covered, same-lane is covered via duplicate). Positive controls for reads are good (admin_technical, owner), anon and aal1 and cross-lane denial present.

L4. `select *` by authenticated fails with 42501 because of the column grant (:60). Expected, but any generated client or PostgREST `select=*` will error. Make sure packages/core/src/db/types.ts consumers list columns, and mention it in README. No security issue.

L5. Provider list duplicated in the CHECK (:24) and in core.connections; they can drift when a provider is added. Fix: a note in the migration, or a single `core.is_provider(text)` function used by both in a later migration.

L6. FK `on delete restrict` on (connection_id, lane_id) (:38) blocks any hard delete of a connection for up to the retention window (30 days). Consistent with the no-deletion rule, but T-042 / any disconnect-and-erase flow must purge receipts first (purge floor of 7 days prevents it) or the FK should be `on delete cascade`. Decide and note in plan-review.

L7. Purge is a single unbounded delete (:203). After a long outage of the retention job it could be large. Fix: optional p_limit with a batched delete (ctid/id in subquery limit), returning the count.
