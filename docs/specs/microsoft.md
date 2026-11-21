# Spec — Microsoft 365 mail and calendar connector (M2, M5, M6)

Status: proposed (planner output, Nov 18, 2026). Re-plans T-066 – T-068 and adds T-250 – T-269 in `docs/backlog.md`.

**Nov 21, 2026: D-57** (Saurabh): one lane may have Google and Microsoft mail/calendar connections at the same time, permanently; Microsoft is an additional connector and nothing disconnects, hides, skips or stops syncing a Google connection because Microsoft exists. Supersedes D-54 and the PKG cut-over. Sections changed: §1, §2, §4 (rewritten; new config shape, T-269), §6.3 (inventory note), §7 (where Connect shows, precheck, guard), §8.6, §9 (calendar ids, wiring), §10 (approvals dispatch), §11 (one line), §12 (title; §12.1 step 3; §12.2 rewritten as "Enabling Microsoft for PKG alongside Google"), §13, §16 (edge cases replaced and added), §17 (tests 1 – 3, 26, 27 rewritten; 28 – 30 added), §18 (questions 1 and 7), §19 (task range). Sign-in is unchanged (D-6).
Brief: decisions D-48 – D-53 and human items H-062 – H-065 (Nov 18, 2026). Read `CLAUDE.md` (rules 1 – 13), `docs/specs/approvals.md` and the T-063/T-064/T-219/T-247 notes in `docs/plan-review.md` first.

Facts about Microsoft Graph and Entra in this spec are from memory. Every one marked **(verify)** is also in section 15 and must be checked against Microsoft's current documentation before the task that relies on it is built. Nothing marked (verify) may be treated as certain.

## 1. Purpose

A native Microsoft Graph connector for mail and calendar, behind the existing T-062 interfaces (`MailProvider`, `CalendarProvider` in `packages/connectors/src/comms/provider.ts`), so a lane whose mailboxes live in Microsoft 365 gets the same product as a Google lane: Settings → "Connect Microsoft", sign in, approve once; mail and calendar metadata in the index; bodies read live; Home, Inbox and the briefing work unchanged; reply drafts and sends go through the Approval Center.

Google and Microsoft run side by side, **also inside one lane** (D-57): a lane enables one or both providers in `lane_config` (`mail.providers`, section 4), and each person may connect Google and Microsoft mailboxes in the same company. Microsoft is an additional connector; PKG keeps its native Google connections and may add Microsoft when Robert wants it (section 12.2). The first live Microsoft test is Nichols Capital (`NC`, D-50).

## 2. Scope and out of scope

**In scope (this spec):**
- Per-lane list of enabled mail providers in `lane_config` (Google, Microsoft or both), read on every sync and call, fail closed.
- One multi-tenant Entra app; tenant and cloud recorded per lane and per connection, never in code.
- Connect, reconnect and disconnect of a person's own Microsoft mailbox (D-43 ownership, T-247 rules).
- Mail metadata sync (per-folder delta), live body read, live search.
- Calendar metadata sync (calendarView delta), live event description.
- Write path for `email.save_draft` and `email.send` through `packages/modules/approvals` only (rule 5, D-34).
- Change notifications (subscriptions) as a later task, with polling as the default and fallback.
- Enabling the `NC` lane for mail and calendar only (D-50), and a runbook for adding Microsoft to a lane that already uses Google (PKG, when Robert wants it). No cut-over: Google is never switched off because Microsoft is added (D-57).
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

## 4. Mail providers of a lane (lane_config; D-57)

`laneConfigSchema` is strict, so new keys need a schema change and tests. T-250 (merged) added a single `mail.provider` value under D-54; D-57 (Nov 21, 2026) replaced D-54, so T-269 turns it into a list. Plan-review item 12 suggested `mail: { provider, via }`; `via` already exists as `mail_transport` (T-219), so it is not repeated.

```ts
mail: {
  providers: ("google" | "microsoft")[],   // T-269; 1..2, unique; default ["google"]: no change for existing lanes
  provider?: "google" | "microsoft",       // T-250, deprecated input only: read as [provider] when `providers` is absent;
                                           // both keys present is refused; never written by the app again
  allowed_domains: string[],               // existing (T-247), fail closed when empty; applies to BOTH providers' accounts
  self_connect_domains: string[],          // existing, unused
},
mail_transport: "native" | "composio",     // existing; applies to Google connections only; "composio" requires "google" in providers
microsoft: {                               // T-250, optional; required when "microsoft" is in providers (refine)
  cloud: "commercial" | "gcc_high",        // default "commercial" (covers plain GCC as far as we know: verify)
  tenant_ids: uuid[],                      // allowed Entra tenant ids, 1..10; empty is refused by the schema
  allow_gcc: boolean,                      // default false; see section 5.4 (D-49)
  mail_folders: ("inbox" | "sentitems" | "archive")[],  // default ["inbox", "sentitems"]
  calendar_ids?: string[],                 // T-269; raw Graph calendar ids, 1..5; replaces the default selection for Microsoft connections only
},
calendar: { calendar_ids?, include_read_only, forward_days }
  // existing; calendar_ids = raw GOOGLE ids only (D-26, unchanged); include_read_only and forward_days apply to both providers
```

What "enabled" means, per provider:
- **Google enabled** for a lane: `google` is in `mail.providers` (true for every stored lane by default). Google connections are then gated exactly as today (`allowed_domains`, `mailboxes`, D-23, T-247 ownership, `mail_transport`).
- **Microsoft enabled** for a lane: `microsoft` is in `mail.providers` **and** the `microsoft` block is present and valid. A lane with `microsoft: null` never allows a Microsoft connect, sync or call (T-250 review L1). Connections are then gated by `tenant_ids`, `cloud`, `allow_gcc` and the same mail policy.
- A `microsoft` block without `microsoft` in the list is allowed: a lane prepared before use, or Microsoft paused after use.

Rules:
- Read on every sync, every provider call and every connect (like `mailboxes` today), from ONE read (`mailProviderSettings(laneId)` returns `{ providers, microsoft }`; plus `mailProviders(laneId)` and `isMailProviderEnabled(laneId, provider)`). A malformed or unreadable config fails closed.
- **Both providers may be enabled in one lane at the same time, permanently (D-57).** Each connection is handled by its own row's provider: the facade dispatches by `core.connections.provider`, never by a lane-level value. One lane's mail and calendar ticks run all its usable Google **and** Microsoft connections.
- Nothing about a lane's Google connections changes because Microsoft is enabled: they are not disconnected, hidden, skipped, paused or re-consented, and their proposals are not invalidated.
- One person may have a Google and a Microsoft mailbox in the same lane, even with the same address (the D-23 index is `(provider, lower(external_account_id))`). Home, Inbox, the briefing, calendar and approvals show both providers' rows together, each labelled with its provider and account. The same message or meeting seen through both mailboxes appears twice; whether to de-duplicate is open decision **D-58** (default: no de-duplication in the pilot; each row labelled with its account).
- **A provider later removed from `mail.providers`** (a new config version, by a human): its connections are **paused**: not synced, not read live (the guard refuses), not offered Connect or Reconnect; Settings lists them as "Paused: <Google|Microsoft> is not enabled for this company"; their status is not changed, nothing is deleted, and their indexed metadata stays (shown with the stale line) until the retention purge removes it (rule 6 and the lane's retention policy are unchanged). Pending `email.*` proposals on a paused connection are refused at execute (`connection_unavailable`, body purged). Microsoft subscriptions of a paused connection are stopped (T-264). Adding the provider back resumes from the stored cursors.
- Calendar ids are per provider: `calendar.calendar_ids` (Google, D-26) and `microsoft.calendar_ids`. Each list replaces the default selection for that provider's connections only; a shared list would leave the other provider's connections with no calendar or need a silent fallback.
- `mail_transport` is about how Google is reached; Microsoft connections are always `native`.

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
- A GCC tenant may be detectable from its OpenID metadata (`tenant_region_sub_scope = "GCC"` in `/{tenant}/v2.0/.well-known/openid-configuration`) **(verify)**. If it is: the connect refuses a GCC tenant unless the lane's `microsoft.allow_gcc` is true. A human sets that flag only after D-49 is decided. If it is not detectable, `allow_gcc` stays as a documented manual gate and the runbook says so. **Checked Nov 21, 2026 (V-3): Microsoft's documentation does not describe `tenant_region_sub_scope` or any other GCC signal in the metadata, so GCC is treated as NOT detectable: no metadata call is made, and `allow_gcc` is the documented manual gate.**
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

T-253 also does the **reader inventory**: every function and view whose latest body names `'google'` (examples from the notes: `core.home_calendar_status`, Home feed counts, `core.briefing_coverage`, the sync-now and job-failure functions, the calendar target lists). Each is decided case by case and logged: "mail provider" meanings accept `microsoft`; `transport = 'native'` filters stay (Microsoft rows are always `native`). A pgTAP test lists those functions and asserts each accepts a Microsoft connection. The inventory (plan-review "T-253: review results") found that every SQL reader serves both providers regardless of `lane_config`; under D-57 that is the desired behaviour (both providers' rows of one lane are read together), not a gap. Provider enablement is checked in TypeScript (facade, guards, Settings), not in SQL.

### 6.4 Push subscriptions (T-068)

`core.push_subscriptions` (`lane_id`, `connection_id`, `provider`, `resource` `mail|calendar`, `subscription_id`, `resource_path` (non-secret template), `expires_at timestamptz`, `status`, `created_at`, `updated_at`). The `clientState` is a Vault secret per subscription, never in this table. RLS: health view only (no content), service role writes through definer functions. pgTAP incl. cross-lane denial. Registered with retention (rows of removed subscriptions, 30 days). The provider check of `core.webhook_events` must include `microsoft` (check; extend if not).

No change to `comms.message_index` or `cal.event_index` columns: both already allow `microsoft` (T-061).

## 7. Connect flow (T-256, T-066, T-257)

Same experience as Google: Settings → "Your Microsoft accounts" → **Connect Microsoft** → Microsoft sign-in → approve once → back on Settings with the result. **Reconnect** appears when the grant dies. Portal sign-in is unchanged (D-6): this connect is a data connection, not a login, and the page says so.

"Your Microsoft accounts" is shown when Microsoft is enabled for the lane (section 4), **next to** "Your Google accounts" when Google is enabled too; the Google section is unchanged. The start and the callback refuse server-side when Microsoft is not enabled. Any member with `own_mail` connects **their own** account; the connection's owner is the signed-in user (D-43, T-247); nobody connects someone else's mailbox.

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
1. `precheck` (one `mailProviderSettings` read): the lane's `mail.allowed_domains` is not empty, and Microsoft is enabled for the lane (`microsoft` in `mail.providers`, `microsoft` settings present and valid) (fail closed before the code exchange). Whether the lane also has Google enabled or Google connections is irrelevant; they are not read or changed.
2. Code exchange at the lane's cloud token endpoint (PKCE, client secret in the body).
3. Granted scopes are exactly the requested set (the token response `scope`; OIDC extras tolerated). A missing scope, an unrequested write scope, or no refresh token refuses the account. The format of `scope` (short names vs full URIs) must be handled: **verify**.
4. Tenant: the `tid` claim of the id_token received directly from the token endpoint over TLS (OIDC code flow; verified Nov 21, 2026, V-6: OpenID Connect Core §3.1.3.7 rule 6 allows TLS server validation in place of the signature check for an ID Token received directly from the Token Endpoint; the connector does not check the signature but MUST check `iss` = the v2.0 issuer of that same `tid`, `aud` = our client id, `exp`, and the `nonce` it sent; decision recorded in `docs/plan-review.md`, T-066 verify section). `tid` must be in `microsoft.tenant_ids` → otherwise `wrong_tenant` (new result code, fixed message). A personal-account tenant is refused by the `organizations` authority and by this check.
5. GCC check (section 5.4).
6. Identity: Graph `GET /me?$select=id,mail,userPrincipalName,userType` with the new access token (`userType` is returned only with `$select`, V-4/V-6 check Nov 21, 2026). The mailbox is `mail` (primary SMTP), lower-cased. No `mail` (unlicensed or no mailbox) refuses. A guest account (`userType` other than `Member`, or `#EXT#` in the UPN) refuses.
7. Mail policy: `assertMailAccountAllowed` (allowed domain, and on the exact `mailboxes` list when the lane keeps one).
8. Reconnect: the address must equal the bound connection's (`wrong_account` otherwise); the tenant must equal its stored `tenant_id`.
9. D-23 and ownership: the existing `ensureConnection` + owner checks (a row owned by someone else is refused, `ACCOUNT_OWNED_BY_OTHER_MESSAGE`). A Google row with the same address in the lane does not conflict (different provider).
10. Store the token set in the Vault (`storeToken`), set `tenant_id` + `cloud` (set-once function), record features (`graph_mail_write: true|false`), audit.

A grant refused after step 2 is dropped from memory, never stored, and the user is told to remove the app's access in their Microsoft account (the existing `GRANT_NOT_STORED_MESSAGE` path).

**Tokens** (`microsoft/token-manager.ts`, mirrors Google's): refresh when under 5 minutes left and on a 401; single-flight per connection per process; Microsoft **rotates** refresh tokens on use **(verify)**, so the new set is stored with the existing compare-and-swap `rotateToken` and a loser re-reads the Vault. `invalid_grant` and the "consent revoked / password changed / conditional access" family (`interaction_required`, specific `AADSTS` codes: **verify**) → `reconnect_required`. Refresh POSTs are never retried. `token_expires_at` stays null (refresh-token lifetime is sliding and not returned: **verify**); expiry is found by the refresh failure.

**Guard** (`microsoft/guard.ts`, mirrors `google/guard.ts`) on every provider call, before any token read, from one `mailProviderSettings` read: lane brand, provider `microsoft`, authoritative row, usable status, Microsoft enabled for the lane (section 4; `microsoft: null` refuses), the row's `tenant_id` still in `tenant_ids`, the row's `cloud` equal to the lane's cloud (a changed cloud means Reconnect), mail policy on the address. The guard never refuses because the lane also has Google enabled, and never touches Google rows.

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

`mail-ingest-delta` (T-238) and `conn.sync` pick the runner from the connection's provider through the facade; the Microsoft connections of every lane where Microsoft is enabled are listed and run in the same tick as that lane's Google connections; the per-tenant concurrency key is added for Microsoft rows. Home, Inbox and the briefing show the user's Google and Microsoft mail together in one list, each row labelled with its provider and account; "Open in Gmail" / "Open in Outlook" per row from that row's `source_url`; provider names in UI text come from the row's connection, not hard-coded "Gmail". No de-duplication across providers (D-58 default). Coverage, Sync now and the stale line treat Microsoft streams like Google's.

## 9. Calendar sync on Graph (T-067, T-261)

- **Which calendars (D-26 equivalent):** discovery `GET /me/calendars` at the start of each run: the default calendar plus calendars the user owns (`owner.address` = the mailbox) or can edit (`canEdit`); others' read-only and subscribed calendars only with `calendar.include_read_only`; `microsoft.calendar_ids` (raw Graph ids, T-269) replaces the default. `calendar.calendar_ids` holds Google ids (D-26) and is never applied to a Microsoft connection. **At most 5 calendars** per Microsoft connection (calendarView deltaLinks are long and carry the window; the 16 KB cursor bound must hold: **verify** link length, raise the cap only with a measured bound). Settings read on every page, fingerprint in the cursor, as T-064.
- **Delta:** `GET /me/calendars/{id}/calendarView/delta?startDateTime=..&endDateTime=..` per calendar, window = retention back (max 180 days) to `forward_days` ahead, `Prefer: IdType="ImmutableId"`, `Prefer: outlook.timezone="UTC"` **(verify which Prefer headers delta honours)**. calendarView delta may not support `$select` and may return bodies **(verify)**: the mapper projects to `EventMeta` (strict, no description) and drops everything else in memory; a test feeds bodies in the fake and asserts none reaches the store, a log or an error.
- **Cursor:** `m1.<connection id>.c:<base64url JSON>` with per calendar the deltaLink or nextLink and the window it was created for; a calendar whose forward window has run down to half is reloaded (as T-064).
- **Mapping:** `seriesMasterId` → `recurring_event_id`; occurrences and exceptions are instances; `isCancelled` → status `cancelled`; `showAs`/`responseStatus` not stored in v1 (as Google); `onlineMeeting.joinUrl` (https only) → `online_meeting_url`; `webLink` (host-checked) → `source_url`; attendees capped at 500; all-day events from `isAllDay` with the event's original time zone (`originalStartTimeZone`, Windows zone names mapped to IANA: **verify**); an all-day event without a usable zone is skipped and logged, never guessed.
- **Deletions:** `@removed` → `removals` (hard delete), which the apply function sets to `cancelled`. The contract suite runs with `removedEventsAreStubs: false` for Microsoft.
- **readBody:** the event's `body` read live (`$select=body`, text), only for a calendar in the current selection.
- **Wiring (T-261):** `CALENDAR_PROVIDERS` (T-130 note) gains `microsoft`; `cal-ingest-delta` lists the Microsoft connections of every lane where Microsoft is enabled, beside its Google connections; Home and the briefing show the user's Google and Microsoft events together in time order, each labelled with its provider and account, and "Join" links for Teams meetings like any https link (never opened automatically). The same meeting on both calendars appears twice (D-58 default).

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
- **Approvals dispatch:** the email executor and reconciler pick the writer by the action's connection provider, so a lane with both providers executes Google and Microsoft proposals side by side; the Approval Center labels each email proposal with its provider and sending mailbox. An action whose connection's provider is no longer enabled for the lane is refused at execute (`connection_unavailable`, body purged). Any SQL in the approvals path that assumes `provider = 'google'` for `email.*` is generalised with pgTAP (T-263).

## 11. Mailbox setups (H-065)

| Setup | Supported | What it means |
|---|---|---|
| **Four separate accounts** (one per company address) | **Yes: the design** | One connection per account, each in its company's lane (pub-k.org and pubkgroup.com → `PKG`, nichols.capital → `NC`, nichols.law → `NL` only after D-51). Several accounts per user per lane already work (T-247). If all four live in one tenant, every lane lists that one tenant id; the lane is decided by the mailbox's domain (`allowed_domains`). |
| One account plus shared mailboxes | Workable, not built (T-268, only if decided) | Needs `Mail.Read.Shared` (+ `Calendars.Read.Shared`), `/users/{shared address}/...` paths, a connection whose mailbox differs from the signed-in identity, and a rule for the token: one refresh token would serve mailboxes in several lanes. Copying it per lane breaks with rotating refresh tokens, and sharing one token row across lanes breaks lane isolation of credentials (rule 1). A design decision is needed first. |
| One mailbox with several addresses (aliases) | **Not supported unless decided** | Every message would have to be sorted into a lane by recipient address; a mistake puts law-firm mail in the wrong lane. Only the primary address is checked at connect; mail to an alias lands in the same mailbox and the same lane. |

Under D-57 a company lane may hold these Microsoft accounts **and** the same people's Google accounts at the same time (e.g. pub-k.org on Google and a pub-k.org Microsoft mailbox in `PKG`); each is its own connection, labelled per account.

## 12. Lanes: NC first (D-50), Microsoft added to PKG later (D-57)

### 12.1 Enabling `NC` for mail and calendar only (T-265)

Configuration only, no company code. A runbook `docs/runbooks/enable-lane-mail.md` plus a gitignored manual SQL pair:
1. `core.lanes`: `NC` enabled.
2. `core.lane_policies` for `NC`: `llm_allowed_categories` = `email`, `calendar` (no finance, no web); `store_content_bodies = false`; `retention_days` 90; `write_actions_allowed` empty and `store_outbound_drafts = false` at first (drafts later, by a human).
3. A new insert-only `lane_config` version: `enabled_modules` = `comms`, `calendar`, `briefing`; `mail.providers = ["microsoft"]` (NC has no Google mail today; Google can be added later the same way); `mail.allowed_domains = ["nichols.capital"]`; `microsoft = { cloud: "commercial", tenant_ids: ["<NC tenant id>"] }`.
4. Memberships: Robert `owner` of `NC` (he connects his own mailbox, D-43); Saurabh `admin_technical` (health only). Finance and approvals are not enabled for `NC`.
5. Vercel Production `ENABLED_LANES=PKG,NC`; Inngest app re-synced.
A lane with mail but no QuickBooks must show no finance tiles or banners: T-265 checks Home and the nav against `enabled_modules` and fixes what does not.

**Where the first live test runs (D-56, recommendation).** Not in an agent worktree with a real mailbox, and not in Saurabh's personal test deployment (H-040 is for his own mail, D-33). Recommended: (1) a local smoke against a **Microsoft test tenant with synthetic users** (H-066), which is synthetic data, so it fits rule 10 and needs no D-33 exception; then (2) the first real mailbox, Robert's nichols.capital, in **Nichols production, lane `NC`**, after the code is merged and deployed, by Robert himself (H-070). Nichols Capital data belongs in Nichols production, like PKG's.

### 12.2 Enabling Microsoft for PKG alongside Google (T-266, H-071; when Robert wants it)

Not a cut-over (D-57): Google stays connected and keeps syncing; nothing is disconnected, invalidated, hidden or purged. This differs from 12.1 because the lane already exists and uses Google: no lane enable, no policy or membership change. A section of `docs/runbooks/enable-lane-mail.md` plus a gitignored manual SQL pair:
1. Before: Robert wants PKG's Microsoft mailboxes in the portal (H-071 records it); the NC test has passed (H-070); the PKG tenant id(s) and cloud are known (H-065); the tenant admin has granted consent once (as H-063).
2. Record the counts the check file compares: usable Google connections of `PKG`, pending Google `email.*` proposals of `PKG`.
3. SQL part: one new insert-only `lane_config` version for `PKG` with `mail.providers = ["google", "microsoft"]` and the `microsoft` block (cloud, tenant ids). Every other key is kept unchanged (`allowed_domains`, `mailboxes`, `mail_transport`, `calendar.calendar_ids`, `briefing`, `approvals`); a legacy `mail.provider` key is removed. It refuses to run unless Google is enabled in the current version and Microsoft is not. Nothing else is written.
4. Each person with a PKG Microsoft mailbox connects it under "Your Microsoft accounts"; their Google rows stay under "Your Google accounts".
5. Check file (read-only): the new version current; both providers listed; the Google keys equal to the previous version's; the two counts of step 2 unchanged.
What users see: a new "Your Microsoft accounts" section; Home, Inbox and the briefing list Google and Microsoft rows together, each labelled with its account. **Caution:** if the same mail reaches both mailboxes (forwarding, or a copy migrated from Google to Microsoft), it appears twice; whether to de-duplicate is open decision D-58 (default: no; each row labelled). The lane policy's `write_actions_allowed` applies to both providers, so a Microsoft connect in PKG requests `Mail.ReadWrite` and `Mail.Send` when PKG allows email writes (section 7); T-263 must be merged first.
Rollback: a new version with `mail.providers = ["google"]` (Microsoft rows paused, nothing deleted, section 4).

## 13. Jobs

| Job | Change |
|---|---|
| `conn.sync` | runner picked by the connection row's provider through the facade; a connection whose provider is not enabled for its lane is skipped (`provider_disabled`, no external call); concurrency key per connection plus per tenant for Microsoft |
| `mail-ingest-delta` (15 min) | lists every usable Google and Microsoft connection of each lane (Microsoft only where enabled) in the same tick |
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
- One user has a Google and a Microsoft mailbox in the same lane (same or different address) → both connections are usable; both sync in the same tick; Home, Inbox, the briefing and calendar show both, each row labelled with its provider and account; a message present in both mailboxes is shown twice (D-58 default).
- The lane has no `microsoft` block, or `microsoft` is not in `mail.providers` → "Your Microsoft accounts" is not shown, Connect Microsoft is refused server-side before the code exchange, nothing is stored; the lane's Google connections, Settings section and sync are unaffected.
- Microsoft is removed from `mail.providers` later (a new config version) → its connections are paused: not synced, live reads refused by the guard, no Reconnect, shown on Settings as "Paused: Microsoft is not enabled for this company"; status unchanged, nothing deleted, indexed metadata left to the retention purge; pending Microsoft email proposals refused at execute with the body purged; subscriptions stopped. Google connections unaffected. The same holds the other way round for Google.
- A config with both `mail.provider` and `mail.providers` → refused (fail closed).
- `mail_transport = "composio"` in a lane with both providers → applies to the Google connections only; Microsoft connections stay native.
- Same address held by a Google row and a Microsoft row in the same lane: allowed (different provider); both shown, each labelled.
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

1. **Both providers in one lane.** Given lane A with `mail.providers = ["google","microsoft"]` and a `microsoft` block, and user U with one Google and one Microsoft mailbox in A, when the 15-minute mail tick runs, then both of U's connections are synced in that tick, each by its own provider's runner; and when U opens Home, Inbox and the briefing, then both mailboxes' rows are shown together, each labelled with its provider and address, with "Open in Gmail" on the Google rows and "Open in Outlook" on the Microsoft rows.
2. **Fail closed config.** Given lane B with `mail.providers = ["microsoft"]` and no `microsoft` block, when the config is parsed, then it is refused; given a config with both `mail.provider` and `mail.providers`, then it is refused; and given a stored config that cannot be read, when a Microsoft sync starts, then nothing is called and the run fails with a config error.
3. **Composio is Google-only.** Given `mail.providers = ["microsoft"]` and `mail_transport = "composio"`, when the config is parsed, then it is refused; given `["google","microsoft"]` and `composio`, then it is accepted and the Microsoft connections run native. Given a stored T-250 config with `mail.provider = "microsoft"`, then it reads as `["microsoft"]`; given one with no provider key, then `["google"]`.
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
26. **NC lane.** Given the synthetic `NC` config (mail-only modules, `mail.providers = ["microsoft"]`), when Robert opens `NC`, then Home shows mail and calendar and no finance tiles, and Settings shows "Your Microsoft accounts" and no Google section.
27. **Microsoft added to a Google lane.** Given synthetic PKG with a usable Google connection, pending Google email drafts and indexed Google rows, when the T-266 SQL runs (locally, synthetic), then the new config version lists both providers with every Google key unchanged, the Google connection is still usable and syncs in the next tick, the drafts are still pending, the Inbox still shows the Google rows, Settings shows both sections, and the check file's rows are all true.
28. **Microsoft settings absent.** Given lane C with `mail.providers = ["google"]` and no `microsoft` block, when a member starts Connect Microsoft (direct request to the start route), then it is refused before any redirect to Microsoft and nothing is stored; and the member's Google connect and the lane's Google sync work as before.
29. **Microsoft disabled later.** Given lane A with both providers and a usable Microsoft connection with indexed rows and one pending Microsoft `email.save_draft`, when a new config version sets `mail.providers = ["google"]`, then the next tick skips the Microsoft connection (`provider_disabled`, no Graph call, no token read), a live body read of a Microsoft row is refused, Settings shows the row as paused with no Reconnect, its status and indexed rows are unchanged, approving the pending draft ends `connection_unavailable` with the body purged, and the Google connections sync as before.
30. **Calendar ids per provider.** Given `calendar.calendar_ids` with one Google id and `microsoft.calendar_ids` with one Graph id, when both of a user's connections sync, then the Google connection syncs only its listed calendar and the Microsoft connection only its listed calendar.

## 18. Open questions for Robert / Saurabh

1. **D-58** (D-54 was decided and then superseded by D-57 on Nov 21, 2026: both providers in one lane, permanently): should Home, Inbox, the briefing and calendar de-duplicate mail and events seen through both a Google and a Microsoft mailbox of the same person? Default: no de-duplication in the pilot; each row labelled with its provider and account.
2. **D-55:** Microsoft Disconnect as a local action (delete our tokens, the user removes the app at Microsoft), without approvals? (Default yes.)
3. **D-56:** first live test: local smoke on a synthetic Microsoft test tenant (H-066), then Robert's nichols.capital mailbox in production `NC` (recommended), or another place?
4. Who in Nichols Capital can grant admin consent (H-063), and is publisher verification worth doing (H-067)?
5. H-065: one tenant or several after the GCC migration; four accounts or shared mailboxes; dates.
6. Should Focused Inbox "Other" mail be excluded from "Needs your attention" by default (it is stored as label `OTHER`; default: not excluded)?
7. Archive folder: sync it for Microsoft connections (Gmail indexes archived mail; Outlook users often archive)? Default: no.
8. D-49 (Robert): GCC content through commercial services; blocks any live GCC mailbox and `allow_gcc`.
9. D-51 (Robert): Nichols Law mail at all.

## 19. Sub-tasks

See `docs/backlog.md`, Phase B9 (T-250 – T-269 and the re-planned T-066 – T-068). Every task is app code (connectors, tokens, RLS or approvals): full security + code review, fix all BLOCKER and HIGH before done.
