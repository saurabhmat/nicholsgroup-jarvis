# Enable mail and calendar for a company (lane): runbook (T-265)

Turns on **mail and calendar only** for one company in **production**: the company appears in the portal, its members sign in to it,
and each member connects their own mailbox. No finance, no QuickBooks, no writes (nothing is sent, drafted or changed in any mailbox).
Worked example: lane **`NC`** with **Microsoft 365**, decision D-50, first live test D-56 (Nov 22, 2026). The steps are
generic: replace the example values with the company's own. Backlog items covered: H-068 (checks), H-069 (this run), H-070 (live check).

You (Saurabh) run every production step yourself. The agent never touches production, never sees a token, and never runs the SQL.

**Read this first.** The first real Microsoft call of the whole system happens in this run, in production, with a real mailbox
(D-56: there was no earlier rehearsal). So the SQL refuses to run on anything it does not recognise, and every step below says what
you must see before you go on. **If a result differs from "Expect", stop and tell the agent word for word. Do not continue.**

## What changes, and what does not

| Changes | Does not change |
|---|---|
| A new company row, its policy, one new settings version, two memberships (the SQL part) | The existing full company (`PKG`): its settings, policy, members, mailboxes, jobs and pages |
| `ENABLED_LANES` gets the new company's code | Sign-in (email code + authenticator), the Vault, any token |
| Members of the new company see it in the company switcher | Nothing is deleted, nothing is written to any mailbox |

What the new company shows (its settings version lists the modules `comms`, `calendar`, `briefing` and limits the company to them):
Home with mail and calendar, Inbox, Calendar, Settings with **Your Microsoft accounts**. It has **no** Finance, Approvals, Assistant,
Projects, QuickBooks strip, GovCon news card or "Get started" entry. Every member sees only their **own** mail and calendar, you included
(D-43): you see Robert's mailbox row on Settings as health only (status, last sync), never his messages.

## Before you start

Tick every line. Each one has an exact way to check it.

1. **The code is deployed.** The production deployment is built from a `main` that contains T-265 and the whole Microsoft read side
   (T-255 to T-261, T-066, T-067, T-269). Vercel dashboard -> the project -> **Deployments** -> the top **Production** row: its commit
   message or commit id is on `main` after the T-265 merge. *Expect:* yes. If not, merge and deploy first. (The code comes before the SQL because an older deployment ignores the new `limit_to_enabled_modules` setting, so the company would show every module, finance tiles and QuickBooks strip included.) (T-067 and T-260 matter most: until
   they are deployed every Microsoft calendar sync fails and raises an alert, H-069.)
2. **H-068 is done.** Vercel dashboard -> Settings -> Environment Variables: `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and `GRAPH_REDIRECT_URI`
   exist for **Production** only (not Preview), and `GRAPH_TENANT_ID` exists nowhere. `GRAPH_REDIRECT_URI` is **exactly** the production
   `NEXT_PUBLIC_APP_URL` plus `/api/connect/microsoft/callback` (see "The redirect address and the Entra app" below: never a domain that is not live yet),
   and that same address is listed in the Entra app (Entra admin centre -> App registrations -> the app -> Authentication -> Web). *Expect:* all true.
3. **The production database has parts 26, 27 and 28.** Supabase dashboard (production project) -> SQL Editor: open
   `supabase/core/bootstrap/manual-migrations/check-part-26.sql`, paste, **Run**; then `check-part-27.sql`, then `check-part-28.sql`.
   *Expect:* every row `true` in each (13, 5 and 5 rows; they were applied on Nov 21, 2026). If a check shows `false`, do not go on.
4. **Consent is granted in the company's Microsoft tenant** (H-063): the tenant admin has approved the portal's app once, or users may consent
   themselves. For `NC` you are the tenant admin, so this is done (backlog H-063). For another company: ask its admin (spec section 5.5).
5. **Each person you name has signed in to the portal once** (email code, then the authenticator code), so a user exists for them. Do not
   assume it: check with this read-only query in the SQL Editor (production), which lists every portal user:
   ```sql
   select u.email, u.email_confirmed_at is not null as confirmed,
          exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified') as authenticator
   from auth.users u order by u.email;
   ```
   *Expect:* a row with `confirmed` and `authenticator` both `true` for each person you will name. (Nov 22, 2026: production had one portal
   user only, so the first run for `NC` named no owner.) **The owner is optional:** when the owner has no portal sign-in yet, leave the owner
   address and name empty (`''`) in both files; the company then has the admin_technical member only. Add the owner later with the section
   "Add the owner later" below.
6. **You know the eight values** (six items; two of them are an address plus a name) (never write them in any committed file or chat; they go only into the gitignored SQL file on your machine):

   | Value | Example (NC) | Where it comes from |
   |---|---|---|
   | Lane code | `NC` | 1 to 8 capital letters; the existing code of the company |
   | Lane display name | the company's name as the portal should show it | only used when the company has no row yet |
   | Mail domain | the company's mail domain, lower case | the part of the mailbox address after `@` |
   | Tenant id | a lower-case UUID | Entra admin centre -> **Overview** -> **Tenant ID** (backlog H-063 has it) |
   | Owner sign-in address and name | Robert's portal sign-in address, or empty (`''`) for both when he has no portal sign-in yet | the address he signs in to the portal with, not necessarily his mailbox |
   | admin_technical sign-in address and name | your portal sign-in address | the address you sign in to the portal with |

7. **Write down the "before" state** (you compare against it at the end). Supabase SQL Editor (production), run:
   ```sql
   select (select version from core.lane_config_current where lane_id = 'PKG') as pkg_config_version,
          (select count(*) from core.lanes where enabled) as enabled_lanes,
          (select count(*) from core.connections where lane_id = 'PKG') as pkg_connections,
          (select count(*) from core.memberships where lane_id = 'PKG') as pkg_members,
          (select updated_at from core.lane_policies where lane_id = 'PKG') as pkg_policy_updated_at;
   ```
   Also note the current **Production** value of `ENABLED_LANES` in Vercel (expected `PKG`). *Expect:* the lane you are about to add is not in it.

## 1. Fill in the SQL file (on your machine, not in git)

The files are in `supabase/core/bootstrap/manual-migrations/` and are gitignored on purpose:
`enable-lane-mail-T-265.sql` (the change) and `check-enable-lane-mail-T-265.sql` (the read-only check).

1. Open `enable-lane-mail-T-265.sql` in VS Code. Near the top, in the block that starts `v_lane constant text := ...`, replace each
   `'PASTE-...'` with your value. **Keep the single quotes.** Eight values: lane code, lane display name, mail domain, tenant id, owner sign-in
   address, owner display name, admin_technical sign-in address, admin_technical display name. (The two display names are used only if that person
   has no portal profile row yet; for Robert and you they are not used, but the file still needs a valid name.)
2. Open `check-enable-lane-mail-T-265.sql`. There are two places: the `do $guard$` block and the `with p as (select ...)` block. Paste the
   **same** five values there (lane code, mail domain, tenant id, the two sign-in addresses; the lane name and the two display names are not needed) in both places.
3. Do not touch anything else. In particular do not edit the JSON between `$cfg$` markers: it is the exact settings text the app was tested with.

*Expect:* nothing runs yet. If you press Run now, with a `PASTE-` left, the file stops with "A PASTE-... placeholder is still in the block".

## 2. Run the change

Supabase dashboard (the **production** project: check the project name in the top left) -> **SQL Editor** -> **New query** -> paste the whole
`enable-lane-mail-T-265.sql` -> **Run**.

*Expect:* the result panel says success, and the messages (the "Messages" or "Notices" tab) read, in this order (with no owner named the first line is `OWNER: none named. ...` and there is no `Owner membership written.`; for a company that already had the unused default policy the policy line is `Lane policy: the untouched bootstrap policy (nothing allowed, 30 days) replaced by the mail-only policy ...`):
`OWNER resolved: display name ..., sign-in email ..., already member of: ...` and `ADMIN_TECHNICAL resolved: ...` (**read these two lines: the names and emails must be Robert and you**; when no owner was named, only the ADMIN_TECHNICAL line names a person, and it must be you. The SQL Editor shows the messages only after the script has finished, so if either is the wrong person the change is already written: do not go on, do not set `ENABLED_LANES`, and take the company out of service with rollback level 2, step 3, below, then tell the agent), then `Lane NC created and enabled.` (or `Lane NC enabled.`), `Lane policy written.`, `Lane config version 1 written.`,
`Owner membership written.`, `Admin_technical membership written.`, `Done. Now run check-enable-lane-mail-T-265.sql...`.

*If it stops with an error,* nothing was written (the script is one transaction). The message says what to fix:
- "No portal sign-in for the owner address yet", "... not confirmed" or "... no verified authenticator" -> that person finishes sign-in once (email code, then authenticator); run again. "More than one sign-in matches" or "... already has members other than these two people" -> stop and tell the agent.
- "... already has a lane config ... that differs" / "... a lane policy with different settings" / "... a different membership" -> someone
  configured this company before. **Stop and tell the agent.** The file never overwrites.
- "... not a core-plane lane" or "... already has a QuickBooks, Stripe or GoHighLevel connection" -> this is not a mail-only company. Stop.
- a format message (tenant id, domain, address) -> fix that value and run again.

**Running it twice is safe.** The second run says `Lane config version 1 is already exactly this: nothing written.` and
`Everything was already in place: nothing changed.`

## 3. Run the check (every row must be true)

SQL Editor -> new query -> paste the whole `check-enable-lane-mail-T-265.sql` -> **Run**.

*Expect:* 14 rows, every `ok` = `true`. Do **not** go on with any false row.
Then two more result sets with real values: the lane row (`code`, `name`, `enabled`) and one row per member (role, display name, sign-in email, confirmed, authenticator). **Confirm the two names shown are the owner and you**, there are exactly two rows, and `enabled` is `true`. (When no owner was named: exactly **one** row, you as admin_technical. Do not add anyone by hand.) (Some SQL editors show only the last result set; use the tabs under the Run button.)

**Then put the placeholders back.** In both SQL files replace every value you pasted by its `PASTE-...` again (or delete your filled copies, or keep filled copies outside the repository). The files are gitignored, but a filled file must not sit in the checkout.
Two rows look at "the last 2 hours" for other companies' settings and policies: if one of them is false because you changed another
company on purpose in the last two hours, say so to the agent; otherwise it is a real warning that something else was touched.

## 4. Turn the company on in the app (Vercel Production)

Order matters: the SQL (steps 2 and 3) **must come first**. A company listed in `ENABLED_LANES` that the database does not know or has not enabled
makes the webhook lookup fail for **all** companies, including `PKG` (it asks every served company), and makes that company's scheduled runs fail
(the run is marked failed, and three in a row can raise the failure banner); the other companies' scheduled work still goes out.

Before you save the variable, copy the company code from the check output (the `code` column, step 3) and run once more:
```sql
select code, enabled from core.lanes where code = 'PASTE-LANE-CODE';
```
*Expect:* exactly one row, `enabled` = `true`. Only then continue.

1. Vercel dashboard -> the project -> **Settings** -> **Environment Variables**.
2. Find `ENABLED_LANES` -> the three dots -> **Edit**. Environments: tick **Production** only. Value: the old value plus the new code,
   comma separated, no spaces: `PKG,NC`. **Save.**
3. **Deployments** -> the top **Production** row -> the three dots -> **Redeploy** -> **Redeploy**. (A changed variable only applies to a
   new deployment.) Wait until the row says **Ready**.

*Expect:* **Ready**, no build error. Do not use any command-line deploy.

## 5. Sync the background jobs

Inngest dashboard -> **Apps** -> the production app -> **Sync new deployment**.

*Expect:* sync succeeds and the function list is unchanged (no new function is added by this run; Microsoft jobs came with H-068's sync).
Then wait for the next quarter hour and open **Runs**: `mail-ingest-delta` and `cal-ingest-delta` finish **Completed** (they have nothing to
do for the new company until a mailbox is connected), `briefing-refresh` and `news-daily` complete or skip. No failed run. If a run fails,
open it and send the error text to the agent; do not retry by hand.

## 6. Look at it as Robert and as yourself

Sign in (email code, then authenticator) and check each line.

1. **`PKG` is unchanged.** Open the portal address: you land on `PKG` (the landing page prefers a company that shows every
   module, so a mail-only company never becomes the first page). Its menu is as before (Home, Finance, Inbox, Calendar, Approvals, Assistant,
   Projects, Settings); Home shows the QuickBooks figures as before. In the SQL Editor re-run the "before" query of step 7 above:
   *Expect:* `pkg_config_version`, `pkg_connections`, `pkg_members` and `pkg_policy_updated_at` unchanged, `enabled_lanes` one higher.
2. **The company switcher** (top of the side menu, a chip on the phone) now lists both companies. Pick the new one.
3. **Its menu** shows Home, Inbox, Calendar and Settings only. No Finance, Approvals, Assistant, Projects, no "Get started".
4. **Its Home** has "Needs your attention" and the calendar sections and nothing about QuickBooks, cash, AR or bills, no approvals banner,
   no Projects or GovCon news card, no "Ask Jarvis" button.
5. **Settings -> Connections** shows **Your Microsoft accounts** with a **Connect Microsoft** button and **no** "Your Google accounts", no
   QuickBooks row, no Composio row, no "GovCon news", no "AI brain".
6. Pick `PKG` again and click Finance in its menu: it opens. (While on the new company, a Finance address typed by hand sends you to
   its Home. The switcher keeps the page name when you change company, so this is the expected landing.)

If any line differs, stop and tell the agent which line and what you saw.

## 7. Connect the first mailbox (H-070 step 2)

**You** connect your own mailbox first (D-56). Robert connects his own after that, from his own sign-in; nobody connects someone else's mailbox.
This works for you as `admin_technical`: any member who holds the "own mail" view connects their own account (owner, admin_technical and viewer
roles; checked in code, see the PR notes).

1. In the new company: **Settings -> Connections -> Your Microsoft accounts -> Connect Microsoft**.
2. Microsoft sign-in opens. Sign in with your company mailbox (the one on the mail domain from step 6 of "Before you start"). Accept the
   permissions. They are **read mail**, **read calendar**, **sign you in and read your profile**, and **keep access** (`offline_access`). Because
   this company's policy allows no writes there is **no** "send mail" or "read and write mail" permission on the consent screen. **If you see
   a send or read-write permission, press Cancel and tell the agent.**
3. You return to Settings. *Expect:* your address under Your Microsoft accounts, status connected.
   Refusals have fixed texts: "wrong tenant" (the account is in another Microsoft tenant), "account does not match", "not allowed for this
   company" (domain), an "admin approval needed" notice with a link (the tenant admin must approve once).
4. Click **Sync now** (Settings -> Connections, above the list, or on Home beside the sync status; it syncs every mail and calendar connection of the company, whichever provider). *Expect:* within a few minutes Inbox lists messages labelled "Outlook · your address" with **Open in Outlook**; open one: the text
   is shown (read live, never stored). Home shows your mail and today's meetings. A large mailbox takes several runs.
5. Sign in as Robert (he does this himself, later) and check that Settings shows **his** mailbox row and **yours** as health only (status and
   last sync, no message, no subject), and that his Inbox shows only his mail.
6. Open Settings -> Disconnect only if you want to undo this step. It stops syncing and deletes the stored token; Microsoft keeps the app
   listed under "My Apps" until you remove it there (the page tells you where).

Write down for the agent, step by step, "ok" or the message you saw word for word. Never paste a token or a code. These answers settle the
live checks of `docs/plan-review.md` (H-070 step 3).

## The redirect address and the Entra app (reference; T-270)

Read this when a connect is refused, and before you set `GRAPH_REDIRECT_URI` for a new deployment.

**The redirect address.** Until the company's own domain is live, production runs on its fixed Vercel address. The server accepts a redirect
address only on the app's own origin, so `GRAPH_REDIRECT_URI` must be **`NEXT_PUBLIC_APP_URL` (the Production value, no trailing slash) followed by
`/api/connect/microsoft/callback`**, and the same address must be listed in the Entra app under Authentication -> Web. Never write the address
of a domain that is not live yet: the connect then fails at the start with `GRAPH_REDIRECT_URI: must be on the app's own origin` (the banner says
"This connection isn't configured on this server"). The custom domain's address may be added to the Entra app **in addition**, so that the switch
to the domain later is a change of the two variables only; it is not used until `NEXT_PUBLIC_APP_URL` is changed.

**The permissions the Entra app may hold** (API permissions -> Microsoft Graph -> **Delegated**) for a company whose policy allows no writes:
exactly `User.Read`, `Mail.Read`, `Calendars.Read`, `openid` and `offline_access`; `email` and `profile` are harmless extras. Nothing else.
Microsoft lists **every delegated permission the tenant has consented for the app** in the token answer, not only the ones the connect asked
for, and the portal refuses any grant that holds a permission it did not ask for ("Microsoft account not accepted"). So one stray
permission, for example an access-review or authentication-method permission left over from an earlier use of the same app registration,
makes **every** connect fail, for everyone. To remove such a permission: **first revoke the admin consent** for it (Entra admin centre -> Enterprise
applications -> the app -> Permissions -> the permission -> revoke, or "Revoke admin consent"), **then** remove it from the app registration
(App registrations -> the app -> API permissions -> the three dots -> Remove permission). Removing it from the registration alone leaves the
consent in place and the token answer still names it. Then connect again.
(When a company's policy later allows email writes, `Mail.ReadWrite` and `Mail.Send` are added for it; a read-only company in the **same** tenant
would then be refused on every connect. That is an open design question for the write task, not something to work around by hand.)

**When the first sync comes.** After a connect the first sync is not immediate. **Mail** and **calendar** run on different quarter-hours:
mail at minutes 7, 22, 37 and 52 of every hour, calendar at 0, 15, 30 and 45 (cron `7-59/15` and `*/15`). So the calendar can sync
first and the mail up to 15 minutes later; until the mail has synced, Settings shows "Mail: not synced yet" for it (and Coverage lists Mail as
"Not synced yet", never with the calendar's time). **Sync now** starts both at once. Home's AI summary is not made before a mailbox is
connected, and a summary made before the first sync is renewed once when you next open Home.

**Where to look in the logs** (Vercel -> the project -> Logs, search for the text):
- `oauth_callback_failed` (event `connector.oauth_callback_failed`): why a connect was refused. The field `reason` is the fixed reason shown to the person.
  For a refusal because of granted permissions, the field `unexpected_scopes` lists the permissions the grant held that were not asked for, by name
  (for example `AccessReview.Read.All`); names that are not plain letters, digits, dot, dash or underscore, and any beyond the tenth, appear as `other`.
  Remove those permissions as described above. The refusal text itself, the redirect and the audit entry never carry the names.
- `[api/connect/start] unavailable:` is a connect that could not start: the line names the error class and, for a connector error, its `kind` and fixed
  message (for example `connection_unavailable` with `GRAPH_REDIRECT_URI must end with ...`).
- `microsoft.mail.sync_done` and `microsoft.calendar.sync_done`: one line per successful sync of a stream (the counts of pages, written and removed
  messages or events). Their absence after the expected quarter-hour means the stream did not run or failed.
- `conn.sync.*` (`conn.sync.skipped` with its `reason`, `conn.sync.full_reload`, `conn.sync.cursor_conflict`, `conn.sync.log_failed`): the generic sync runner.
  `skipped` with `provider_disabled` or `connection_not_usable` explains a connection that is not syncing on purpose.

## Allow drafts and sending in a lane (T-262, T-263; live check H-072)

A mail-only company starts read-only. To let a mailbox owner **save a draft** or **approve and send** from the portal (Reply on Home, the Approvals page), do these steps **in this
order**. Nothing is done by the app on its own: it is your decision, per company.

**First read what the lane SQL turns on** (it is more than "allow sending"; the header of `enable-lane-mail-write-H-072.sql` says the same). It sets `store_outbound_drafts = true`, which means:
- the text of an email proposal is stored until the action ends and then deleted (D-19); an unanswered proposal expires after 72 hours and is deleted then; history keeps recipients and subject only;
- the AI's reply drafts are written, in full, into the stored briefing and stay as long as that briefing: 30 days for a 90-day company (briefing retention = the smaller of the company's retention and 30 days);
- **the briefing job then creates pending "send" proposals by itself** for every reply draft the model marks ready (a Microsoft row only when its connection holds the write permission). Nothing is sent without the owner's approval and authenticator code, but the Approvals page starts filling up without anyone clicking Reply. This is more than "allow drafts and sending"; if you do not want it, do not run the lane SQL for that company;
- the reply drawer keeps unsent text in this browser tab's session storage (typed draft 24 hours, AI draft 30 minutes, quoted original 24 hours; cleared at sign-out).

1. **Database part 30 (production).** Run `part-30-T-263.sql`, then `check-part-30.sql` (every row true). It replaces one function body. Without it approving an email on a Microsoft
   connection is refused (`connection_not_enabled`). Do this first so nothing later can half-work.
2. **Entra app registration (once per tenant; admin consent).** Entra admin centre -> App registrations -> the Nichols app -> API permissions: add the *delegated* Microsoft Graph
   permissions `Mail.ReadWrite` and `Mail.Send`, then **Grant admin consent for the tenant**. Afterwards the permissions page must list, all as *Delegated* with status *Granted for <tenant>*:
   `openid`, `offline_access`, `User.Read`, `Mail.Read`, `Calendars.Read`, `Mail.ReadWrite`, `Mail.Send` (a red or amber "not granted" status on any row means consent did not take).
   `Mail.ReadWrite` allows creating and editing drafts and "does not include permission to send mail"; `Mail.Send` is used only for the send call.
   *Consequence (decided Nov 22, 2026, spec section 7):* Microsoft's token answer names every permission consented for the app in that tenant, and the connect refuses an account whose
   granted set differs from the requested one. So **within one tenant one app registration serves either read-only companies or writing companies, not both**: once these two are consented,
   a company whose policy allows no writes is refused at its next connect. Do this step only for a tenant where every company that uses the app is meant to write; otherwise a second app
   registration is needed (not built yet).
3. **The company's rules (SQL).** Fill in and run `enable-lane-mail-write-H-072.sql` (gitignored, in `supabase/core/bootstrap/manual-migrations/`): the lane code, the mail domain and the
   tenant id exactly as in the T-265 run, and `true` or `false` for approvals go-live. **The live test in step 5 needs `approvals_live` = `true`.** Then run
   `check-enable-lane-mail-write-H-072.sql` with the same pasted values: every row must be true (a value pasted differently makes rows false: it fails safe). It changes: the policy allows
   `email_send` and `email_draft` and may store outbound drafts (only from the exact mail-only state the T-265 file wrote; anything else is refused), and one new config version adds `approvals` to
   `enabled_modules` (a limited company hides Approvals otherwise) and sets `approvals.approvals_live`. It refuses a config with any other approvals setting. It changes no connection, token, member or mail row.
4. **Each person Reconnects Microsoft** (Settings -> Your Microsoft accounts -> Reconnect; the write permissions are asked for only on a connect after step 3). What they see: Microsoft's
   sign-in asks them to approve mail read-and-write and send; back on Settings the account is active; on Home a Microsoft mail row now shows **Reply** instead of "Reply is not available for this
   mailbox yet". What a refused Reconnect looks like: the page says nothing was connected and "remove its access in your provider account"; in Vercel logs look for the event
   `connector.oauth_callback_failed` (provider `microsoft`; its `reason` and the scrubbed error message say which scope check refused, for example "granted a scope that was not requested" or
   "did not grant every required scope") and the audit row `connection.connect.grant_not_stored`. The most common cause is step 2 not being consented, or this tenant also serving a read-only company (see step 2).
5. **The live test (H-072).** From a Microsoft mailbox, to a recipient you control, with `approvals_live` true: approve one "Save as Outlook draft" and one "Approve & send".
   **First thing to look at: after "Approve & send", does the card end Verified?** (Verified means the sent copy was found by the marker, or by the id check, in Sent Items.) If it says "Sent. Waiting for the copy
   to show in Sent Items", wait a few minutes: the sweep verifies it; if the history later says it was sent but could not be read back, the mail went out and the read-back could not confirm it. Then
   confirm one draft and one sent copy each in Outlook, in the right conversation for a reply. Record in `docs/plan-review.md`: V-19, V-20, and the open points listed in the PR note
   (marker survives the send; Bcc on the sent copy; the text body reads back as plain text; recipient addresses are not rewritten; the PATCH body replaces the quoted original (replies carry no quoted
   thread: is that wanted); the marker filter works on the Drafts and Sent Items folder paths).

**Undo (tested, one transaction):** run `undo-enable-lane-mail-write-H-072.sql` (gitignored, next to the others; replace `PASTE-LANE-CODE`). It sets `write_actions_allowed` back to empty and
`store_outbound_drafts` to false (only when the policy is exactly the enable file's target state) and adds one new config version without the `approvals` block and without `approvals` in
`enabled_modules`. It is safe to run twice. Pending proposals then fail at approve ("type not allowed"); stored AI reply drafts stay until the briefing retention purge (30 days);
connections and mail rows are untouched. Removing the two permissions in Entra stops sending at Microsoft's side too.

## Turn on Microsoft change notifications (T-068, T-264; live check H-073)

Without this, Microsoft mail and calendar arrive by the 15-minute poll. With it, Microsoft tells the portal when something changes and a new message shows within about a minute; the poll keeps running as the fallback. **Production only**: Microsoft must reach a public https address. Do it after Microsoft mail works (H-070) and Inngest is synced. Local and preview deployments leave the variable unset and keep polling.

1. **SQL, once.** Supabase SQL Editor (production): run `supabase/core/bootstrap/manual-migrations/part-31-T-068.sql` (on your machine, not in git), then `check-part-31.sql`. *Expect:* every row `true`. It only adds a table and seven functions; nothing visible changes yet.
2. **Variable.** Vercel -> Settings -> Environment Variables -> add `GRAPH_NOTIFICATION_URL` -> **Production** only -> value `https://<your portal's own address>/api/webhooks/microsoft` (the same address as `GRAPH_REDIRECT_URI` and `NEXT_PUBLIC_APP_URL`, path exactly `/api/webhooks/microsoft`; no query, no `www` mismatch) -> Save -> Deployments -> top Production row -> **Redeploy**. Wait for **Ready**. A wrong value (http, another host, another path) only means no subscription is created: the renewal scan logs `microsoft.subscription.config_unreadable` naming `GRAPH_NOTIFICATION_URL` and the rule it breaks (never the value), and Microsoft connect, sync and health are not affected. Fix the value and redeploy.
3. **Sync the background jobs.** Inngest -> Apps -> **Sync new deployment**. A new function appears: `microsoft-webhook-sync`.
4. **Create the subscriptions now** (otherwise they appear within 12 hours). Inngest -> Functions -> `conn-subscriptions-renew-scan` -> **Invoke**. Wait a minute.
5. **What Settings shows.** Settings -> Connections -> Your Microsoft accounts: under *Last sync*, **Live updates until <date, time> ET** (about 6 days ahead). Owners and administrators see it; other members do not. A connection that was just connected shows it after the next scan.
6. **What to look for in the logs** (Vercel -> Logs, filter `webhook` or `microsoft.subscription`): `microsoft.subscription.ensured` (counts of created and renewed), `webhook.enqueued` (outcome `enqueued`) for each accepted notification, `webhook.skipped` with `outcome` `duplicate` (a replay, normal), `bad_client_state` (someone sent a notification that is not Microsoft's, or a subscription was recreated meanwhile: one or two are fine, a stream of them is worth telling the agent) and `unknown_account`-style drops. Ids and counts only: no address, subject or secret is ever logged. A failed create or renewal shows as `microsoft.subscription.failed` with a kind and, once permanent, an attention alert (`subscription_renewal_failed`); the connection keeps polling.
7. **Live check (H-073).** Send yourself a mail from another account: it should be on Home within a minute. Record in the backlog what Microsoft did.

**Turn it off.** Vercel -> Environment Variables -> **delete** `GRAPH_NOTIFICATION_URL` (Production) -> Redeploy. The next renewal scan (within 12 hours, or invoke it as in step 4) stops the subscriptions it created and marks them removed; polling carries on unchanged. Nothing is deleted from mail or calendar data. To stop sooner, or if Microsoft is switched off for the company, no action is needed: a paused provider's subscriptions are marked removed by the same scan, and the portal drops anything Microsoft still sends for them. Disconnecting an account marks its subscriptions removed at once in the portal's records (no request reaches Microsoft: its token is gone). Microsoft keeps posting to the portal for up to 6 days; the portal answers 202 and drops it. If the marking failed, the daily retention purge removes the leftover row.

**If it does not work.** Settings shows no *Live updates* line after step 4: check the variable's exact value (step 2) and that the function ran (Inngest -> Runs). A message takes the full 15 minutes to arrive: notifications are not reaching the portal (Microsoft refused the address during creation, so no subscription exists) or the sync job is not synced (step 3); polling is unaffected, and nothing needs rolling back.

## Add the owner later

When the first run named no owner: the owner signs in to the portal once (email code, then authenticator). Then put the owner's sign-in
address and name into `enable-lane-mail-T-265.sql` and the address into both places of the check file, keep every other value exactly as in
the first run, and run both again (sections 2 and 3). *Expect:* `OWNER resolved: ...`, `Lane config version 1 is already exactly this:
nothing written.`, `Owner membership written.`, then the check with every row true and two member rows. Nothing else changes: no new
settings version, no policy change, no redeploy.

## Add a second provider, or use another provider, later

The settings version of a company lists its providers in `mail.providers`: `["microsoft"]`, `["google"]` or `["google","microsoft"]` (one
person may connect both; D-57). The three settings texts below are tested against the app's schema (`mail-only-lane.test.ts`); the SQL pair
of this task writes only the first. A company that already uses Google gets Microsoft added by the T-266 pair, which keeps every other key.
Do not edit the SQL files by hand for the other variants; ask the agent for a pair.

<!-- lane-config-template -->
```json
{
  "enabled_modules": ["comms", "calendar", "briefing"],
  "limit_to_enabled_modules": true,
  "mail": { "providers": ["microsoft"], "allowed_domains": ["__MAIL_DOMAIN__"] },
  "microsoft": { "cloud": "commercial", "tenant_ids": ["__TENANT_ID__"] }
}
```
Google only (no `microsoft` block; the Google settings and sign-in keys are separate, T-063):
<!-- lane-config-variant-google -->
```json
{
  "enabled_modules": ["comms", "calendar", "briefing"],
  "limit_to_enabled_modules": true,
  "mail": { "providers": ["google"], "allowed_domains": ["__MAIL_DOMAIN__"] }
}
```
Both providers:
<!-- lane-config-variant-both -->
```json
{
  "enabled_modules": ["comms", "calendar", "briefing"],
  "limit_to_enabled_modules": true,
  "mail": { "providers": ["google", "microsoft"], "allowed_domains": ["__MAIL_DOMAIN__"] },
  "microsoft": { "cloud": "commercial", "tenant_ids": ["__TENANT_ID__"] }
}
```
`limit_to_enabled_modules: true` is what hides the other modules; without it a company shows everything, as `PKG` does. Adding a module
later (for example `approvals`) is a new settings version with the longer list. Turning on write actions for such a company later (the lane policy's `write_actions_allowed`, by a human) also needs `approvals` in `enabled_modules`, or its approvals page and API stay hidden.

## Turn a provider off later

A provider is turned off by a new settings version **without** it in `mail.providers`. Its connections are then **paused**: not synced, not
read, not offered Connect or Reconnect, listed on Settings as "Paused: Microsoft is not enabled for this company". Nothing is deleted: the
rows, the stored token and the indexed metadata stay (metadata leaves with the normal retention purge), and adding the provider back resumes
from the stored position (spec section 4).

A company's list cannot be empty. So this only works when another provider stays. For a company with Microsoft **only**, turn the company off
(next section) instead. For a company with both:

```sql
-- Supabase SQL Editor (production). Edit ONLY the two values in the first line (keep the quotes); write nothing else.
begin;
with p as (select 'PASTE-LANE-CODE'::text as lane, 'microsoft'::text as provider),   -- provider: 'microsoft' or 'google'
     cur as (select c.lane_id, c.version, c.config from core.lane_config_current c, p where c.lane_id = p.lane),
     keep as (select coalesce(jsonb_agg(e), '[]'::jsonb) as list
                from cur, p, jsonb_array_elements_text(cur.config -> 'mail' -> 'providers') e where e <> p.provider)
insert into core.lane_config (lane_id, version, config, created_by)
select cur.lane_id, cur.version + 1, jsonb_set(cur.config, '{mail,providers}', keep.list), null
from cur, keep, p
where jsonb_array_length(keep.list) >= 1 and (cur.config -> 'mail' -> 'providers') ? p.provider;
select c.version, c.config -> 'mail' -> 'providers' as providers from core.lane_config_current c, p where c.lane_id = p.lane;
commit;
```
(Set `provider` to `'google'` in that one place to turn Google off.) *Expect:* one row, the providers without the one you removed. If the version
did not change, the provider was not in the list, or it was the only one.

## Enable Teams for a company (T-278 to T-280; decision D-66; live checks H-078, H-079, H-081, H-080)

Gives the people of one company a **Sign in to Teams** button (Settings -> Connections -> **Your Teams account**, and the Messages page). Teams is a **separate connection** from
mail: a company whose mail is Google (worked example: **`PKG`**, whose people use their `pubkgroup.com` and `pub-k.org` Microsoft accounts for Teams) needs **no** Microsoft mail
setting, and a company with Microsoft mail (**`NC`**, H-080) signs in once more, with the same Microsoft account, to get a second, Teams-only connection. Nothing about Google or Microsoft
mail changes. Nothing is stored from a chat: this step only switches the sign-in on. Chats themselves arrive with T-281 to T-285.

**An extra permission on the Teams app breaks its connections (intended).** If a tenant administrator consents ANY Graph permission on the Teams app that is not on the app's own list (for example a `Mail.*` scope), every Teams connection in that tenant goes to "needs reconnect" at its next token refresh (the refresh is refused and nothing is stored), and Sign in / Reconnect are refused until the extra permission is removed in Entra (Enterprise applications -> the app -> Permissions). This is the T-278 review S9 rule: a Teams token must never carry mail access.

The generic steps, in this order (you run every production step yourself; the agent never touches production):

1. **The code is deployed** with T-278, T-279 and T-280 (Vercel -> Deployments -> the top Production row is a commit on `main` after their merge).
2. **H-078 is done:** the second Entra app "Nichols Executive Portal - Teams" exists (multi-tenant; redirect URIs `http://localhost:3000/api/connect/teams/callback` and
   `https://<the production app domain>/api/connect/teams/callback`; delegated permissions `openid`, `offline_access`, `User.Read`, `Chat.Read`, `User.ReadBasic.All` and nothing else), and
   Vercel **Production only** has `GRAPH_TEAMS_CLIENT_ID`, `GRAPH_TEAMS_CLIENT_SECRET` and `GRAPH_TEAMS_REDIRECT_URI` (exactly the production `NEXT_PUBLIC_APP_URL` plus `/api/connect/teams/callback`;
   a wrong value shows "This connection isn't configured on this server" on Settings, not a broken page). Never Preview.
3. **H-079 is done:** the tenant admin granted consent for the Teams app (Entra admin centre -> Enterprise applications -> the app -> Permissions -> Grant admin consent). Users of another
   tenant cannot consent to an unverified multi-tenant app beyond sign-in scopes, so this is needed.
4. **Run the database part** once: `supabase/core/bootstrap/manual-migrations/part-33-T-278.sql` in the Supabase SQL Editor of the production project, then `part-33-T-278-check.sql`.
   *Expect:* every row `true` (the md5 rows may differ only by whitespace). The part refuses to run if the objects it changes are not the ones it expects, or if it was already applied. It adds
   no row and switches nothing on.
5. **Fill in `enable-lane-teams-T-280.sql`** (same folder; gitignored): the lane code, the tenant id of the Teams accounts (Entra admin centre -> Overview -> Tenant ID; for `PKG` it is the id in
   decision D-62), the sign-in domains of the Teams accounts (for `PKG`: `pubkgroup.com` and `pub-k.org`), the features (first phase: `chat_read`, `call_links`) and `v_add_messages`: **`true` for every company that limits its modules** (like `NC`: its settings have `limit_to_enabled_modules: true`), otherwise the Messages page stays hidden and the Settings notice cannot point to it (the SQL **refuses and writes nothing** when it is missing: set it and run the file again); `false` for a company that shows every module (like `PKG`). Keep the quotes. The same values go into `check-enable-lane-teams-T-280.sql`.
6. **Before you run it**, run the check file once and write down the last result (the count of usable mail connections), ignoring the false rows.
7. **Run `enable-lane-teams-T-280.sql`.** It adds ONE new settings version: the current settings with one extra key, `teams` (the template below). Every other key is carried over unchanged. It
   refuses a company that has no settings, is not enabled, or **already has a `teams` key** (it never edits one), and a placeholder left in the file. *Expect:* a notice naming the new version.
8. **Run `check-enable-lane-teams-T-280.sql`.** *Expect:* every row `true`, and the count of usable mail connections **equal to the number you wrote down**. If a row is false, stop and tell the agent.
9. **Each person signs in to Teams** (Settings -> Connections -> Your Teams account -> Sign in to Teams) with their own Microsoft work account. *Expect:* "Teams connected" on Settings and "Connected as <their address>"
   on Messages. A person's Google rows (or Microsoft mail rows) must look exactly as before.

What the lane's `teams` block looks like (the file inserts it; the app refuses a block it cannot read and treats it as Teams off):

<!-- teams-config-template -->
```json
{
  "teams": {
    "enabled": true,
    "cloud": "commercial",
    "tenant_ids": ["__TEAMS_TENANT_ID__"],
    "allowed_domains": ["__TEAMS_DOMAIN__"],
    "features": ["chat_read", "call_links"]
  }
}
```

**Switch Teams off again** (a new settings version, never an edit): the same file's pattern with `"enabled": false`, or without the block. People then see "Teams is paused for this company";
their connections and Vault tokens are kept until they press Disconnect. **Roll back:** a new version without the `teams` block. Neither touches mail.

**What the agent checked:** the schema and the template parse with the app's own settings schema (tests in `packages/core/src/lane-config`); the SQL refuses what is listed above (run against a copy of the
production shape in a transaction that was rolled back); Teams reads only the `teams` settings, never the mail provider list.

## Roll back this run

Pick the smallest step that fixes the problem. Nothing below deletes mail metadata, a token or an audit row.

1. **Only pause Microsoft for the company** (it also has Google): the SQL above.
2. **Take the company out of service** (the usual rollback of this run). In this order; the order matters:
   1. Each person who connected a mailbox: **Settings -> Connections -> Disconnect** (this deletes the stored token while the company is still
      enabled). Skip if nobody connected yet.
   2. Vercel -> Settings -> Environment Variables -> `ENABLED_LANES` -> Edit -> **Production** only -> back to the value you noted in step 7
      ("before"), for example `PKG` -> Save -> Deployments -> top Production row -> **Redeploy**. Wait for **Ready**. Inngest -> Apps ->
      **Sync new deployment**.
   3. Only then, SQL Editor (production):
      ```sql
      -- Replace PASTE-LANE-CODE (keep the quotes). The company disappears from every switcher; members, settings and rows stay.
      update core.lanes set enabled = false where code = 'PASTE-LANE-CODE';
      select code, enabled from core.lanes where code = 'PASTE-LANE-CODE';
      ```
      *Expect:* `enabled` = `false`. To bring it back: `enabled = true`, then step 4 of this runbook again.
   Never disable the company in the database while it is still in `ENABLED_LANES`: the webhook lookup then fails for all companies and the
   company's scheduled runs are marked failed (three in a row can raise the banner).
3. **Undo only the app change** (the company works in the database but should not show): do 2.2 only.

If `PKG` misbehaves at any point of this run, do 2.2 first (that returns the app to the "before" state) and tell the agent.

## What the agent checked (for the record)

Every scheduled job and fan-out, every Home and briefing reader, the company switcher and the landing page were walked for a company that has
only mail and calendar; the findings and their tests are in `.agent/pr/T-265.md`. The synthetic tests are `mail-only-lane.test.ts` (core,
connectors), `home-page-mail-only.test.tsx`, `settings-page.test.tsx`, `lane-modules.test.ts`, `landing-order.test.ts`,
`mail-only-lane-jobs.test.ts` and the pgTAP file `323_mail_only_lane.test.sql`.
