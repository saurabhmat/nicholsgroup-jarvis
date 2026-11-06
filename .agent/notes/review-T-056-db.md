Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
# T-056 review: QuickBooks normalizer (`raw.source_records` → `fin.*`)

**Result: no BLOCKER and no HIGH.** There are 5 MEDIUM and 7 LOW findings, plus a process gap that the definition of done requires you to close.

**What I could not do:** `supabase db reset`, `supabase test db`, vitest and typecheck all need approval in this sandbox, so I did not run them. Everything below comes from reading the code against the spec, not from running it. The claim "194 pgTAP tests and 13 Vitest tests green" is unverified by me and must be re-run before merge.

## What I checked and found correct

- **Spec points covered.** I checked these against `docs/backlog.md` T-056 (with the Review additions), `docs/specs/finance.md` section 5, the T-051 reviews (including the Nov 6 M1/M2/M3 items) and the T-055 reviews:
  - Load order is accounts, then invoices and bills, then payments, then transactions.
  - A payment whose invoice is unknown is stored with `invoice_id` null and linked later in place on `(connection_id, source_id, alloc_no)`.
  - Lost lines and lost allocations are tombstoned, and nothing is hard-deleted.
  - `multi_class` is set with a null `class_id`.
  - `currency_code` is set and non-USD rows are counted.
  - The class-tracking fallback (QB-10) is recorded in `fin.normalize_runs`.
  - The `features.class_tracking` key matches what `featuresFromPreferences` writes (`entities.ts:197-205`).
- **Deletion gap (T-051 M3).** The cutoff rule is sound for the normal case. `raw.source_records_upsert` refreshes `synced_at` when `source_updated_at` is equal and the record is not deleted. So a full reload does re-stamp unchanged records, and only records the reload did not see fall behind the cutoff. A targeted sync always needs a cursor, so it never records `kind = 'full'`. `QBO_SYNC_ENTITIES` covers all ten types the normalizer treats as entities.
- **T-051 M1 and M2.** Payroll accounts are re-classified from `lane_config`: ids, subtypes, a name safety net, and sub-accounts. Any non-account record referencing one is dead, and so is any record referencing an excluded customer or vendor. A Payment or BillPayment linked to a dead Invoice or Bill gets no ledger rows, and the Invoice and Bill tombstones that make this work do exist.
- **T-055 M3.** The name guard is a BEFORE trigger with a constant message and no DETAIL. The masker NFKC-normalises and tolerates up to three separators, and the masker and the guard use the same pattern. Reallocations are logged with ids only. Links to voided or deleted invoices are refused in the function and again by the `payments_invoice_link_guard` trigger.
- **Money and time.** Money is rounded once in SQL (half away from zero) and is null if it is not a JSON number or does not fit `numeric(18,2)`. `posted_at` uses `txn_date::timestamp at time zone 'America/New_York'`, so it does not depend on the session timezone.
- **Idempotency.** Every upsert has a `where … is distinct from` guard, so `updated_at` is untouched on a no-op run.
- **Functions and grants.** The function pins `search_path = ''` and takes an advisory lock per connection. It checks lane, provider and status. Execute is limited to `service_role`. The catalog allowlist entry in `050_catalog.test.sql` is present.
- **RLS on `fin.normalize_runs`.** The policy uses `allowed_lanes(…, 'health')` and `aal2`. The tests cover another lane, AAL1, anon and the insert refusal (lines 430-471).
- **Wiring.** `afterSync` carries ids only. The event schema is strict and its id is deterministic per sync run. Concurrency is keyed per connection. A failure to send the follow-up never fails the sync.

## MEDIUM

**M1. `Purchase.Credit = true` is ignored, so refunds and credit-card credits post with the wrong sign.**
- Where: migration lines 697 and 712.
- Header and line signs are fixed by object type only. A QuickBooks credit-card credit has positive amounts and `Credit: true`, and it should be inverted: header debit, lines credit.
- This is unverified against Intuit (H-034), but ignoring it overstates expenses.
- Fix: read `payload ->> 'Credit' = 'true'` into `docs`, multiply the sign by -1 for Purchase when it is set, and add a pgTAP case. If you decide not to handle it, put it in the H-034 checklist.

**M2. Lines with a null `account_id` are stored as real amounts and are not marked uncategorised.**
- Where: migration lines 707-713 and 729.
- Item-based Purchase and Bill lines, and Deposit lines that deposit linked payments (probably no `AccountRef`), get `account_id` null.
- `is_uncategorized` only checks the account *name*, so a null account gives false.
- Any ledger-side P&L or uncategorised count (T-082/T-083) will silently drop or misplace these amounts.
- Fix: set `is_uncategorized = true` when `account_id` is null and the line is not a header row. Alternatively, count null-account rows in `counts` and document how T-082 must treat them. Add a test either way.

**M3. Any single bad row blocks the whole connection forever, and the cause is invisible.**
- Where: migration lines 778-781 and `normalize-store.ts` (the `^2[23]` branch).
- Examples of a bad row: a `source_id` over 256 characters, or any CHECK or trigger failure.
- The whole call rolls back and the job fails as non-retryable, so nothing reaches `fin.*`.
- The database message (SQLSTATE, table, constraint name) is deliberately discarded, so operators see only "The normalizer refused the synced data".
- There is no `fin.normalize_runs` row for a failed run either, so nothing shows on the health view.
- Fix, in two parts:
  1. Return SQLSTATE and the constraint name (they are schema names, not data) from the store as a typed field and log them in `qbo.normalize.failed`.
  2. Add a length guard for `external_id` to the existing `qbo_ids_ok` pattern so a long id is counted as invalid instead of aborting the run.

**M4. Resurrection risk if `core.sync_runs` rows are purged.**
- Where: migration lines 390-393.
- The unseen cutoff depends on the latest *succeeded full* run existing in `core.sync_runs`.
- If a retention job ever trims that table, the cutoff becomes null, and records that were dead as unseen come back to life as ledger rows on the next normalize. That includes deletions made while the cursor was stale. T-051 M3 exists precisely to prevent this.
- Today the retention migration does not touch `sync_runs`, so this is latent.
- Fix: persist the cutoff, for example use the last `normalize_runs.unseen_cutoff` as a floor, or record the last full-load start on the connection. Document in the T-042 retention registry that the latest full-run row must be kept.

**M5. Missing Definition-of-done artefacts.**
- `.agent/pr/T-056.md` does not exist.
- `docs/plan-review.md` has no T-056 entry.
- Nothing is set in `docs/backlog.md`.
- The three review files (`.agent/notes/review-T-056-{code,db,security}.md`) are 295-byte error stubs ("Ignoring 31 permissions.allow entries… workspace has not been trusted"). They contain no review, so the `security-reviewer` step has not actually happened.
- Fix: re-run the three reviews from a trusted workspace. Write the PR file with changes, tests, risks, and the H-034 unverified items (M1, M2, and the `Voided` marker, which relies on the unverified `PrivateNote: "Voided"` mapping). Log the LOWs below in `docs/plan-review.md`.

## LOW

- **L1. A single ambiguous or unmapped class falls through to the customer mapping.** `fin.qbo_resolve_entity` (lines 174-184) does this for a class in two entities, while the migration header says an ambiguous class "counts as unmapped". Several ambiguous classes do give `unmapped`. Decide which is intended and align the header, the code and the tests. Falling back to the customer mapping can attribute a row to an entity because of a config error.
- **L2. `Payment` and `BillPayment` post one-sided.** They have a header leg only, with no AR or AP leg, and an Invoice posts nowhere. Net across all accounts is therefore not zero, and any ledger tie-out must not assume it is. This is documented in the header, but T-082/T-083 should be told.
- **L3. The digit-run net covers only a few digit scripts.** `has_digit_run` and `mask_digit_runs` cover ASCII plus Arabic-Indic, Extended Arabic-Indic, Devanagari, Bengali, Thai and Myanmar. The connector uses `\p{Nd}`, so other scripts such as Khmer or Tibetan pass in the database. NFKC only folds compatibility forms. The header admits it. If you want parity, use the connector's wider list.
- **L4. `NormalizeResultSchema` keeps unknown keys inside each table's counts.** `z.looseObject` in `normalize-store.ts:21` contradicts the file comment "Unknown keys are dropped, never forwarded". The values are only counts, so there is no leak, but use `z.object` to match the comment.
- **L5. Dead accounts keep `type`, `is_bank`, `entity_code` and `owner_entity_code`.** Only the name and subtype are scrubbed (lines 480-482). That is probably fine, but the header says values are scrubbed, so either scrub them or say what stays.
- **L6. `fin.normalize_runs` grows with every call, including no-op runs, and has no retention.** Its `(connection_id, lane_id)` foreign key is `on delete restrict`, so offboarding a connection must delete these rows first. Add it to the T-055 offboarding LOW and to the T-042 registry.
- **L7. The 15-minute margin treats a record as live if it was last CDC-updated within 15 minutes before the full reload.** That record is not marked unseen even if the reload did not see it. This is only a theoretical gap.

## Suggested order of fixes

Do M5 first (it is required for done), then M3 and M4 (data-safety and operability), then M1 and M2 (correctness, including pgTAP cases). The LOWs can go into `docs/plan-review.md`.
