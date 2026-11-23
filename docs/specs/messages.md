# Spec — Messages: Microsoft Teams in the portal (M-Teams)

Status: proposed (planner output for T-277, Nov 23, 2026). Adds Phase B11 (T-278 – T-293) to `docs/backlog.md`. Nothing here is approved until Saurabh approves the tasks.
Brief: decisions D-52, D-62, D-63, D-64, D-65 (Nov 23, 2026), D-23, D-43, D-57; read `CLAUDE.md` (rules 1 – 13), `docs/specs/microsoft.md` (§5, §7, §14) and `docs/specs/approvals.md` first.

**Vendor facts.** Every Microsoft fact in this spec comes from `.agent/notes/T-277-vendor-facts.md` (checked against learn.microsoft.com on Nov 23, 2026), cited as **[A1]**, **[B]**, **[D8]** and so on. Facts in that note's "Not confirmed" list are marked **(not confirmed)** here and each has a live check in a human item. Nothing in this spec adds a vendor fact from memory. One fact comes from our own live run instead: Microsoft's token response lists every scope already consented for the app in that tenant, not only the requested ones (observed Nov 22, 2026, `docs/specs/microsoft.md` §7).

## 1. Purpose

The Messages page (a placeholder since T-271) shows the signed-in person's own Microsoft Teams conversations, in the company (lane) where that Teams account is connected: read 1:1 chats, group chats and the channels of their teams (D-64), reply and send (each send is the person's approval of that exact text, D-65), and start a call or video call. **A call always opens Teams** through a link, with the person or chat selected (D-63 as revised Nov 23, 2026: the owner chose "option 1", our own Messages page with a Call button that opens Teams; calling inside the portal is not planned, section 2).

Teams is a **separate connection** from mail: a company whose mail is Google (Pub K Group, `PKG`) offers "Sign in to Teams" without enabling Microsoft mail (D-62), and a company with Microsoft mail (Nichols Capital, `NC`) can sign the same Microsoft account in to Teams too (section 4).

## 2. Scope and non-goals

**In scope:**
- A Teams connection per person per lane, its own `teams` settings in `lane_config`, its own consent flow and Settings section (sections 4 – 6).
- Chats: list, unread state, read messages, members, "Open in Teams" (phase 2).
- Call and Video call buttons that open Teams with the people of a chat selected (phase 2, section 13). The call itself happens in Teams.
- Sending and replying in chats through `packages/modules/approvals` with Send = approval (phase 3, section 10).
- New-message notices through change-notification subscriptions without resource data, with a "new" dot on Messages; no polling of Microsoft (phase 4, section 9).
- Channels of the person's joined teams: list, read root posts and replies, post and reply (phase 5, D-64).
- Optional: AI-drafted reply text placed in the composer, sent only when the person presses Send (only if D-69 says yes).

**Non-goals:**
- **Calling inside the portal: not planned** (D-63 revised, Nov 23, 2026: "I will go with option 1"; dropped for now, reopened only if the owner asks). Reasons from the fact sheet: Graph cannot place a call as a user [D6]; the only route is Azure Communication Services with a Teams identity [D8], a new paid vendor at about $0.004 per participant minute, which Microsoft retires as a standalone offering on 2028-09-30 without naming "communication as Teams user" among what stays supported; on iPhone a call rings only while the page is open and drops or mutes in the background, and the installed home-screen app is undocumented [D8]; and it is not available in GCC or GCC High [D8, E10], where these companies are expected to move (D-48). Calls are the deep-link buttons of section 13. If the topic is reopened, start from fact sheet sections D8, D9 and F2: no task, scope or human item for it exists in this plan.
- **Google Chat.** Not asked for (D-62).
- **Embedding Teams itself.** Asked by the owner on Nov 23, 2026 ("cant we embed entire teams into the app?"). Microsoft documents no supported way to show the Teams client inside another site's page [F]. Entra sign-in refuses to render any prompt that needs the user (credentials, consent) in an iframe ("X-FRAME OPTIONS SET TO DENY"), and Teams' own docs say "Sign-in pages don't render in iFrames" [F1]. On iPhone, Safari blocks the third-party cookies an iframe sign-in would need [F1]. The Microsoft Graph Toolkit chat component (`mgt-chat`) was retired on 2026-08-28 and the Teams-chat embed sample is archived [F2]. The documented routes are our own chat and channel pages over Graph (this spec), links that open Teams [D7], and the reverse direction: the portal as a tab inside Teams [F3]. Not confirmed: the actual framing headers of `teams.microsoft.com` (a browser dev-tools check would settle it; it would not change the answer, because sign-in alone rules out the iframe). "The portal as a tab inside Teams" is an open question for the owner (Q-M12), not a task.
- Presence (needs `Presence.Read.All`, and presence subscriptions always need an encryption certificate [C]).
- Starting a new chat with someone the person has no chat with (needs `Chat.Create` [A2] and a people picker). Until it is decided (Q-M9), the page offers "New chat in Teams" as a link.
- Editing or deleting messages, reactions, mentions, attachments, inline images in sent messages, cards. A sent message is plain text only.
- Marking a chat read in Teams (needs `Chat.ReadWrite`, a broader scope [A1], and it is an external write; Q-M5). The portal keeps its own read marker.
- Searching chats; Teams content in the briefing, Home or the assistant (only the optional composer draft, D-69).
- Web push to the phone for new Teams messages (Q-M8).
- Shared channels hosted outside the person's joined teams, and cross-tenant shared channels (section 14).
- GCC High (section 15) and Nichols Law (D-51, rule 13).

## 3. Rules applied

- Rule 1: every function, table, job, cache entry and route takes `laneId`; DB clients only from the lane router.
- Rule 2: tenant ids, allowed domains, enabled features and the cloud live in `lane_config.teams`; no tenant id, domain or company name in code. The PKG tenant id is recorded in D-62 and goes into production `lane_config` only through a human SQL step (H-081).
- Rule 3: every new table has `lane_id`, RLS and pgTAP (with cross-lane AND cross-user denial) in the same task.
- Rule 4: Graph is called only from `packages/connectors/src/teams/*`; tokens only in the Vault; never logged or put in a prompt.
- Rule 5: the only writes to Microsoft are (a) sends through the approvals executor and (b) subscription create/renew/stop by jobs, accepted infrastructure under the same conditions as T-068 (`docs/specs/microsoft.md` §3, §14).
- Rule 6: message text, `lastMessagePreview`, chat topics, member names and addresses, channel names and file names are **never stored, logged, audited or put in an event**. They are fetched live and shown. The only Teams data stored is listed in section 7; the composed text of a send exists only while its action is open (section 10.4).
- Rule 9: everything that comes from Teams is untrusted: rendered as text through an allow-list converter (section 8.4), links https only, never triggers an action, never changes a permission.
- Rule 10: MSW fakes and synthetic data only. Every live check is a human item.
- D-23: one Teams account, one lane. D-43 / T-247: a person sees only the Teams data of connections they own; admins (owner, admin_technical) see the connection row's health columns only (status, UPN, tenant, cloud, features, owner, times, last error: section 7.1 lists them), never chats.
- Microsoft API terms [A3, E12]: no background polling of Teams (at most once per day; we do none); fetch on page open or refresh; a date range on incremental fetches; notices through subscriptions without resource data; delete the person's data on disconnect; "do not use Teams as a log file" (the portal never posts anything the person did not type and send).

## 4. Connection model (D-62, decision D-66)

### 4.1 Decision: a separate Teams connection on a dedicated Entra app (recommended; D-66)

Each person who wants Teams in a lane has one connection row with **provider `microsoft_teams`**, separate from any `google` or `microsoft` mail connection, obtained through a **second Entra app registration used only for Teams** ("Nichols Executive Portal – Teams", H-078). The mail app of H-062 is not changed.

Why not "one Microsoft connection with Teams scopes added after a reconnect":
1. **It breaks NC mail.** The Microsoft connect refuses a grant that holds any scope it did not request (`assertGrantedScopes`, `packages/connectors/src/microsoft/provider.ts`; decided Nov 22, 2026, `microsoft.md` §7), and Microsoft's token response lists every scope already consented for the app in that tenant (observed live). Once Teams scopes are consented on the shared app in the NC tenant, the next Microsoft mail Reconnect there is refused for unrequested Teams scopes, and a Teams connect is refused for the admin-consented `Mail.*` scopes. Loosening that check would reopen the read-only-lane question the Nov 22 decision closed.
2. **It does not fit PKG.** PKG has no Microsoft mail (`mail.providers = ["google"]`). The Microsoft guard, provider gate and subscription job refuse or skip every `microsoft` row in a lane where Microsoft mail is not enabled (`microsoft/guard.ts`), and every SQL reader and job treats a `microsoft` row as a mailbox (`core.mailbox_ids` filters `provider in ('google','microsoft')`; the 15-minute mail and calendar ticks list all usable Microsoft rows). A Teams-only account usually has no mailbox, so a `microsoft` row for it would fail every mail tick and raise the three-failures alert.
3. **The unique constraints already allow a second row.** The D-23 index is `connections_one_lane_per_account (provider, lower(external_account_id)) where status not in ('disconnected','pending')`. A `microsoft_teams` row with the same address as a `microsoft` mail row is a different key, so in NC the same Microsoft account can hold a mail connection and a Teams connection in the same lane. The same Teams account cannot be connected in a second lane (D-23 holds; D-62: "a Teams account belongs to exactly one lane").
4. **Fail closed by construction.** No existing reader, job, guard or approvals path knows `microsoft_teams`, so nothing built so far can sync, read or write with a Teams token by mistake.
5. **A dedicated app isolates tokens and consent.** A mail token cannot reach chats and a Teams token cannot reach mail. Consent for Teams scopes, including the admin-only `ChannelMessage.Read.All` [E11], is given to the Teams app only.

Cost of the decision: one more app registration and client secret (with its own expiry), one more redirect URI per environment, one more sign-in for NC people who already connected mail (the account picker; Microsoft does not ask for the password again if the browser is signed in). The fact sheet confirms that incremental consent on ONE app also works [E11]. That route is the alternative in D-66: it needs `assertGrantedScopes` relaxed for both purposes, and Teams rows kept out of every mail reader by a `purpose` column. More code paths to change, weaker isolation.

### 4.2 The row

| Column | Teams value |
|---|---|
| `provider` | `microsoft_teams` (added to `PROVIDERS` and to every provider check, section 7.1) |
| `external_account_id` | `lower(userPrincipalName)` from `GET /me`. The sign-in name; checked against `teams.allowed_domains`. A Teams account may have no mailbox, so `mail` is not required. |
| `owner_user_id` | the signed-in portal user (set once; the T-247 rules) |
| `tenant_id`, `cloud` | set once at connect, as for Microsoft mail (T-254), extended to `microsoft_teams` rows |
| `entra_object_id uuid` (new) | the account's Entra object id (`/me` `id`), set once, immutable, server-only (no column grant to `authenticated`). Used to recognise the person's own messages and to build the subscription resource [A3]. |
| `features` | what was granted and asked for: `teams_chat_read`, `teams_chat_send`, `teams_call_links`, `teams_channels_read`, `teams_channels_send` (booleans; always written, so a reconnect under fewer features clears them) |
| `transport` | `native` |

At most **one usable Teams connection per person per lane** (partial unique index on `(lane_id, owner_user_id) where provider = 'microsoft_teams' and status not in ('disconnected','pending')`). The page needs no account switcher; a second account is refused with a fixed message (Q-M10 if two are ever needed).

### 4.3 Lane settings (`lane_config.teams`, new, strict)

```ts
teams?: {
  enabled: boolean,                       // default false; Teams is off for every lane until a human version sets it
  cloud: "commercial" | "gcc_high",       // default "commercial"; gcc_high is refused until a GCC High Teams task (section 15)
  tenant_ids: lowerUuid[],                // 1..10, unique, never the personal-account or nil tenant (same rules as microsoft.tenant_ids)
  allowed_domains: mailDomain[],          // 1..20; the UPN domain must be listed; empty refuses (fail closed)
  features: ("chat_read" | "chat_send" | "call_links" | "channels_read" | "channels_send")[],
                                          // default ["chat_read"]; chat_send needs chat_read; channels_send needs channels_read
}
```
- Independent of `mail.providers`, `mail.allowed_domains` and the `microsoft` block (D-62). A lane may have `teams` with Google mail only (PKG), with Microsoft mail (NC), or with no mail.
- Read on every connect, every Graph call and every page render, from one read (`teamsSettings(laneId)`), as `mailProviderSettings` is. Malformed or unreadable fails closed.
- `MODULES` gains `messages`; `NAV_OF` maps it to the `messages` nav key. An unlimited lane (PKG today) shows Messages as now. A limited lane (NC) shows it only when `enabled_modules` lists `messages` (H-080). The module decides only what is drawn; `teams.enabled` and RLS are the gates.
- Removing a feature or setting `enabled: false` in a new version **pauses** the matching calls: the guard refuses, Settings shows "Paused: Teams is not enabled for this company", nothing is deleted at once, subscriptions are stopped locally (as `microsoft.md` §4 for mail).

### 4.4 Scope sets per phase (least privilege, from the fact sheet)

The Teams provider requests `openid offline_access User.Read` plus the union for the lane's `features`:

| Feature (phase) | Delegated scopes | Admin consent [E11] | Covers |
|---|---|---|---|
| `chat_read` (2) | `Chat.Read` | No | list chats, `viewpoint`, `lastMessagePreview`, members, messages, one message, hosted contents, the all-chats subscription [A1, A3; design note 1] |
| `call_links` (2) | `User.ReadBasic.All` | No | another member's `userPrincipalName` for call deep links [C] |
| `chat_send` (3) | `ChatMessage.Send` | No | `POST /chats/{id}/messages` [A2] |
| `channels_read` (5) | `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` | **Yes** for `ChannelMessage.Read.All` | joined teams, channels, root posts, replies, channel inline images [B] |
| `channels_send` (5) | `ChannelMessage.Send` | No | post and reply in a channel [B] |

Never requested: `Chat.ReadWrite` (Q-M5), `Chat.Create` (Q-M9), `Presence.*`, `Files.*`/`Sites.*`, `Group.*`, `ChannelMessage.ReadWrite`, `ChatMember.Read`, any Azure Communication Services permission (in-portal calling is not planned), any application permission.

Policy notes:
- A multi-tenant app registered in another tenant and not publisher-verified cannot get user consent for more than sign-in scopes in other tenants [E11]. So, in practice, **each tenant's admin grants consent once** for the permissions listed on the Teams app (H-079, H-080). In PKG the admin is the technical lead (D-62).
- **Scope check of the Teams connect** (differs from mail on purpose; security review to confirm): every requested scope must be granted; a granted scope that was not requested is accepted only if it is on the Teams app's own list (`TEAMS_KNOWN_SCOPES` = the table above plus the OIDC scopes); anything else (a `Mail.*` scope, another resource) refuses the grant. Reason: tenant-wide admin consent covers every permission on the registration [E11], and the token response lists them all, so an exact-set rule would refuse every connect the moment the admin consents one phase ahead. The connection's `features` record only **requested ∩ granted**; the code allows an operation only when the lane's feature AND the connection's feature are both on, and the write client's allow-list and approvals are the gates for sends.
- New scopes need a new `/authorize` round trip [E11]. When a lane gains a feature, people whose connection lacks it see "Reconnect Teams to add <channels | sending | call buttons>"; what they already have keeps working.

## 5. Consent and connect flow (mirrors T-066 / T-257)

**Where:** Settings → Connections → a new section **"Your Teams account"**, shown when `teams.enabled` is true, beside "Your Google accounts" / "Your Microsoft accounts" (which are unchanged). The Messages page shows the same **Sign in to Teams** button in its not-connected state. Both start `/api/connect/teams/start?lane=<laneId>` (slug `teams`, provider `microsoft_teams`). The page says: "This connects your Microsoft Teams account to <company>. It is not your portal sign-in."

**Who:** any member holding `own_mail` (owner, admin_technical, viewer) connects **their own** account (`connectRolesFor("microsoft_teams")` = `MAIL_CONNECT_ROLES`; `core.oauth_state_create` accepts the provider for those roles). Reusing `own_mail` for "own Teams" avoids a role-matrix change (Q-M6).

**Environment** (app-level, so env, not lane_config; read through `requireConnectorEnv`; secrets registered with the redactor and the client-bundle canary):

| Variable | Use |
|---|---|
| `GRAPH_TEAMS_CLIENT_ID`, `GRAPH_TEAMS_CLIENT_SECRET` | the Teams app (H-078). Missing → Settings shows the existing "isn't configured on this server" banner. |
| `GRAPH_TEAMS_REDIRECT_URI` | optional locally (default `http://localhost:3000/api/connect/teams/callback`); elsewhere https, on `NEXT_PUBLIC_APP_URL`'s origin, path exactly `/api/connect/teams/callback` |

**Start** (generic T-035 flow): role and lane checked; `startCheck` refuses unless `teams.enabled`, a supported cloud, `tenant_ids` and `allowed_domains` are present; state + PKCE + nonce bound to user and lane; authority = the lane's one tenant id, or `organizations` when several (never `common`); `response_mode=query`; `prompt=select_account` (dropped when `login_hint` carries the stored UPN on a reconnect, as Microsoft mail does).

**Callback, in order, everything before anything is stored:**
1. Consent errors map to `admin_consent_required` (`consent_required`; `AADSTS65001`, `AADSTS90094` [E11]), reusing `microsoftCallbackErrorReason`.
2. `precheck`: the same settings checks as start.
3. Code exchange at the lane's cloud token endpoint (client secret in the body).
4. Scopes: the Teams rule of 4.4; a refresh token is required.
5. id_token: `tid` in `teams.tenant_ids`, `iss`, `aud` = the Teams client id, `exp`, `nonce` (reuse `checkIdToken`); otherwise `wrong_tenant`.
6. `GET /me?$select=id,userPrincipalName,userType`: a guest (`#EXT#` in the UPN, or `userType` other than Member) is refused (as mail); the UPN domain must be in `teams.allowed_domains` (`account_refused`).
7. Reconnect: the UPN and tenant must equal the stored row's (`wrong_account`).
8. D-23 (`D0023` → "This Teams account is connected to another company"), owner checks, and one Teams connection per person per lane.
9. Store tokens in the Vault; set `tenant_id`, `cloud`, `entra_object_id` once (definer function); record `features`; audit `connection.connected` (ids only).

A grant refused after step 3 is dropped and never stored (the existing `GRANT_NOT_STORED_MESSAGE` path).

**Admin consent message.** When the result is `admin_consent_required`, or the lane enables `channels_read` and the person's connect fails for it, Settings and Messages show a fixed text: "Your organisation's Microsoft admin must approve the portal's Teams app once (Entra admin centre → Enterprise applications → <app name> → Permissions → Grant admin consent)." No link is generated: the v2 admin-consent URL needs a registered redirect URI [E11] and we add no route for it; the admin uses the Entra admin centre, as for H-062 / H-063.

**Tokens:** a Teams token manager built from `microsoft/token-manager.ts` (the same rotation, compare-and-swap, single-flight, `reconnect_required` mapping and no retried refresh POSTs), on the Teams client credentials.

**Disconnect (local, D-55 pattern):** the owner at AAL2 confirms; in one service call: Vault tokens deleted, row `disconnected`, its push subscriptions marked removed with their secrets deleted (no DELETE to Microsoft, D-61 default), its rows in `comms.teams_chat_reads` and `comms.teams_activity` deleted, every open `teams.*` action of the connection invalidated with its text purged; audited. The page tells the person to remove the app at Microsoft ("My Apps"). This is the API terms' "delete data when the user abandons" [E12].

**Health:** `conn.token_health` registers a Teams check (`GET /me`, `$select=id`). Settings shows status, last check, "Live updates until <time> ET" (phase 4) and which features the connection has. Admins see the row's health (status, UPN, last check, error) through the existing `connections` view, never chats.

## 6. Guard and HTTP client (`packages/connectors/src/teams/`)

New folder, beside `microsoft/` (whose files are not changed except to export shared helpers).

- **Guard** (every Graph call, before any token read), from ONE `teamsSettings` read: lane brand → provider `microsoft_teams` → authoritative row, usable → `teams.enabled` → supported cloud → row `tenant_id` in `teams.tenant_ids` → row `cloud` = lane cloud → UPN domain in `allowed_domains` → the feature the operation needs is on in the lane AND on the connection → for user-request reads, **`owner_user_id` = the session user** (checked explicitly: an admin can see the row's health through RLS, so "row visible" is not enough). Returns a branded `GuardedTeamsConnection`, the only thing the token manager accepts.
- **Hosts:** `graph.microsoft.com`, `login.microsoftonline.com` (commercial, as `MICROSOFT_HOSTS`); `gcc_high` empty.
- **Read path allow-list** (exact templates; ids are path parameters, validated and encoded, never concatenated):
  `GET /me`, `GET /me/chats`, `GET /chats/{chatId}`, `GET /chats/{chatId}/members`, `GET /chats/{chatId}/messages`, `GET /chats/{chatId}/messages/{messageId}`, `GET /chats/{chatId}/messages/{messageId}/hostedContents/{hostedId}/$value`, `GET /users/{userId}` (only `$select=userPrincipalName`, feature `call_links`), `GET /me/joinedTeams`, `GET /teams/{teamId}/channels`, `GET /teams/{teamId}/channels/{channelId}/messages`, `GET /teams/{teamId}/channels/{channelId}/messages/{messageId}/replies`, `GET /teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedId}/$value`.
- **Write path allow-list** (separate client, built only by the approvals wiring; lint rule like `createGraphSubscriptionClient`): `POST /chats/{chatId}/messages`, `POST /teams/{teamId}/channels/{channelId}/messages`, `POST /teams/{teamId}/channels/{channelId}/messages/{messageId}/replies`. Only the key `body` with `contentType: "text"` and `content`. `retry: false`. A test enumerates and refuses `PATCH`, `DELETE`, `/setReaction`, `/softDelete`, `POST /chats`, `markChatReadForUser` and anything else.
- **Subscriptions:** the existing subscription client (`/subscriptions`, `/subscriptions/{id}`), with the Teams guard.
- **Id formats:** a chat id is `19:...` [D7]. Validation: chat and channel ids `^19:[A-Za-z0-9._@:-]{1,200}$`; team id and user id a lower-case UUID; message and hosted-content ids `^[A-Za-z0-9._:=@-]{1,256}$` (our own bound; the format is not documented in the fact sheet). In page URLs, chat and channel ids are base64url-encoded.
- **Paging:** a Graph `@odata.nextLink` is never sent to the browser. The server keeps only its `$skiptoken` (validated, bounded) in an opaque cursor, and re-attaches it to the same path on the Graph host; any other host or path is refused.
- **Throttling:** honour `Retry-After` on 429 for GETs (shared client); our own per-connection read bucket of 1 request/s for `/me/chats` (the per-user limit is 1/s [A2]) and per chat 1/s for chat messages; never retry a POST.

## 7. Data model

All in `supabase/core/supabase/migrations`, pgTAP in the same task, production SQL as the next numbered gitignored `manual-migrations` part (33 or later) with a `check-part-N.sql`, guarded, one transaction, refusing a second run.

### 7.1 Changes to existing objects (T-278)

| Object | Change |
|---|---|
| `core.connections` provider check, `core.oauth_states` provider check, `core.webhook_events` provider check, `core.push_subscriptions` provider check | add `microsoft_teams` |
| `connections_owner_only_mail` | owner allowed for `google`, `microsoft`, `microsoft_teams` |
| `connections_identity_only_microsoft` (tenant/cloud only on Microsoft rows) | also `microsoft_teams` |
| `core.connections.entra_object_id uuid` | new; `microsoft_teams` rows only (check); set once by a service-role definer function; immutable (extend `core.connections_identity_immutable`); no column grant to `authenticated` |
| new partial unique index `connections_one_teams_per_owner` | `(lane_id, owner_user_id) where provider = 'microsoft_teams' and status not in ('disconnected','pending')` |
| `core.teams_connection_ids(p_uid, p_lane)` | new definer function, the one place "my Teams connections" is written (as `core.mailbox_ids`): owner = p_uid, provider `microsoft_teams`, lane in `allowed_lanes(p_uid, 'own_mail')`, `core.may_resolve(p_uid)` |
| `core.mailbox_ids` and every mail/calendar reader | **unchanged**: they keep `provider in ('google','microsoft')`, so a Teams row is never a mailbox (pgTAP asserts it) |
| RLS on `core.connections` | unchanged (own rows through `owner_user_id` + `own_mail`; the `connections` view reads the lane's rows through the existing column grants). Enforced and tested (pgTAP 328): an admin (owner, admin_technical) reads these columns of another person's Teams row: `id, lane_id, provider, external_account_id` (the UPN), `status, features, features_checked_at, token_expires_at, last_sync_at, last_error, owner_user_id, tenant_id, cloud, created_at, updated_at, transport, toolkit, account_identity`, as for mail rows; never `entra_object_id`, `created_by`, `reconnect_notified_at`, `last_error_stream`, a token or a chat. A viewer cannot read another person's Teams row at all. |

### 7.2 `comms.teams_chat_reads` (T-282): the portal's own read marker

| Column | Notes |
|---|---|
| `lane_id text not null` | FK to lanes; composite FK `(connection_id, lane_id)` to the connection |
| `connection_id uuid not null` | a `microsoft_teams` connection (trigger) |
| `chat_id text not null` | Graph chat id, pattern of section 6, at most 200 characters |
| `read_through timestamptz not null` | the `createdDateTime` of the newest message the person was shown when they opened the chat in the portal (Microsoft's clock, not ours) |
| `updated_at timestamptz not null default now()` | |

Primary key `(connection_id, chat_id)`. **Nothing else:** no topic, member, preview, message id or sender. At most 1,000 rows per connection (the upsert function deletes the oldest). RLS select: `connection_id = any (core.teams_connection_ids(auth.uid(), lane_id))` at AAL2; no table write grants; writes through `comms.teams_chat_read_mark(p_lane, p_connection, p_chat, p_read_through)` (definer, caller must own the connection, `read_through` only moves forward, not more than 5 minutes ahead of `now()`). Retention: rows not updated for 90 days purged (T-042 registry, class "policy"). Deleted on disconnect.

### 7.3 `comms.teams_activity` (T-289): new-message notices, per connection

| Column | Notes |
|---|---|
| `lane_id text not null`, `connection_id uuid not null` | primary key `connection_id`; composite FK as above |
| `last_notice_at timestamptz` | time OUR receiver accepted the latest valid `created` notification of the connection |
| `notices_since_seen int not null default 0` | incremented per accepted notification, capped at 999 |
| `last_seen_at timestamptz` | when the owner last loaded the chat list on Messages |
| `updated_at timestamptz` | |

No chat id, message id or sender: the receiver never reads `resource` (section 9). RLS: owner only (as 7.2). Writers: `comms.teams_activity_notice(p_lane, p_connection)` (service role, used by the job) and `comms.teams_activity_seen(p_lane, p_connection)` (owner). Deleted on disconnect; a paused lane's row stays until the connection is disconnected or purged.

### 7.4 `core.push_subscriptions` (T-289)

`resource` check gains `teams_chats`. One live row per connection and resource (the existing index fits: one all-chats subscription per Teams connection). `resource_path` = `users/<entra_object_id>/chats/getAllMessages` (fits the existing pattern). No channel resource (section 9.3).

### 7.5 Approvals (T-286)

`act.proposed_actions` gains types and rules, no new table (section 10). The text is held in `payload` only while the action is open; `act.purge_content` empties it in the same statement as every terminal transition (as for email, D-19).

### 7.6 pgTAP list

`3xx_teams_connections` (provider in every check, owner and identity rules, `entra_object_id` set-once and hidden, one Teams connection per owner per lane, D-23 across lanes, `teams_connection_ids` fail-closed without AAL2, Teams rows absent from `mailbox_ids`), `3xx_teams_chat_reads` (owner-only select, cross-lane and cross-user denial, admin sees nothing, forward-only marker, row cap, purge on disconnect), `3xx_teams_activity` (same, plus the service-only notice writer), `3xx_push_subscriptions_teams` (resource value, Teams provider, cross-lane), `3xx_approvals_teams` (section 10.6).

## 8. Connector interface (read side)

`TeamsReader` (all calls `(laneId, guardedConnection, …)`; every result is a strict Zod-parsed projection; anything not projected is dropped in memory):

| Method | Graph | Returns (never stored) |
|---|---|---|
| `listChats({ cursor? })` | `GET /me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50` [A1] | per chat: `chatId`, `chatType`, `topic`, `webUrl` (host-checked), members (≤ 25 per chat [A1]: `userId`, `displayName`, `tenantId`, external = `tenantId` ≠ the connection's tenant), preview (`createdDateTime`, sender id and name, text converted and cut to 160 characters), `viewpoint.lastMessageReadDateTime`, `viewpoint.isHidden`; plus an opaque cursor |
| `listMembers(chatId)` | `GET /chats/{id}/members` | as above, all members |
| `listMessages(chatId, { before?, sinceModified?, cursor? })` | `GET /chats/{id}/messages?$top=30&$orderby=createdDateTime desc` (page back with `createdDateTime lt`); new-since with `$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt <t>` (a date range, as the terms ask [A3]) | per message: `id`, `createdDateTime`, `lastModifiedDateTime`, `deletedDateTime`, `messageType`, sender (`user.id`, `displayName`, own = id equals `entra_object_id`), body as converted nodes (8.4), attachment stubs (name, kind, https link), hosted-content ids |
| `hostedContent(chatId, messageId, hostedId)` | `.../hostedContents/{id}/$value` [A1] | bytes for the proxy (8.5) |
| `resolveCallTargets(chatId)` | members, then `GET /users/{id}?$select=userPrincipalName` per same-tenant member except self (feature `call_links`) [C] | UPNs, in memory only |
| `listTeams()`, `listChannels(teamId)` | `GET /me/joinedTeams`, `GET /teams/{id}/channels` [B] | ids, names, `membershipType`, `webUrl` |
| `listChannelPosts(teamId, channelId, { cursor? })`, `listReplies(...)` | [B]; `$top=20` posts, `$expand=replies` not used (replies fetched when a post is opened, `$top=50`) | as messages |

Notes:
- The combined `$expand=members,lastMessagePreview` is listed as allowed [A1] but whether both can be combined in one request is not shown; H-081 checks it. If Graph refuses it, the reader requests `lastMessagePreview` only and fetches members for the visible chats in parallel (at most 20, at the per-user rate).
- System events are not requested (no `Prefer: include-unknown-enum-members` [A1]), so they are not shown. If one arrives anyway (any `messageType` other than `message`), the page does not draw it (T-281 review C4); it still counts for paging and for the read marker, and a system event as the newest preview never makes a chat unread.
- `lastUpdatedDateTime` of a chat is NOT the last message time [A1]; ordering and unread use `lastMessagePreview.createdDateTime`.
- Nothing returned by these methods is written to the database, logs, audit, Inngest events, Sentry breadcrumbs or caches outside the one request (a DB-write and logger spy test with a canary, as for Gmail bodies).

### 8.1 Unread state (chats)

A chat is **unread** when `lastMessagePreview.createdDateTime` > max(`viewpoint.lastMessageReadDateTime`, the portal's `read_through` for that chat) and the preview's sender is not the person [A1]. Opening a chat in the portal sets `read_through` to its newest shown message's `createdDateTime`. Teams' own read state is not changed (Q-M5), so Teams may still show it unread. Hidden chats (`viewpoint.isHidden`) are not listed.

### 8.2 Channels

No per-user read state or "mark read" exists for channels [B], so channels show no unread marker. Only channels the person can see are listed [B]; teams come from `joinedTeams` (shared-channel host teams are not returned [B]; out of scope).

### 8.3 Attachments, mentions, external members

- File attachments are SharePoint/OneDrive links [A1]. The portal shows the file name (as text) and an "Open" link (https only) that the browser opens in a new tab with the person's own Microsoft session. **The portal never fetches a file with its own token** (no Files/Sites scope).
- Cards and other attachment types: "Card: open in Teams".
- Mentions (`<at>`) become plain "@Name" text; they never link or resolve anything.
- External members (another `tenantId` [A1]) are labelled "External"; guests likewise. They get no Call button (their UPN is not resolvable, section 13).

### 8.4 HTML to safe nodes (rule 9)

Message bodies are mostly HTML. The server converts them into a small typed node list: text, line break, paragraph, bold, italic, underline, strike, code, code block, quote, list and item, link (https only, no credentials, shown with its host; `rel="noopener noreferrer nofollow"`, new tab), mention (text), emoji (its alt text), image placeholder (every picture becomes a neutral placeholder except a tracking pixel of 3 px or less; no image address is read or emitted), table cells flattened to text. Everything else (script, style, iframe, object, form, svg, event attributes, `javascript:`/`data:` links, CSS) is dropped. React renders the nodes; **no raw HTML reaches the browser** (no `dangerouslySetInnerHTML`). The text is cut at 20,000 characters per message. Unit tests feed a hostile-HTML corpus.

### 8.5 Inline images (T-285; built)

A server route `GET /api/lanes/<lane>/messages/image` (`?chat=<key>&message=<id>&hosted=<id>`, or `?team=<id>&channel=<key>&message=<id>&hosted=<id>`; no other parameter) streams `hostedContents/{id}/$value` [A1] for a (chat or channel, message, hosted id) that the guard and an ownership check allow. The converter hands over only a hosted-content id, and only when the `<img src>` is exactly the documented Graph address of a hosted content of the same message; no URL from message content is ever fetched. The type is decided from the first bytes (`image/png|jpeg|gif|webp`; SVG and everything else refused), at most 4 MB plus a small margin [A2], enforced while streaming; headers `Cache-Control: private, no-store`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`; never stored or logged. Pictures have their own two slots per connection and their own 1-per-second bucket per chat or channel, wait at most 5 seconds for both together (then `429`), and stop when the browser closes the request. The page shows a failed picture as a "tap to load" button. Pictures in channel replies stay placeholders (no reply template in the fact sheet).

## 9. New-message notices without polling (phase 4)

### 9.1 Subscription

One subscription per Teams connection: resource `/users/{entra_object_id}/chats/getAllMessages` (delegated, `Chat.Read` [A3]), `changeType: "created"` only (so a reaction or edit, which fires `updated` [A3], is not a notice), **no `includeResourceData`** (ids only, no certificate needed [A3]), `notificationUrl` and `lifecycleNotificationUrl` both `GRAPH_NOTIFICATION_URL` (lifecycle URL required beyond 1 hour [A3]; same receiver as mail), `clientState` a random Vault secret per subscription (T-068).

- **Not confirmed:** the delegated `/users/{id}/chats/getAllMessages` subscription without resource data [A3]. H-083 tests it. If Microsoft refuses it, notices are off for that connection (logged `teams.subscription.unsupported`, Settings shows "Live updates unavailable"). There is **no per-chat fallback**: only one subscription per app and chat is allowed [A3], so two portal users in the same chat would block each other.
- **Lifetime:** we ask for 4,200 minutes (just under the documented 4,320 [A3]) and record Microsoft's answer. One page says 60 minutes (not confirmed). If Microsoft answers with less than 26 hours, the 12-hourly renewal scan cannot keep it alive: the subscription is stopped, the connection stays on "refresh on open", and this is logged (`teams.subscription.lifetime_too_short`). Renewal: within 24 hours of expiry, by the existing `conn.subscriptions_renew` scan (T-040, T-264), which now also lists usable `microsoft_teams` connections of lanes where `teams.enabled` and `chat_read` are on.
- Lifecycle `reauthorizationRequired` → renew; `subscriptionRemoved` → recreate (both exist for chat messages [A3]); `missed` is not sent for Teams [A3]. Messages lost while delivery was paused are not fetched by a job; the next page open shows them.
- Quotas: 10 all-chats subscriptions per user, 10,000 per organisation [A3]; we use one per person.

### 9.2 Receiver and job

The receiver (`POST /api/webhooks/microsoft`) is **unchanged in logic**: validation echo, `clientState` constant-time check, dedupe, lane and connection from the stored subscription row, `resource` and `resourceData` never read. For a row whose `resource` is `teams_chats` its existing rule yields the event type `teams_chats.changed`. A new Inngest function `teams-activity` (on `webhook/received` with that type) calls `comms.teams_activity_notice` for the connection. **No Graph call, no content.** `microsoft-webhook-sync` skips the event (it is not `microsoft`), and a test proves it.

### 9.3 Channels: no notices

Delegated channel subscriptions are one per channel, and only one per app and channel is allowed [B, A3], which one portal user would hold for everyone else in that channel. No delegated "all my channels" resource exists [B]. So channels have no notices and no unread marker; they are fetched when opened or refreshed (Q-M7).

### 9.4 What the person sees

- **Nav dot:** Messages (side menu and the More list on iPhone) shows a dot when `last_notice_at > last_seen_at`. It is fetched **client-side after the shell renders** from `/api/lanes/<lane>/messages/activity` (DB only, no Graph call), so no page gains a sequential level (T-276). A count is not shown: without reading `resource` or each message the count would include the person's own messages sent from Teams (Q-M4).
- **While Messages is open and visible:** the page asks the same DB-only endpoint every 30 seconds (paused when the tab is hidden). When `last_notice_at` moves, it refetches the chat list and the open conversation from Graph, the conversation with the `lastModifiedDateTime` date-range filter (8). Graph is called only because a notification arrived or because the person acted (open, Refresh, focus at most once a minute). Polling our own database is not polling Microsoft [A3].
- Without a configured `GRAPH_NOTIFICATION_URL` (local, preview), there is no dot, and the page offers Refresh.

## 10. Sending through approvals (phase 3; D-65)

### 10.1 Action types

| Type | Target (non-secret, hashed) | Feature | Lane policy class |
|---|---|---|---|
| `teams.chat.send` | `{ chat_id, client_request_id }` | `chat_send` | `teams_send` |
| `teams.channel.post` | `{ team_id, channel_id, client_request_id }` | `channels_send` | `teams_send` |
| `teams.channel.reply` | `{ team_id, channel_id, reply_to_id, client_request_id }` | `channels_send` | `teams_send` |

Payload: `{ content_type: "text", text }`. `text`: 1 – 10,000 characters after trimming, NFC-normalised, at most 80 KB as UTF-8 (Microsoft recommends a message under 80 KB [A2]), no control characters except newline and tab. No HTML, mentions, images or attachments. A "reply" in a chat is simply a message in that chat.

The hash is the existing JCS SHA-256 of `{lane_id, action_type, connection_id, target, payload, payload_schema_version}`.

### 10.2 SQL (T-286)

- `act.is_allowed_type` adds the three types; `lane_policies.write_actions_allowed` check adds `teams_send`; `act.type_allowed` maps all three to `teams_send`.
- `act.write_roles(teams.*)` = owner, admin_technical (the email rule; D-68 asks whether viewers may send their own). The real gate is ownership: the connection must be owned by the proposer and the approver (as T-247 for email), checked in `act.insert_proposal`, `act.approve`, `act.reject` and re-checked in `act.claim_execution`.
- `act.connection_ok`: provider `microsoft_teams`, status `active|degraded`, feature `teams_chat_send` (chat type) or `teams_channels_send` (channel types).
- Visibility: a `teams.*` action, its history and claim rows are visible only to the owner of its connection (extend `act.action_rows_visible` and the `proposed_actions_select` policy with `core.teams_connection_ids`). An admin sees `core.action_index` counts only.
- Content: `teams.*` proposals need `lane_policies.store_outbound_drafts` (D-19 (a): composed outbound text only while the action is open; Q-M2 confirms that it covers Teams). `act.purge_content` empties `payload.text` at every terminal transition in the same statement, and also on supersede, keeping target, hash, type and timestamps.
- Step-up: `act.approve` reads `approvals.teams_step_up_max_age_s` for `teams.*` (D-67), and `step_up_max_age_s` for every other type, unchanged.
- One send per composed message: a unique index on `(connection_id, (target->>'client_request_id'))` for `teams.*` types; a repeated request with the same id returns the existing action instead of creating a second one.
- `approvals_live` stays the gate (approve, claim, execute), as for email. Expiry for `teams.*`: 1 hour (`approvals.expire_after_hours`), since a Teams action is approved at once.

### 10.3 One user step (`sendTeamsMessage`, `packages/modules/approvals`)

Route `POST /api/lanes/<lane>/messages/send` with `{ connectionId, target (chat key, or team/channel/post), text, textSha256, clientRequestId, aiDrafted }`:
1. Session at AAL2; `requireStepUp(teams max age)`; the lane module visible; the caller owns the connection; `teams.enabled` and the feature; lane policy `teams_send`; `approvals_live` (a refusal names which gate is off).
2. The server normalises the text and checks `textSha256` (computed by the browser from the exact text shown in the composer) against it, so the bytes approved are the bytes the person typed.
3. `proposeTeamsAction` (`proposerKind: "user"`, `derivedFromRetrieved: aiDrafted`), then `approveAction` with the hash just computed, in the same request: **pressing Send is the approval** of that exact text, recorded in `act.status_history` and the audit (ids, type, hash; never text).
4. Claim (single), then the Teams writer executes once, verifies (10.4) and marks the action `verified` or `failed`, with the text purged.

It is inline, like email (no Inngest hop). The response is the final state or `sent_unverified`.

AI-drafted text (only if D-69 says yes) is placed in the composer and never becomes a proposal by itself. It is sent only when the person presses Send, and then it is marked `derived_from_retrieved`.

### 10.4 Execute, verify, failure states (Teams writer, `@nichols/connectors/write`)

- **Before the POST:** the guard runs; `prepare` re-checks lane, connection brand, provider, action lane/connection, approver = owner, payload hash (constant time), feature, target pattern, and the open claim.
- **POST once**, `{"body":{"contentType":"text","content":<text>}}` [A2], `retry: false`. Sends are not idempotent at Microsoft (no dedupe header; a retry after a timeout can post twice [A2]).

| Outcome of the POST | Result |
|---|---|
| 201 with a message id | read back `GET .../messages/{id}`: sender `user.id` = `entra_object_id`, same chat/channel (and reply parent), created after the claim, and the body converted to plain text and normalised equals the approved text → `verified` (claim `verified`, `result = {message_id, created_at}`). Text differs → `failed` / `verification_mismatch` ("Sent, but Teams shows different text; check the chat"). How Teams returns a text post (`text` or `html`) is not stated in the fact sheet, so the normaliser handles both; H-082 records what Teams returns. |
| 201, read-back not possible yet (404, timeout) | claim `sent` with the id; `sent_unverified`; the reconcile sweep reads it back by id |
| 400, 403, 404, 413 | `failed`, nothing sent; fixed message per code (403: "You are not a member of this chat or channel, or sending is not allowed") |
| 429 | `failed` / `throttled`, nothing sent; **not retried automatically**. The person may press Send again, which makes a new action. |
| timeout, network error, 5xx (unknown outcome) | **no retry.** Look up the conversation: `GET .../messages?$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt <claim time − 2 min>&$top=50` (for a channel reply, the replies of the post). Exactly one message from the person whose normalised text equals the approved text → `verified` (`already_applied`); two or more → `failed` / `ambiguous_match` (`outcome_unknown`); none → stays `executing` for the sweep. |

- **Reconcile** (`action.reconcile_stuck`, T-192): a `TeamsMessageReconciler` (find + verify only, no execute) runs the same lookup while the action is `executing` (the text is still held). At `reconcile_give_up_minutes` it ends in `failed` / `outcome_unknown`, and the page says "Outcome unknown: check the chat in Teams before sending again". Never a blind resend.
- There is no hidden marker: a chat message has no property the portal can set. So the lookup can match a message with the same text that the person typed in Teams within the window. Accepted; listed in risks.
- Every transition purges the text (10.2) and audits ids, type, hash and codes.

### 10.5 What the person sees

The composer is plain text with a "Send" button and the line "Send posts this exact text to Teams as you (logged)." On desktop Ctrl/Cmd+Enter sends and Enter is a newline; on a phone only the button sends (an accidental Enter must not be an approval). The bubble states: Sending… → Sent (verified) / Sent, checking… / Not sent (reason; the text stays in the composer) / Outcome unknown (check Teams). The text stays in the browser only. Approvals → History lists Teams sends as "Teams message" with chat or channel name looked up live, never the text.

### 10.6 pgTAP and tests

pgTAP: types allowed only with `teams_send`; a viewer and a non-owner cannot propose or approve; cross-lane connection refused; a Google or `microsoft` connection refused for `teams.*`; text purged on every terminal state and on supersede; duplicate `client_request_id` refused; `approvals_live` false refuses approve and claim; the step-up age per type. Vitest with MSW: each row of the table in 10.4, double-click (one action, one POST), a hash mismatch between the browser and the server, AI-drafted flag stored, sweep give-up.

## 11. The Messages page and phone layout

Route `/[laneId]/messages` with search params `?chat=<b64url>` or `?tab=channels&team=<id>&channel=<b64url>[&post=<id>][&more=<cursor>]` (the Channels tab is `?tab=channels`). Module `messages` (`requireModule`). Gates: lane check, `teams.enabled`, the caller's own Teams connection.

**Desktop:** two panes. Left: tabs **Chats** and **Channels** (the bar is drawn only when the lane lists `channels_read`; a direct `?tab=channels` address for another company shows "Channels are not switched on for this company" with a link back). Channels: teams, the open team's channels (shared ones open in Teams and are not read), then the posts of the open channel (Graph's order, with the date and time of each post, "Posts with the newest replies come first.") and the replies of the open post. Chats list rows: avatar initials, title (topic, or the other members' names, "+n"), preview line (text, 1 line), time (ET), unread dot, "External" label when any member is external. Right: the conversation, newest at the bottom, "Load earlier", day separators, sender names in group chats, "Edited" / "This message was deleted" markers, attachment stubs, image placeholders or proxied images. Header: title, member count, **Call**, **Video call** (section 13), **Open in Teams**, Refresh. Composer at the bottom (phase 3).

**Phone (iPhone width first):** the list fills the screen; tapping a chat opens it full screen with a back arrow; the composer is sticky above the keyboard with safe-area padding; the header keeps Call / Video / Open in Teams as icons. Messages is in the More tab (T-271), with the dot.

**States** (each with a fixed text, none shows an empty list on an error):

| State | Shown |
|---|---|
| Teams not enabled for this company | "Teams is not set up for <company>." (no button) |
| Not connected | "Sign in to Teams" button and one line on what is shown and that nothing is stored |
| Needs reconnect | "Your Teams sign-in expired. Reconnect Teams." button |
| Feature missing on the connection | "Reconnect Teams to add channels / sending / call buttons." (what exists keeps working) |
| Needs admin consent (channels or the whole app) | the admin text of section 5; chats still work if only channels need it |
| Paused | "Teams is paused for this company." |
| Could not load | "Teams could not be reached. Try again." with Retry; on 429 "Teams is busy; try again in N seconds" |
| Approvals not live / sending not enabled | the composer is replaced by "Sending is not enabled for this company yet" (names the gate for owner/admin) |

**Settings → Connections:** "Your Teams account" (own row: UPN, status, features, live updates until …, Sign in / Reconnect / Disconnect), beside the mail sections. Admins see other people's Teams rows as health only.

**Performance (T-276):** the page shell (header, tabs, skeleton) renders at once. Level 1 starts in parallel: the lane gate, `teamsSettings`, the caller's Teams connection row (shared request-scoped reads, no repeated lane_config read). Level 2: the chat list and, when the URL names a chat, its messages are **started together** (not list then conversation), each in its own Suspense section. Members' UPNs are resolved only when Call is pressed. No Graph call runs during a link prefetch (Graph reads live only in dynamic sections; a test asserts that a prefetch makes none). The nav dot is client-side (9.4). No other page gains a database or Graph call.

## 12. Jobs

| Job | Change |
|---|---|
| `conn.subscriptions_renew` (T-040/T-264) | also lists usable `microsoft_teams` connections of lanes with `teams.enabled` + `chat_read`; Teams renewer (create, renew within 24 h, recreate, stop when paused; lifetime rule of 9.1) |
| `teams-activity` (new) | on `webhook/received` type `teams_chats.changed`: `comms.teams_activity_notice`; no Graph call |
| `conn.token_health` | Teams health check registered |
| `retention.purge` | `comms.teams_chat_reads` (90 days unchanged rows) registered; `teams_activity` is deleted with the connection |
| `action.reconcile_stuck` | `TeamsMessageReconciler` for `teams.*` |
| none | **no polling job** for chats or channels |

## 13. Calling: buttons that open Teams (phase 2; T-284; D-63 revised)

The call itself always happens in Teams; the portal only opens Teams with the people selected. Calling inside the portal is not planned (section 2). Graph cannot place a call as a user [D6]. The buttons use deep links [D7]:
- **Call:** `https://teams.microsoft.com/l/call/0/0?users=<upn>[,<upn>...]`; **Video call:** the same plus `&withVideo=true`. Teams asks for confirmation before it calls [D7].
- Pressing the button calls `POST /api/lanes/<lane>/messages/call-link` `{chatKey, video}`. The server resolves the chat's members to UPNs (`call_links` feature, `User.ReadBasic.All` [C]) for same-tenant members other than the person, builds the URL and returns it. The browser opens it in a new tab. Nothing is stored or logged; opening a link is navigation, not a write.
- Shown only when every other member is in the person's tenant and there are at most 10 of them (our own cap: the maximum users in a deep link is not confirmed). Otherwise only **Open in Teams** is shown: the chat's `webUrl` (host `teams.microsoft.com`) or `https://teams.microsoft.com/l/chat/<chatId>/conversations` [D7].
- Channels: **Open in Teams** only (the post's `webUrl` or the channel-message deep link [D7]).
- `https://` links are used (they work with or without the installed client, via the browser page [D7]); `msteams:` is not used. Behaviour from the iPhone home-screen app is not documented [F3] and is part of H-081.
- "New chat in Teams" for someone with no existing chat needs a people picker, so it is not built; the page shows "Open Teams" instead (Q-M9).

## 14. Security notes

- **Untrusted HTML:** the server-side node converter (8.4); no raw HTML; links https only, opened in a new tab, never followed or fetched by the server; external images never loaded (no tracking pixels); text never reaches a prompt except through D-69's user-initiated draft, wrapped as untrusted.
- **Attachments** are links the person's browser opens with their own Microsoft session; the portal never reads a file (no Files/Sites scope) [A1].
- **Mentions** are text only; they never resolve to a portal user, change permissions or trigger anything.
- **External and guest members** [A1] are labelled; no call link; their names are shown as given (untrusted).
- **Cross-tenant shared channels:** not listed (joined teams only). The portal builds paths from ids and never follows an `@odata.id` (the known `/tenants/{id}` issue [B]). Reading them delegated is not confirmed.
- **Token scope:** a Teams token can read the person's chats and post as them. The write client's three templates, the feature gates, `approvals_live`, the lane policy and the owner checks are the guards; the read client cannot build a write.
- **Privacy:** every read checks `owner_user_id` = the session user; RLS on the two tables is owner-only; admins see health only; nothing about a chat is in audit rows or logs (ids, counts, codes only).
- **Rate abuse:** the activity endpoint is DB-only and rate-limited per user; the send route is limited to 1 request per second per connection (the per-user POST limit [A2]).
- **Teams as a log file** [A2]: only text the person typed and sent; no system posts, no automated messages.
- **Review depth:** every task in this phase is app code (connectors/tokens, RLS, approvals): full security + code review, fix all BLOCKER and HIGH.

## 15. GCC High (out until T-267 and a Teams follow-up)

What differs [E10]: a separate app registration in that cloud and its own env group (`GRAPH_TEAMS_USGOV_*`); hosts `graph.microsoft.us` and `login.microsoftonline.us`; no publisher verification; list chats does not support `$orderby`, so the reader would sort pages itself; shared channels unsupported for channel APIs; Teams client host `gov.teams.microsoft.us` for the call and chat deep links. Plain GCC uses the commercial endpoints [E10], so chats, channels and the call buttons work there as specified. `teams.cloud = "gcc_high"` is refused by the guard until that work is planned.

## 16. Edge cases

- PKG person with a Google mailbox and a Teams account at the same address: two connections (`google`, `microsoft_teams`); no conflict; Google untouched.
- NC person with a Microsoft mailbox signs in to Teams with the same account: a second row (`microsoft_teams`); mail Reconnect is unaffected (dedicated app).
- The Teams account is already connected in another lane → refused (D-23).
- A second Teams account for the same person in the lane → refused with a fixed message.
- UPN on a domain not in `teams.allowed_domains`, or a guest → refused, nothing stored.
- Admin consent not given and the tenant blocks user consent → `admin_consent_required` text.
- The lane adds `channels_read` after people connected → chats keep working; "Reconnect Teams to add channels".
- A feature removed or `teams.enabled` false → calls refused, subscriptions stopped locally, composer hidden, data kept until disconnect or purge.
- Membership removed from the lane → `teams_connection_ids` returns nothing; reads stop; the renewal scan stops subscriptions of connections whose owner lost `own_mail`.
- A notification for a disconnected connection → dropped (T-068 rule).
- A message the person sent from Teams → raises the nav dot (accepted, Q-M4); the list does not show it unread (sender is self).
- The same text sent twice on purpose → two different `client_request_id`s, two actions, two messages.
- Double-click / network retry of one Send → one action, one POST.
- Send times out and the text matches a message the person also typed in Teams in the window → verified against that message (accepted risk).
- A deleted message → "This message was deleted"; an edited one → "Edited" with the new text.
- A chat with more than 25 members → names from the first 25 + "and others" [A1].
- Graph 429 on list → "Teams is busy" with the `Retry-After` seconds; never an empty list.
- iPhone: a chat with external members shows only Open in Teams.

## 17. Acceptance tests (Given / When / Then)

All with MSW fakes of Entra and Graph and synthetic data. Every SQL test includes cross-lane and cross-user denial.

1. **Teams in a Google-mail lane.** Given lane A with `mail.providers = ["google"]` and `teams = {enabled, tenant_ids:[T], allowed_domains:[d]}`, when a viewer signs in to Teams as `u@d` in tenant T, then one `microsoft_teams` row exists, owned by them, with `tenant_id`, `cloud`, `entra_object_id`, tokens only in the Vault; the lane's Google rows, sync and Settings section are unchanged; no mail or calendar job lists the new row.
2. **Same account, mail and Teams.** Given lane B with a usable `microsoft` mail row for `x@e`, when the owner signs in to Teams as `x@e`, then a second row (`microsoft_teams`) is created and a later mail Reconnect still succeeds.
3. **One lane per Teams account.** Given `u@d` connected for Teams in lane A, when it is connected in lane C, then `D0023` → "connected to another company", nothing stored.
4. **Scope rule.** Given the lane requests `chat_read` and the token lists `Chat.Read ChannelMessage.Read.All`, then the connect succeeds with `teams_channels_read = false`; given it lists `Mail.Read`, then it is refused.
5. **Wrong tenant / guest / domain.** Each is refused with its fixed result; nothing stored.
6. **Privacy.** Given Robert (owner) and Saurabh (admin_technical) each with a Teams connection in lane A, when each opens Messages, then each sees only their own chats; Saurabh sees Robert's row on Settings as health only; a direct request by Saurabh with Robert's connection id is refused before any Graph call.
7. **List and unread.** Given 3 fake chats, one with a preview newer than `lastMessageReadDateTime` from another user, one whose newest preview is from the person, one hidden, then 2 chats are listed and exactly one has the unread dot; after opening it, the dot is gone and `comms.teams_chat_reads` holds only `(connection, chat_id, read_through)`.
8. **Nothing stored.** Given a canary string in a preview, a message body, a chat topic and a member name, when the list and a conversation are loaded and a send is verified, then the canary appears in no table, log line, audit row, Inngest event or error.
9. **Hostile HTML.** Given a message with `<script>`, `<img src=https://tracker>`, `onerror=`, a `javascript:` link and an `<at>` mention, then the rendered output has none of them, shows "@Name" as text and the link only if https.
10. **Send = approval.** Given a connection with `chat_send`, policy `teams_send`, `approvals_live` and a fresh step-up, when the person presses Send, then exactly one POST is made, the action is `verified`, status history shows proposed → approved → executing → verified by that person, and `payload.text` is empty.
11. **Double click.** Given two requests with the same `clientRequestId`, then one action and one POST.
12. **Unknown outcome.** Given the POST times out after Graph accepted it, when the lookup finds one matching own message, then `verified` (`already_applied`) and no second POST; given none, then `executing`, and at give-up `failed` / `outcome_unknown`.
13. **Gates.** With `approvals_live` false, or without `teams_send`, or a connection without `teams_chat_send`, or a step-up older than the Teams window, then the send is refused before any Graph call, and the composer says which gate is off.
14. **Notices.** Given `GRAPH_NOTIFICATION_URL` and a Teams connection, when the renewal scan runs, then one subscription for `users/<oid>/chats/getAllMessages` with `changeType=created` and no `includeResourceData` is recorded; when a valid notification arrives, then `last_notice_at` moves, no Graph call is made, and the Messages dot shows; after the person opens Messages, it is gone.
15. **Lifetime too short.** Given Graph answers an expiry 60 minutes ahead, then the subscription is stopped and logged, and the page offers Refresh.
16. **Call link.** Given a 1:1 chat with a same-tenant member, when Call is pressed, then the returned URL is `https://teams.microsoft.com/l/call/0/0?users=<upn>`; Video adds `&withVideo=true`; given an external member, then only Open in Teams is shown.
17. **Channels.** Given `channels_read` and a connection that has it, then joined teams, their channels and root posts with replies are shown with no unread marker; given a connection without it, then "Reconnect Teams to add channels" and chats still work.
18. **Channel reply.** Given `channels_send`, when the person replies to a post, then one POST to `.../messages/{id}/replies` and `verified`; a 403 → "not a member", nothing retried.
19. **Disconnect.** When the owner disconnects, then the Vault holds no token, the subscription row is removed with its secret, `teams_chat_reads` and `teams_activity` rows of that connection are gone, and an open Teams action is invalidated with its text purged.
20. **Prefetch.** When the Messages link is prefetched, then no Graph request is made.
21. **Phone.** Render tests at iPhone width: list, open conversation with back, sticky composer, More with the dot.

## 18. Open questions (Q-M1 …)

- **Q-M1 (D-66):** separate Teams connection on a dedicated Entra app (recommended), or one app with the scope check relaxed for both purposes? Blocks T-278.
- **Q-M2:** does D-19 (a) (composed outbound text kept only while the action is open, gated by `store_outbound_drafts`) cover Teams messages too? Default yes.
- **Q-M3 (D-67):** step-up for Teams sends: (a) a fresh authenticator code within 5 minutes, as email; (b) recommended: at most once per 8 hours for `teams.*` (`approvals.teams_step_up_max_age_s`, 300 to 43,200); (c) AAL2 sign-in only. Blocks T-288.
- **Q-M4:** the Messages nav shows a dot (built), or a count (needs reading each notified message and its sender in a job)?
- **Q-M5:** mark chats read in Teams when opened in the portal? Needs `Chat.ReadWrite` (replaces `Chat.Read` and `ChatMessage.Send`, broader) and it is an external write. Default no: portal-only marker.
- **Q-M6:** reuse the `own_mail` view for "own Teams" (built) or add an `own_messages` view?
- **Q-M7:** channel notices are not possible per person (one subscription per app per channel). Accept "fetch on open" for channels? Default yes.
- **Q-M8:** phone push for new Teams messages (a later task on the T-161 notifications path, text-free "New Teams message")?
- **Q-M9:** start new chats from the portal (needs `Chat.Create` and a people search with `User.ReadBasic.All`)? Default: no; "Open Teams".
- **Q-M10:** one Teams account per person per lane (built), or several?
- **Q-M11 (D-68):** may a viewer send from their own Teams connection? Default: owner and admin_technical only (as email).
- **Q-M12 (owner):** later, the reverse direction: the portal as a personal tab app inside Teams [F3]? Not planned; no task.
- **Q-M13 (D-69):** may the assistant draft Teams replies (chat text sent to the model; a new `teams` category in `lane_policies.llm_allowed_categories`)?
- **Q-M14:** enable Teams in `NC` too (H-080), or PKG only first?

## 19. Human setup items (backlog "Needs human")

H-078 (Teams app registration), H-079 (PKG tenant consent), H-080 (NC, optional), H-081 (production SQL, PKG switch-on and first live check of chats and call buttons), H-082 (sending), H-083 (notifications), H-084 (channels). Exact steps are in `docs/backlog.md`. No human item exists for in-portal calling (not planned).

## 20. Risks

- The all-chats delegated subscription and its lifetime are not confirmed: notices may be unavailable (the page still works with Refresh).
- No idempotency at Microsoft: a timeout can leave an unknown outcome, settled by lookup or by the person checking Teams; a text-equal message typed in Teams in the same window can be taken as ours.
- The tolerant Teams scope rule is new and deliberately different from mail; it needs the security review's agreement.
- Unverified multi-tenant app: every tenant needs its admin once; tenant policy can block users.
- `$expand=members,lastMessagePreview` combined, the read-back body form, the iPhone behaviour of deep links: live checks.
- Graph's per-app-per-tenant limit of 20 requests/s for chat messages [A2] is shared by everyone in the tenant using the portal; fine for a small team, watch later.
- GCC migration (D-48): chats, channels and call buttons keep working in plain GCC; GCC High needs new registrations (section 15).
- HTML conversion bugs are an XSS risk: a hostile corpus test and the no-raw-HTML rule.

## 21. Sub-tasks

See `docs/backlog.md`, Phase B11 (T-278 – T-293). Every task is app code (connectors/tokens, RLS/data access, approvals): full security + code review, fix all BLOCKER and HIGH before done.
