# Checkpoint for Nov 22, 2026

**Where things stand:**
- Checkout: `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-068`**.
- origin/main = `a549092` (PR #63 merged: T-068 and T-264, Microsoft change notifications). T-262, T-263 and T-270 are merged too.
- **Six commits on `agent/T-068` are not on `main`** (docs only: `docs/backlog.md`, `docs/plan-review.md`, this file): `faaa1dc`, `b629715`, `ac488d7`, `db7a11a`, `d85e4e9`, `0741430`, plus the commit of this checkpoint. Saurabh pushes (steps at the end).
- No code changed after PR #63. Nothing is being built right now.

## Microsoft 365 for Nichols Capital (`NC`): working in production
All reported by Saurabh; the agent saw one Home screenshot and no SQL output.
- Production parts 26 to 31 applied. `ENABLED_LANES=PKG,NC`. `GRAPH_NOTIFICATION_URL` set, redeployed, Inngest synced.
- His own mailbox `saurabh@nichols.capital` is connected: mail sync, calendar sync, Home, labels, AI summary, "Open in Outlook".
- Drafts and sending switched on for `NC` (Entra `Mail.ReadWrite` + `Mail.Send` with admin consent, `enable-lane-mail-write-H-072.sql`, check all true, Reconnect). A reply to himself worked.

## Human items closed today
| Item | What | Closed on |
|---|---|---|
| H-072 | Drafts and sending from a Microsoft mailbox, live test | his word: draft, send and Verified "worked" |
| H-068 | Microsoft production setup (app, Vercel variables, SQL parts) | his word; "Production only, not Preview" for the `GRAPH_*` variables never stated |
| H-073 | Change notifications, live check | his word; no observation recorded (expiry on Settings, delivery delay, fall-back). If they fail, the 15-minute polling stays |

What was not observed for each is in `docs/plan-review.md` ("H-072 live test", "H-068 and H-073 closed on Saurabh's word").

## Decided today
- **No DMARC fix task** (Saurabh: "no to dmarc task"). An automated DMARC report was ranked as mail from a person on Home; left as built. A lane can add a sender pattern in its lane_config later.
- Logged, not scheduled: the AI summary said "I could not check whether the payment actually went through" with nothing about a payment on the page. `grounded()` checks figures and dates only. The saved briefing was never read (query given, not run). Do not raise it again unless he asks.

## Waiting on Saurabh (start here next time)
1. **His list of the two new work items. He said he had told the agent before; nothing was written down anywhere (backlog, plan-review, notes, memory), so the details are lost and he was asked three times today:**
   - **Changes to the Pub K (PKG) interface:** which pages, what changes on each.
   - **New reports in the QuickBooks section:** which reports, where they show (Finance page Reports card, Home, or both).
   When he answers: write them into `docs/backlog.md` as tasks the same turn, before anything else.
   Know for the reports: cached today are P&L, AR aging summary, AP aging summary. Balance Sheet and Cash Flow are built but off until D-27 (payroll exposure: A accept aggregate exposure to owner/finance roles, or B withhold more rows first). Anything else is new build work.
2. **H-074:** Robert signs in to production once; re-run the `NC` enable SQL with his address to add him as owner; decide who owns `PKG` (Saurabh is owner today). H-069 stays open until then.
3. **Open decisions:** D-61 (delete Microsoft subscriptions on disconnect), D-58 (same meeting or mail twice across Google and Microsoft), D-60 (limit "Join" links), H-064 / H-065 (GCC cloud and tenant layout), D-27 (payroll in reports).
4. Older, unchanged: Stripe, GoHighLevel and monday.com credentials (H-006, H-007, H-009), Sophie's mapping (D-8).

## Build side
- T-267 (GCC High) and T-268 (shared mailboxes): approved, start only if needed (H-064 / H-065; his decision).
- T-266 (Microsoft for PKG alongside Google): parked until Robert wants it (H-071). Google stays.
- Many older tasks still read `status: proposed` in the backlog; they were not re-checked today.

## To get today's docs commits onto `main` (Saurabh)
1. `cd ~/dev/pubk-projects/jarvis/pilot-build`
2. `git push origin agent/T-068`
3. `gh pr create --base main --head agent/T-068 --title "Docs: Nov 22 human items closed (H-068, H-072, H-073), checkpoint" --body "Docs only: backlog, plan-review, checkpoint. No code."`
4. Merge the PR on GitHub.

Or leave them: the next task branch starts from this checkout and carries them in its PR.
