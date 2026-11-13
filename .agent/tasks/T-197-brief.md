# T-197 brief: Settings → Connections, QuickBooks section

Approved by Saurabh on Nov 13, 2026: "carry on with quick books connect... complete the code... no need for my approval". He is away. Make scope decisions yourself and log them in `.agent/notes/T-197.md`.

Read these first:
- CLAUDE.md
- `docs/backlog.md`: the T-197 entry, T-198, T-199, and the QB list above T-050
- `.agent/pr/T-195.md` and `.agent/pr/T-196.md`, for the server pieces you are wiring up
- `docs/design/README.md`; Robert approved all designs on Nov 6

## Where you work
- Branch: `agent/T-197`. The lead creates it from agent/T-196 before you start; confirm with `git branch --show-current`.
- Do not switch branches. Do not push.
- `git add` only your own files. Never `-A`. Never commit `.agent/notes/checkpoint-2026-11-02-b.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## LOCAL DATABASE: DO NOT RESET
The local Supabase stack holds Saurabh's live connections.
- Never run `pnpm test:db`, `supabase db reset` or `pnpm test:e2e`.
  - Playwright's global setup (`apps/web/scripts/e2e-reset.mjs`) resets the DB, so do not run Playwright at all.
- Write the Playwright spec (model it on `apps/web/e2e/settings-google.spec.ts`, using the MSW QuickBooks mocks). Make sure it typechecks and lints.
  - List "run `pnpm --filter @nichols/web test:e2e -- settings-qbo` when the local DB may be reset" as a Needs human item.
- If you add SQL (avoid it if you can):
  - Apply it with `supabase migration up --local --workdir supabase/core`.
  - Test with `node scripts/test-db.mjs --no-reset`. Files 060, 070, 150, 160, 200 and 280 fail only because of live data.
  - Add the gitignored manual migration pair `part-17-T-197.sql` and `check-part-17.sql`.

## What to build
1. **Where the section goes.**
   - The page is `components/settings-page.tsx`. The Google section is `components/google-connection-section.tsx` (T-199); use it as the pattern for structure, styles, role gating and copy tone.
   - Add a QuickBooks section beside the Google one.
2. **What the section shows.**
   - Status, from the connection record: not connected / active / degraded / reconnect_required / disconnected.
   - Last sync: last successful `core.sync_runs` time per job, or "not synced yet".
   - The class-tracking flag: "Class tracking: on/off". When it is off, show a short warning that figures are shown unsplit.
   - No figures, no company name if avoidable, and no realm id beyond a masked tail if needed.
   - Data comes from SQL via the lane router. Every function takes `laneId`. Fetch over HTTPS / server components only; no Realtime.
3. **Buttons.** Owner and admin_technical only, at AAL2. Other roles see the status but no buttons, and the server actions or routes return 403 (other lanes 404).
   - **Connect QuickBooks:** starts the existing T-050 flow at `/api/connect/qbo/start` (check the actual start route).
   - **Reconnect QuickBooks:** the same flow. It appears with a `reconnect_required` banner.
   - **Disconnect:** shows a confirm dialog explaining what happens (revokes access at Intuit, deletes stored tokens, stops sync, needs approval). On confirm it calls the T-195 propose action (`propose_qbo_disconnect` on the approvals route), then links to the Approvals page where it is approved with step-up.
     - While a disconnect proposal is pending, show "Disconnect waiting for approval" with a link instead of the button.
     - If the lane's write gate (`qbo_disconnect` policy / `approvals_live`) is off, keep the button available only if proposing still works; otherwise show the reason. Check T-195's gate behaviour and decide.
   - **Download error log (CSV/JSON)** for Intuit support: uses T-196's `connectorErrorExportUrl()` with a small date-range picker, default the last 30 days.
4. **Shared QuickBooks error banner component.**
   - It shows `reconnect_required` and failed states with fixed text and a "Contact support" link (`mailto:it@pub-k.org`).
   - Use it on this page. Also put the "Contact support" link on the page itself.
5. **Fold in the temporary T-198 controls.**
   - "Check connection" moves into the QuickBooks section (keep the route).
   - Remove the "Temporary: connection test" block, and its env/lane_config flag if it is only used there.
   - Update the T-198 notes in the backlog (it says "removed or folded into T-045"; note it is folded here).
6. **Tests.**
   - Vitest for the server loader/view logic and the components: roles, every status, banner, pending disconnect, class-tracking warning, and no realm or figures in the output.
   - The Playwright spec described above.
   - In the PR body, the QB-1 manual checklist against the sandbox company.

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass.
- Commit in logical steps.
- Write `.agent/pr/T-197.md` (changes, tests, risks, Needs human including the Playwright run and the QB-1 checklist) and `.agent/notes/T-197.md`.
- Do NOT set the backlog to done.
- Final message: a summary, the commit list, test results and the decisions you made.
