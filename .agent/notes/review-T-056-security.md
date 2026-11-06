Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I couldn't run the tests here, so I've finished as a static review. Report follows.

---

# T-056 security and code review: QuickBooks normalizer (raw.source_records → fin.*)

**Verdict: no BLOCKER and no HIGH. 7 MEDIUM and 7 LOW.** By the security rules nothing has to be fixed before done. Several MEDIUMs are wrong-number problems that the Nov 12 sandbox run or the Nov 16 tie-out would catch anyway.

**Tests not run.** Vitest, pgTAP and `pnpm test:db` all need approval in this session, so I could not run them. That includes the `plan(194)` count and whether the migration applies. Someone needs to run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db` before done.

## What I checked, and what holds

- **Lane scoping (rule 1).** The SQL function refuses unless the lane is enabled and the connection belongs to that lane, is QuickBooks, and is `active` or `degraded` (migration :340-349). Every raw read filters on connection, lane and provider (:406, :428). Every fin insert, update and join filters on `connection_id = p_connection_id` (:482, :521, :567, :606, :629, :653-660, :731, :746-755). `sync_runs` is read by lane and connection (:390-392). The job validates the lane and the id, loads the connection lane-bound, and checks the provider (normalize-job.ts:39-42). The store calls `assertLaneBound` before taking a client from `getLaneJobClient` (normalize-store.ts:44-50, vault/index.ts). The event is a strict Zod schema; it is validated again on receipt, and enabled lanes are re-checked (fin-normalize.ts:43-45). pgTAP covers another lane's connection, a Stripe connection, a reconnect-required connection, a disabled lane, and service_role calling with the wrong lane's connection.
- **Privileges.** The function is `security definer` with `search_path=''`; only service_role may execute it, and `050_catalog` lists it. Helper and trigger functions are revoked from public, anon and authenticated (:207, :241, :249-251; pgTAP :61-66). Nothing grants DELETE on ledger tables, and the function deletes nothing; rows are only tombstoned.
- **New table `fin.normalize_runs`.** It has `lane_id` with a composite FK to the connection, RLS with AAL2 plus `allowed_lanes(...,'health')`, and pgTAP including cross-lane, AAL1 and anon denial and a test that a run row cannot be forged.
- **No leaks of record data (rule 4/6, T-055 final M3).** The name checks are BEFORE triggers that raise a constant message with no DETAIL (:194-220); pgTAP asserts DETAIL and HINT are empty (:411-422). Any failure inside the run is re-raised with only the SQLSTATE plus table and constraint names (:778-781); the poison-row test at :401-406 confirms it. The store maps database errors to fixed `ConnectorError`s and Zod-parses the result (normalize-store.ts:55-68). Logs carry counts only.
- **Masking.** Names are NFKC-normalised, separators of up to 3 characters are allowed, several digit scripts are covered, and every name is masked before insert, including FullyQualifiedName.
- **Full-reload deletion gap (T-051 M3).** I checked that `core.source_records_upsert` sets `synced_at` again when it re-sees a record at the same provider version (raw migration :366, :375-376), and that the connector stamps `synced_at` at its own start, which is after the `sync_runs` row is created. So the cutoff (latest succeeded full run's start minus 15 minutes) does not wrongly tombstone records that are still live. Raw is not modified (pgTAP :343).
- **Backlog review additions.** All are implemented and tested:
  - load order
  - unknown invoice stored unapplied, then linked in place
  - lost lines tombstoned
  - `multi_class` with a null `class_id`
  - currency and non-USD counts
  - `raw_record_id` taken only from the matching object type
  - payroll handled as defence in depth
  - links to voided or deleted invoices refused, with a trigger backstop
  - reallocations logged with ids only
  - QB-10 fallback recorded on the run row
  - sign convention and `posted_at` pinned (T-055 M)
- **Fields line up with the T-051 projection.** `Voided` comes from `PrivateNote` (entities.ts:315). The Deposit line `Entity.EntityRef` and Purchase `EntityRef.type` are what the normalizer reads.
- **Out-of-scope rules.** No external write, no provider call, no AI input, no webhook. Rules 5, 8 and 9 don't apply beyond the comment at :40.

## MEDIUM

**M1. With no `qbo.entity_mapping_mode` in lane_config, every run fails with a misleading error.** Migration :359-364, :776-777.
- `v_mode` becomes null, so `v_fallback := v_mode = 'file_class' and not v_tracking` is NULL when class tracking is off.
- The insert into `normalize_runs` (where `class_fallback` is NOT NULL) then fails with 23502. The store maps that to a non-retryable `provider_error`. If the insert somehow got through, `class_fallback: null` would fail Zod instead.
- This happens whenever `qbo` or `entities` is missing, which the schema allows (lane-config/index.ts:73-79). It fails closed but says the wrong thing.
- **Fix:** `v_fallback := coalesce(v_mode = 'file_class' and not v_tracking, false)`. Better, raise a dedicated constant error early (for example SQLSTATE 22023, "lane_config has no QuickBooks entity mapping") when `v_cfg` or `v_mode` is null, and add a pgTAP case for it.

**M2. Finance users cannot see the QB-10 fallback.** Migration :284-286; pgTAP :450.
- `fin.normalize_runs` is readable only with the `health` view, so `finance_operator` reads 0 rows (the test asserts this).
- Spec §8.1 / QB-10 says the query layer shows unsplit figures "with a warning note". T-081 runs as the user and cannot get the fallback or unmapped counts for finance users.
- **Fix:** allow `health` or `finance` in the policy (both views AAL2-gated, lane-scoped). Or decide now that T-081 reads `core.connections.features` for the warning, and record that in plan-review.

**M3. Bill payments always land in `unmapped` in `file_class` mode.** Migration :726-728.
- Payment rows inherit the entity of the invoice they pay (`pe.ent`). BillPayment rows don't: they use the document's own classes, which a BillPayment normally doesn't have, with a null customer, so the result is `unmapped`.
- Every PKG bill payment drops out of `entity_code = 'PKG'` views and inflates `unmapped_rows` and the `unmapped_entity` control. This conflicts with spec §12 test 8a (a bill payment appears in the weekly snapshot).
- **Fix:** do what payments do. Take the entity of the linked live `fin.bills` row(s) through `LinkedTxn` when they agree, otherwise `unmapped`. Add a pgTAP assertion on BP1's `entity_code`.

**M4. Credit-card credits get the wrong sign.** Migration :697, :712; entities.ts Purchase schema (~:157).
- A QuickBooks Purchase with `Credit: true` (a card refund) reverses the posting. The projection drops `Credit`, and the normalizer always credits the paying account and debits the lines, so refunds increase expenses.
- **Fix:** keep `Credit: z.boolean().optional()` in the T-051 Purchase projection and flip both signs in the normalizer when it is true. Add a fixture and a test, and add the item to H-034 for sandbox verification.

**M5. Rows are not balanced per document, and nothing says so.** Migration :685-717 (pgTAP :242-243 shows Deposit D1: header 100, lines −100, the linked-payment line skipped).
- Linked-payment Deposit lines, Payments with no `DepositToAccountRef` (Undeposited Funds), item-based expense lines (`account_id` null), and Invoices (no posting at all) mean the posting rows of a document don't sum to zero. Per-account totals other than bank accounts are incomplete.
- This is fine for cash by bank account, but T-081 or the controls could treat `fin.transactions` as a full ledger.
- **Fix:** say it in the function comment and the column comments ("partial posting ledger: bank and expense side only; not balanced per document; P&L comes from the report cache"). Add a pgTAP check that pins the item-line `account_id` null behaviour. Log it for T-081 in plan-review.

**M6. A document that becomes invalid keeps its old live values.**
- Invoices and bills: :495-506 and :541-552. Payments: :587-588 then :653-656. Transactions: :718-719 then :746-750.
- When a live raw record stops parsing (date, total or currency becomes invalid), it is skipped and counted as invalid. Its existing fin rows stay `deleted = false` with the previous amounts. For payments and transactions the stale checks require the document in `q_prow`/`q_txn`, or a parseable `TxnDate`, so the old rows are never touched. The figures are silently stale and only an `invalid` count shows it.
- **Fix:** add a flag such as `stale_invalid` (or mark the rows `deleted`, as for dead records) when a live raw record fails validation. At minimum, log `invalid > 0` as a warning in normalize-job.ts and assert this behaviour in pgTAP.

**M7. T-051 final M1 and M2 are only closed for fin.*; raw still holds the data.**
- `.agent/notes/T-056.md` says both are "closed at the normalizer layer".
- The normalizer keeps payroll out of fin.*. But `raw.source_records` still holds transactions stored before an account became payroll (M1), and Payments/BillPayments of excluded payroll bills with `TotalAmt` and `VendorRef` (M2).
- D-25 (b) says nothing sensitive is stored, so the raw-layer items must stay open for H-024.
- **Fix:** in plan-review, record them as "fin.* layer closed by T-056; raw layer still open before H-024". Do not mark them resolved.

## LOW

- **L1. Unknown nested result keys pass through** (normalize-store.ts:16). `TableCounts` is `z.looseObject`. The comment says "Unknown keys are dropped", and the test only checks top-level keys. **Fix:** `z.object` (strip) and assert `payments.extra_key` is undefined.
- **L2. Payroll accounts are read in a separate statement from the rest** (migration :399-428). Under READ COMMITTED, a concurrent sync can add a payroll account between building `q_payroll` and `q_eff`. The account would then be written with its name once, and tombstoned on the next run. This only affects the defence-in-depth layer, since T-051 already excludes payroll in raw. **Fix:** build `q_eff` first and take payroll accounts from it, or note the limitation.
- **L3. Payroll settings are read leniently** (:382-387). A malformed `finance.payroll` value silently becomes an empty list or the default subtypes, where T-051 fails closed. lane_config is validated by Zod on write, so this is low risk. **Fix:** raise a constant error when the key exists but is not an array.
- **L4. `normalize_runs` has no retention** (:289-290). One row per QuickBooks sync, every 4 hours plus webhooks, each up to 64 KB of reallocations. The `ON DELETE RESTRICT` FK also blocks connection offboarding. **Fix:** a T-042 registry entry (floor, cap, lane filter, cross-lane pgTAP) or a logged follow-up task.
- **L5. The `afterSync` comment says "a sync that wrote data", but it fires for every non-skipped sync** (conn-sync.ts ~:24-29 vs :48), including `written = 0`. Every run rescans the whole connection's raw records and adds a run row. Also, a failed follow-up is not logged; it only appears in the return value. **Fix:** correct the comment or skip when `written === 0` (keep the manual trigger), and log `followUp: "failed"`.
- **L6. One update in the cross-lane pgTAP block does nothing useful** (220 test :442). It changes the owner's APK membership, then signs in as a different user. The assertions still hold. **Fix:** remove it, or change admin-technical's own membership if that was the intent.
- **L7. Digit-run check gaps (database net only).**
  - Decimal-digit scripts outside the listed ranges count as separators, not digits; the connector covers them with `\p{Nd}`.
  - A payroll account that is deleted in raw is not in `q_payroll` unless its id is configured.
  - A BillPayment that links to a Bill absent from raw stays live.

  All fail safe or are covered upstream. Note them in the T-056 plan-review entry.

## Not done yet (definition of done, not security)

- `.agent/pr/T-056.md` does not exist.
- `docs/backlog.md` still says `status: approved`, and `docs/plan-review.md` has no T-056 entry.
- The files `.agent/notes/review-T-056-{security,code,db}.md` contain only a "workspace has not been trusted" error. The earlier review runs failed, so they are not reviews and must not be cited as such.
- `.agent/notes/checkpoint-2026-11-02-b.md` is untracked and unrelated to T-056. Keep it out of this commit.
- The normalizer's Intuit assumptions (Purchase `Credit`, Deposit linked lines, Undeposited Funds) should be added to H-034 for the Nov 12 sandbox run.
