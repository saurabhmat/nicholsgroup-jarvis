# Go-live checklist: PKG on the real QuickBooks company (H-061)

Written Nov 14, 2026, and updated the same day for T-246 and the domain. Nothing here has been run in production. The SQL files are gitignored, in `supabase/core/bootstrap/manual-migrations/`. Each was tested locally inside a rolled-back transaction with synthetic ids.

Decisions:
- Mode is `file`: the whole Pub K Group company file is PKG.
- Only PKG connects now. The other two companies come later as their own lanes, on the same Intuit production app.
- The app domain is `https://nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app`, the git-main alias we actually use.
- Out of scope: GCC and Microsoft 365.
- The old sandbox scripts (`pkg-qbo-sandbox-realm.sql`, `pkg-qbo-entity-mapping.sql`) will be deleted by Saurabh.

## Before go-live day
1. **T-246 deployed, with part 24 run** (`part-24-T-246.sql`, then `check-part-24.sql`: 9 rows, all true).
   - Every Home and Finance figure now reads only the current QuickBooks connection: AR over 30 days, aging, oldest invoices, bills due, the AR total, the unmapped counts and the "has data" test. Cash, Net income and Reports already did.
   - Without it, the sandbox's invoices (AR over 30 today $5,281.52) would be added to the real company's AR.
   - Part 24 is safe to run before the T-246 deploy. Run it before switch day; it must be in place before the real company is connected (step 5).
2. **T-245 deployed** (the Finance page crash).
3. **Intuit production keys approved** (see "Intuit production keys" below).
4. **Confirm the company ids.** The real Pub K Group company id and the other two companies' ids come from QuickBooks: Settings gear > Account and settings > Billing & subscription > Company ID.
5. **Old sandbox helpers deleted** (Saurabh). Running `pkg-qbo-sandbox-realm.sql` after go-live would pin PKG back to the sandbox.
6. **Vercel: `main` is the Production branch.** Check Settings > Git > Production Branch = `main`, so the git-main URL serves Production deployments (`VERCEL_ENV=production`). The app refuses `INTUIT_ENVIRONMENT=production` in any other Vercel environment (`isRealDataEnv`) except the custom Staging environment. If `main` deploys as Preview, the build fails with "Intuit (production keys only in staging or production)".

## Switch day, in order
1. **Baseline (read-only).**
   - Run `pkg-report-cache-list.sql` and `golive-timeout-a-check.sql`.
   - Note the sandbox connection id: `select id, status from core.connections where lane_id='PKG' and provider='quickbooks';`
2. **Disconnect the sandbox while Vercel still has the development keys.**
   - Preferred: Settings > Connections > QuickBooks > Disconnect, then approve it on the Approvals page. This also asks Intuit to end the grant, and that call needs the development keys. It needs `qbo_disconnect` in PKG's write actions and approvals switched live.
   - Fallback: `golive-0-pkg-qbo-sandbox-disconnect.sql`. It deletes the stored token, marks the connection disconnected and writes an audit row (actor "service"), but does not tell Intuit. After that the grant cannot be revoked from the app either. It only reaches sandbox data, so let it lapse or remove it in the Intuit sandbox.
   - The status must end as `disconnected`. Any other status, including `reconnect_required`, still counts as current, and its figures would be added (pgTAP 318 shows this).
   - Nothing is deleted: the sandbox's raw rows, `fin.*` rows and cached reports stay, and the figures ignore them.
3. **Vercel: switch to the production Intuit keys** (below), then redeploy production.
4. **Run `golive-1-pkg-qbo-realm.sql`**, after pasting the real id and the other two companies' ids (both required). Then run `check-golive-1-pkg-qbo-realm.sql` (6 rows, all true).
   - It refuses: a missing or duplicate "other" id, the sandbox id, either of the other two ids, an id another lane is configured for or connected to, and any PKG connection that is still live to a different company.
   - It also clears the bank account list, because sandbox account ids mean nothing in the real file. In the local test, id 35 was "Checking" in the sandbox and "Stripe Clearing" in the real file.
5. **Connect QuickBooks.** In the portal: Settings > Connections > Connect QuickBooks (owner or admin, with a recent authenticator code), signed in to Intuit, choosing Pub K Group.
   - The callback refuses any other company for PKG ("not the one configured for the lane").
   - The connect step starts a full sync automatically (T-241). Watch it in Inngest until the sync and the normalize finish.
   - **If the normalize fails with 57014 (statement timeout):**
     - run `golive-timeout-a-check.sql`;
     - with Saurabh's go-ahead, run `golive-timeout-b-apply.sql`;
     - re-send `fin/qbo-normalize.requested` for the real connection.
   - If it still fails after the reload, undo with `golive-timeout-c-undo.sql` and stop.
6. **Map the bank accounts** (`golive-2-pkg-qbo-entity-mapping.sql`).
   - First check that exactly one PKG QuickBooks connection is not disconnected: `select id, status, external_account_id from core.connections where lane_id='PKG' and provider='quickbooks';`. A leftover `pending` or `error` row from an aborted connect must be disconnected first.
   - Run **PART A** (the read-only preview at the bottom):
     - Check that the company name is Pub K Group.
     - Check the fiscal year start month. If it isn't January, tell Saurabh: the portal's "Year to date" is the calendar year.
     - Decide with Sophie or Robert which bank accounts are Cash. The suggestion leaves out Stripe, clearing, undeposited and in-transit accounts. A PayPal, Square or sweep account is NOT left out automatically: decide each one.
     - Account names can include the last digits of an account number. Keep them in the SQL Editor; don't copy them into chat or documents.
   - Paste three values into **PART B**: the real id, a part of the company name (for example `Pub K`), and the exact account ids to count. Run PART B. It refuses if the connected company's name does not contain that text, or if an id is not an active bank account of the real connection.
   - Run `check-golive-2-pkg-qbo-entity-mapping.sql` with the same three values (6 rows, all true, plus the Cash total).
7. **Refresh the figures.** Send `fin/qbo-normalize.requested` with `{ "laneId": "PKG", "connectionId": "<real connection id>", "trigger": "manual" }`, then `fin/qbo-reports.requested` with the same payload.
8. **Timeout review.** Run `golive-timeout-a-check.sql` again.
   - If p95 is above about 5 s, decide on `golive-timeout-b-apply.sql`.
   - That file reverses the T-052 decision against a role-wide timeout: it affects every service_role request, and the hosted role may refuse the change. If you apply it, log it in `docs/plan-review.md`.
9. **Verify against QuickBooks with Sophie.**
   - Home and Finance Cash equal the check-2 total, labelled "book balance".
   - AR equals QuickBooks' A/R Aging Summary total.
   - Bills due in 14 days.
   - Net income for month to date and year to date equals the QuickBooks P&L for the same dates and accounting basis.
   - Controls shows the left-out accounts (for example Stripe clearing) as "not mapped", which is expected.
   - The Vercel logs are clean.
10. **Close H-061** in the backlog, and record the realm and the go-live date.

**Rollback.** Disconnect the real connection through approvals (Settings > Connections > QuickBooks > Disconnect). The realm stays pinned to the real company, and nothing is deleted.
- Going back to the sandbox is not a one-step undo, because the sandbox helper scripts are deleted. It needs a new, guarded realm switch: ask Saurabh.
- In practice, stay pinned to the real company and fix forward.

## Intuit production keys (one app for all three companies)
1. developer.intuit.com > the app > Keys & credentials > **Production**. Complete "Get production keys" (domain: `nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app`):
   - app details;
   - the end-user license agreement and privacy policy URLs;
   - the host domain and launch, connect and disconnect URLs;
   - the app assessment questionnaire.
   
   Intuit may review it before the keys are issued.
2. Production > **Redirect URIs**: add exactly `https://nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app/api/connect/qbo/callback`. It must use https, with no trailing slash, and match `INTUIT_REDIRECT_URI` exactly. The app refuses any other path.
   - Use the same domain for the app's host domain, launch URL (`/`), connect URL and disconnect URL in the production keys form.
3. **Webhooks** (only if used): add the production endpoint `https://nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app/api/webhooks/qbo`, and copy its verifier token.
4. Vercel > Project > Settings > Environment Variables, **Production only**:
   - `INTUIT_CLIENT_ID`;
   - `INTUIT_CLIENT_SECRET` (mark it Sensitive);
   - `INTUIT_ENVIRONMENT=production`;
   - `INTUIT_REDIRECT_URI=https://nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app/api/connect/qbo/callback`;
   - optionally `INTUIT_WEBHOOK_VERIFIER_TOKEN`.
   
   Keep the sandbox keys on Preview and Staging. The app refuses production Intuit keys outside staging and production builds anyway.
5. **Redeploy production** (a push to `main`, or Redeploy on the latest Production deployment). Variables take effect only on a new deployment. The git-main alias then points at it.
6. **Later companies:** each new lane gets its own realm pinned in its lane config. The same keys and redirect URI serve all three, and one company can be connected to only one lane (D-23 index).

## Stripe inside QuickBooks
- **Double counting.** Revenue and MRR come only from Stripe (rule 8). QuickBooks supplies Net income, AR, bills and cash, and no portal figure adds QuickBooks income to Stripe revenue. Stripe sales that the Stripe-to-QuickBooks sync posts into the books are correctly part of QuickBooks Net income. Keep two rules:
  - never show QuickBooks "Income" as revenue next to Stripe revenue;
  - never sum the two.
  
  Tie-out point for Sophie: if the Stripe sync creates QuickBooks invoices that stay open until payout, AR includes them.
- **Clearing account.** In golive-2 you list the exact accounts to count in Cash. The preview suggests leaving out any bank account whose name or subtype looks like Stripe, clearing, undeposited funds or payments in transit. An account left out appears in Controls as "not mapped". Robert or Sophie should confirm that Stripe money in transit is not cash. If they want a dedicated "excluded from cash" list instead of "not mapped", that is a small schema task.
- After new bank accounts are added in QuickBooks, run golive-2 again: PART A shows them, and PART B takes the full list of ids to count.
