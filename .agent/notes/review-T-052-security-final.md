Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**Verdict for T-052: one HIGH is open, so the task can't be marked done.** Changes (1) and (3) are in place and correct. Question (2) is only partly true: no exact payroll total can be recovered from what is cached, but an excluded person's pay can. That makes part of the D-27 / plan-review wording in (4) inaccurate. I read the code and docs but did not run the test suites.

## What was asked

1. **Default report kinds — done.** The default is `pnl`, `ar_aging_summary` and `ap_aging_summary` (`packages/core/src/lane-config/index.ts:66-67`, used at `:148`). `planReports` only builds requests for the listed kinds (`quickbooks/reports.ts:110`), and the job reads both settings before any QuickBooks call (`reports-job.ts:148-151`). `reportSettings` uses the same Zod schemas and throws on a bad `finance`, `entities` or `qbo` value, so the run stops before fetching anything (`vault/lane-config.ts:150-168`). There are tests for the default, a missing config row, a bad `kinds` value, and an empty list fetching nothing.
2. **Payroll totals — none can be recovered from what is cached.** With payroll rows removed, the P&L keeps only "Total Income". Total Expenses, Gross Profit, Net Operating Income and Net Income are all held back (`reports.ts:284-302`). The aging reports drop the parent totals and TOTAL when a person is removed. The raw schema is closed to `authenticated`, and `fin.accounts` stores no balance. **Excluded people's pay can still be recovered — see HIGH below.**
3. **Migration and timeout — done.** The migration has no `alter role` and no `statement_timeout`, only a comment at `:2`. `report-store.ts:36` sets a 30-second abort; when it fires, the run fails as transient, and the database's message is never passed on (`:39-45`).
4. **Docs — the cost of D-27 is described correctly.** The cash view, weekly cash report and tie-out are blocked until it is decided, and options A and B are clear. The claim that no individual's amount can be recovered is wrong (HIGH), and a few lines are out of date (LOW).

## HIGH

**H1. An excluded person's pay shows in a kept P&L line, and the docs say it can't.**
- **Where:** `packages/connectors/src/quickbooks/reports.ts:236-242`, plus the claims at `docs/backlog.md:147`, `docs/plan-review.md:660` and `.agent/pr/T-052.md:37`.
- **Problem:** `excludedEntityIds` can only match aging rows. P&L rows are accounts, so they never match. D-25 says the people Robert lists (contractors, owners) are "treated like employees", but their bills and purchases post to ordinary expense accounts such as "Contract labor" or "Management fees". Those P&L lines are kept, `TotalsWithheld` stays "false", and nothing is held back. Two ways to get the amount:
  - If that person is the only payee on the account, the P&L line *is* their pay, read straight off the report.
  - Otherwise, once T-056 fills `fin.transactions` and `fin.bills` (where T-051 drops that person's transactions), the P&L line minus the ledger total for that account gives their exact amount.
  
  Nothing leaks today because `excluded_entity_ids` is empty. It leaks as soon as Robert answers D-25, which this setting exists for.
- **Fix (pick one):**
  - **(a) Withhold the accounts they post to.** During the sync (T-051), when a transaction is dropped for an excluded person, record which accounts it touched (ids only, per lane). The report job then treats those accounts like payroll accounts: remove the row and hold back the totals above it.
  - **(b) Stop until it's handled.** While `excludedEntityIds` is not empty, refuse to cache `pnl` (fail closed) unless every account those people post to is listed in `finance.payroll.account_ids`. Tell Robert in the D-25 question to list those accounts.
- **Either way:** correct the three doc sentences above, and add a test in which an excluded vendor posts to a non-payroll expense account.

## MEDIUM

- **M1. Non-payroll legs of payroll transactions can be worked out.** T-051 drops a whole transaction if it touches a payroll account, including its other lines (employer health insurance, 401k match, provider fees). Those other accounts stay in the P&L, so the P&L line minus the `fin.*` total gives the employer-paid benefit part of payroll. See `reports.ts:28-35` and `entities.ts` `classifyPayrollAccounts`. **Fix:** fold this into the H1 mechanism (also withhold accounts touched by excluded transactions), or add it to D-25/D-27 so Robert decides whether benefits count as compensation.
- **M2. No timeout on the database side (already documented, `plan-review.md:661`).** That's acceptable as logged. But the T-052 acceptance text at `docs/backlog.md:462` still says "jobs set `statement_timeout`". **Fix:** change the acceptance text to point to the plan-review item, or record the deviation in the PR's risks.

## LOW

- **L1. "Five reports" wording is out of date.** The default is now three. Update:
  - `quickbooks/reports.ts:97` ("The five requests")
  - `reports-job.ts:1`
  - `docs/plan-review.md:653` ("Five summary reports … pulled nightly")
  - H-035 item (6) at `docs/backlog.md:153` ("five rows per run" should be three by default)
- **L2. The `fin.accounts` table comment is now misleading.** It says "cash is read from the Balance Sheet cache" (`migrations/20261104120000_fin_ledger_and_reports.sql:81`), but the balance sheet isn't cached by default. Add "(when D-27 allows `balance_sheet`)" in a later comment migration, or note it in D-27.
- **L3. No test runs the job with the real default settings.** The job tests set `kinds` by hand in the test harness, and the default is only tested in `lane-config.test.ts:156`. Add one test that builds settings from `createLaneConfigReader` with an empty config and checks that only three report requests go out.

The HIGH needs fixing before the task is done. The MEDIUM and LOW items can be fixed or listed in the PR.
