# Microsoft 365 connect and sync on the local stack (H-070 step 1)

This runbook takes one Microsoft 365 mailbox through connect, mail sync and calendar sync on the dev server, against the
LOCAL database. Which tenant and mailbox may be used is decision D-56 (the backlog recommends a test tenant with made-up
users, H-066). Never production keys, never the production database.

What is built: connect, mail sync (metadata only), calendar sync (default calendar only, D-59), Home / Inbox / briefing
with both providers, opening a message. Not built yet: reply and send from a Microsoft mailbox (T-262, T-263), change
notifications (T-068), other calendars.

## Before you start
- The repo-root `.env.local` holds `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and
  `GRAPH_REDIRECT_URI=http://localhost:3000/api/connect/microsoft/callback` (H-062). The launcher reads only these names
  (and the three `ANTHROPIC_*` names with `--with-ai`) and never prints them.
- The Entra app has that localhost redirect URI, and the tenant has consented to the app (or lets users consent).
- The local switch-on SQL for your lane exists in `supabase/core/bootstrap/manual-migrations/` (gitignored; it holds the
  tenant id, the mail domain and the mailbox). The agent prepares it from the tenant id and domain you give.
- You have an authenticator app on your phone.

## 1. On the server (three VS Code terminals)
Terminal A, the database and the lane settings:
```bash
cd ~/dev/pubk-projects/jarvis/pilot-build
pnpm db:start                                                   # local Supabase, if not running
(cd apps/web && node -e 'import("./scripts/e2e-reset.mjs").then(m=>m.default())')   # RESETS the local database, fresh test users
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/core/bootstrap/manual-migrations/local-enable-microsoft-PKG.sql
```
The last command prints one check row: every column must be `t`.

Terminal B, the app:
```bash
cd ~/dev/pubk-projects/jarvis/pilot-build
node apps/web/scripts/microsoft-local-dev.mjs          # add --with-ai for the briefing and the assistant
```
Terminal C, the background jobs (the sync runs here):
```bash
npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest
```
Leave B and C running. In C, the Inngest page lists the app's functions once the app has started; if it reports an error
for a function, stop and report it word for word.

## 2. On your Mac (Terminal)
```bash
ssh -N -L 3000:127.0.0.1:3000 -L 54324:127.0.0.1:54324 -L 8288:127.0.0.1:8288 saurabh@<server>
```
Leave this window open. Port 8288 is the Inngest dev page (http://localhost:8288).

## 3. In the browser
1. Open **http://localhost:3000**. Use `localhost`, not `127.0.0.1`, or the Microsoft redirect will not match.
2. Sign in as `owner@example.test`. Your 6-digit code is at **http://localhost:54324**. Scan the QR code with your
   authenticator app and enter its code.
3. **Settings -> Connections**: "Your Google accounts" and "Your Microsoft accounts" are side by side. Click
   **Connect Microsoft**, sign in with the test mailbox, accept the permissions (read mail, read calendar, sign in).
   You return to Settings with the account listed as connected.
4. Click **Sync now** (or wait for the 15-minute jobs). On http://localhost:8288 two `conn-sync` runs appear for the
   Microsoft connection (mail, calendar). A large mailbox takes several runs.
5. **Inbox**: messages appear, each labelled "Outlook · <address>" with "Open in Outlook". Open one: the text is shown.
   Reply shows "Reply is not available for this mailbox yet."
6. **Home**: today's meetings and the look-ahead show the default calendar's events, labelled with the account.
7. Negative checks: sign in at Microsoft with an account of ANOTHER tenant -> "wrong tenant" and nothing connected.
   Reconnect a row with a DIFFERENT account -> "account does not match".
8. **Disconnect** the Microsoft account: the row shows disconnected; the text tells you how to remove the app at Microsoft.

## 4. Tell the agent the result
For each numbered step say "ok" or the message you saw, word for word. Also report, from the browser or the Inngest page
(never paste tokens): whether "Open in Outlook" opened the right message and which host it used; whether all-day events
appeared; anything listed as skipped. These answer the open live checks in `docs/plan-review.md` (H-070 step 3).

## Stop and clean up
Press Ctrl+C in terminals B and C and in the Mac tunnel. To remove everything the test stored locally (the mail and
calendar rows and the stored Microsoft token), reset the local database:
```bash
(cd apps/web && node -e 'import("./scripts/e2e-reset.mjs").then(m=>m.default())')
```
