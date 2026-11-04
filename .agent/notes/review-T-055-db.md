# Review T-055 (a7e4c3d) database, finance schema part 1

Paths: M = supabase/core/supabase/migrations/20261104120000_fin_ledger_and_reports.sql, T = supabase/core/supabase/tests/130_fin_ledger_and_reports.test.sql.
Ran locally: `pnpm test:db` PASS (14 files, 915 tests), `pnpm db:types:check` ok. Live grants checked: service_role has INSERT/SELECT/UPDATE/DELETE only, authenticated SELECT only, anon nothing; no FORCE RLS anywhere in the project (consistent, not required).

Verdict: no BLOCKER. 1 HIGH, 5 MEDIUM, several LOW. Types, composite FKs, RLS policy shape, grants and the two triggers are sound.

## HIGH

H1. No currency column (M:86-111, 117-142, 149-171, 183-211). Spec §11: "Foreign currency is excluded and flagged". Without `currency_code` the normaliser has nowhere to mark a non-USD invoice, bill, payment or line, so T-056/T-081 would sum EUR into USD silently (rule 7), and the later `unsupported`/control path has nothing to read. Fix: add `currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$')` to invoices, bills, payments, transactions (and accounts if QBO multicurrency is on); views filter `currency_code = 'USD'`. Cheap now, a backfill migration later.

## MEDIUM

M1. fin.payments grain and key (M:174-175, 274). (a) The unique key is an expression index (`coalesce(invoice_id, zero-uuid)`); `ON CONFLICT (cols)` and PostgREST/supabase-js `upsert(onConflict)` cannot target it, so T-056 idempotent upsert needs raw SQL or an RPC. (b) `invoice_id` is in the frozen identity set, so a payment that goes unapplied -> applied (or is re-allocated) in QBO cannot be updated; the normaliser must delete + insert, which contradicts the header ("never hard-deleted") and the missing-delete guard. (c) Two allocation lines of one payment to the same invoice collide on the key. Fix: add `line_no integer not null default 0 check (line_no >= 0)`, `unique (connection_id, source_id, line_no)`, make `invoice_id` a mutable value, and freeze `(lane_id, connection_id, provider, source_id, line_no)`. Update test T:~205 (re-point test) and the unapplied-unique test accordingly.

M2. No index on the raw FK columns (M:77, 109, 140, 167, 207, 242). `ON DELETE SET NULL (raw_record_id)` runs a lookup on each of six fin tables per purged raw row; without an index each purge row seq-scans transactions/invoices/etc. (quadratic on retention purge). Fix: `create index <t>_raw_record_idx on fin.<t> (raw_record_id, connection_id) where raw_record_id is not null` on all six. (Same check for report_cache lookups by `connection_id` alone: the unique key starts with `lane_id`, so the `connection_id` FK check on connection delete also scans; add `(connection_id)` there.)

M3. report_cache payload has no DB guard (M:234, plan-review notes it). raw.source_records runs `raw.payload_scan` for forbidden keys (tokens, account/routing numbers) on every write; report_cache stores 4 MB of jsonb with only a size and type check. Rules 4/6 defence in depth. Fix: call `raw.payload_scan(new.payload, 'quickbooks', false)` in a before insert/update trigger (same 22023 error, no echo). Also `params`/`params_hash` are not frozen (M:273) although they are the cache key: an UPDATE of params silently re-keys the row (or hits 23505). Add `params` and `params_hash` to the report_cache identity list (hash trigger still runs on insert).

M4. Header-level `class_id` and `entity_code` on invoices and bills (M:99-100, 130-131). QBO carries class per line on invoices/bills; a multi-class invoice gets one class and one entity, so AR/AP by class (spec §4.4, D-18) misattributes. Not fixable in this commit without a decision. Fix options: add `fin.invoice_lines`/`bill_lines` (class, entity, amount) in part 2, or have the normaliser set entity `unmapped` + flag when lines disagree (control 7). Record the decision before T-056.

M5. Index coverage gaps for obvious paths (M:113-114, 144-145, 213-217):
- invoices: no (lane_id, customer_id) (customer drill-down, customer mapping) and no (lane_id, issue_date). Open-AR partial index (lane, entity, due_date) where balance <> 0 and not voided and not deleted is good (planner proves `balance > 0` implies `<> 0`).
- bills: no (lane_id, vendor_id).
- payments: no (lane_id, paid_at); only lane_id and invoice_id.
- transactions: only (lane, account_id, txn_date) and the uncategorized partial; no (lane_id, entity_code, txn_date) for the P&L-style ledger tie-out (spec §4.4 cross-check) and class filters.
Fix: add those four or five; drop `*_lane_id_idx` on transactions (prefix of lane_account_date), keep others only if no better composite exists.

M6. Tests missing for logic the migration added (T). All pass but do not exercise: (a) a payment pointing at an invoice of the same lane but another connection (the `(invoice_id, connection_id)` FK, M:169); (b) `line_no >= 0` check; (c) hash trigger on INSERT with a caller-supplied hash (only UPDATE is tested, T:~125); (d) viewer at AAL1 and admin_technical at AAL1 (owner and finance_operator are covered); (e) a finance_operator whose lane is disabled; (f) viewer in a second lane with/without the view (cross-lane for a non-owner is covered only by finance_operator's PKG-only membership, which is acceptable but thin); (g) service_role cannot truncate is tested via privilege only, fine. Strengths: positive controls (counts 3/1/1/2/2/1 for the operator), disabled lane for owner, viewer with and without `finance`, anon 42501 per table, exact policy expression via helper, FK cross-lane and cross-connection. 213 is mostly generated rows over six tables; meaningful, not padding.

## LOW

L1. Delete guard (M:23-24 header). Header says voided/deleted rows are never hard-deleted, but service_role has DELETE and nothing prevents it. Acceptable if the normaliser is the only writer; consider revoke delete from service_role on ledger tables (keep for report_cache) or document why not.
L2. Stale posting lines. When a QBO transaction is edited to fewer lines, old `line_no` rows linger; T-056 must mark them `deleted`. Note for the T-056 spec.
L3. `raw_record_id` FK checks only `(id, connection_id)`, not that the raw row is the right provider/object_type (M:77...). A transaction can reference a raw Customer record. Low value; skip or check in normaliser.
L4. `ON DELETE RESTRICT` on connection and lane FKs means a lane/connection with finance rows can never be removed. Intentional (no deletions in scope) but offboarding or a connect-replace flow (D-23) will need a documented path.
L5. report_cache has no retention; each new `as_of` is a new row of up to 4 MB, and `as_of` is frozen so rows are never refreshed in place. Add a retention job note (keep latest N per key) before T-052 schedules frequent pulls.
L6. Identity-freeze raises 42501 (same code as permission denied). Callers cannot tell the two apart; acceptable, note in T-056 error handling. `to_jsonb(new)` per update is a small per-row cost; fine at pilot volume.
L7. Missing sanity checks: no `balance`/`total` relation, no `due_date >= issue_date`, no max on `line_no`. Intentionally lax (credits); optional `check (line_no < 100000)`.
L8. `fin.accounts.type/subtype` have no classification (income/expense) for P&L tie-out beyond free text; fine while P&L comes from report_cache.

## Checked and fine

- Types: money columns are exactly 6, all numeric(18,2) (test enforces); `*_at`/`as_of` timestamptz; dates are `date` per spec; `posted_at` nullable (spec silent).
- Composite FKs `(connection_id, lane_id, provider) -> core.connections` and `(raw_record_id, connection_id) -> raw.source_records`: MATCH SIMPLE, null raw ref skips the check, `set null (raw_record_id)` (column list) leaves connection_id intact; connection FK restrict/restrict. Same-connection FKs for account and invoice also pin the lane. New unique indexes on core.connections and raw.source_records are redundant-superset of the PK but required for the FKs; non-concurrent create is fine on these small tables.
- Triggers: hash set before identity trigger (name order a < i), jsonb text is canonical so the hash is stable; identity trigger and `set_updated_at` ordering fine; both functions `set search_path = ''`, execute revoked from API roles.
- RLS: policy on all six via the exact standard expression (helper compares whole `pg_get_expr`), single permissive SELECT policy; writes by service_role only; anon has no schema usage and no table grants; sequences none. No views, so `security_invoker` is not needed here; T-081 views must set it and filter lane_id (spec §6). Not FORCE RLS, same as the rest of the project.
- Rule 7: no balance column on fin.accounts; `balance` on invoices/bills is documented as open document amount; forbidden-column regex test covers `bankbalance`, account/routing numbers, bodies/memos. Rule 8: nothing here is revenue; payments comment says so.
- Rule 1/2/3: `lane_id` not null everywhere, FK to core.lanes, entity code list stays in lane_config, RLS + pgTAP in the same commit.
- `fin` not in PostgREST api.schemas: consistent with spec (T-081 decides). Note T-056 writes via direct grants, not an RPC like `core.source_records_upsert`; decide on the writer path (lane job client with schema `fin` exposed vs security-definer upsert functions) before T-056. If PostgREST is used, M1 must be fixed first.

## Impact on T-056 / T-081

- T-056 idempotent upsert: needs M1 (key) and L2 (stale lines); currency (H1) and class-per-line (M4) decide the normaliser mapping.
- T-081 query layer: needs M5 indexes; add `security_invoker` views and a lane_id filter; `fin` must be exposed or queried through a pg connection.
