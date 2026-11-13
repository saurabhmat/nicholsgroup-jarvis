# T-195 brief: QuickBooks disconnect, reconnect and error mapping

Approved by Saurabh on Nov 13, 2026: "carry on with quick books connect... complete the code... no need for my approval". He is away; make scope decisions yourself and log them in `.agent/notes/T-195.md`.

Read first: CLAUDE.md, `docs/backlog.md` (T-195 entry and the QB-1 – QB-20 list just above T-050), `docs/specs/approvals.md`, `docs/plan-review.md` (search D-24, T-050, T-232).

## Where you work
- Branch `agent/T-195` in this checkout (already checked out, stacked on agent/T-237). Do not switch branches; do not push.
- `git add` only files you changed. Never `git add -A`. Never commit `.agent/notes/checkpoint-2026-11-02-b.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## LOCAL DATABASE: DO NOT RESET
The local Supabase stack (`nichols-jarvis-core`) holds Saurabh's live connections.
- **Never run** `pnpm test:db`, `supabase db reset` or `pnpm test:e2e`. Also never run any script that resets the database.
- Apply new migrations with `supabase migration up --local --workdir supabase/core`.
- Run pgTAP with `node scripts/test-db.mjs --no-reset`.
- If the Supabase CLI says it is not running, append the Node 24 nvm bin to PATH: `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)"`.

## What to build (the acceptance is in the backlog; these are the decisions)
1. **Disconnect is an approvals action, `qbo.disconnect`.**
   - **Pattern:** follow the T-232 email flow exactly: `packages/modules/approvals/src/server/email.ts`, `rows.ts`, `wire.ts`, `errors.ts`, `apps/web/lib/approvals.ts` and the approvals routes and UI. That covers proposal, approve the exact hash, step-up (AAL2), claim once, execute, verify and audit.
   - **No T-113:** it is not built. Like email, execution runs inline after the approval.
   - **Who may propose and approve:** owner or admin_technical of the lane only. The executor reads `payload_sha256` and `approved_by` from the locked `act.proposed_actions` row, never from the caller.
   - **Executor:** it calls the existing `quickbooksWriter` (`@nichols/connectors/write`, action `qbo.revoke_grant`; see `packages/connectors/src/quickbooks/writer.ts`). It verifies by reading back that the connection is `disconnected` with its Vault tokens gone. Make sure the connection row ends `disconnected`; check whether `vault.revokeToken` already does that.
   - **Hash test vector:** share one JCS test vector between the approvals hash and the connector's `computePayloadSha256` (T-050 F-M1).
   - **Payload:** the target is `{ realm_id }` of the lane's QuickBooks connection. Keep the payload minimal: no tokens, and no company name if avoidable.
   - **Allowed type:** add `qbo.disconnect` to `act.is_allowed_type` (and to any type list or check in TS).
     - Put this in a new migration under `supabase/core/supabase/migrations/`, with pgTAP that includes a cross-lane denial.
     - Write a production manual-migration file `supabase/core/bootstrap/manual-migrations/part-15-T-195.sql` plus `check-part-15.sql`, in the style of part-14.
   - **Approvals page:** it must show a `qbo.disconnect` card (what will happen, which company by realm id, who proposed it) with Approve (step-up) and Reject. The email-only parts (editing, Sends as) stay email-only.
   - **Propose route:** add a server route or action to propose it, owner/admin_technical at AAL2; other roles get 403, other lanes 404. T-197 puts the button on Settings; you may add no UI button yet.
   - **Write gate:** check how `lane_policies.write_actions_allowed` and `approvals_live` gate email. Decide whether disconnect needs the same gate. Revoking our own grant is low risk, but follow the existing gate unless the spec says otherwise, and log the decision.
2. **Reconnect.** It reuses the T-050 connect flow and the existing connection row for the same realm, flipping it back to active. Check what the callback does today and add tests: reconnect after `reconnect_required`, reconnect after `disconnected`, and a different realm when a realm is configured (rejected, as before).
3. **invalid_grant, revoked or expired refresh token.**
   - Set `reconnect_required`, never retry (test), and stop `conn.sync`, webhook-triggered CDC and the reports job for that connection (tests).
   - Emit the admin notification event. Look for the existing token-health or notification event from T-040 and reuse it.
4. **Error map** (QB-14). Map Intuit responses to retry (capped exponential backoff), `reconnect_required` or failed-with-message:
   - 400 Fault/Error codes (validation and syntax);
   - 401, 403, 404;
   - 429 with `Retry-After`;
   - 5xx and timeouts.

   Much may already exist in `packages/connectors/src/contract/errors.ts` and `quickbooks/api.ts`; extend rather than duplicate. Fixtures are hand-written in Intuit's real response format with synthetic values (rule 10; no live calls); say so in the PR.
5. No external call in tests. No real credentials. Tokens are never logged.

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass.
- `node scripts/test-db.mjs --no-reset` passes after `migration up`.
- Commit in logical steps.
- Write `.agent/pr/T-195.md` (changes, tests, risks, production SQL part 15, Needs human: the QB-4 manual check against the sandbox) and `.agent/notes/T-195.md` (decisions).
- Do NOT set the backlog status to done; the lead does that after the security and code reviews.
- Final message: a summary of what you built, the commit list, test results, decisions, and anything unfinished.
