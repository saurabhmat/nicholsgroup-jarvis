Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I couldn't run the tests here (approval needed), so I'm writing the findings from reading the code and fixtures.

## T-052 security re-review (working tree on `agent/T-052`)

**Verdict: not done.** One new HIGH remains: the H1 fix is incomplete, and the case is in the test's own fixture. The task is already set to `status: done` in `docs/backlog.md:459`, and that has to be undone.

### What is fixed
- **H1, within one report:** fixed. `reports.ts:274-292` takes a count of removed rows before each section. If anything below a section was removed, the section's Summary is withheld, and so is every enclosing Summary up the tree. Summary-only sections (Net Income, Gross Profit, the aging `TOTAL`) are tracked at `:290` and dropped at `:300` whenever anything was removed. `Header.TotalsWithheld` is set at `:301`, and the `ExcludedRows` count is gone (L5 fixed). Tests are at `reports.test.ts:303-325` and `:350-357`.
- **H2:** fixed. With `def.aging`, `dropName` is now set on Header, Data and Summary rows (`:276`, `:279`, `:289`). Only a `GrandTotal` group or a literal `TOTAL` label keeps its text. A nested sub-customer fixture was added (`fixtures.ts:218-224`), and `reports.test.ts:252-266` asserts that `TOTAL` is the only label left.
- **No excluded id survives:** an excluded section header drops the whole subtree, and excluded Data and Summary rows are skipped. The stored Header is limited to seven validated scalar fields plus `TotalsWithheld`.
- **M2:** handled. The migration runs a one-off `delete` (`migration:56-63`). LOW: no pgTAP check asserts that no stored row fails the rule. A one-line assertion in `210_*.test.sql` would cover it.
- **M3:** handled. The retry wording is corrected (`reports-job.ts:7-9`). A one-hour plausibility window is added (`:25`, `:118-119`) with a test (`reports.test.ts:145`). Each retry still adds a new row; that growth depends on the M1 retention item, which is logged.
- **Plan-review section:** "Nov 6, 2026 — T-052" now exists (`docs/plan-review.md:651-664`). Part of it is inaccurate; see M-A.

---

### HIGH

**H-A. The payroll total and an excluded person's balance can still be worked out exactly from stored rows. The stored data amounts to D-25 option (a), which is an open human decision.**

1. **P&L plus CashFlow, using the fixture's own data**
   - `fixtures.ts:205`: the CashFlow `OperatingActivities` section has a Data row "Net Income" = `111288.50`. It is a Data row, not a Summary, so it is always kept (`reports.ts:277-279`).
   - Both reports use the same `start_date`/`end_date`.
   - From stored values: Total Income 152000.50 − Office Supplies 1200.00 − fees 12.00 − Net Income 111288.50 = **39500.00**. That is exactly the removed payroll (39000 + 500).
   - `reports.test.ts:309` asserts that `111288.50` is absent from the P&L, while the same value is stored in `cash_flow`. The test therefore gives false confidence.
2. **BalanceSheet on its own**
   - In a real QuickBooks BalanceSheet, Liabilities and Equity are siblings under `LiabilitiesAndEquity`.
   - Removing a payroll-liability row withholds Liabilities and Total L&E. `TotalAssets`, the Equity Summary and the Equity "Net Income" Data row are kept, so payroll liabilities = Assets − Equity − the visible liabilities.
   - This is one report, not "different reports" as the comment at `reports.ts:34-35` and plan-review say. The fixture (`fixtures.ts:195`) has no Equity or payroll liability, so this path is untested.
3. **One excluded individual, exactly (new path)**
   - `excluded_entity_ids` are people paid as individuals.
   - The aging `TOTAL` is withheld, but the BalanceSheet keeps the "Accounts Payable (A/P)" and A/R Data rows (`fixtures.ts:188`, `:195`). On the same date, that balance equals the aging total.
   - So the excluded vendor's balance = BS A/P − the sum of the visible AP aging rows. With one excluded person, this is that individual's amount (rule 13 / spec §2).

**Fix (pick one, then test it):**
- **(i) Withhold derived rows when payroll exists.** When the run's policy has any payroll account or excluded entity:
  - withhold the CashFlow and BalanceSheet "Net Income" rows, and the BalanceSheet `TotalAssets` and Equity Summaries, whenever anything was removed in the P&L or BalanceSheet;
  - withhold the BalanceSheet A/R and A/P rows, and their section totals, when an aging report removed an entity.

  Add tests that rebuild each identity from all five stored payloads and show it can't be solved. Use the existing fixture and add Equity and payroll-liability rows.
- **(ii) Treat it as a human decision.** Add the D-25 sub-question to "Needs human" in `docs/backlog.md`. It is currently only in `.agent/pr/T-052.md:44`, and `backlog.md:146` is unchanged. Then either withhold the `balance_sheet` and `cash_flow` caching (and the aging ↔ BalanceSheet A/P pair) until it is decided, or set T-052 back from `done` and stop, per CLAUDE.md "When blocked".

---

### MEDIUM

**M-A. Plan-review, the PR body and the code comment describe the leftover risk wrongly.**
- `docs/plan-review.md:661`, `.agent/pr/T-052.md:38` and `reports.ts:34-35` say cross-report identities can only "bound" the aggregate, and list A = L + E as a cross-report identity.
- In fact the aggregate can be recovered exactly, A = L + E works inside one report, and the aging ↔ BalanceSheet A/P path for an individual is not mentioned.
- "Individual amounts are not stored" is not true in effect: with one employee or one excluded entity, the aggregate is the individual amount.
- **Fix:** rewrite these after H-A is resolved.

**M-B. Backlog H-035 item (4) is now out of date** (`docs/backlog.md:152`). It still says "which section totals still include payroll (they do by design, see plan-review…)". That contradicts the H1 fix and would mislead the Nov 12 live check.
- **Fix:** reword it to "confirm totals above removed rows are withheld and `TotalsWithheld` is set".

---

### LOW

- **L-A.** The title of `reports.test.ts:316` says "the other aging report keeps its TOTAL". But excluded id `"2"` is in both the AR and AP fixtures (`fixtures.ts:234-235`), so the AR `TOTAL` is withheld too, and the test doesn't assert AR. **Fix:** give AR different ids and assert its `TOTAL` is kept, or correct the title.
- **L-B.** Excluding a nested sub-customer (id `"4"`) is not tested. Only the flat row `"2"` is. The logic (`:285`) covers it. **Fix:** add a case asserting the parent "Total" and `TOTAL` are both withheld.
- **L-C.** `reports.ts:289`: a `GrandTotal` Summary keeps any label QuickBooks sends (masked). That's fine for now; **fix:** limit the kept label to the literal `/^total$/i`.
- **L-D.** `reports.ts:283-284`: if a section's header is neither a payroll id nor a payroll label, but its Summary label is (for example "Total Payroll"), the child rows are already in `out`. Those rows are only caught by id or label checks. This fails safe for totals; add it to H-035 (4).
- **L-E.** I couldn't run Vitest or pgTAP in this session (command approval was refused). Re-run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db` before done.

I did not edit any files, and the previous review in `.agent/notes/review-T-052-security.md` is untouched.
