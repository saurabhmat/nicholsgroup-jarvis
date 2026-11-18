# Spec — Microsoft 365 mail and calendar connector (M2, M5, M6)

Status: proposed (planner output, Nov 18, 2026). Re-plans T-066 – T-068 and adds T-250 – T-268 in `docs/backlog.md`.
Brief: decisions D-48 – D-53 and human items H-062 – H-065 (Nov 18, 2026). Read `CLAUDE.md` (rules 1 – 13), `docs/specs/approvals.md` and the T-063/T-064/T-219/T-247 notes in `docs/plan-review.md` first.

Facts about Microsoft Graph and Entra in this spec are from memory. Every one marked **(verify)** is also in section 15 and must be checked against Microsoft's current documentation before the task that relies on it is built. Nothing marked (verify) may be treated as certain.

## 1. Purpose

A native Microsoft Graph connector for mail and calendar, behind the existing T-062 interfaces (`MailProvider`, `CalendarProvider` in `packages/connectors/src/comms/provider.ts`), so a lane whose mailboxes live in Microsoft 365 gets the same product as a Google lane: Settings → "Connect Microsoft", sign in, approve once; mail and calendar metadata in the index; bodies read live; Home, Inbox and the briefing work unchanged; reply drafts and sends go through the Approval Center.

Google and Microsoft run side by side, chosen **per lane** in `lane_config` (D-48). PKG stays on native Google until its mailboxes move (D-48); the first live Microsoft test is Nichols Capital (`NC`, D-50).

## 2. Scope and out of scope

**In scope (this spec):**
- Per-lane provider choice in `lane_config`, read on every sync and call, fail closed.
- One multi-tenant Entra app; tenant and cloud recorded per lane and per connection, never in code.
- Connect, reconnect and disconnect of a person's own Microsoft mailbox (D-43 ownership, T-247 rules).
- Mail metadata sync (per-folder delta), live body read, live search.
- Calendar metadata sync (calendarView delta), live event description.
- Write path for `email.save_draft` and `email.send` through `packages/modules/approvals` only (rule 5, D-34).
- Change notifications (subscriptions) as a later task, with polling as the default and fallback.
- Enabling the `NC` lane for mail and calendar only (D-50), and a PKG Google → Microsoft cut-over runbook.
- GCC High as a second cloud, built only if H-064/H-065 say it is needed.

**Out of scope (later work only, not planned here):**
- Microsoft Teams chats and channels (D-52, open).
- The Claude/ChatGPT chat section (D-53, open).
- OneDrive/SharePoint search: T-187 stays as written.
- Calendar writes on Graph (T-117 parity; Release B, after this spec).
- Nichols Law: no nichols.law mailbox is connected, live or in tests, until D-51 is decided (and D-49, H-064). This spec does not change `CLAUDE.md` rule 13 or `docs/pilot-scope.md`.
- Composio for Microsoft: not used (D-48). Composio stays Google-only (D-47).
- One mailbox with several company addresses (H-065 option 3): not supported unless decided (section 11).

## 3. Rules applied

- Rule 1: every function, job, cursor and cache entry takes `laneId`; clients only from the lane router.
- Rule 2: tenant ids, cloud, domains, folders and calendars live in `lane_config`; nothing company-specific in code.
- Rule 3: every SQL change ships with RLS and pgTAP, including a cross-lane denial test, in the same task.
- Rule 4: Graph is called only from `packages/connectors/src/microsoft/*`; tokens only from the Vault; never logged, never in prompts.
- Rule 5: nothing writes to Microsoft except the approvals executor. `watch`/`renew`/`stop` are accepted infrastructure under the conditions of the T-062 review (plan-review, Nov 5: callback from server config only, jobs only, channels recorded server-side).
- Rule 6, D-19: bodies, event descriptions and header values are never stored. Only booleans derived from headers are stored (as T-234 does for Gmail).
- Rule 9: subjects, names, locations, titles and bodies are untrusted. They never change permissions or trigger actions.
- Rule 10: MSW fakes and synthetic data only in code and tests. Every live check is a human item.
- D-23: one mailbox, one lane. D-43: a mailbox belongs to the person who connected it; admins see health, never content.

## 4. Provider per lane (lane_config)

`laneConfigSchema` is strict, so new keys need a schema change and tests (T-250). Plan-review item 12 suggested `mail: { provider, via }`; `via` already exists as `mail_transport` (T-219), so it is not repeated.

```ts
mail: {
  provider: "google" | "microsoft",        // NEW, default "google": no change for existing lanes
  allowed_domains: string[],               // existing (T-247), fail closed when empty
  self_connect_domains: string[],          // existing, unused
},
mail_transport: "native" | "composio",     // existing; "composio" is refused when mail.provider = "microsoft" (refine)
microsoft: {                               // NEW, optional; required when mail.provider = "microsoft" (refine)
  cloud: "commercial" | "gcc_high",        // default "commercial" (covers plain GCC as far as we know: verify)
  tenant_ids: uuid[],                      // allowed Entra tenant ids, 1..10; empty is refused by the schema
  allow_gcc: boolean,                      // default false; see section 5.4 (D-49)
  mail_folders: ("inbox" | "sentitems" | "archive")[],  // default ["inbox", "sentitems"]
},
calendar: { calendar_ids?, include_read_only, forward_days }  // existing; applies to whichever provider the lane uses
```

Rules:
- Read on every sync, every provider call and every connect (like `mailboxes` today). A malformed or unreadable config fails closed.
- A lane uses **one** mail provider at a time (default for D-54). A connection whose provider is not the lane's `mail.provider` is not synced, not read and not offered Reconnect; Settings shows "This company now uses <provider>". Its rows stay until the retention purge (section 12).
- Google and Microsoft lanes run side by side: the provider is a per-lane value, every job reads it per lane.
- `calendar.calendar_ids` holds raw ids of the lane's current provider. A provider switch (the cut-over runbook, T-266) writes the new config version without them; ids of the other provider would simply never match a calendar.

## 5. Tenant, cloud and consent

### 5.1 One multi-tenant Entra app

One app registration (H-062), "Accounts in any organizational directory". Each company tenant grants it access once (by user consent or admin consent). The app never uses application permissions (no tenant-wide mailbox access); only delegated permissions, so the app sees only the mailbox of the person who signed in.

### 5.2 Environment

| Variable | Use |
|---|---|
| `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` | the commercial-cloud app (H-062). Required for a Microsoft connect. |
| `GRAPH_REDIRECT_URI` | optional locally (default `http://localhost:3000/api/connect/microsoft/callback`); required, https and on the app's own origin elsewhere (same rules as `GOOGLE_REDIRECT_URI`). |
| `GRAPH_USGOV_CLIENT_ID`, `GRAPH_USGOV_CLIENT_SECRET`, `GRAPH_USGOV_REDIRECT_URI` | a separate env group for an app registered inside the GCC High cloud. Only added by T-267, only if needed. |
| `GRAPH_TENANT_ID` | **removed.** A multi-tenant app has no single tenant. Tenant ids move to `lane_config.microsoft.tenant_ids` (allowed) and `core.connections.tenant_id` (actual). `.env.example` is human-owned: T-251 proposes the diff in its PR body. |

These are app-level settings (one app serves every company), so they are env, not `lane_config` (same reasoning as the Google client and the Composio auth config ids). All are read through `requireConnectorEnv` inside `packages/connectors`; the secrets are registered with the redactor and added to the client-bundle canary set.

### 5.3 Authority and endpoints

- Authorization and token endpoints come from `endpoints(laneId)` (the `OAuthProvider` hook already takes the lane), built from the lane's `microsoft.cloud`:
  - `commercial`: `https://login.microsoftonline.com/{authority}/oauth2/v2.0/{authorize|token}`, Graph `https://graph.microsoft.com/v1.0` **(verify)**.
  - `gcc_high`: `https://login.microsoftonline.us/...`, Graph `https://graph.microsoft.us/v1.0` **(verify; built only in T-267)**.
- `{authority}` is the lane's tenant id when `tenant_ids` has exactly one entry (the user signs in to that tenant only), otherwise `organizations` (work accounts only; personal Microsoft accounts are refused). Never `common`.
- Hosts are an allow-list per cloud in `microsoft/constants.ts` (provider facts, not company data). The HTTP client refuses any other host before a token is read, as `createGoogleHttp` does.

### 5.4 GCC and D-49

- `commercial` is believed to cover plain GCC (GCC tenants use the commercial sign-in and Graph endpoints) **(verify)**. GCC High needs the app registered inside that cloud and different endpoints **(verify)**.
- A GCC tenant may be detectable from its OpenID metadata (`tenant_region_sub_scope = "GCC"` in `/{tenant}/v2.0/.well-known/openid-configuration`) **(verify)**. If it is: the connect refuses a GCC tenant unless the lane's `microsoft.allow_gcc` is true. A human sets that flag only after D-49 is decided. If it is not detectable, `allow_gcc` stays as a documented manual gate and the runbook says so.
- Nothing here enables Nichols Law (D-51).

### 5.5 Consent and "admin approval needed"

- Many tenants do not let users consent to apps from unverified publishers **(verify)**. Then Microsoft shows its own "Need admin approval" page, and the user may never come back to our callback. Two mitigations:
  1. Settings shows, next to "Connect Microsoft", a short note: "If Microsoft says your organisation's admin must approve, send them this link", with a **tenant admin consent link** built from the client id, the lane's tenant id, the cloud and the registered redirect URI (no secret, no state stored). The admin approves at Microsoft. The portal stores nothing and calls nothing, so this is not an external write by the portal (security review to confirm).
  2. When the user does come back with an error, the callback maps the known consent errors (the `AADSTS` codes for "admin consent required" and "user consent blocked", **verify the exact codes**) to a new result `admin_consent_required`, shown as a fixed message with the same link. Other errors stay `denied`.
- Publisher verification of the app (H-067) would let users consent in tenants that allow verified publishers. Optional.
- The first live tenant is Nichols Capital (H-063 names the admin).

## 6. Data model changes

All in `supabase/core/supabase/migrations` with pgTAP in the same task; production SQL as a gitignored numbered `manual-migrations` part (next free number after part 25; check the folder) with a `check-part-N.sql`, guarded, one transaction, refusing a second run, as T-247 did.

### 6.1 `core.connections` (T-254)

| Column | Notes |
|---|---|
| `tenant_id uuid` | Entra tenant of the signed-in account (`tid`). Microsoft rows only (check). Set once by a service-role definer function at connect; immutable afterwards (extend `core.connections_identity_immutable`). |
| `cloud text` | `commercial` or `gcc_high`. Microsoft rows only, set once with `tenant_id`, immutable. |

- `external_account_id` = the mailbox's primary SMTP address from Graph `/me` (`mail`), lower-cased. The D-23 index `(provider, lower(external_account_id))` then means one Microsoft mailbox, one lane.
- `owner_user_id` already allows `microsoft` (T-247 check `connections_owner_only_mail`).
- RLS unchanged: health columns (incl. the two new ones, no content) for the `connections` view; owners read their own rows (`own_mail`). pgTAP: set-once, immutability, non-Microsoft rows refused, cross-lane denial, an `own_mail` member cannot read another user's tenant column through the own-rows policy.

### 6.2 OAuth state (T-254)

`core.oauth_state_create` / `core.oauth_state_consume` treat `microsoft` like `google` (any member with `own_mail` connects their own account). TypeScript `connectRolesFor("microsoft")` returns `MAIL_CONNECT_ROLES`. pgTAP: viewer may start a Microsoft state; finance_operator may not; a QuickBooks state still needs owner/admin_technical; cross-lane state refused.

### 6.3 Page writers (T-252, T-253)

The plan-review "T-219 build notes"/finding 1 list (file:line) shows the provider hard-coded to Google in SQL. Changes:

| Function | Today | After |
|---|---|---|
| `core.comms_mail_apply_page` (latest body: `20261113120000_message_flags_and_thread_ref.sql`) | `c.provider = 'google'`, inserts `'google'` | usable connection of provider `google` or `microsoft`; inserts the connection's own provider |
| same | no cursor prefix check (T-063 re-review LOW) | cursor must start with `g1.<connection id>.` (google) or `m1.<connection id>.m:` (microsoft); 22023 otherwise; max 16384 |
| same | removals are message ids | removals may also be `{message_id, folder}`; with a folder, only a stored row in that folder is flagged deleted (a message that moved between two synced folders in two pages is not lost) |
| same | absent flags written as `false` | on insert absent = false; on update absent = keep the stored value (Graph may not send every flag on every page) |
| `core.cal_events_apply_page` (latest body; find the newest migration that defines it) | `c.provider = 'google'`, prefix `g1.<id>.c:` | `google` or `microsoft`; prefix `g1.<id>.c:` or `m1.<id>.c:` by the row's provider; a Google row cannot store an `m1` cursor and vice versa |

The cursor table `core.sync_cursors` (streams `mail`, `calendar`) is reused unchanged.

T-253 also does the **reader inventory**: every function and view whose latest body names `'google'` (examples from the notes: `core.home_calendar_status`, Home feed counts, `core.briefing_coverage`, the sync-now and job-failure functions, the calendar target lists). Each is decided case by case and logged: "mail provider" meanings accept `microsoft`; `transport = 'native'` filters stay (Microsoft rows are always `native`). A pgTAP test lists those functions and asserts each accepts a Microsoft connection.

### 6.4 Push subscriptions (T-068)

`core.push_subscriptions` (`lane_id`, `connection_id`, `provider`, `resource` `mail|calendar`, `subscription_id`, `resource_path` (non-secret template), `expires_at timestamptz`, `status`, `created_at`, `updated_at`). The `clientState` is a Vault secret per subscription, never in this table. RLS: health view only (no content), service role writes through definer functions. pgTAP incl. cross-lane denial. Registered with retention (rows of removed subscriptions, 30 days). The provider check of `core.webhook_events` must include `microsoft` (check; extend if not).

No change to `comms.message_index` or `cal.event_index` columns: both already allow `microsoft` (T-061).

## 7. Connect flow (T-256, T-066, T-257)

Same experience as Google: Settings → "Your Microsoft accounts" → **Connect Microsoft** → Microsoft sign-in → approve once → back on Settings with the result. **Reconnect** appears when the grant dies. Portal sign-in is unchanged (D-6): this connect is a data connection, not a login, and the page says so.

Shown only when the lane's `mail.provider` is `microsoft`. Any member with `own_mail` connects **their own** account; the connection's owner is the signed-in user (D-43, T-247); nobody connects someone else's mailbox.

**Start** (generic T-035 flow): role and lane checked, state + PKCE bound to user and lane, audited. Authorization parameters: `response_type=code`, `response_mode=query`, `prompt=select_account` (verify), scopes from `scopesFor(laneId)`, `login_hint` with the stored address on a reconnect.

**Scopes (delegated):**

| When | Scopes |
|---|---|
| Always (read) | `openid`, `offline_access`, `User.Read`, `Mail.Read`, `Calendars.Read` |
| Only when the lane policy allows email writes (`write_actions_allowed` has `email_send` or `email_draft`; same switch as Google's `gmail.compose`, T-232) | add `Mail.ReadWrite`, `Mail.Send` |
| Shared mailboxes (only if decided, T-268) | add `Mail.Read.Shared` (and `Calendars.Read.Shared`) |
| Teams (D-52), OneDrive (T-187) | not requested by this spec |

Permission names and whether each needs admin consent: **verify**.

**Callback, in order (all before anything is stored):**
1. `precheck`: the lane's `mail.allowed_domains` is not empty and `microsoft` settings are valid (fail closed before the code exchange).
2. Code exchange at the lane's cloud token endpoint (PKCE, client secret in the body).
3. Granted scopes are exactly the requested set (the token response `scope`; OIDC extras tolerated). A missing scope, an unrequested write scope, or no refresh token refuses the account. The format of `scope` (short names vs full URIs) must be handled: **verify**.
4. Tenant: the `tid` claim of the id_token received directly from the token endpoint over TLS (OIDC code flow; signature check optional in that case: **verify** and let security review decide). `tid` must be in `microsoft.tenant_ids` → otherwise `wrong_tenant` (new result code, fixed message). A personal-account tenant is refused by the `organizations` authority and by this check.
5. GCC check (section 5.4).
6. Identity: Graph `GET /me?$select=id,mail,userPrincipalName` with the new access token. The mailbox is `mail` (primary SMTP), lower-cased. No `mail` (unlicensed or no mailbox) refuses. A guest account (`#EXT#` in the UPN) refuses.
7. Mail policy: `assertMailAccountAllowed` (allowed domain, and on the exact `mailboxes` list when the lane keeps one).
8. Reconnect: the address must equal the bound connection's (`wrong_account` otherwise); the tenant must equal its stored `tenant_id`.
9. D-23 and ownership: the existing `ensureConnection` + owner checks (a row owned by someone else is refused, `ACCOUNT_OWNED_BY_OTHER_MESSAGE`).
10. Store the token set in the Vault (`storeToken`), set `tenant_id` + `cloud` (set-once function), record features (`graph_mail_write: true|false`), audit.

A grant refused after step 2 is dropped from memory, never stored, and the user is told to remove the app's access in their Microsoft account (the existing `GRANT_NOT_STORED_MESSAGE` path).

**Tokens** (`microsoft/token-manager.ts`, mirrors Google's): refresh when under 5 minutes left and on a 401; single-flight per connection per process; Microsoft **rotates** refresh tokens on use **(verify)**, so the new set is stored with the existing compare-and-swap `rotateToken` and a loser re-reads the Vault. `invalid_grant` and the "consent revoked / password changed / conditional access" family (`interaction_required`, specific `AADSTS` codes: **verify**) → `reconnect_required`. Refresh POSTs are never retried. `token_expires_at` stays null (refresh-token lifetime is sliding and not returned: **verify**); expiry is found by the refresh failure.

**Guard** (`microsoft/guard.ts`, mirrors `google/guard.ts`) on every provider call, before any token read: lane brand, provider `microsoft`, authoritative row, usable status, lane `mail.provider = microsoft`, the row's `tenant_id` still in `tenant_ids`, the row's `cloud` equal to the lane's cloud (a changed cloud means Reconnect), mail policy on the address.

**Disconnect** (D-55 default). Microsoft has no per-app token revocation a user's delegated token can call (revoking all sign-in sessions is far too broad; removing the grant needs admin permissions) **(verify)**. So Disconnect is local: the mailbox owner, at AAL2, confirms; the Vault tokens are deleted, the row becomes `disconnected`, audited; the page tells the user to remove the app in their Microsoft account ("My Apps" / "Apps and services": exact place **verify**). This is not an external write, so it does not go through approvals; D-55 asks Saurabh to confirm (D-24 covered provider-side revocation only).

**Errors shown** (fixed texts, never provider text): `admin_consent_required`, `wrong_tenant`, `wrong_account`, `account_refused` (domain or list), `denied`, `exchange_failed`, `unavailable`.

## 8. Mail sync on Graph (T-258, T-259)

### 8.1 Folders and cursor

Graph message delta is per folder **(verify)**. The lane chooses well-known folders in `microsoft.mail_folders` (default `inbox`, `sentitems`; `archive` optional; drafts, junk and deleted items are never synced). Custom folders are not supported in v1.

Composite cursor, one per connection, stream `mail`:
`m1.<connection id>.m:<base64url JSON>` with `{ v: 1, folders: [{ name, id, delta?: deltaLink, next?: nextLink, since }], pos, fp }`:
- `id`: the folder's Graph id, resolved once from `GET /me/mailFolders/{wellKnownName}` and kept for mapping `parentFolderId`.
- `next`: an in-progress page link; `delta`: the finished deltaLink.
- `pos`: the folder being read; one Graph page per `sync` call (page-bounded like Google).
- `fp`: a fingerprint of `mail_folders`; a change means a fresh discovery and a full load of new folders.
- Size bound: at most 3 folders; the encoded cursor must stay under 16 KB (the table limit). A test builds the largest allowed state with long synthetic links and asserts the bound. Real deltaLink length: **verify** in the live check.

Requests: `GET /me/mailFolders/{id}/messages/delta` with `$select` of the index fields only, `Prefer: IdType="ImmutableId"` (T-061 review: ids survive moves) and `Prefer: odata.maxpagesize=<pageSize>`. First load: messages of the last 90 days (or the lane's retention, whichever is shorter), using `$filter=receivedDateTime ge ...` if message delta supports it **(verify)**; otherwise older items are dropped in the mapper.

`410 Gone` / `syncStateNotFound` / `resyncRequired` on a stored link → `fullResyncRequired` (an answer, not an error), as Gmail 404 and Calendar 410 are **(verify the codes)**. A foreign or malformed cursor → `fullResyncRequired`.

### 8.2 Field mapping (`MessageMeta`, strict, no body field)

| Index field | Graph |
|---|---|
| `message_id` | `id` (immutable) |
| `thread_id` | `conversationId` |
| `source_url` | `webLink`, accepted only when https and its host is in the cloud's Outlook host allow-list (**verify** host names); else null |
| `from_address`, `from_name` | `from.emailAddress` |
| `to_recipients`, `cc_recipients` | `toRecipients`, `ccRecipients` (capped at 200) |
| `subject` | `subject` (cleaned like Gmail: controls and bidi removed, bounded) |
| `received_at` | `receivedDateTime` (`sentDateTime` for Sent Items) |
| `is_read` | `isRead` |
| `is_starred` | `flag.flagStatus = "flagged"` |
| `is_important` | `importance = "high"` |
| `has_attachments` | `hasAttachments` |
| `folder` | canonical: `INBOX`, `SENT`, `ARCHIVE` (so the existing readers, which look for `INBOX` and `SENT`, work unchanged) |
| `labels` | `SENT` for Sent Items (readers check `'SENT' = any(labels)`); `OTHER` when `inferenceClassification = "other"` (Focused Inbox); user categories as `cat:<name>`, so a category named "SENT" can never pose as a system marker |
| `source_updated_at` | `lastModifiedDateTime` |
| flags | see 8.4 |

Removals: an `@removed` entry in a folder's delta → `{ message_id, folder }` removal (section 6.3). A message that moves to an unsynced folder therefore drops out (as an archived Gmail message leaves `INBOX`).

### 8.3 Live body and search

- `readBody`: `GET /me/messages/{id}?$select=body` with `Prefer: outlook.body-content-type="text"` **(verify)**, through the guard, bounded by `maxChars`, wrapped in `UntrustedBody`, freshness `live`, never persisted (a DB-write spy test, as for Gmail). Ids are validated with `ProviderIdParamSchema` first; whether Graph ids can contain `/` (which that schema refuses) must be **verified**; if they can, ids are base64url-mapped like Google calendar ids.
- `search`: `GET /me/messages?$search="<escaped>"&$select=...` with the query quoted so search operators in it cannot widen it **(verify escaping rules)**. Metadata only.
- The app's callers (`readGmailBody`, `prepareEmailWrite`, the reply route, the briefing body reads) go through a provider-agnostic facade (T-255) that picks the provider from the authoritative connection row and keeps the T-247 owner check.

### 8.4 Header-derived flags

Gmail flags (`is_bulk`, `is_calendar`, `is_auto`, `is_generated`, `is_auth_pass`) come from headers. Graph returns `internetMessageHeaders` only on a single-message read, not in delta **(verify)**. So T-259 reads `$select=internetMessageHeaders` for **new inbox messages** in a page (bounded per page, at the mail rate limit), runs the existing classifier (`mail-flags.ts`), stores only the booleans, and never stores or logs a header. `is_auth_pass` needs the receiving server's `Authentication-Results` (Exchange Online Protection's, not Google's): the parser must accept only the tenant's own authserv-id **(verify the header shape)**. Until it is verified, `is_auth_pass` stays false for Microsoft mail (fail closed: priority-sender top tier does not apply). `is_calendar` also comes from the message `@odata.type` `eventMessage` when present in delta **(verify)**.

### 8.5 Throttling

- Graph throttling is per app per mailbox and per tenant; 429 (and 503) carry `Retry-After` **(verify the limits; the commonly cited mailbox limit is 10,000 requests per 10 minutes and 4 concurrent requests per mailbox)**.
- The shared HTTP client already honours `Retry-After` with capped backoff (T-034). Microsoft adds: a per-connection rate bucket (default 4 requests/s for sync, separate `:write` bucket), at most 4 concurrent requests per mailbox, and an Inngest concurrency key per tenant (`tenant_id`) on top of the per-connection key, so one tenant's throttling never blocks another (architecture §6 M2).
- A run has a time budget: it stops after N pages or T seconds and returns `hasMore`; the cursor resumes (Gmail first-load lesson, plan-review Nov 6).

### 8.6 Wiring (T-260)

`mail-ingest-delta` (T-238) and `conn.sync` pick the runner from the connection's provider through the facade; Microsoft connections of a lane whose `mail.provider` is `microsoft` are listed; the per-tenant concurrency key is added. Home, Inbox and the briefing show Microsoft mail: "Open in Outlook" uses `source_url`; provider names in UI text come from the connection, not hard-coded "Gmail". Coverage, Sync now and the stale line treat Microsoft streams like Google's.

## 9. Calendar sync on Graph (T-067, T-261)

- **Which calendars (D-26 equivalent):** discovery `GET /me/calendars` at the start of each run: the default calendar plus calendars the user owns (`owner.address` = the mailbox) or can edit (`canEdit`); others' read-only and subscribed calendars only with `calendar.include_read_only`; `calendar.calendar_ids` (raw Graph ids) replaces the default. **At most 5 calendars** per Microsoft connection (calendarView deltaLinks are long and carry the window; the 16 KB cursor bound must hold: **verify** link length, raise the cap only with a measured bound). Settings read on every page, fingerprint in the cursor, as T-064.
- **Delta:** `GET /me/calendars/{id}/calendarView/delta?startDateTime=..&endDateTime=..` per calendar, window = retention back (max 180 days) to `forward_days` ahead, `Prefer: IdType="ImmutableId"`, `Prefer: outlook.timezone="UTC"` **(verify which Prefer headers delta honours)**. calendarView delta may not support `$select` and may return bodies **(verify)**: the mapper projects to `EventMeta` (strict, no description) and drops everything else in memory; a test feeds bodies in the fake and asserts none reaches the store, a log or an error.
- **Cursor:** `m1.<connection id>.c:<base64url JSON>` with per calendar the deltaLink or nextLink and the window it was created for; a calendar whose forward window has run down to half is reloaded (as T-064).
- **Mapping:** `seriesMasterId` → `recurring_event_id`; occurrences and exceptions are instances; `isCancelled` → status `cancelled`; `showAs`/`responseStatus` not stored in v1 (as Google); `onlineMeeting.joinUrl` (https only) → `online_meeting_url`; `webLink` (host-checked) → `source_url`; attendees capped at 500; all-day events from `isAllDay` with the event's original time zone (`originalStartTimeZone`, Windows zone names mapped to IANA: **verify**); an all-day event without a usable zone is skipped and logged, never guessed.
- **Deletions:** `@removed` → `removals` (hard delete), which the apply function sets to `cancelled`. The contract suite runs with `removedEventsAreStubs: false` for Microsoft.
- **readBody:** the event's `body` read live (`$select=body`, text), only for a calendar in the current selection.
- **Wiring (T-261):** `CALENDAR_PROVIDERS` (T-130 note) gains `microsoft`; `cal-ingest-delta` lists Microsoft connections of Microsoft lanes; Home and the briefing show "Join" links for Teams meetings like any https link (never opened automatically).

## 10. Write path (T-262, T-263)

`email.save_draft` (D-34 default) and `email.send`, executed only by the approvals module through `@nichols/connectors/write` (rule 5): proposal → the mailbox owner approves the exact payload with step-up → execute once → verify → audit. Same `EmailComposeSchema` payload as Google (`fromMailbox`, `to`, `cc`, `bcc`, `subject`, `bodyText`, `inReplyTo {threadId = conversationId, messageId}`).

- **Scopes:** `Mail.ReadWrite` and `Mail.Send` are requested only when the lane policy allows email writes, and only on a Connect/Reconnect after that (section 7). The connection's feature `graph_mail_write` must be true; otherwise the card says "Sending isn't enabled for this mailbox yet. Reconnect Microsoft with send permission in Settings" (T-232 pattern).
- **Checks before any call** (mirror `google/email-writer.ts` `prepare`): lane and connection brand, provider `microsoft`, action lane/connection, approver id, payload hash (constant time), authoritative row usable, `graph_mail_write`, mail policy, owner = approver, target `{mailbox[, thread_id]}`, `fromMailbox` = the mailbox, the open execution claim (`claims.claimOpen`).
- **Idempotency marker:** each message carries `X-Portal-Action-Id: <action id>` in `internetMessageHeaders` and a single-value extended property (a named string property in a fixed property set) holding the action id **(verify both are settable on create and that the extended property is filterable)**. Before any create, and after any ambiguous failure, the writer looks for its own copy in Drafts (save_draft) or Sent Items (send) with `$filter=singleValueExtendedProperties/Any(ep: ep/id eq '<prop id>' and ep/value eq '<action id>')` **(verify)**, From = the mailbox. A hit returns `already_applied`. No hit after an ambiguous failure (timeout, 5xx, network) ends `outcome_unknown` (a human checks the mailbox); never a blind resend.
- **save_draft:** a reply in the thread is `POST /me/messages/{messageId}/createReply` (the message must be in the approved conversation, read first) then `PATCH` of that draft's recipients, subject and body with the approved payload and the marker; a new message is `POST /me/messages` (lands in Drafts) **(verify createReply semantics and whether the marker can be set on a reply draft)**.
- **send:** the same draft as above, then `POST /me/messages/{draftId}/send`. `/sendMail` is not used (it returns no id, so read-back would rely on search alone). Whether the sent copy keeps an id we can read back, or must be found by the marker in Sent Items, must be **verified**; the read-back uses the marker either way.
- **Verify (read-back):** recipients, subject, conversation and marker equal the approved payload; else `VERIFICATION_MISMATCH_MESSAGE`. The body is purged on any terminal state (D-19, existing `act.purge_content`).
- **Write client allow-list:** the Graph write client accepts only these method + path templates: `POST /me/messages`, `POST /me/messages/{id}/createReply`, `PATCH /me/messages/{id}` (only a draft this action created, checked by marker before the call), `POST /me/messages/{id}/send`. No `DELETE`, `move`, `copy`, `forward`, rules or settings call can be built (a test enumerates and refuses them). `Mail.ReadWrite` would allow deletes; this allow-list is the guard.
- **Recovery (T-192):** a `MicrosoftEmailReconciler` with `findWrite` and `verifyWrite` only (no `executeWrite`), used by `action.reconcile_stuck`.
- **Approvals dispatch:** the email executor and reconciler pick the writer by the action's connection provider. Any SQL in the approvals path that assumes `provider = 'google'` for `email.*` is generalised with pgTAP (T-263).

## 11. Mailbox setups (H-065)

| Setup | Supported | What it means |
|---|---|---|
| **Four separate accounts** (one per company address) | **Yes: the design** | One connection per account, each in its company's lane (pub-k.org and pubkgroup.com → `PKG`, nichols.capital → `NC`, nichols.law → `NL` only after D-51). Several accounts per user per lane already work (T-247). If all four live in one tenant, every lane lists that one tenant id; the lane is decided by the mailbox's domain (`allowed_domains`). |
| One account plus shared mailboxes | Workable, not built (T-268, only if decided) | Needs `Mail.Read.Shared` (+ `Calendars.Read.Shared`), `/users/{shared address}/...` paths, a connection whose mailbox differs from the signed-in identity, and a rule for the token: one refresh token would serve mailboxes in several lanes. Copying it per lane breaks with rotating refresh tokens, and sharing one token row across lanes breaks lane isolation of credentials (rule 1). A design decision is needed first. |
| One mailbox with several addresses (aliases) | **Not supported unless decided** | Every message would have to be sorted into a lane by recipient address; a mistake puts law-firm mail in the wrong lane. Only the primary address is checked at connect; mail to an alias lands in the same mailbox and the same lane. |

## 12. Lanes: NC first (D-50), PKG cut-over later

### 12.1 Enabling `NC` for mail and calendar only (T-265)

Configuration only, no company code. A runbook `docs/runbooks/enable-lane-mail.md` plus a gitignored manual SQL pair:
1. `core.lanes`: `NC` enabled.
2. `core.lane_policies` for `NC`: `llm_allowed_categories` = `email`, `calendar` (no finance, no web); `store_content_bodies = false`; `retention_days` 90; `write_actions_allowed` empty and `store_outbound_drafts = false` at first (drafts later, by a human).
3. A new insert-only `lane_config` version: `enabled_modules` = `comms`, `calendar`, `briefing`; `mail.provider = "microsoft"`; `mail.allowed_domains = ["nichols.capital"]`; `microsoft = { cloud: "commercial", tenant_ids: ["<NC tenant id>"] }`.
4. Memberships: Robert `owner` of `NC` (he connects his own mailbox, D-43); Saurabh `admin_technical` (health only). Finance and approvals are not enabled for `NC`.
5. Vercel Production `ENABLED_LANES=PKG,NC`; Inngest app re-synced.
A lane with mail but no QuickBooks must show no finance tiles or banners: T-265 checks Home and the nav against `enabled_modules` and fixes what does not.

**Where the first live test runs (D-56, recommendation).** Not in an agent worktree with a real mailbox, and not in Saurabh's personal test deployment (H-040 is for his own mail, D-33). Recommended: (1) a local smoke against a **Microsoft test tenant with synthetic users** (H-066), which is synthetic data, so it fits rule 10 and needs no D-33 exception; then (2) the first real mailbox, Robert's nichols.capital, in **Nichols production, lane `NC`**, after the code is merged and deployed, by Robert himself (H-070). Nichols Capital data belongs in Nichols production, like PKG's.

### 12.2 PKG cut-over from Google to Microsoft (T-266; date unknown)

Modelled on T-247's part 25. A runbook plus a gitignored manual SQL pair, run in one short window:
1. Before: the pub-k.org/pubkgroup.com mailboxes are migrated to Microsoft 365 (H-065, H-071 sets the date); the NC test has passed.
2. SQL part: a new insert-only `lane_config` version for `PKG` with `mail.provider = "microsoft"`, the same `allowed_domains`, and `microsoft` settings; every pending `email.*` proposal on a Google connection of `PKG` is invalidated and its body purged; Google connections of `PKG` become `disconnected` (status only; their Vault tokens deleted by the existing function).
3. Each person reconnects under "Your Microsoft accounts".
4. Old Google rows in `comms.message_index` and `cal.event_index` are left to the retention purge (90 / 180 days). Readers must not show rows of a `disconnected` connection, or migrated mail would appear twice (the Google copy and the Microsoft copy). T-266 checks every reader and adds the filter where missing, with pgTAP.
5. Revoking the Google grant at Google is an approvals action (`google.revoke_grant`, D-24) or done by each user at Google; the runbook names both.
6. Check file: every `PKG` Google connection disconnected, no pending Google email proposal, the new config version current, at least one Microsoft connection per person after step 3.
What users see between step 2 and 3: no mail or calendar on Home until they reconnect. The briefing says "Not connected".

## 13. Jobs

| Job | Change |
|---|---|
| `conn.sync` | runner picked by provider through the facade; concurrency key per connection plus per tenant for Microsoft |
| `mail-ingest-delta` (15 min) | lists Microsoft connections of Microsoft lanes |
| `cal-ingest-delta` (15 min) | same |
| `conn.token_health` | Microsoft health check (`GET /me`) registered; no expiry warning (no expiry known) |
| `conn.subscriptions_renew` (T-040 registry) | Microsoft renewer (T-264) |
| `retention.purge` | unchanged; `core.push_subscriptions` registered (T-068) |
| `action.execute` / `action.reconcile_stuck` | Microsoft email writer / reconciler by provider (T-263) |

## 14. Change notifications (T-068, T-264; later)

Polling stays the default (`capabilities.watch = "polling"`) until these land, and stays the fallback after.
- **Subscribe** (`POST /subscriptions`) for `me/mailFolders('inbox')/messages` and each synced calendar's events, `changeType` created,updated,deleted, `notificationUrl` = server config (`/api/webhooks/microsoft`), `lifecycleNotificationUrl` likewise, `expirationDateTime` within Graph's maximum for these resources (believed about 3 days for Outlook resources: **verify**), `clientState` = a random secret stored in the Vault per subscription.
- **Validation:** a request with `validationToken` is answered `200 text/plain` with the token, within Graph's time limit **(verify)**, and nothing else is done.
- **Notifications:** `clientState` compared in constant time; unknown subscription id or wrong `clientState` → 202 and dropped, logged; deduped in `core.webhook_events`; each valid notification only queues a delta sync for that connection (debounced), never reads content inline. Rich notifications (with resource data) are never requested.
- **Lifecycle:** `reauthorizationRequired` → renew; `subscriptionRemoved` → recreate; `missed` → a delta sync. A subscription that cannot be renewed falls back to polling and raises `conn/attention.needed` (`subscription_renewal_failed`).
- **Renewal job:** the T-040 `conn.subscriptions_renew` scan renews subscriptions expiring within 24 hours.
- Notifications need a public https URL: production only; local dev and tests use fakes.
- Rule 5: subscriptions change provider-side state without moving data; accepted under the T-062 review conditions (section 3).

## 15. Verify before building

Each item is unverified and must be checked against Microsoft's current documentation (or the live checks) before the named task is built. Record the answer in `docs/plan-review.md`.

| # | Fact to verify | Task |
|---|---|---|
| V-1 | Commercial endpoints (`login.microsoftonline.com/{tenant\|organizations}/oauth2/v2.0/...`, `graph.microsoft.com/v1.0`); plain GCC uses them | T-256, T-066 |
| V-2 | GCC High endpoints (`login.microsoftonline.us`, `graph.microsoft.us`) and that a commercial multi-tenant app cannot serve a GCC High tenant (separate registration) | T-267 |
| V-3 | `tenant_region_sub_scope` (or another signal) identifies a GCC tenant in OpenID metadata | T-066 |
| V-4 | Delegated permission names and which need admin consent: `User.Read`, `Mail.Read`, `Calendars.Read`, `Mail.ReadWrite`, `Mail.Send`, `Mail.Read.Shared`, `Calendars.Read.Shared` | T-066, T-262 |
| V-5 | Format of the token response `scope` (short names vs `https://graph.microsoft.com/...`) | T-066 |
| V-6 | `tid` in the id_token; trusting id_token claims received directly from the token endpoint over TLS | T-066 |
| V-7 | AADSTS codes for admin consent required / user consent blocked / conditional access / revoked grant | T-066, T-256 |
| V-8 | Refresh tokens rotate on use; lifetime sliding and not returned; old token's validity after rotation | T-256 |
| V-9 | No per-app grant revocation with a delegated token; where users remove an app | T-257 |
| V-10 | Message delta is per folder; `$select` and `$filter=receivedDateTime ge` support; `@removed` shape and reasons; 410 / `syncStateNotFound` codes | T-258 |
| V-11 | `Prefer: IdType="ImmutableId"` on delta and reads; immutable id character set (any `/`?) and maximum length | T-258 |
| V-12 | deltaLink lengths (mail and calendarView) against the 16 KB cursor bound | T-258, T-067 |
| V-13 | `internetMessageHeaders` only on single reads; Exchange `Authentication-Results` shape and authserv-id | T-259 |
| V-14 | `$search` escaping rules on messages | T-259 |
| V-15 | `webLink` hosts per cloud (Outlook on the web) | T-258 |
| V-16 | Throttling limits per mailbox and per tenant; `Retry-After` on 429 and 503 | T-256 |
| V-17 | calendarView delta: `$select` support, whether bodies are returned, supported `Prefer` headers, window handling, `@removed` for deleted events | T-067 |
| V-18 | All-day events and `originalStartTimeZone` (Windows zone names) | T-067 |
| V-19 | Custom `internetMessageHeaders` (X- names) and single-value extended properties settable on draft create / createReply; filtering by extended property | T-262 |
| V-20 | createReply, PATCH draft, send: ids before and after send; where the sent copy lands | T-262, T-263 |
| V-21 | Subscription resources, maximum lifetimes, validation time limit, `clientState` length, lifecycle event names | T-068, T-264 |
| V-22 | Users cannot consent to apps from unverified publishers by default; what publisher verification changes | H-067 |

## 16. Edge cases

- The signed-in account has no mailbox (`mail` null) → refused, fixed message.
- A guest account, or a personal Microsoft account → refused.
- The tenant is removed from `tenant_ids` → the guard refuses every call; Settings shows the row as not usable.
- `microsoft.cloud` changes after connect → the guard refuses; Reconnect.
- The lane switches `mail.provider` → old provider's connections stop syncing at the next run; no data is deleted.
- Same address held by a Google row (any status) and a Microsoft row in the same lane (cut-over): allowed (different provider); readers hide disconnected rows.
- A user category named like a system marker → stored as `cat:<name>`.
- A message moves Inbox → Sent Items between two pages → removal carries the folder; the newer folder's upsert wins.
- 429 storm on one tenant → only that tenant's connections wait (per-tenant key); others continue.
- Refresh-token race on two instances → compare-and-swap, the loser re-reads.
- Conditional access blocks the refresh → `reconnect_required`, admin alert, no retry loop.
- An event body or description in a delta page → dropped in memory; never in the store, logs or errors.
- A calendar beyond the cap of 5 → not synced; Settings says how many were left out (no names).
- An approval whose connection was disconnected between approve and execute → executor refuses (`connection_unavailable`), body purged.
- A send times out and the marker lookup finds nothing → `outcome_unknown`, never resent.
- A notification with a wrong `clientState` → dropped; no sync queued.

## 17. Acceptance tests (Given / When / Then)

All with MSW fakes and synthetic data. Every test of a SQL change includes a cross-lane denial case.

1. **Provider per lane.** Given lane A with `mail.provider = "google"` and lane B with `"microsoft"`, when the 15-minute mail tick runs, then A's Google and B's Microsoft connections are synced and neither lane's other-provider connections are.
2. **Fail closed config.** Given lane B with `mail.provider = "microsoft"` and no `microsoft` block, when the config is parsed, then it is refused; and given a stored config that cannot be read, when a Microsoft sync starts, then nothing is called and the run fails with a config error.
3. **Composio refused for Microsoft.** Given `mail.provider = "microsoft"` and `mail_transport = "composio"`, when the config is parsed, then it is refused.
4. **Connect, happy path.** Given a viewer in lane B with `own_mail`, an allowed domain and the tenant in `tenant_ids`, when they connect and the fake Entra returns the read scopes, a refresh token and a `tid` in the list, then one `active` Microsoft row exists with the user as owner, `tenant_id` and `cloud` set, tokens only in the Vault, and an audit row.
5. **Wrong tenant.** Given a `tid` not in `tenant_ids`, when the callback runs, then the result is `wrong_tenant`, no row or token is stored, and the message tells the user to remove the app's access.
6. **Wrong domain / not on the list.** Given `/me` returns an address on another domain, then `account_refused`; nothing stored.
7. **Wrong account on reconnect.** Given a reconnect of mailbox X, when the user signs in as Y, then `wrong_account` and the row of X is unchanged.
8. **Extra scope.** Given the token response includes `Mail.Send` while the lane policy allows no writes, then the account is refused.
9. **Admin consent.** Given the callback returns the admin-consent-required error, then the result is `admin_consent_required` and Settings shows the admin consent link (client id, tenant, cloud; no secret).
10. **Ownership.** Given Robert (owner) and Saurabh (admin_technical) in the same lane, each with a Microsoft mailbox, when each opens Home, Inbox and the briefing, then each sees only their own mail and events (tables, reader functions and assistant tools); and Saurabh sees Robert's row on Settings as health only.
11. **Mail delta.** Given a fake mailbox with 3 inbox and 2 sent messages, when the first sync runs, then 5 rows are indexed with `folder` `INBOX`/`SENT`, `SENT` in the sent rows' labels, and the stored cursor starts with `m1.<connection id>.m:`.
12. **Removal with folder.** Given a message moved from Inbox to Sent Items, with Sent's upsert applied before Inbox's `@removed`, then the row stays present with folder `SENT`.
13. **410.** Given the fake answers 410 for the stored deltaLink, when sync runs, then the cursor is reset and one full load follows; a second 410 in the same run fails the run.
14. **Cursor bound.** Given the largest allowed cursor state (3 folders, long synthetic links), then the encoded cursor is under 16 KB; given a 4th folder, the config is refused.
15. **Foreign cursor.** Given a Google connection, when `core.comms_mail_apply_page` is called with an `m1.` cursor, then it raises 22023; and given a lane-B Microsoft connection, a call with lane A raises 42501.
16. **Body never stored.** Given a fake message body containing a canary string, when Inbox opens the message and the briefing reads it, then the canary is shown to the owner only and appears in no table, log line, audit row or error.
17. **Throttling.** Given the fake answers 429 with `Retry-After: 2` for tenant T, then the client waits about 2 s and retries; a sync of a connection in tenant U is not delayed.
18. **Calendar.** Given a default calendar, an owned secondary calendar and a read-only shared one, when sync runs with defaults, then the first two are synced and the shared one is not; given an `@removed` event, then its row reads `cancelled`; given an event with a body in the delta page, then no body reaches the store.
19. **Calendar cap.** Given 7 eligible calendars, then 5 are synced and Settings says 2 were left out.
20. **Save draft.** Given an approved `email.save_draft` reply in thread C, when the executor runs, then exactly one draft exists in thread C with the marker, read-back matches, the action is `verified` and the body is purged.
21. **Send once.** Given an approved `email.send` and a fake that times out after accepting the send, when the executor runs, then it finds the marker copy in Sent Items and records `already_applied`; and if the marker is not found, then the action ends `outcome_unknown` and nothing is sent twice.
22. **Write allow-list.** Given the Graph write client, when any `DELETE`, move, copy, forward or settings request is built, then it is refused before a token is read.
23. **No write scope.** Given a connection with `graph_mail_write = false`, when an email action is approved, then the executor refuses with the reconnect message and nothing is called.
24. **Contract.** `describeCommsContract` passes for the Microsoft mail and calendar providers (with `removedEventsAreStubs: false`).
25. **Notifications (later).** Given a validation request, then the token is echoed as plain text; given a notification with a wrong `clientState`, then nothing is queued; given a subscription expiring in 12 hours, when the renew scan runs, then it is renewed and `expires_at` moves.
26. **NC lane.** Given the synthetic `NC` config (mail-only modules), when Robert opens `NC`, then Home shows mail and calendar and no finance tiles, and Settings shows "Your Microsoft accounts".
27. **Cut-over.** Given PKG with a Google connection, pending Google email drafts and indexed rows, when the cut-over SQL runs (locally, synthetic), then the drafts are invalidated with bodies purged, the Google rows are `disconnected`, the Inbox shows no Google rows, and the check file's rows are all true.

## 18. Open questions for Robert / Saurabh

1. **D-54:** one mail provider per lane (default), or both Google and Microsoft in one lane during a migration?
2. **D-55:** Microsoft Disconnect as a local action (delete our tokens, the user removes the app at Microsoft), without approvals? (Default yes.)
3. **D-56:** first live test: local smoke on a synthetic Microsoft test tenant (H-066), then Robert's nichols.capital mailbox in production `NC` (recommended), or another place?
4. Who in Nichols Capital can grant admin consent (H-063), and is publisher verification worth doing (H-067)?
5. H-065: one tenant or several after the GCC migration; four accounts or shared mailboxes; dates.
6. Should Focused Inbox "Other" mail be excluded from "Needs your attention" by default (it is stored as label `OTHER`; default: not excluded)?
7. Archive folder: sync it for Microsoft lanes (Gmail indexes archived mail; Outlook users often archive)? Default: no.
8. D-49 (Robert): GCC content through commercial services; blocks any live GCC mailbox and `allow_gcc`.
9. D-51 (Robert): Nichols Law mail at all.

## 19. Sub-tasks

See `docs/backlog.md`, Phase B9 (T-250 – T-268 and the re-planned T-066 – T-068). Every task is app code (connectors, tokens, RLS or approvals): full security + code review, fix all BLOCKER and HIGH before done.
