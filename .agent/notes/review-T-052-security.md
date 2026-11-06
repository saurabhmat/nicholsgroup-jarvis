Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
## T-052 security review: QuickBooks Reports API (`agent/T-052`, uncommitted tree)

**Verdict: not done.** There are 2 HIGH findings, which must be fixed before T-052 can be marked done (app-code tier). There are no BLOCKERs.

Things that hold up:
- **Lane isolation** is checked at every layer: the event schema, the enabled-lanes check, `assertLaneBound`, the lister's `.eq("lane_id")`, and the lane and connection check inside the SQL function.
- **Read-only (rule 5):** only GET requests go to Intuit, and the only write is to the cache.
- **Tokens and errors:** no tokens are handled here. Error messages are fixed text and logs carry kinds and counts only.
- **Grants:** `core.fin_report_cache_put` is security invoker, uses an empty `search_path`, and only `service_role` can run it. The guard is still security definer and is revoked from public, anon and authenticated.
- **pgTAP:** the tests cover cross-lane, AAL1, admin_technical, anon and owner-write denial.

---

### HIGH

**H1. Payroll and excluded people's amounts can be worked out from the kept totals, against the D-25 default (b).**
- **Where:** `packages/connectors/src/quickbooks/reports.ts:27-30` and `:275-278`. The test `reports.test.ts:282-289` shows it.
- **What happens:** payroll rows are removed, but every enclosing section total and grand total is kept: "Total Expenses", "Net Income", the BalanceSheet liability totals, and the aging `TOTAL`.
  - Total minus the sum of the visible rows gives total payroll.
  - In the AP aging fixture, the `TOTAL` 140.00 is stored after excluded person "2" (40.00) is removed. So 140.00 − 100.00 = exactly what that individual is owed.
  - With one excluded person or one employee, this is individual compensation (rule 13 / spec §2). D-25 (b) says "nothing sensitive is stored". Keeping the totals in practice is option (a) (an aggregate payroll figure), which is an open human decision.
- **The cited sign-off doesn't exist:** the notes and H-035 point to a plan-review entry "Nov 6, 2026 — T-052" for this choice. `docs/plan-review.md` is not changed in this diff and has no such entry. The choice is undocumented and was never approved.
- **Fix:**
  1. While walking the rows, mark every section that has an excluded descendant. Drop that section's `Summary` and every ancestor `Summary`, including group `NetIncome`, `GrossProfit`, the BalanceSheet `TotalAssets` / `TotalLiabilitiesAndEquity`, and the aging `TOTAL`.
  2. Record this in `Header.TotalsWithheld: true`. T-081 then computes totals in SQL from the kept rows (rule 7).
  3. Add tests:
     - The P&L has no "Total Expenses" or "Net Income" when payroll is present.
     - AP aging has no `TOTAL` when an excluded entity is present.
     - The sum of stored figures never lets anyone recover an excluded row.
  4. The BalanceSheet stays derivable through Assets = Liabilities + Equity. Either withhold the BalanceSheet equity and total rows too, or add a D-25 sub-question under "Needs human" (keep or withhold the BalanceSheet totals) and stop.
  5. Remove the dangling plan-review reference, or write the entry once a human decides.

**H2. Customer and vendor names are stored in the aging reports for parent customers and vendors (data minimisation; breaks the acceptance's "no … name columns").**
- **Where:** `reports.ts:266`, where `push("Header", …, false)`, and `:277`, where Summary rows also use `dropName = false`. `dropName` only applies to Data rows without a Header (`:271`).
- **What happens:** QuickBooks aging summaries nest sub-customers and jobs as sections. The parent's `Header.ColData[0]` is the customer or vendor name, and its Summary reads "Total <name>". Both are stored unmasked. AP vendors are often individuals (contractors, owners).
- **The fixture misses it:** the aging fixture (`fixtures.ts`, the `aging(...)` builder) is flat, so this path is untested.
- **Fix:**
  - When `def.aging`, set `dropName = true` for every Header row and every Summary except the `GrandTotal` group or the literal `TOTAL`.
  - Add a nested sub-customer aging fixture that asserts no label text is stored except "TOTAL".
  - Add the nested shape to H-035 item (3).

---

### MEDIUM

**M1. No retention for `fin.report_cache` and no purge when D-25 changes** (`reports-job.ts`, `.agent/notes/T-052.md` "Not done").
- Now that the nightly schedule exists, about 5 rows a night (each up to 2.5 MB) build up forever.
- Rows cached before a payroll account was configured keep its lines indefinitely. The T-055 LOW only fits while nothing schedules pulls, and this task adds the schedule.
- **Fix:** register `fin.report_cache` with the T-042 retention registry and keep the latest N per (connection, report, params). Put a hash of the payroll policy (the ids, subtypes and excluded ids) in `params` so a policy change starts a new cache key, and purge older keys. Otherwise log it in plan-review as a tracked item before done.

**M2. The guard skips values that are unchanged on UPDATE** (`migration:30-32`).
- An unchanged payload is never re-scanned, so a row stored under the T-055 guard, before the value check existed, keeps any account-number-like value.
- **Fix:** in this migration, run a one-off scan that deletes or refuses existing `fin.report_cache` rows failing the new value rule. Or state in the PR that the table is empty in every environment and add a pgTAP check that no stored row fails the rule.

**M3. The cache key and idempotency claim don't hold on retry** (`reports-job.ts:5-7, 111-114`).
- `as_of` is Intuit's `Header.Time`, so a retry gets a new time and inserts new rows instead of upserting.
- `as_of` is only clamped from above, so a provider time far in the past is accepted as is.
- **Fix:** use the run's start time rounded to the run (or the schedule day) as the key, and keep `Header.Time` only in the payload. Refuse or clamp a `Header.Time` more than about 1 hour before `fetchedAt`.

---

### LOW

- **L1** (`migration:39-45`): the database backstop only matches contiguous `[0-9]{5}`. It misses digits split by separators ("1234-5678-9012") and non-ASCII decimal digits that NFKC leaves alone (for example Arabic-Indic). It also ignores object keys and doesn't check `params` at all. The connector's `maskDigitRuns` (`\p{Nd}`, up to 2 separators) covers these. **Fix:** use `[[:digit:]]` with separators `([^[:alpha:][:digit:]]{0,2}[[:digit:]]){4,}` and also scan `params` string values.
- **L2** (`reports.ts:173-176`): a label made only of digits (for example a bank account named "123456789") is stored because no letter is present. This matches the spec rule, but add it to H-035 item (6): check that no chart account name is purely numeric.
- **L3** (`migration:53`): `alter role service_role set statement_timeout = '60s'` applies to every service_role session (retention purges, raw upserts), not only report jobs. Note it in the PR body as a change across all jobs, and confirm the T-042 purge batches finish inside 60 s.
- **L4** (`reports/index.ts:1`): the comment says "Server-only", but unlike `fin-reports.ts` it has no `import "server-only"`. **Fix:** add it, since this entry reaches `getLaneJobClient`.
- **L5** (`reports.ts:283`): `Header.ExcludedRows` tells a finance viewer how many payroll rows exist. That is minor, but under H1's fix use a boolean instead.

---

**Before done:** fix H1 and H2 (H1 may need a "Needs human" D-25 sub-item if the BalanceSheet totals can't be withheld). Add the plan-review entry the notes and H-035 cite, or remove the reference. Log M1–M3 and the LOWs in `docs/plan-review.md` / `.agent/pr/T-052.md` if they are not fixed now. I did not edit any files.
