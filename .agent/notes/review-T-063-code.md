# T-063 code review: findings and resolution

| # | Sev | Finding | Resolution |
|---|---|---|---|
| M1 | MED | Concurrent or replayed pages could interleave | `core.comms_mail_apply_page` takes `pg_advisory_xact_lock` per connection and compares the stored cursor with `p_expected_cursor` (the cursor the run read) before storing the new one; mismatch raises SQLSTATE D0409, which the store returns as `conflict: true` (a normal outcome: the run stops, no retry loop). Header comment corrected: replay safety comes from the cursor CAS, not from timestamps. pgTAP + TS tests. |
| M2 | MED | A stale page could un-delete a row | `deleted` is cleared only when the caller passes `p_revive` (fresh page of the run that won the CAS). Without it an upsert updates the row and leaves it deleted. pgTAP. |
| M3 | MED | A poison page could loop as "transient" / pages over 1000 failed | Store cuts a page into chunks of 500 (cursor, completion flag only on the last; earlier chunks are idempotent); SQLSTATE class 22/23 maps to `invalid_input`; missing incoming `source_updated_at` counts as oldest. |
| M4 | MED | Gmail 403 rate limits not retried | `api.get` retries a 403 with a rate-limit reason (3 attempts, 1 s / 3 s pauses); 429 is retried by the HTTP client with Retry-After. Tests for both, and for a plain 403 not being retried. |
| M5 | MED | TRASH/SPAM inconsistent with messages.list | A fetched message carrying TRASH or SPAM is a removal; removing the label re-adds it (revive). Documented in `mail.ts`. Tests (provider and sync run). |
| L1 | LOW | Page-token charset / resync loops | Charset widened to `[A-Za-z0-9_=+/.%-]`; at most one resync per run (a second is `provider_error`). |
| L2 | LOW | history types implicit | `historyTypes` = messageAdded, messageDeleted, labelAdded, labelRemoved sent as repeated parameter. Test. |
| L3 | LOW | `received_at` fell back to now() | Uses internalDate, else the Date header; neither = message skipped with a content-free log line. Test. |
| L4 | LOW | `has_attachments` heuristic | Logged in docs/plan-review.md. |
| L6 | LOW | FK on `sync_cursors` | `on delete cascade` (derived state). The disconnect path keeps the connection row and does not delete cursors, so nothing else needed. |
| L7 | LOW | `mapLimit` in-flight workers | Logged in docs/plan-review.md. |
