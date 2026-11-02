# T-039 code review (independent code-reviewer on b7c50df)

| ID | Finding | Disposition |
|----|---------|-------------|
| M1 | Conflict update could overwrite newer data with an older payload | Fixed: where-guard on source_updated_at; stale rows are skipped and not counted. pgTAP test. |
| M2 | Unchanged payloads are rewritten | Deferred: skipping would also freeze synced_at ("last seen") and change the returned count. Hash stays stable on identical re-upsert (tested). |
| M5 | Parity test hardcoded the migration name | Fixed: globs for *_raw_source_records.sql (and asserts exactly one). |
| Low | Vacuous "never echoes" test | Fixed: expect.assertions plus toThrow. |
| Low | lane_mismatch kind not asserted in the sink test | Fixed. |
| Low | No store-level idempotency test | Added. |
| Low | Missing pgTAP: direct UPDATE through trigger, 1000-record cap (54000), non-object payload, identical re-upsert hash | Added. |
| Note | SQL batch limit (1000 records, 8 MB) differs from TS (500 records, ~5 MB) | Deliberate; documented in both files. |

## Round 2 (changes reviewed with the security round on 173484c)

| ID | Finding | Disposition |
|----|---------|-------------|
| - | No separate code-review findings this round; the security findings above (H-1, M-A, M-B, M-C, L-1..L-3) were all fixed. | See review-T-039-security.md. Parity of SQL and TS lists, regex alternation order (no safe token is a prefix of a later one) and shared key_words fixtures are pinned by tests. |
