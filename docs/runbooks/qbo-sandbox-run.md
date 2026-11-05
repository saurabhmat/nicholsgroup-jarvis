# QuickBooks sandbox connection (T-050, T-198)

This runbook takes the Intuit **sandbox** company through the connect and health check on the dev server. It uses the local database with test users only. Never use production keys or the live Pub K Group file; that is H-024.

## Before you start
- The repo-root `.env.local` holds the Intuit **sandbox** keys from H-005: `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET`, `INTUIT_ENVIRONMENT=sandbox` and `INTUIT_REDIRECT_URI=http://localhost:3000/api/connect/qbo/callback`. The launcher reads only these four names and never prints them.
- You have an authenticator app on your phone.

## 1. On the server (VS Code terminal)
```bash
cd ~/dev/pubk-projects/jarvis/pilot-build
pnpm db:start                                                   # local Supabase, if not running
(cd apps/web && node -e 'import("./scripts/e2e-reset.mjs").then(m=>m.default())')   # fresh test users
node apps/web/scripts/qbo-sandbox-dev.mjs --enable-connection-test
```
Leave it running. The launcher refuses to start unless the keys are for the sandbox and the redirect address is the localhost one.

## 2. On your Mac (Terminal)
```bash
ssh -N -L 3000:127.0.0.1:3000 -L 54324:127.0.0.1:54324 saurabh@72.60.97.219
```
Leave this window open. It shows nothing while the tunnel is up.

## 3. In the browser
1. Open **http://localhost:3000**. Use `localhost`, not `127.0.0.1`, or the Intuit redirect will not match.
2. Sign in as `owner@example.test`. Your 6-digit code is at **http://localhost:54324**.
3. Scan the QR code with your authenticator app and enter its code.
4. Go to **Settings** and find **Temporary: connection test**. Click **Connect QuickBooks**.
5. Log in to Intuit with your developer account, choose the **sandbox company** and click **Connect**.
6. You come back to Jarvis. Click **Check connection**. It should show **ok**, a time, and an Intuit request id.

## 4. Tell the agent the result
Report "ok", or the message you saw. Intuit errors mentioning `code_challenge` or `code_verifier` are useful to report word for word. The agent checks the database and audit rows (`.agent/pr/T-050.md`, manual steps 5–8).

## Stop
Press Ctrl+C on the server terminal and in the Mac tunnel. Nothing needs cleaning up; the local database is reset on the next test run.
