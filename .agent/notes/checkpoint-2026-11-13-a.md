# Checkpoint for Nov 13, 2026 (a): QuickBooks connect done (T-195, T-196, T-197)

Checkout: `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-197`**. Nothing is pushed, because agents can't push.

## Push, PR and merge order
To push and open the PRs, run `.agent/pr/open-prs-T232-T197.sh` after `gh auth login`.

The chain is stacked; merge with merge commits in this order:
1. T-232
2. T-192
3. T-234
4. T-235
5. T-236
6. T-237
7. **T-195**
8. **T-196**
9. **T-197**

Each branch contains all the branches before it. The PR bodies are in `.agent/pr/<task>.md`.

## Production SQL (new parts 15–17)
These files are gitignored and exist only in this checkout, in `supabase/core/bootstrap/manual-migrations/`. Run each part in the SQL Editor in order, after part 14, and then run its `check-part-N.sql`.
- **Part 15 (T-195):**
  - adds the `qbo.disconnect` approvals type, the role per type, the status guard trigger and `reconnect_notified_at`;
  - the check returns 16 rows, all true.
- **Part 16 (T-196):**
  - adds `core.connector_api_errors`, `sync_runs.job`, the 90-day purge, and briefing_coverage reading sync runs only;
  - the check returns 12 rows;
  - **run it before the T-196 code deploys.**
- **Part 17 (T-197):**
  - adds the read-only `core.act_pending_qbo_disconnects`;
  - the check returns 3 rows.

## What was built
- **T-195:**
  - **Disconnect** is an approvals action. An owner or admin_technical proposes it, someone approves it with step-up, and it executes once. Execution revokes access at Intuit, deletes the Vault tokens, and verifies that the connection is `disconnected`.
  - **Reconnect** reuses the existing connection row.
  - **Lost access:** only `invalid_grant`, or a 403 with code 3100, marks a connection `reconnect_required`. Sync, reports and webhook CDC then stop, and admins get one durable notice.
  - **Error map:** Intuit errors are mapped to retry, reconnect or failed, always with fixed text.
- **T-196:**
  - per-job run log for sync, reports and the normalizer;
  - a scrubbed `connector_api_errors` table, with no tokens, emails, names, digit runs or Intuit text;
  - an audited CSV/JSON export using New York days, at most 90 days and 10,000 rows;
  - Sentry is only a seam until T-041.
- **T-197:**
  - Settings → Connections gets a QuickBooks section: status, last sync per job, class tracking, and a masked company id;
  - Connect, Reconnect, and Disconnect (asks for approval);
  - the error-log download;
  - a banner with Contact support;
  - the temporary T-198 controls are folded in.

Each task had a security review, a code review and a re-check of the fixes. No BLOCKER or HIGH is open. Remaining LOW items are in `docs/plan-review.md` under "T-195/T-196/T-197: logged, not fixed".

## Tests
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- `components/brain-wizard.test.tsx` can time out under load; it passes alone.
- pgTAP was run with `--no-reset` only, because the local DB holds the live Google connection. Files 308–310 pass. The older files 060, 070, 150, 160, 200 and 280 fail only because of live local data, which the security reviewer confirmed.
- The DB was never reset and Playwright was not run.

## Needs human
1. Run production SQL parts 15, 16 and 17, in order, with their checks.
2. To enable Disconnect for a lane:
   - add `qbo_disconnect` to `core.lane_policies.write_actions_allowed`;
   - set `approvals_live` to true;
   - the SQL is in `.agent/pr/T-195.md`.
3. Run `pnpm --filter @nichols/web test:e2e -- settings-qbo` once the local DB may be reset; the reset wipes the live connections.
4. Sandbox only, never the live PKG file:
   - the QB-1 checklist (`.agent/pr/T-197.md`);
   - the QB-4 check (`.agent/pr/T-195.md`);
   - record the real Intuit error codes for QB-14 (`quickbooks/errors.ts` was written from the documented format);
   - force a 400 and a 429, check that rows appear in `connector_api_errors`, and download the export.
5. T-041 (Sentry) plugs into the error sink seam in `packages/connectors/src/error-log/sink.ts`.
