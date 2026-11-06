Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
# T-056 review: QuickBooks normalizer (raw.source_records → fin.*)

**Verdict: no BLOCKER or HIGH findings. Four MEDIUM and several LOW items, none of which stop the merge.** I read the whole tree by hand. I could not run `pnpm test`, `pnpm test:db`, `typecheck` or `lint`: the sandbox refused to run them. The pgTAP and Vitest suites are therefore unconfirmed, and the pgTAP plan count of 194 is unchecked. Please run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db` before merge.

## What I checked against the spec

- **Idempotency.** Every upsert has an `IS DISTINCT FROM` guard, and the pgTAP test compares a full snapshot (including `updated_at`) after a second run.
- **Load order.** Accounts come first, then invoices and bills, then payments, then transactions. A payment whose invoice is unknown is stored with `invoice_id` null and linked in place on `(connection_id, source_id, alloc_no)`. Both are tested.
- **Never hard-delete.** The function has no `DELETE`, and `service_role` has none on ledger tables. Lost transaction lines and lost payment allocations get `deleted = true`. Dead records are scrubbed and tombstoned, and a newer live version clears the flag.
- **Entity tagging.** The `file` and `file_class` modes are covered, including an ambiguous class, multi-class documents (`multi_class` true, `class_id` null, entity `unmapped`), and the customer fallback.
  - QB-10: with class tracking off, rows fall back to the customer mapping or `unmapped`, and `fin.normalize_runs.class_fallback` records it. Both are tested.
- **Name masking and the T-055 M3 items.**
  - The BEFORE triggers raise a constant message with no DETAIL, and pgTAP asserts the detail is empty.
  - The masker applies NFKC and tolerates up to three separators between digits.
  - The old CHECK constraints are dropped and the guard triggers added, so nothing echoes a row.
  - The function's exception handler re-raises with only SQLSTATE, table and constraint names.
  - Reallocations are logged with ids only. Links to voided invoices are refused, and links to deleted invoices make the payment dead; a trigger backs both up.
- **Full-reload deletion gap (T-051 M3).** I confirmed that `core.source_records_upsert` refreshes `synced_at` on a re-read record: the equal-timestamp branch applies when the stored row is not deleted. A targeted sync needs a cursor, so a "full" run always covers every entity type. The cutoff therefore cannot mass-tombstone unchanged records.
- **T-051 re-review M1 and M2.** Payroll is re-classified from `lane_config` (ids, subtypes, name net, sub-accounts). Transactions that touch a payroll account or an excluded entity are dead. A Payment or BillPayment linked to a dead Invoice or Bill gets no rows.
- **`raw_record_id` and rule 7.** `raw_record_id` is set only from the matching object type (asserted per table). Money is parsed in SQL with one rounding step.
- **Rules 1, 2, 4 and 5.**
  - The lane and connection are re-checked inside the definer function.
  - The function is granted to `service_role` only, and the catalog test 050 is updated.
  - No company codes appear in code; everything comes from `lane_config`.
  - Only counts and ids reach the TypeScript layer, and the Zod result schema drops unknown keys.
  - `normalize_runs` has RLS on, `aal2` and the `health` view, and a cross-lane denial section exists.
- **Jobs and retries.**
  - The Inngest function has concurrency limit 1 per connection and 3 retries.
  - It honours `RetryAfterError`.
  - Event data is re-validated on receipt.
  - The event id `fin-normalize:<conn>:<run>` dedupes the same sync.
  - A follow-up failure never fails or repeats the sync.
  - 22xxx/23xxx errors are not retried; 42501 maps to `connection_unavailable`; everything else is transient.
- **Dependencies and scope.** No new dependencies. The `provider` field on the sync outcome and the `afterSync` hook are the minimum needed to trigger the job.

## MEDIUM

**M1. Every sync re-normalizes the whole connection, and the timeout does not stop the database work.**
- Files: `packages/core/src/inngest/conn-sync.ts` (the `afterSync` call), `normalize-store.ts:14` and `:50`, migration lines 389–463.
- `afterSync` fires after every QuickBooks sync that ran, including incremental syncs that wrote nothing. Each call rebuilds `q_eff` over all raw records and runs `jsonb_path_query('$.**')` per record, twice.
- `NORMALIZE_TIMEOUT_MS` (120 s) only aborts the HTTP call. The server-side statement keeps running and holds the advisory lock. The retry then queues behind it, and a large file could time out repeatedly.
- Fix: send the follow-up only when `written > 0` (pass `written` through `afterSync`, or send only after a full run or a non-empty incremental). Also run `set local statement_timeout` inside the function (for example 100 s, below the client timeout) so the database cancels what the client has abandoned. Add a test for the zero-written case.

**M2. A live raw invoice that is skipped as invalid leaves its payments linked to nothing, uncounted.**
- File: migration lines 592–607.
- `q_alloc.unknown` is false because the invoice is in `q_eff`. `refused` is false because there is no `fin.invoices` row. `fin_invoice_id` is null, so the payment is stored unapplied.
- It is not counted in `unapplied_unknown_invoice`. It also cannot be told apart from a genuine link once the invoice is fixed.
- The stored data is safe, but the counts understate it, and QB-style reconciliation would see unexplained unapplied cash.
- Fix: set `unknown := (fi.id is null)`, or add an `invoice_invalid` count. Add a pgTAP case with an invalid-date invoice plus a payment against it.

**M3. A Customer or Vendor that is not re-seen, or is excluded, takes its name away from live invoices and bills silently.**
- File: migration lines 449–454.
- `q_cust` and `q_vend` take names only from live (`why is null`) records. When a customer is dead, its invoices stay live with `customer_name` null, and the update sets that null.
- For `unseen` this is a side effect of the unseen rule. For `entity` (D-25 excluded) the invoice's own `CustomerRef` already makes the invoice dead, so that case is correct.
- Document it, or count `customer_name`-nulled rows, so a partial reload does not look like a data fault.
- This is a low-impact edge, but it is untested.

**M4. The Definition-of-done artifacts are missing from the tree.**
- `.agent/pr/T-056.md` does not exist and `docs/backlog.md` is unchanged. The task is not marked `status: done`.
- `.agent/notes/checkpoint-2026-11-02-b.md` is untracked and unrelated to T-056. Keep it out of the commit or explain it.
- Fix: write the PR body (changes, tests, risks, human items). Set `done` only on merge. List the security and code review outcomes in the PR.

## LOW

- **L1. `fin.normalize_runs` grants `delete` to `service_role`** (migration line 290), with the comment "a later retention task". No code uses it. Remove it now (least privilege) and grant it in the retention task.
- **L2. `createNormalizeStore` turns a failure to get the lane client into `connection_unavailable`**, which never retries (`normalize-store.ts:46`). A transient Vault or config hiccup then waits for the next sync (a self-heal path that M1's `written > 0` filter could skip). Use `transient`, or at least distinguish a missing lane.
- **L3. The text of the exception handler's re-raised message** includes `table` and `constraint` names. That is fine, but SQLSTATE `23514` from the name guard has table `-`. Operators cannot tell which table refused, so add the table name in the trigger via `using table = tg_table_name`.
- **L4. `fin.has_digit_run` covers six Unicode digit scripts (Arabic-Indic, Devanagari, Bengali, Thai, Myanmar), not all `\p{Nd}`.** NFKC does not map non-ASCII decimal digits, so scripts such as Tamil or Khmer still pass. The comment admits this; consider `[[:digit:]]` with `\d` in the regexp, or a wider class.
- **L5. `payment_row`/`from_invoice`/`to_invoice` are uuids only.** That is correct. However, `reallocations` is capped at 200 entries while `reallocation_count` is not. Fine, but the logged count and entries can diverge. State that in the column comment.
- **L6. An incremental sync is not the same as a full one for the `unseen` cutoff.** The comment in the migration header says "kind = 'full'", but tests only cover the "no full run" case and one full-run case. Add a case where a later incremental run exists after a full one, to pin that the cutoff still uses the full run's start.
- **L7. `docs/plan-review.md`: log the HIGH-and-below items you accept** (M1–M3 above) if you choose not to fix them in this change.

## Optional suggestions

- Add a one-line pgTAP assertion that the `NormalizeResultSchema` keys match the function's `v_counts` keys. A fixture-driven Vitest test would do it. It would catch drift between the SQL and Zod.
- `qbo_account_refs` and `qbo_entity_refs` duplicate the connector's exclusion scan. The `normalize-sql.test.ts` file pins the subtype list, but not these key patterns (`AccountRef$` and `^(Entity|Vendor|Customer)Ref$`). Pin them the same way.
