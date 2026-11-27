# Checkpoint for Nov 25, 2026

**Where things stand:**
- Checkout: `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/checkpoint-2026-11-25`** (from `origin/main`).
- origin/main = `9640338` (PR #75 merged: the security test suite T-170, the header fix T-299, the backlog notes of D-71).
- **One commit on this branch is not on `main`** (docs only: this file and two status lines in `docs/backlog.md`). Saurabh pushes (steps at the end).
- Nothing is being built right now. No builder or reviewer is running.

## Merged since the last checkpoint (Nov 22)
| PR | What | Tasks |
|---|---|---|
| #68 | Calendar page for the signed-in accounts (Google and Microsoft) | T-274 |
| #69 | Connect error shown on Settings instead of `{"error":"unavailable"}` (the cause was a wrong `GOOGLE_REDIRECT_URI` in Vercel, fixed by Saurabh) | T-275 |
| #70 | Faster navigation (reads in parallel, sections streamed) | T-276 |
| #71 | Teams sign-in, chats, call buttons | T-278 to T-284 |
| #72 | Teams send (server side), pictures, channels (read), new-message notices, several Teams accounts per person, tidier Messages | T-285 to T-287, T-289 to T-291, T-294 to T-297 |
| #73 | Teams Send box, "Send = your approval" | T-288 |
| #75 | Security test suite, header fix, D-71 notes | T-170, T-299 |

Dropped: T-293 (AI-drafted Teams replies; D-69 answered no).

## Production state for Pub K (`PKG`), as reported by Saurabh or seen in query results he pasted
- Parts 33 to 37 applied. Lane config version 13 or later: `teams` enabled with features `chat_read`, `call_links`, `chat_send`; `max_accounts_per_person` 2; an `approvals` block with `approvals_live: true` and `teams_step_up_max_age_s: 28800`.
- Lane policy: `write_actions_allowed` = email_draft, email_send, calendar, monday, notion, teams_send; `store_outbound_drafts` true. Calendar, monday and notion have no code behind them (verified by the security review).
- Two Teams accounts connected and usable (pubkgroup.com first; the second was shown only as a count of 2). Two Google mail accounts connected.
- **Teams sending works from the portal** (his words: "i am able to send chats from the portal"). Not reported: the bubble state, whether the authenticator code was asked for, whether both accounts were tried.
- Entra app "Nichols Executive Portal – Teams": in the Pub K tenant (D-62), admin consent granted; the client secret expires about Nov 23, 2027.

## Decisions taken (all in `docs/backlog.md`)
- **D-71, option B (Saurabh, Nov 24):** `approvals_live` switched on for PKG before the security suite existed. The agent had advised a Teams-only switch. This opened every write class the policy lists; only email, Teams and QuickBooks disconnect have executors.
- **D-67:** authenticator code at most once per 8 hours for Teams sends (email keeps 5 minutes). The sign-in's own code counts toward the 8 hours.
- **D-69:** no AI drafts for Teams.
- **D-70 (the agent's default; he was told):** a chat both of a person's accounts are in shows as two rows, one per account.
- Calls open Teams by link; calling inside the portal is not planned. Embedding Teams in the portal is not possible.

## Security suite (T-170): result
- Report: `docs/security/pilot-test.md`; plan: `docs/security/pilot-test-plan.md`; run with `pnpm test:security` (`--db` adds pgTAP without reset).
- Verdict: no BLOCKER or HIGH found. Checked twice by an independent reviewer with mutation tests; the suite was strengthened until its breaks were caught.
- F-01 (MEDIUM, no anti-framing headers): fixed in code by T-299, **production check open**.
- Open LOW findings: F-02 (sign-in wrong-code counter in a client cookie), F-09 (an admin sees a QuickBooks disconnect proposal but not its history), F-10 (`approvals_live` accepted as the text "true"), F-03 (inert policy classes), F-05 (about 40 `console.*` sites outside the redacting logger, now guarded by a test).
- Known flaky test: `apps/web/components/reply-drawer.test.tsx` under load (diagnosis in `docs/plan-review.md`). `pnpm test` as one run exceeds this machine's time limit; run it package by package.

## Waiting on Saurabh (start here next time)
1. **Header check in production (T-299):** DevTools → Network: a page request and an `/api/...` request must show `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`, `x-content-type-options: nosniff`. Then one Teams chat picture request (`…/messages/image`): send its `content-security-policy` and `referrer-policy` values (how Vercel combines a route's own header with the configured one was never seen).
2. **Supabase:** confirm the MFA verification-attempt hook is enabled and points at `core.mfa_verification_attempt` (report step 10).
3. **H-087:** look at the new Messages layout on desktop and iPhone and send screenshots; nobody has seen it on a screen. Sub-steps (a) to (h) in the backlog, including the iPhone keyboard with the reply box, and sign out / sign in as another person / Back.
4. **H-083:** does Settings show "Live updates until …" on the Teams rows, and does the "new" dot appear when someone messages him (whether Microsoft accepted the all-chats subscription was never reported).
5. **H-085 notes:** did Microsoft show its account picker when connecting the second account (A-1), and which account Reconnect picks (A-2).
6. Details of the first live Teams send (bubble state, authenticator prompt, both accounts).
7. Older open items: H-077 (Supabase region), H-074, D-61, D-58, D-60, H-064/H-065, D-27, H-006/H-007/H-009, D-8; the "new reports in the QuickBooks section" request is still undefined.

## Not built, waiting for a word from him
- **T-292** posting in team channels (approved; channels are not switched on for PKG: H-084 needs Entra permissions and consent).
- **T-298** replace real company domain names in tests and comments with synthetic ones (proposed).
- Fixes for the LOW findings above (F-10 needs a production SQL part).
- A full Content-Security-Policy (script and style), and a behaviour test for the headers `proxy.ts` returns.

## How this work was run (for the next session)
- One builder at a time (1 core, 3 GB); each piece: build → security review and code review → one fix list → re-check; reviewers were given the code, not conclusions. Builders commit checkpoints every 20 to 30 minutes, because sessions ended unexpectedly several times.
- Never: pushing, production, `pnpm test:db`, `supabase db reset`, Playwright or e2e runs, `apps/web/.env.local`. pgTAP only with `node scripts/test-db.mjs --no-reset`.
- Production SQL: a read-only state query first; hand him paste-ready SQL with the values filled in; the SQL Editor shows only the last result set.
- Gitignored operator files with PKG values are in `supabase/core/bootstrap/manual-migrations/` (parts 35 to 37, and the `H-082`, `H-085` and `D-71` files).
- A lesson from this stretch: check a feature's go-live gate before building it. The Teams Send box was built, reviewed and merged before it surfaced that `approvals_live` was deliberately off (D-11, T-170).

## Push steps for this checkpoint (Saurabh)
1. `git push origin agent/checkpoint-2026-11-25`
2. `gh pr create --base main --head agent/checkpoint-2026-11-25 --title "Checkpoint Nov 25: Teams live, security suite merged" --body "Docs only: the checkpoint note and two task status lines in the backlog."`
