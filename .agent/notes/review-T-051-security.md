Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I found no blockers and one high finding: T-051 isn't done until the payroll issue (H1) is fixed. The project rules require every high finding in connector code to be fixed first. I made no edits.

**Checks that passed:**
- **Lane binding:** `laneId` and `assertLaneBound` are used throughout. The row is reloaded through `useConnection`. The feature store gets its database client from the lane router (`getLaneJobClient`).
- **Read-only:** QuickBooks is only called with GET through `QboApi`. The fake Intuit server records any other request to Intuit, and the tests require that list to stay empty. The writer is not imported.
- **Validation and logs:** Zod checks every response and every record, and a bad shape stops the run. Logs and errors carry counts and entity names only, and tokens never reach the log (tested).
- **Cursor:** it is stored only after a successful run, and the store refuses an overwrite if the cursor changed in the meantime. A cursor near the 30-day limit, missing, malformed or in the future triggers a full reload. A CDC answer that hits Intuit's 1000-per-entity cap also triggers one.
- **Feature flags:** the audit is written before the flags change. The database check on `core.connections.features` accepts the new keys.
- **Sensitive fields:** account and routing numbers, custom fields, memos, contact details and tax detail are all dropped. No kept key trips the database's forbidden-key check.
- **Scope:** no SQL, RLS, webhook or AI code is in this change.

## HIGH

**H1 — Individual pay is stored in `raw.source_records`.** `entities.ts:41,53` (`JournalEntryLineDetail` with `Entity.EntityRef`) and `entities.ts:146-147` (`Purchase.EntityRef`).
- Payroll journal entries and paycheck purchases are kept line by line: amount, payroll account and employee reference. That is per-person compensation.
- The finance spec (`docs/specs/finance.md:21`) says compensation is never stored. The D-25 default is that payroll is excluded "so nothing sensitive is stored."
- `Ref` also drops the `type` field, so the stored record can't even show that a reference points to an employee.
- **Fix:**
  - Read the payroll account ids from `lane_config` (the D-25 key; `laneConfigReader` is already in `vault/index`). With no config, fail closed or refuse payroll subtypes.
  - In `projectEntity`, drop every line posted to a payroll account. Also drop any line or transaction whose `Entity.Type` (or `EntityRef.type`) is `Employee`.
  - Keep the dropped transaction only as an Id with an `excluded: "payroll"` marker, or skip it entirely.
  - Add a fixture with a synthetic payroll journal entry and a paycheck purchase, plus a test that no employee reference or payroll line amount is stored.

## MEDIUM

**M1 — Long digit runs in text values are stored unchecked.** `entities.ts:65-66, 80, 88, 91, 115, 153, 175-176` (`Name`, `FullyQualifiedName`, `DisplayName`, `DocNumber`, `CompanyName`, `LegalName`).
- Bank account names often include the full account number, e.g. "Operating Checking 123456789".
- The raw database check only looks at key names, not values. T-055/T-056 mask these runs only when writing `fin.*`, so the raw copy keeps the number.
- **Fix:** in the projection, apply the same rule as T-055/T-056: normalise digits (NFKC), strip separators, then mask any run of 5+ digits. Add a fixture account named with a synthetic 9-digit number.

**M2 — Full-load paging has no sort order.** `sync.ts:35-36`.
- `STARTPOSITION`/`MAXRESULTS` without an order can shift between pages. A deletion during the load can then skip a record that hasn't changed, so CDC will never re-send it.
- **Fix:** add `ORDERBY Id` (or `MetaData.CreateTime, Id`) to the query, and update the fake server's regex and the paging test.

**M3 — A full reload never marks deletions.** `sync.ts:142-144, 172-173`.
- After a stale cursor or a capped CDC answer, objects deleted in the meantime stay as live records. T-056 would then turn them into ledger rows, so figures would be wrong.
- The T-172 hand tie-out is not a system fix.
- **Fix:** after a successful full run, mark the connection's records of the loaded types with `synced_at < syncedAt` as deleted. Do this with one raw-store call after the last sink write, and test it.

**M4 — Acceptance gap: "Preferences read on connect".** Nothing starts `conn.sync` for QuickBooks: not the OAuth callback, not a schedule.
- The note at `.agent/notes/T-051.md` defers this to T-195/T-197/T-053.
- **Fix:** have the T-050 callback send a `conn.sync` event with trigger `connect`. Otherwise, list it as not met in `.agent/pr/T-051.md` and add the gap to the acceptance of T-195 or T-197.

## LOW

- **L1 — Deletion stubs can be stored as live records.** `sync.ts:161`: every field in the schemas is optional. If Intuit's deleted-object shape differs from `status: "Deleted"`, a stub such as `{Id, status:"deleted"}` passes `projectEntity` and is stored as a live, empty record. **Fix:** refuse any object that has a `status` other than exactly `"Deleted"`. Confirm the real shape in the Nov 12 sandbox run.
- **L2 — Void detection is a guess.** `entities.ts:204-206`: matching `PrivateNote === "Voided"` exactly is unverified. Add it to the Nov 12 sandbox checklist (QB-1 – QB-20).
- **L3 — Feature flags merge from a stale copy.** `features.ts:252` builds the new flags from the in-memory `conn.features`, so a concurrent writer's keys could be overwritten. **Fix:** merge in SQL (`features || $1`) through an RPC, or re-read the row before updating.
- **L4 — Names of people are kept.** `entities.ts:80,88`: `Customer.DisplayName`/`Vendor.DisplayName` can be individuals' names. They are needed for mapping, so this is acceptable, but note it in the PR risks. Together with `Vendor1099` and `Balance`, they show amounts owed to individual contractors.

**Before marking T-051 done:** fix H1. M1–M4 can be fixed now or logged in `docs/plan-review.md` and the PR body.
