# First live test: Gmail + Calendar, setup interview, assistant (Nov 8, 2026)

Path: **native Google** (already built and reviewed: T-063, T-064, T-199) + AI Brain interview (T-216) + assistant with brain context (T-212).
Composio is not on this path yet (D-37; needs H-041 and T-223). Everything below is done by Saurabh; agents never touch production.

## A. Production database (Supabase SQL Editor, project lxjhaxdkqtmkhloqaffb), in this order
1. `supabase/core/bootstrap/production-pkg.sql` with `v_email := 'saurabh@pub-k.org'` (skip if already run: the check select shows `PKG | true | {email,calendar} | owner`).
2. `supabase/core/bootstrap/manual-migrations/part-6-T-219.sql` (both Composio migrations; the deployed code reads the new columns).
3. `supabase/core/bootstrap/production-pkg-lane-config.sql` (PKG lane settings + the mailbox list; without it the interview answers 403 and Google refuses to connect).

## B. Google (console.cloud.google.com, the OAuth client already in .env.local)
- Authorized redirect URI: `https://<your-vercel-domain>/api/connect/google/callback`
- If the OAuth consent screen is in Testing, add `saurabh@pub-k.org` as a test user.
- Use the Pub K Group mailbox only (D-33): not a personal or SimpliAutomated mailbox.

## C. Vercel env vars (the environment that serves `main`; Production unless you changed it)
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_ANALYSIS`, `ANTHROPIC_MODEL_FAST` (the assistant needs all three),
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (same as the redirect URI above).
Inngest keys are already set (background jobs run). Redeploy after changing variables.

## D. Ship the code
Push `agent/T-219` (it contains T-212 and T-216), open the PR, merge to `main`. Vercel deploys.

## E. Test, in this order
1. Sign in (email code + authenticator).
2. Settings -> Connections -> **Connect Google**. Consent lists read mail, read calendar, read Drive. You return with a green "Google connected".
3. Wait for the first sync (Home briefing / Inbox / Calendar fill in). If nothing appears after about 15 minutes, tell me; do not reconnect repeatedly.
4. Assistant -> type "set up my brain" (or Settings -> AI brain). Answer a group, check the diff card, press Save. Nothing saves before that click.
5. Ask the assistant something your answers should change ("what do you know about my preferences?"; "any unread important email?").

## F. Known limits for this test
- Composio, Disconnect (arrives with Approvals), the test briefing (T-213) and daily briefing are not built yet.
- The Playwright iPhone spec for the interview has not been run (its setup resets the local DB).
