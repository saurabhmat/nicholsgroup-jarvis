# Code review: T-055 (commit a7e4c3d), finance schema part 1

Checks run: `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0; `node --test scripts/*.test.mjs` 138/138 pass.
Not run (database in use by another reviewer): `pnpm test:db`, `pnpm db:types:check`. Run `db:types:check` after the next reset.
Verdict: no BLOCKER. One HIGH (fitness for T-056). Spec conformance is good; the deviations are documented in the PR and plan-review.

Paths: M = supabase/core/supabase/migrations/20261104120000_fin_ledger_and_reports.sql, T = supabase/core/supabase/tests/130_fin_ledger_and_reports.test.sql

## Spec conformance
Every column in spec §5 Part 1 is present on all six tables, with the right types (numeric(18,2), date, timestamptz). The extra columns (connection_id, provider, raw_record_id, source_updated_at, deleted, line_no, created/updated_at) and the report_cache unique key including connection_id are justified and logged. The standard lane policy, service_role-only writes and cross-lane FK/read denial match §5. The "no account/routing number, no balance on accounts" rules are enforced and tested. The T-055 acceptance in backlog.md is met. The task still says `status: approved`; the DoD says to set `done` on merge, so confirm that happens with the PR.

## BLOCKER
None.

## HIGH
H1. fin.payments cannot be upserted idempotently by T-056 (M:149-176, M:274).
- The natural key is an expression index: `(connection_id, source_id, coalesce(invoice_id, '0000...'::uuid))` (M:174). `ON CONFLICT` and the supabase-js/PostgREST `upsert(onConflict: 'col,col')` cannot target an expression index. The normalizer would need an RPC or a delete-then-insert.
- `invoice_id` is also an identity column (M:274), so a payment that is re-allocated or becomes applied later cannot be updated. The old row has to be deleted (service_role can) or tombstoned (the security review's L7 notes the double-count risk).
- Both break the T-056 acceptance "re-run produces no diff" and are cheap to fix now, before any data exists.
- Fix: model allocations like transaction lines. Add `alloc_no integer not null default 0 check (alloc_no >= 0)` with a plain `unique (connection_id, source_id, alloc_no)`. Make `invoice_id` mutable (drop it from the identity list, add `alloc_no`). Drop `payments_source_alloc_key`. Update the tests (T:133-ish unique test, T identity test on `invoice_id`). Alternatively keep the design and write the delete+reinsert contract into the migration comments and the T-056 task.

## MEDIUM
M1. Raw purge scans every fin table (M:62, 92, 123, 155, 189, 229).
- `raw_record_id` has the FK `(raw_record_id, connection_id) -> raw.source_records ... on delete set null`, but no index on it. Each deleted raw row (retention purge, T-039) runs a seq scan of the referencing table, which is O(purged rows x table size) on `fin.transactions`.
- Fix: `create index ... on fin.<t> (raw_record_id) where raw_record_id is not null` on all six tables. Add a catalog assertion if cheap.

M2. No names for customers, vendors or classes (M:92-96, 123-127; fits spec §5 literally).
- AR "by class or customer" and AP views (§4.4, §6 `v_ar_aging`) have only opaque `class_id`/`customer_id`/`vendor_id` text. T-081 cannot label buckets or the tie-out to Sophie's report without a second source: the raw payloads (which are not readable by authenticated and carry more than needed) or lane_config.
- Fix: add nullable `customer_name`, `vendor_name`, `class_name` text to invoices, bills and transactions (length checks, covered by the forbidden-column regex), or a small `fin.dimensions (lane_id, connection_id, kind, source_id, name)` table. Decide before T-056 or log it as a T-080 prerequisite.

M3. Cash view depends on report_cache JSON that the schema does not constrain (M:224-248).
- `v_cash_book_balance` has to pick the latest unsplit Balance Sheet per connection and match payload rows to `fin.accounts.source_id`. That needs a stable convention that the schema does not carry: the unsplit/class-filtered/method marker lives only inside `params` (opaque hash), and the payload must keep the account Id on each row.
- Fix: document the params keys (`method`, `class`, `start`, `end`) as a contract in the migration comments or T-052, and pin the account-id-in-payload requirement in the T-052 acceptance. Optionally add a `class_filter text` column (null = unsplit) so views do not parse jsonb.
- Related: the `report_cache_lane_report_asof_idx` index omits `connection_id`. Use `(lane_id, connection_id, report, as_of desc)`; the unique index already covers a prefix, so this one may be redundant.

M4. Money is typed `number` in the generated types (packages/core/src/db/types.ts, `amount`, `balance`, `total`).
- This is how the CLI maps numeric and is the same elsewhere. But spec §7 requires string figures with two decimals. T-081 must read money through views or casts to text, never `select *` into JS arithmetic. Add one line to the T-081 task or the PR risks. No code change in T-055.

M5. T-056 ordering constraints are not documented.
- Composite FKs mean accounts must exist before transactions, and invoices before payments. CDC delivers entity types in any order, and a payment may reference an invoice outside the sync window. The normalizer needs a topological order and a rule for "invoice unknown" (null the allocation and flag it?). Add this to the T-056 task notes. Not a T-055 change.

M6. The `period_lock` control (§4.5 #6) has no source in part 1.
- Nothing in these six tables holds the books-closed-through date. It is probably CompanyInfo/Preferences via T-052 or lane_config. Log it so T-196/T-094 do not discover the gap late.

## LOW
L1. T:216 comment is garbled ("APK has 1 of each (2 payments? no: 1)"). Rewrite it to the facts: PKG 3/1/1/2/2/1, APK 1/1/1/1/1/1.

L2. T:257 restores `memberships.views` to a hard-coded list that does not include `finance`. It is rolled back, but the line reads like a restore. Reword the comment ("viewer with all other views but not finance") or capture and restore the original value.

L3. Test gaps worth adding (all cheap):
- A payment cannot point at an invoice of another connection in the same lane.
- Caller-supplied `params_hash` is overridden on INSERT (only UPDATE is tested).
- The `params` (4096) and `payload` (4 MB) size caps and the `params` object check.
- `deleted` defaults to false.
- The `id` and `params` are not frozen (security review L3). Decide and pin the behaviour with a test.
- The hard-coded `plan(213)` is brittle; acceptable under the repo convention.

L4. T:41-43 "exactly six money columns" is a good guard. It will need updating deliberately when T-057 adds Stripe `numeric(18,2)` columns. Scope it to the six T-055 tables by name so T-057 does not have to edit this file.

L5. M:233 `params_hash ... default ''` relies on the BEFORE trigger running before the CHECK. This works, but add a one-line comment, or drop the default (callers cannot omit a NOT NULL column when the trigger fills it? they can; the trigger runs before the NOT NULL check in Postgres, so the default is unnecessary but harmless).

L6. M:213 `transactions_lane_id_idx` is a prefix of `transactions_lane_account_date_idx` (and the other tables' lane_id indexes are partly redundant with the composite indexes). Keep it if the catalog test requires a lane_id index; otherwise drop it to cut write cost.

L7. M:174 `provider = 'quickbooks'` as a CHECK on every table pins the schema to one accounting provider. Fine for the pilot; note that adding a second provider needs a migration on six tables.

## gen-db-types script and regenerated types
- scripts/gen-db-types.mjs: a one-token change (`public,core,audit,fin`) plus the header comment. Correct. `gen types --local --schema fin` does not need PostgREST exposure. No test covers the schema list (the existing `--check` path covers drift). Optional: hoist the list to a `const SCHEMAS`.
- packages/core/src/db/types.ts: the `fin` block is complete and matches the migration (all columns present; money `number`; nullable/optional flags right; the only Relationships are intra-fin FKs because core/raw are not in the schema list). Formatting matches the existing generated style (`},"fin": {`). I could not run `db:types:check` against the live DB (database busy). Run it after the next `db:reset` to confirm no drift.
- `fin` is typed but not exposed to PostgREST, so a `.schema('fin')` client call fails until T-081 adds it to `api.schemas` and `scripts/supabase-config.test.mjs`. Documented; fine.

## Fitness for downstream tasks
- T-056: idempotent upserts work for accounts, invoices, bills, transactions and report_cache (plain unique keys). Payments do not (H1). The voided/deleted flags, `source_updated_at`, `raw_record_id` and `entity_code` default `'unmapped'` give the normalizer what it needs. Sign convention and `posted_at` rule are left to T-056 and logged; T-056 must pin them in a test.
- T-081 / views: AR aging (invoices: balance, due_date, class_id, customer_id, entity_code, voided/deleted) and AP due <=14d (bills: balance, due_date) are straightforward with `fin.et_date(now())`. The partial indexes on `balance <> 0` should be matched by `balance <> 0` in the views, not `> 0`, to be safe. P&L MTD/YTD and cash work only through report_cache JSON (M3). The controls `uncategorized_transactions`, `unmapped_entity` and `shared_bank_account` are covered (flag, entity_code, account_id). Missing: names (M2), `period_lock` source (M6); `unreconciled` is T-191's table.

## Scope
No creep. The two supporting unique indexes on core.connections and raw.source_records, the README line and the plan-review entry are all justified and disclosed. The security-reviewer note .agent/notes/review-T-055-security.md is untracked, from the parallel review, and not part of the commit.
