# Security review: T-055 (commit a7e4c3d), finance schema part 1

Reviewer: security-reviewer subagent, Nov 4, 2026. Scope: `git show a7e4c3d`, CLAUDE.md, docs/specs/finance.md §3/§5/§8.1,
docs/architecture.md M3 and the data-retention table, .agent/pr/T-055.md, docs/plan-review.md §6 T-055.
I made no code edits and did not run a db reset.

M = migration `supabase/core/supabase/migrations/20261104120000_fin_ledger_and_reports.sql`
T = test `supabase/core/supabase/tests/130_fin_ledger_and_reports.test.sql`

## Verdict
No BLOCKER and no HIGH findings. Lane isolation, who-can-read, and the write path are correct and tested. The open risks are
about data minimisation in content that later tasks will write (T-052 report payloads, T-056 names and payroll lines).
Those tasks need explicit acceptance criteria before they are approved.

## What I verified (no finding)
- RLS: all six tables have RLS on and one SELECT policy for `authenticated` with the exact standard expression
  (aal2 AND `lane_id = any(core.allowed_lanes(auth.uid(), 'finance'))`) (M:283-286). The 050 catalog test scans every non-platform schema, so it already covers `fin`
  (policy shape, no write policies, no authenticated DML, no security-definer or callable functions outside the reviewed lists,
  views must be security_invoker, no anon privilege).
- `core.allowed_lanes` filters to enabled lanes and own uid at aal2, and it intersects with role views. finance_operator gets `finance`, admin_technical
  does not, and viewer gets `finance` only by name. T covers owner across lanes, a disabled lane for the owner, finance_operator on PKG only, viewer with and without
  the view, viewer with every other view, admin_technical, an outsider, AAL1 owner and operator, and anon (42501).
- Lane binding: `(connection_id, lane_id, provider) -> core.connections` and `(raw_record_id, connection_id) -> raw.source_records`,
  plus same-connection FKs for `transactions.account_id` and `payments.invoice_id`. Same connection means same lane, because
  `core.connections` freezes lane, provider and account. T covers each cross-lane, cross-provider and cross-connection case (23503).
- No security-definer function, no view, no materialized view. Both trigger functions are invoker with `search_path = ''` and
  revoke execute from public/anon/authenticated (M:36-51, M:250-259). Postgres checks EXECUTE on a trigger function only at CREATE TRIGGER, so the revoke does not break the triggers.
- Writes: `authenticated` gets SELECT only and `service_role` gets S/I/U/D, with no TRUNCATE (tested). There are no sequences (uuid keys). The FK `on delete set null`
  action from the private raw table runs as the table owner, so service_role needs no grant on raw.
- Hash trigger: it sorts before the identity and updated_at triggers, and it overrides any hash the caller supplies (tested).
- Rule 2: there are no company literals in DDL. `entity_code` has a shape check only. Rule 10: the tests use synthetic data. Rule 11: money is numeric(18,2) and times are timestamptz (tested).
- Rule 6 columns: there is no memo, description, note, body, account or routing number, TIN or SSN column. `customer_id` and `vendor_id` are QBO ids, not names.
- `scripts/gen-db-types.mjs:28`: this is a fixed argv change with no shell or interpolation. Generating types for a schema that is not exposed through PostgREST has no security effect.
- New unique indexes (M:31-32): `id` is already the PK, so they cannot reject existing data. `id` and `connection_id` never change, so HOT updates
  on raw are not affected. The only cost is one extra btree per row.

## MEDIUM

### M1. `fin.report_cache` has no DB-side guard and no report-name allowlist (rule 6)
- Where: M:231 (`report ~ '^[a-z][a-z0-9_]{1,63}$'`), M:234 (payload is only checked to be an object of 4 MB or less).
- Scenario: T-052, or a later report job, caches `general_ledger`, `transaction_list` or `profit_and_loss_detail`. Those reports carry
  Memo/Description, payee names and, through account names, sometimes account numbers. The rows land in a table that every finance reader
  and every finance viewer can read. `raw.source_records` has a guard that runs on every write, whoever the writer is. This table does not, so the
  defence-in-depth pattern is broken.
- Key-only scanning is not enough. A QBO report puts content in values (`Rows.Row[].ColData[].value`) under generic keys
  (`Header`, `Columns`, `Rows`, `ColData`, `value`, `id`). Calling `raw.payload_has_forbidden_field` would therefore catch almost nothing in a report.
- Fix (land in T-052's migration and make it an acceptance criterion; a `needs:` line on T-052 is enough now):
  1. Replace the shape check with a fixed list:
     `check (report in ('pnl','balance_sheet','cash_flow','ar_aging_summary','ap_aging_summary'))`, as spec §8.1 lists. Report names are
     provider vocabulary, not company settings, so rule 2 is not affected.
  2. The connector projects each report into a typed, allowlisted shape validated with Zod (`.strict()`), for example
     `{columns:[{key,label,period}], rows:[{accountRef, accountName, group, amounts:{[colKey]: string}}], header:{reportName, startPeriod, endPeriod, accountingMethod, currency}}`.
     It drops `Header.Option`, any `Memo`/`Description`/`Name` columns, and any column whose metadata is not in the allowlist. Amounts are decimal strings.
  3. DB guard: add a BEFORE INSERT/UPDATE trigger that checks the top-level keys of `payload` are a subset of the allowlist. Make it security definer only if it
     needs raw's helper functions; then add it to `security_definer_ok` with `search_path` pinned. The trigger should also apply
     `raw.payload_has_forbidden_field` to keys, as a second net.
  4. Add pgTAP: an unknown report name gives 23514, an extra top-level key is refused, and a `Memo` column is refused.

### M2. Free-text names and payroll lines can carry forbidden data (account numbers, compensation)
- Where: M:64 (`fin.accounts.name`, up to 200 chars of free text), and `report_cache.payload` values. Architecture §7 and the data table say
  "Bank/account numbers, SSNs, compensation ... Never". Spec §2 says "Payroll, compensation ... never stored".
- Scenario 1: a QBO bank account named "Chase Checking 000123456789" is normalised as is, and the account number is stored and shown to viewers.
- Scenario 2: the P&L and transactions include "Officer Compensation" or "Salaries - <name>" accounts. Payroll-provider JournalEntries post
  per-person pay lines to `fin.transactions`. In a small company that is individual compensation, and a viewer with the `finance` view can read it.
- Fix (T-056 / T-052 acceptance criteria, plus a human decision):
  1. The normaliser and the report projection mask digit runs of 5 or more in any name (keep at most the last 4). Optionally add a DB check
     `name !~ '[0-9]{5,}'` on `fin.accounts` (QBO chart numbers are usually 4 digits; confirm before adding).
  2. Add a `lane_config` list of payroll/compensation account ids or subtypes (QBO `PayrollExpenses`, officer comp). For those accounts the
     normaliser stores only a period aggregate under a generic "Payroll (aggregated)" line, or nothing. Transactions on those accounts are
     not stored line by line. The report projection collapses those rows the same way.
  3. Record the decision in docs/plan-review.md: is aggregate payroll expense in the P&L allowed? Per-person compensation is not.
     This is a product decision and needs a human.

## LOW

### L1. Viewers with the `finance` view read the entire ledger and every cached report
- Where: M:283-286 together with `core.viewer_view_names()`. This matches spec §5 ("viewers with the named `finance` view"), so it is acceptable as specified.
  The architecture's example viewer grant is narrower ("NL weekly cash"), and a PKG file may also hold APK/PKI classes (D-8), so a PKG viewer sees
  those entities' rows too (spec §5 says rows are not hidden).
- Fix: when T-081 exposes `fin`, expose only security_invoker views and query-layer functions to `authenticated`. Keep base tables unexposed,
  or split a narrower `finance_summary` viewer view from `finance`. Record the choice before any viewer is given `finance` on real data.

### L2. `service_role` has DELETE although the design says rows are never hard-deleted
- Where: M:289. Scenario: a buggy normaliser or a mis-scoped job deletes ledger rows, and nothing audits it. AR history disappears silently.
- Fix: grant `select, insert, update` only. Add a reviewed purge function later, when retention needs one.

### L3. The identity trigger does not freeze `id`, or `params` on report_cache
- Where: M:271-276. `id` can be changed on an unreferenced row. Updating `report_cache.params` re-keys a cached payload to different
  filters (the hash follows), which could mislabel a class-filtered P&L.
- Fix: add `'id'` to every identity list and `'params'` to the report_cache list (a new fetch inserts a new row). Optionally hoist
  `to_jsonb(new)/to_jsonb(old)` out of the loop (M:43-47). On a 4 MB payload the trigger currently serialises the row twice per identity column.

### L4. The forbidden-column test misses compensation and tax-id words
- Where: T:69. The regex lacks `salary|wage|payroll|compensation|tin|ein|fein|itin|ledger|trust`.
- Fix: derive the regex from `raw.forbidden_contained()` / `raw.forbidden_words()` plus the body words, so one list governs both.

### L5. No default-privilege hardening for future `fin` functions
- New functions in `fin` get EXECUTE for PUBLIC by default. The catalog test catches it (`authenticated_exec_ok`), but only at test time.
- Fix: `alter default privileges in schema fin revoke execute on functions from public;` in this or the next fin migration.

### L6. Side effects of the composite FKs on `core.connections`
- A QuickBooks connection that has fin rows can no longer be deleted (`on delete restrict`). That is correct, but a future disconnect,
  offboarding or lane purge must delete or archive fin rows first, in order. The index build on `raw.source_records` is non-concurrent:
  it takes a SHARE lock that blocks raw upserts for the duration of the build on a populated staging database. That is brief at pilot volumes.
  Also, `raw_record_id` is not tied to `object_type`, so an account row could reference an Invoice raw row. That is an integrity issue, not a lane issue.
- Fix: note the delete order in the retention/offboarding task. T-056 should set `raw_record_id` only from the matching object_type, optionally with a test.

### L7. A reallocated payment needs a tombstone, so views risk double counting
- `payments.invoice_id` is frozen and rows are never deleted. A re-pointed allocation therefore becomes `deleted = true` plus a new row. Any view that
  omits `not deleted and not voided` double-counts receipts.
- Fix: in T-080/T-081, add a pgTAP check that every `fin` view over these tables filters `deleted` and `voided`.

### L8. Generated types include `fin`, but PostgREST does not expose it
- `packages/core/src/db/types.ts` lets `client.schema('fin')` typecheck, but it fails at runtime (PGRST106). This has no security effect.
- Fix: none required. T-081 exposes the schema deliberately (already logged).

## Rules 1-13 check
1 ok (lane_id on every table; no app code). 2 ok. 3 ok (RLS + pgTAP + cross-lane denial in the same change). 4 n/a. 5 n/a (read-only
data; no external write). 6: M1, M2. 7 ok (no authenticated DML; book-balance wording respected; no balance on accounts). 8 ok (payments are
commented as not revenue). 9 n/a now; M1 also limits retrieved free text. 10 ok. 11 ok. 12 ok. 13 ok (no Plaid, no posting).

## Review fixes (0e93648)

Scope: `git show 0e93648 -- supabase packages`. F = `supabase/core/supabase/migrations/20261104130000_fin_ledger_review_fixes.sql`,
R = `supabase/core/supabase/migrations/20261102080000_raw_source_records.sql`, T = `supabase/core/supabase/tests/130_fin_ledger_and_reports.test.sql`.
Read-only review; no resets or test runs.

Verdict: no BLOCKER, no HIGH. Two MEDIUM, five LOW. M1, L2, L3, L4 and L5 from the first pass are addressed. M2 is partly addressed (names), and M1 is partly addressed (values are still open, see M4 below).

### What I verified (no finding)
- **Security definer is needed.** R:16 revokes all on schema `raw` from service_role, so an invoker trigger would fail with "permission denied for schema raw"
  when service_role inserts. The other option, granting service_role USAGE on `raw` plus EXECUTE on `raw.payload_scan`, would widen the private schema.
  A definer trigger is the narrower choice. The body reads only `new`/`old` and `tg_op`, reads and writes no table, qualifies every call
  (`pg_catalog.*`, `raw.payload_scan`) and pins `search_path = ''`. Operators resolve from pg_catalog implicitly. The owner is the migration role
  (`postgres`), which owns `raw`. No `alter function ... owner to` exists anywhere, and the function is on the 050 reviewed-definer list.
- **Direct calls.** It returns `trigger`, so Postgres refuses any direct call ("trigger functions can only be called as triggers"). PostgREST does
  not expose `fin`, and RPC never lists trigger functions. F:142 revokes EXECUTE from public, anon and authenticated, and T:92-99 pins this.
  Firing a trigger does not check EXECUTE, so the revoke does not break service_role writes. Using it in another trigger would need EXECUTE
  plus table ownership. Even then it can only raise. The ineffective `alter default privileges` (F:152) is harmless and already logged.
- **Bypass.** The top-level allowlist (F:133) compares keys exactly and case-sensitively, so `header`, `HEADER` and `Header ` are refused. It fails closed.
  The forbidden-key scan normalises keys (NFKD, case, separators, camelCase, zero-width characters). Depth 16 or more trips `has_forbidden` (R:100-121),
  which fails closed. More than 20000 distinct keys or a key over 256 characters raises 22023. The UPDATE skip (F:130) only applies when the payload is unchanged,
  and `report`, `lane_id`, `connection_id` and `params` are frozen. An ON CONFLICT DO UPDATE upsert is scanned on the proposed row and again on a changed payload.
  service_role cannot disable triggers (it does not own the table) or set `session_replication_role`.
- **No echo.** The guard's messages are constant. A non-object payload falls through to the table check (see M3 for its DETAIL).
- **`invoice_id` mutable.** The FK `(invoice_id, connection_id) -> fin.invoices (id, connection_id)` stays, and `connection_id` is frozen on both tables.
  An invoice's `(connection_id, lane_id)` is tied to `core.connections`. A retarget therefore stays inside one connection, and so inside one lane.
  Only service_role writes. The cross-connection FK test exists.
- **DELETE revoked** on the five ledger tables. There is no TRUNCATE grant, and raw purge `ON DELETE SET NULL` needs no privilege on the referencing table.
  Owner and finance_operator delete denial is tested (T:276, T:429, T:436).
- **`Z0055`.** Class Z0 is in the implementation-defined range and Postgres does not use it. It no longer collides with 42501, so callers can tell
  "frozen column" from "permission denied". No TypeScript in `packages/` maps the old code for `fin`.
- **Rules 1-13.** 1 ok (no new table; new columns sit on lane-scoped tables). 2 ok (report list is a provider/spec list, not company data). 3 ok
  (no new table; new checks tested). 4/5 n/a. 6: M3, M4. 7 ok. 8 ok. 9 n/a. 10 ok (synthetic fixtures). 11 ok (no new money/time columns;
  currency is text). 12 ok. 13 ok.

### MEDIUM

#### M3. The digit-run CHECK constraints echo the refused account number in the error DETAIL and the Postgres log
- Where: F:31-34 (`accounts_name_no_digit_run`, `invoices_customer_name_no_digit_run`, `payments_customer_name_no_digit_run`,
  `bills_vendor_name_no_digit_run`), and the same applies to F:28-30 length checks.
- Scenario: a T-056 normaliser bug skips masking for one account. The insert of `name = 'Chase Checking 000123456789'` fails with 23514 and
  `DETAIL: Failing row contains (..., Chase Checking 000123456789, ...)`. service_role has SELECT, so Postgres includes the row, with each value cut to 64 bytes,
  which is enough for a name. The account number then lands in the Postgres/Supabase log. supabase-js returns it in `error.details`, so it reaches the
  Inngest job's error log too. The backstop that refuses the data writes it somewhere else. `core.source_records_upsert` avoided exactly this ("our own messages
  and no DETAIL, so a payload never reaches the Postgres log through a constraint error"). A non-object `report_cache.payload` also echoes its first 64 bytes through the
  table check (F:127 defers to it).
- Fix: move the name checks into a BEFORE INSERT OR UPDATE trigger (invoker is fine) that raises a constant message with errcode 23514 and no
  DETAIL. Also raise for a non-object payload in `fin.report_cache_guard` instead of returning. Keep or drop the CHECKs. If they stay, the trigger fires
  first, so the CHECK never reports. Add a pgTAP test with `throws_ok(..., '23514', '<constant message>')`, and assert the DETAIL is absent
  (catch the error in a DO block, read `PG_EXCEPTION_DETAIL` and expect it to be empty). T-056 acceptance: the normaliser never logs a failed row.

#### M4. The report_cache guard does not inspect values, so account numbers and per-person payroll lines in `ColData[].value` are stored
- Where: F:117-120 (by design: "Values are not inspected"), F:133-138.
- Scenario: a QBO BalanceSheet row `{"ColData": [{"value": "Chase Checking 000123456789", "id": "35"}, {"value": "1520.00"}]}` passes. So does a P&L row
  `{"value": "Salaries - Jane Doe"}`. QBO report data lives in values, not keys, so the key scan protects almost nothing here. The digit-run rule
  now enforced on `fin.accounts.name` is not applied to the same account name inside the cached BalanceSheet, which a `finance` viewer can read.
  This is the residual of first-pass M1/M2. The connector projection in T-052 is still the only control.
- Fix (in this task or a T-052 acceptance item with a test): in the guard, walk string values (`jsonb_path_query(new.payload, 'strict $.**')`
  filtered to strings) and refuse, with a constant message, any string that contains a letter and `[0-9]{5,}`. Amounts (`^-?[0-9]+(\.[0-9]+)?$`),
  QBO ids (pure digits) and dates have no letter-plus-digit-run, so they pass. Payroll can't be enforced in the DB. T-052 must collapse the compensation
  accounts listed in lane_config into one aggregate row before caching (D-25), with a fixture test.

### LOW

#### L9. The depth cap of 16 may refuse real QBO BalanceSheet/P&L payloads (fails closed: availability, not security)
- Where: F:136 via R:100-121. Each section nesting in a QBO report costs 3 levels (`Rows` -> `Row[]` -> element). A leaf `ColData` item reaches depth 16
  at 5 nested sections, for example Assets > Current Assets > Bank Accounts > parent account > sub-account. The insert then fails with 22023
  "payload contains a field that must not be stored", which is misleading.
- Fix: T-052 adds a realistic deep BalanceSheet fixture. If it trips, the connector should flatten rows (store `level` instead of nesting).
  Do not raise the cap in raw. Add a pgTAP case for a 17-level payload on report_cache, and one for a lower-case `header` key (both untested now, T:256-265).

#### L10. Errors from `raw.payload_scan` name the wrong table
- Where: R:151-155 messages say `raw.source_records: ...` when the call comes from `fin.report_cache_guard`. Nothing is echoed, but the message
  misleads on-call ("too many distinct keys" on a report write).
- Fix: catch 22023 from the scan in the guard and re-raise `fin.report_cache: payload is too large or too deep to check`, or make the messages generic in raw.

#### L11. The guard runs on every row with the payload up to 4 MB under definer rights; there is no statement timeout
- Where: F:121-144. The recursive walk copies each subtree per level (about size x depth of memory). Only service_role can write, so this is not attacker-reachable.
- Fix: none now. T-052 jobs should set `statement_timeout` for report writes, which the planned retention task also needs.

#### L12. `invoice_id` retargeted in place leaves no record of the earlier allocation
- Where: F:21-25. This is the intended design. It replaces the tombstone approach (first-pass L7, double-counting risk now lower). An unapplied payment that is later applied,
  or reallocated, overwrites `invoice_id`, and the AR history for the old invoice changes silently. Retargeting to a voided or deleted invoice is not refused.
- Fix: T-056 records reallocations in its sync log (ids only) and refuses, or flags, a link to a `voided`/`deleted` invoice. Optionally add a
  trigger check that the target invoice is not deleted.

#### L13. The digit-run check misses separated and non-ASCII digits
- Already logged in plan-review §6 for separators (`000-123-456-789`, `0001 2345 6789`). It also misses full-width digits (`０１２３４５６７`), because `[0-9]` is ASCII only.
- Fix: in the T-056 masker, NFKC-normalise and strip `[ .-]` between digits before matching. If the DB check is kept, use
  `normalize(name, NFKC)` in the trigger proposed in M3.
