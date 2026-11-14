# T-247 plan: per-user mail privacy and several Google accounts per user

**Status: APPROVED by Saurabh on Nov 14, 2026, with the decisions below.** Written the same day from a read-only survey of the code and the local database.

## Decisions (Nov 14, 2026, Saurabh)
1. **Every member sees only their own mail,** admin_technical included. Nobody has access to anyone else's mail.
2. **Allowed domains now:** pubkgroup.com is part of the pub-k.org Google Workspace, so PKG allows pub-k.org and pubkgroup.com (native Google). Non-Workspace accounts (gmail.com) come later through Composio, after H-041. Plan for them, don't build them yet: Composio per-user and multi-account is NOT in this task.
3. **D-33 amended:** Robert (owner) may connect his own personal gmail.com account, visible only to him and connected by himself only. Saurabh's personal and SimpliAutomated mail stays excluded. This is not technically possible until the Composio route exists.
4. **Saurabh's existing pub-k.org mailbox and its data become his only.**
5. **Include the read-only sign-in email check for both users** (Robert, rnichols@pub-k.org; Saurabh, saurabh@pub-k.org).

## What you asked for
- **Users:** Saurabh (saurabh@pub-k.org) and Robert (rnichols@pub-k.org).
- **Several Google accounts per user,** each connected by the user themselves.
- **Allowed account domains for PKG:** pub-k.org and pubkgroup.com, plus gmail.com only when the user connects that account themselves.
- **Private to each user:** mail, calendar, briefing, drafts and email approvals.
- **Shared in the lane:** QuickBooks, Finance, news and Projects.

## How it works today (the gaps)
1. **A Google connection belongs to the lane, not a person.**
   - `core.connections.created_by` records who clicked Connect, but no access rule uses it.
   - Only owner and admin_technical may connect.
2. **Mail and calendar are visible to anyone with the lane's view.**
   - `comms.message_index` and `cal.event_index` are readable by the lane's `comms` / `calendar` view. Today only the `owner` role has it.
   - So two owners would see each other's mail.
   - `apps/web/lib/briefing-schedule.ts:3-5` already warns about this.
3. **Briefings are stored per owner, but built from the whole lane's mail and calendar.**
4. **Any lane owner can approve any email draft,** whoever's mailbox it comes from. Drafts are readable by every owner (`act.proposed_actions_select`).
5. **The allow-list is a list of exact addresses** (`lane_config.mailboxes`). There is no domain rule, and `approvals.allowed_mailboxes` is unused.
6. **Google sign-in setup only reaches pub-k.org.** The native Google OAuth client is "Internal" to the pub-k.org Workspace (H-008).
   - It cannot connect a gmail.com account.
   - It cannot connect pubkgroup.com unless that is the same Workspace (an alias or a secondary domain).
   - Composio can connect any account, but allows only one account per lane per toolkit. A second one replaces the first.
7. **Role decisions block Saurabh's own mail.** D-4 and D-36 make Saurabh `admin_technical` in production, and that role has no mail view. So today he could not see even his own mail.
8. **Nothing stores a user's email in our tables.** Identity is the auth user id (UUID). Memberships, MFA factors, briefings, brain documents, connections, Composio accounts and audit rows all hang off that id.

## The design
**1. Every mailbox has an owner.**
- New column `core.connections.owner_user_id`. It is required for Google and Composio mail/calendar rows and null for QuickBooks.
- Backfill it from `created_by`; today that is Saurabh's pub-k.org connection.
- It is set at connect time to the signed-in user, and it can never change (an immutability trigger, like the lane and account fields).
- **Connecting is a user action for their own accounts:** any lane member with the new `own_mail` view may connect a Google account for themselves. Nobody connects a mailbox for someone else, so the gmail.com rule ("only when the user connects it themselves") holds by construction.
- QuickBooks connect stays owner/admin_technical.

**2. Mail and calendar data are readable only by the mailbox owner.**
- RLS on `comms.message_index` and `cal.event_index`: AAL2, plus the lane check, plus `connection_id` belongs to a connection whose `owner_user_id = auth.uid()`.
- The same rule goes into every reader:
  - Home attention, Inbox, the reply drawer, `briefing_threads`, `briefing_events`, `home_meetings`;
  - `briefing_coverage`, which is a definer function, so the filter has to be explicit;
  - the assistant's mail and calendar tools.
- **The lane owner role no longer implies seeing other people's mail.** Robert sees only Robert's mailboxes, and Saurabh only Saurabh's.
- Admins still see connection *health* (status, last sync, errors), never content.

**3. Briefings are built per person from that person's mailboxes and calendars only.**
- The scheduled job runs per user who has a mailbox, not per lane owner.
- The job client (service role, so RLS doesn't apply) filters by `owner_user_id` explicitly. A test proves one user's briefing never contains the other's mail.

**4. Drafts and email approvals are private to the mailbox owner.**
- `act.proposed_actions` email rows: readable and approvable only by the owner of the sending connection.
- `act.approve` checks `connection.owner_user_id = auth.uid()` for email types. Non-email types, such as `qbo.disconnect`, keep today's lane rules.
- The sender is still fixed to that connection's address. Drafts stored only while pending (D-19) is unchanged.

**5. Allowed accounts by domain, per lane.**
- New lane config: `mail.allowed_domains = ["pub-k.org", "pubkgroup.com"]` and `mail.self_connect_domains = ["gmail.com"]`.
- Under design 1, only self-connect exists, so gmail.com differs only in being listed separately. It stays easy to remove.
- The domain check runs at connect time and on every Google call (`google/guard.ts`), replacing the exact `mailboxes` list. The old list can stay as an optional extra allow-list.
- D-23 is unchanged: one Google account can be in one lane only.
- D-33 holds: Robert's personal and SimpliAutomated mail must never enter Nichols production. The domain list enforces that, because his gmail.com account could only be added if gmail.com is listed for that lane. That needs a decision; see question 3.

**6. Several accounts per user.**
- **Native Google:** already allows several mailboxes per lane. The change is per-user ownership and the UI ("Your connected accounts" per user).
- **Composio:** replace the one-account-per-lane-per-toolkit rule with one per user per address. Remove the replace-the-previous-account step. `find(lane, toolkit)` becomes per user.
- **Which path connects what** depends on question 2.

**7. Settings and per-user preferences.**
- Priority senders and the briefing settings are lane-wide today. Keep them lane-wide in this task and list per-user preferences as a follow-up, unless you want them now.

**8. Shared modules are unchanged:** QuickBooks, Finance, news and Projects stay lane-scoped.

## Safe sign-in email change for Robert (only if his current user is a pubkgroup.com address)
Change the address in place, so the user id (UUID) stays the same. A new user would orphan his memberships, MFA factor, briefings, brain documents and connections.

1. **Read-only check** in the SQL Editor:
   `select id, email, email_confirmed_at, last_sign_in_at from auth.users where lower(email) in ('rnichols@pubkgroup.com', 'rnichols@pub-k.org');`
   - Proceed only if exactly one row exists, for the pubkgroup.com address.
   - If a rnichols@pub-k.org user already exists, stop and tell Saurabh. Two users would need a merge decision.
2. **Make the change:**
   - Use Supabase dashboard > Authentication > Users > Robert's user > change email to `rnichols@pub-k.org`, or the admin API `updateUserById(id, { email, email_confirm: true })`.
   - Both keep the UUID and update the email identity together with the user.
   - Do not edit `auth.users` with SQL: the identity row in `auth.identities` would then disagree.
3. **End his sessions** (dashboard: sign out user), so the next sign-in uses the new address. His TOTP factor stays, because it is keyed by the UUID.
4. **Test with Robert present:** a sign-in code goes to rnichols@pub-k.org, he enters it, then his authenticator code.
5. **Afterwards:** if `lane_config` lists his old address anywhere (`mailboxes`, approvals), write a new version.

Run the same check for Saurabh's user: the production bootstrap placeholder was `REPLACE_WITH_OWNER_EMAIL@pubkgroup.com`. A helper with the read-only check and step-by-step notes ships with the task as a gitignored manual file. There is no code change, and no secrets.

## Build plan (one task, several commits; pgTAP and tests in each)
1. **Ownership.** `owner_user_id`: column, backfill, immutability, RLS on `core.connections` (a user sees their own mailbox rows; admins see health).
   - Every new or changed policy gets a pgTAP test: user A cannot read user B's mail, calendar, drafts or briefing, in the same lane, whatever their role.
2. **Mail and calendar RLS** and every reader function, plus the assistant tools.
3. **Briefing jobs per user;** the explicit filter in the job path; tests.
4. **Approvals:** email visibility and approval by mailbox owner only; tests, including "Robert as lane owner cannot approve Saurabh's draft".
5. **Connect flow:**
   - per-user connect for any member with `own_mail`;
   - domain allow-list in lane_config, checked at connect and on every call;
   - Composio per-user, several accounts;
   - Settings UI "Your Google accounts".
6. **Roles:** the new view `own_mail` for owner, admin_technical and viewer. It grants only your own mailboxes. Production memberships change in a manual part.
7. **Production:** a manual part with its check (migration, backfill, lane_config domains), and the email-change helper.
- **Reviews:** full security and code review (RLS, auth, connectors, approvals). Every BLOCKER and HIGH is fixed before done.

**Out of scope:** GCC and Microsoft 365; per-user priority senders and briefing settings (follow-up); sharing a mailbox with another user (delegation).

## Decisions needed before building
1. **Saurabh's role.** D-4 and D-36 make him `admin_technical` with no content access. The plan gives every member their own mail through `own_mail`, without access to anyone else's. OK, or do you want a different role for yourself?
2. **How non-pub-k.org accounts connect.** The native Google client is Internal to pub-k.org, so it can't reach gmail.com, and maybe not pubkgroup.com. Options:
   - (a) Native for pub-k.org and Composio for everything else, with Composio changed to allow several accounts per user. This needs H-041 (the Composio live check).
   - (b) Make the native client External. That needs Google's verification for Gmail's restricted scopes, including a security assessment that takes weeks.
   - (c) pub-k.org only for now: pubkgroup.com only if it is in the same Workspace, and gmail.com later.

   Recommendation: (a), with (c) as the first step if H-041 isn't done yet. Is pubkgroup.com in the pub-k.org Google Workspace?
3. **gmail.com in the PKG lane.** D-33 says Robert's personal mail must never enter Nichols production. Is PKG's production a "Nichols production" in that sense? I.e. may Robert connect his own gmail.com account to PKG? The plan allows gmail.com in PKG as you asked; confirm that this doesn't conflict with D-33.
4. **Existing data.** Saurabh's current pub-k.org mailbox and its indexed mail become Saurabh's private data (backfill from `created_by`). Robert sees none of it. OK?
