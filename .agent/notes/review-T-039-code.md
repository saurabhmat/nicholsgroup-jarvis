# T-039 code review (Nov 2, 2026)

Reviewer note: the `code-reviewer` subagent could not be launched from this run (no sub-agent tool), so this is a self-review. Re-run with the subagent before merge if wanted.

Result: 0 BLOCKER, 0 HIGH. Fixed during review: (1) payload size check used `pg_column_size` (compressed, so a large repetitive payload would pass); now `octet_length(payload::text)`, with a test. (2) TS depth rule differed from SQL for scalars at depth 16; aligned. (3) `getLaneJobClient` may only be named in the vault folder (lint); the `rawRecords` instance is created in `vault/index.ts` and re-exported from `raw/index.ts`; lint rules and tests added for `rawRecords` / `createRawRecordStore`.

Open (not blocking)
- M1: SQL and TS keep two copies of the content-provider and body-name lists; a Vitest test parses the migration and compares them, so drift fails CI. A later migration that changes the SQL list must update the test's migration path.
- M2: the store makes one policy read per call (per sink batch). Cache per run when T-038 wires the sync, if the extra query matters.
- L1: `upsertRawRecords` returns the DB row count, which counts rows touched, not rows changed.
- L2: `source_updated_at` is not used to drop stale out-of-order writes; the sync runner serialises per connection (T-038), so last write wins.
- L3: the batch is all-or-nothing only per 500-record chunk; a failure in chunk 2 leaves chunk 1 written. Upserts are idempotent, so a retry is safe.
