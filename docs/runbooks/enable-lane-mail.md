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
