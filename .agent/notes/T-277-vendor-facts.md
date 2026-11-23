# T-277 vendor facts: Microsoft Teams chat, channels and calling from a web app (delegated)

Checked on 2026-11-23 against learn.microsoft.com. Graph facts are v1.0 unless marked beta.

URL shorthand: `G/` = `https://learn.microsoft.com/en-us/graph/`, `ACS/` = `https://learn.microsoft.com/en-us/azure/communication-services/`,
`E/` = `https://learn.microsoft.com/en-us/entra/`, `T/` = `https://learn.microsoft.com/en-us/microsoftteams/`. Graph API pages take `?view=graph-rest-1.0`.
"Admin consent" values are the Delegated column of `G/permissions-reference` (updated 2026-11-21). That page and `chatmessage-post` were too large to read raw, so their rows were extracted by the fetch tool (second-hand quotes).
A tenant can still require admin approval for any scope by policy (`E/identity-platform/consent-types-developer`).

## A. Chats (delegated)

### A1. List and read
- List chats: `GET /me/chats` (also `/chats`, `/users/{id}/chats`). Delegated `Chat.ReadBasic` (least), `Chat.Read`, `Chat.ReadWrite`. Admin consent: No for all three. — `G/api/chat-list`
- Query options: `$expand` supports only `members` and `lastMessagePreview`; "Maximum allowed `$top` value is 50"; `$orderby` supports only `lastMessagePreview/createdDateTime desc`; `$filter` supported; paging by `@odata.nextLink`. With `$expand=members` at most 25 members come back per chat. — `G/api/chat-list`
- `lastMessagePreview` contains the message body text (`body.content`), sender and `createdDateTime`. It is returned only by list chats. The portal must not persist the body. — `G/api/chat-list`, `G/api/resources/chat`
- Unread state: `viewpoint.lastMessageReadDateTime` and `viewpoint.isHidden`, "populated only when the request is made in a delegated context". Unread = `lastMessagePreview.createdDateTime` later than `viewpoint.lastMessageReadDateTime` (the page's own example 4). No extra scope beyond list chats. — `G/api/resources/chat`, `G/api/chat-list`
- `lastUpdatedDateTime` is the time the chat "was renamed or the list of members was last changed", not the last message time. — `G/api/resources/chat`
- Members: `GET /chats/{chat-id}/members`, delegated `Chat.ReadBasic` (least). "The client should not assume that all members are from the current tenant only." — `G/api/chat-list-members`
- Read messages: `GET /chats/{chat-id}/messages` (also under `/me/chats/...`). Delegated `Chat.Read` (least), `Chat.ReadWrite`. `$top` max 50. `$orderby` on `lastModifiedDateTime` (default) or `createdDateTime`, descending only. `$filter` date range (`lastModifiedDateTime` `gt`/`lt`, `createdDateTime` `lt`) works only together with `$orderby` on the same property. — `G/api/chat-list-messages`
- Read one message: `GET /chats/{chat-id}/messages/{message-id}`. Delegated `Chat.Read`, `Chat.ReadWrite`. — `G/api/chatmessage-get`
- `ChatMessage.Read` exists (admin consent No) but is not in the permission tables of list messages or get message, so it does not replace `Chat.Read` for these calls. — `G/api/chat-list-messages`, `G/api/chatmessage-get`
- Inline images: `GET /chats/{chat-id}/messages/{message-id}/hostedContents`, bytes at `.../hostedContents/{id}/$value`. Delegated `Chat.Read`, `Chat.ReadWrite`. — `G/api/chatmessage-list-hostedcontents`
- Attachments are on the message (`attachments[]`: `contentType`, `contentUrl`, `content`, `name`). File attachments are SharePoint/OneDrive links, so opening the file needs Files/Sites scopes that are not covered here. — `G/api/resources/chatmessage`, `G/api/chatmessage-post`
- System events are returned as `messageType: systemEventMessage` only when the request has `Prefer: include-unknown-enum-members`. — `G/api/chat-list-messages`
- Mark read: `POST /chats/{chat-id}/markChatReadForUser`, body `{"user":{"id":"<oid>","tenantId":"<tid>"}}`, returns 204. Delegated `Chat.ReadWrite` only ("Higher privileged: Not available"); application not supported. Admin consent: No. — `G/api/chat-markchatreadforuser`

### A2. Send and create
- Send: `POST /chats/{chat-id}/messages`. Delegated `ChatMessage.Send` (least), higher `Chat.ReadWrite`, `Group.ReadWrite.All`. Admin consent for `ChatMessage.Send`: No. Application permission is `Teamwork.Migrate.All` only (import). — `G/api/chat-post-messages`
- Body: `{"body":{"contentType":"text"|"html","content":"..."}}`; only `body` is mandatory; default content type is text. HTML is required for mentions (`<at id="0">` plus a `mentions` array). Inline images go in `hostedContents` with `@microsoft.graph.temporaryId`; "The maximum possible size of hosted content is 4 MB." — `G/api/chatmessage-post`
- Size: "Chat size: Approximately 100 KB per post" (text, image links, mentions, reactions; not base64 images); "it's recommended to ensure that the size of the message itself is within 80 KB". — `T/limits-specifications-teams` (updated 2026-11-09)
- Idempotency: none documented. `id` is read-only and there is no dedupe header. The only duplicate rule is for imports (`createdDateTime` unique to the millisecond, else 409). A retry after a timeout can post twice. — `G/api/chat-post-messages`, `G/api/channel-post-messages`
- Terms note on the send pages: "It's a violation of the terms of use to use Microsoft Teams as a log file. Only send messages that people will read." — `G/api/chat-post-messages`
- Create chat: `POST /chats` with `chatType` `oneOnOne` or `group` and every member (including the caller) as `aadUserConversationMember` with `roles` and `user@odata.bind`. Delegated `Chat.Create` (least), `Chat.ReadWrite`. Admin consent for delegated `Chat.Create`: No. "If a one-on-one chat already exists, this operation returns the existing chat and doesn't create a new one." — `G/api/chat-post`
- Throttling (requests per second; any exceeded limit throttles; a sustained limit of about 83% also applies). — `G/throttling-limits` (updated 2026-11-19)

| Request | Per app, all tenants | Per app per tenant | Per resource | Per user |
|---|---|---|---|---|
| GET `/chats/{id}/messages` | 200 | 20 | 1 per chat | - |
| POST `/chats/{id}/messages` | 200 | 20 | 1 per chat | 1 |
| GET `/me/chats` | 200 | 20 | - | 1 |
| GET `/chats/{id}` | 2000 | 200 | 1 per chat | 5 |
| GET channel messages | 200 | 20 | 1 per channel | - |
| POST channel message or reply | 500 | 50 | 1 per channel | 1 |
| GET `/me/joinedTeams` | 300 | 30 | - | - |
| GET `/teams/{id}/channels` | 1200 | 60 | 4 per team | - |

- The older notes "4 requests per second per team or channel" and "3000 messages per app per day per channel" are no longer in the page. On 429, wait `Retry-After`, otherwise exponential backoff. — `G/throttling-limits`, `G/throttling`

### A3. Noticing new messages without storing text
- Delegated chat-message subscriptions (`POST /subscriptions`): `/chats/{chat-id}/messages` (`Chat.Read`) and `/users/{user-id}/chats/getAllMessages` (`Chat.Read`, `Chat.ReadWrite`) — all of one user's chats in one subscription. Tenant-wide `/chats/getAllMessages` and `/teams/getAllMessages` are application-only. — `G/teams-changenotifications-chatmessage`, `G/api/subscription-post-subscriptions`
- `includeResourceData` is optional. With `false` the notification carries only `subscriptionId`, `changeType`, `tenantId`, `clientState`, `resource` (`chats('{chatId}')/messages('{messageId}')`) and ids — no text, no sender. "Subscriptions for notifications without resource data don't require an encryption certificate". Validate with `clientState`. — `G/teams-changenotifications-chatmessage`
- With `includeResourceData: true` an `encryptionCertificate` (RSA 2,048–4,096 bit) and `encryptionCertificateId` are mandatory, no `$select` is possible and the full message is pushed. Not needed for this design. — `G/change-notifications-with-resource-data`
- `changeType`: `created`, `updated`, `deleted`. `updated` also fires for reactions. — `G/api/resources/subscription`, `G/api/resources/chatmessage`
- Lifetime: chat and chatMessage "4,320 minutes (three days)"; latency under 10 s average, 1 minute maximum. `lifecycleNotificationUrl` is "Required for Teams resources if the `expirationDateTime` value is more than 1 hour from now" and cannot be added later. — `G/api/resources/subscription`, `G/change-notifications-overview`
- Lifecycle events: `reauthorizationRequired` (all resources), `subscriptionRemoved` (chatMessage yes, chat not listed), `missed` (not for Teams). Notifications lost while delivery is paused must be fetched by the app. — `G/change-notifications-lifecycle-events`
- Quotas: "Per app and channel or chat combination: 1 subscription. Per user (for subscriptions tracking chat messages in all chats the user is part of): 10 subscriptions. Per organization: 10,000 total subscriptions", shared across all Teams subscriptions in the tenant; 403 when exceeded. — `G/change-notifications-overview`
- Chat (not message) subscriptions: `/me/chats` or `/users/{id}/chats` and `/chats/{id}`, delegated `Chat.ReadBasic`/`Chat.Read`/`Chat.ReadWrite`. They fire on chat create/update, not on a new message; `?notifyOnUserSpecificProperties=true` adds `viewpoint` changes (read state, hidden). — `G/teams-changenotifications-chat`
- No delegated delta for chat messages: `GET /users/{id}/chats/getAllMessages/delta` and `GET /users/{id}/chats/getAllMessages` are application-only (`Chat.Read.All`). Delegated catch-up is per chat with the `lastModifiedDateTime` filter. — `G/api/chatmessage-delta`, `G/api/chats-getallmessages`
- Polling rule: "If your app polls to see whether a resource has changed, you can only do that once per day"; fetching when the user opens or refreshes a page is allowed; "When polling for new messages, you must specify a date range where supported." Background polling loops breach the API terms. — `G/api/resources/teams-api-overview`
- Payment: "Starting August 25, 2025, the Teams APIs are no longer metered, and no billing configuration is required to use these APIs." The `model=A/B` page (`G/teams-licenses`) now redirects to the Graph hub and `G/teams-protected-apis` returns 404. Remaining wording about protected APIs concerns access "without a user" (application permissions). — `G/metered-api-list`, `T/export-teams-content`

## B. Teams and channels (delegated)

- Joined teams: `GET /me/joinedTeams`. Delegated `Team.ReadBasic.All` (admin consent No). No OData parameters. It "doesn't return the host team of the shared channel that the user is a direct member of". — `G/api/user-list-joinedteams`
- Teams including shared-channel hosts: `GET /me/teamwork/associatedTeams`, delegated `Team.ReadBasic.All`, works only for `me`. — `G/api/associatedteaminfo-list`
- Channels: `GET /teams/{team-id}/channels`. Delegated `Channel.ReadBasic.All` (admin consent No). `$filter` (for example `membershipType eq 'private'`) and `$select` only. Members "can't see private or shared channels that they aren't members of". — `G/api/channel-list`
- Channels shared into a team: `GET /teams/{team-id}/allChannels` and `/incomingChannels`, delegated `Channel.ReadBasic.All`. — `G/api/team-list-allchannels`
- Read channel messages: `GET /teams/{team-id}/channels/{channel-id}/messages` (root posts only). Delegated `ChannelMessage.Read.All` — ADMIN CONSENT REQUIRED (Yes). Default page 20, max 50; `$expand=replies` (the page says both "up to 200" and "up to 1,000" replies); sorted by last modified date of the whole thread. — `G/api/channel-list-messages`
- Replies: `GET .../messages/{message-id}/replies`, delegated `ChannelMessage.Read.All`, `$top` max 50. — `G/api/chatmessage-list-replies`
- Inline images in channel messages: `.../hostedContents/{id}/$value`, delegated `ChannelMessage.Read.All`. — `G/api/chatmessagehostedcontent-get`
- Send: `POST /teams/{team-id}/channels/{channel-id}/messages`; reply: `POST .../messages/{message-id}/replies`. Delegated `ChannelMessage.Send` (admin consent No). Same body shape as chat. — `G/api/channel-post-messages`, `G/api/chatmessage-post-replies`
- Size: "Channel conversation post size: Approximately 100 KB per post". — `T/limits-specifications-teams`
- Change notifications (delegated): `/teams/{team-id}/channels/{channel-id}/messages` with `ChannelMessage.Read.All`; one subscription per app per channel; same lifetime and lifecycle rules as chat. No delegated "all channels of the user" resource exists. — `G/teams-changenotifications-chatmessage`
- Channel delta: the v1.0 page `chatmessage-delta` now documents only the application-only chats delta. No reference page documents `/teams/{id}/channels/{id}/messages/delta`, although the v1.0 PowerShell cmdlet `Get-MgTeamChannelMessageDelta` still exists. Treat as not confirmed. — `G/api/chatmessage-delta`, `G/teams-messaging-overview`
- There is no "mark channel read" API and no per-user read state for channels in the pages read.
- Shared channels across tenants: calling the returned `@odata.id` fails with "TenantId in the optional tenants/{tenantId} segment should match the tenantId(tid) in the token"; the workaround is to remove `/tenants/{tenant-id}`. — `G/known-issues`

## C. Presence and people

- `GET /me/presence` needs `Presence.Read`; another user (`GET /users/{id}/presence`, GUID only) needs `Presence.Read.All`. Batch: `POST /communications/getPresencesByUserId`, `Presence.Read.All`, "Maximum of 650 user IDs". Admin consent for both delegated scopes: No. Limit: "1,500 requests within a 30-second period, per application per tenant". — `G/api/presence-get`, `G/api/cloudcommunications-getpresencesbyuserid`
- Presence subscriptions: delegated only (`Presence.Read.All`), maximum lifetime 60 minutes, encryption certificate always required. — `G/api/subscription-post-subscriptions`, `G/api/resources/subscription`
- A chat member (`aadUserConversationMember`) has `userId` (Entra object id), `tenantId`, `email`, `displayName`; no UPN. `userId` is what presence, `POST /chats` and ACS `microsoftTeamsUserId` take. — `G/api/resources/aaduserconversationmember`
- Deep links take UPNs. Reading another user's `userPrincipalName` needs `User.ReadBasic.All` (admin consent No); `User.Read` covers only the signed-in user. — `G/api/user-get`

## D. Calling

### D6. Graph cannot place a call as a user
- `POST /communications/calls`: "Delegated (work or school account): Not supported." Application only (`Calls.Initiate.All`, `Calls.InitiateGroupCall.All`, `Calls.JoinGroupCall.All`, ...). "Create call enables your bot to create a new outgoing peer-to-peer or group call ... You need to register the calling bot". Same table in beta. No `Calls.*` delegated permission exists. — `G/api/application-post-calls`, `G/permissions-reference`
- Bot calls need admin consent and are placed by the bot identity, not the user. — `T/platform/bots/calls-and-meetings/registering-calling-bot`

### D7. Deep links (open Teams; not in-portal calling)
- New chat: `https://teams.microsoft.com/l/chat/0/0?tenantId=<tenantId>&users=<user1>,<user2>&topicName=<name>&message=<text>`. Users are UPNs only. The text is placed in the compose box and not sent. — `T/platform/concepts/build-and-test/deep-link-teams`
- Existing chat: `https://teams.microsoft.com/l/chat/<chatId>/conversations` (`chatId` is `19:xxx`). Chat message: `https://teams.microsoft.com/l/message/<chatId>/<messageId>?context={"contextType":"chat"}`. — same page
- Channel message: `https://teams.microsoft.com/l/message/<channelId>/<messageId>?tenantId=<tenantId>&groupId=<groupId>&parentMessageId=<parentMessageId>&teamName=<teamName>&channelName=<channelName>&createdTime=<createdTime>`. Graph also returns `webUrl` on chats and channel messages. — same page
- Audio call: `https://teams.microsoft.com/l/call/0/0?users=<user1>,<user2>`; video: add `&withVideo=true`; PSTN: `4:<phonenumber>` as a user. "Before Teams places the call, the client prompts for a confirmation." — `T/platform/concepts/build-and-test/deep-link-workflow`
- An `https://` link opens a browser page offering desktop client, download or web client. `msteams:` skips that page but only works with the client installed. — `T/platform/concepts/build-and-test/deep-links`

### D8. Azure Communication Services (ACS) with a Teams identity
- RETIREMENT: "On September 23, 2026, Microsoft announced the retirement of Azure Communication Services (ACS) as a standalone offering, effective September 30, 2028." Every ACS page carries a banner. — `ACS/acs-retirement-and-breaking-changes-guide` (updated 2026-11-20)
- The Voice/Video Calling SDK is listed under "breaking changes" (a new major version is required), not "retired". After 2028-09-30 it is "supported only when used with a supported Teams-aligned service": "Teams Phone Extensibility (TPE)", "Teams Meeting Interoperability", "Teams Click-2-Call for Teams Voice Apps". "Communication as Teams user" is not named in that list. "Services not impacted" lists "Teams Interop, Teams Phone, and Teams Phone Extensibility". Until 2028 only break-fix: "we're not able to commit to new feature development". — same page
- Retired on 2028-09-30: ACS Chat, UI Library (`@azure/communication-react`), Rooms, ACS Direct Routing, PSTN direct offer, SMS, Email. — same page
- Status today: the Teams-user pages have no preview banner and the token exchange REST API has stable versions (default `2023-10-01`). — `ACS/concepts/teams-interop`
- Needed: an ACS resource; an Entra app with delegated permissions `https://auth.msft.communication.azure.com/Teams.ManageCalls` and `https://auth.msft.communication.azure.com/Teams.ManageChats` on the "Azure Communication Services" API. "Both permissions are required to exchange" the token, even for calling only. "Admin consent required: No" for both. — `ACS/concepts/interop/teams-user/azure-ad-api-permissions`, `ACS/quickstarts/manage-teams-identity`
- If the customer tenant lacks the ACS service principal (app id `1fd5118e-2576-4263-8130-9503064c837a`), an admin must run `New-MgServicePrincipal -AppId "1fd5118e-2576-4263-8130-9503064c837a"`. — `ACS/quickstarts/manage-teams-identity`
- Token exchange (server side, signed with the ACS key or Azure RBAC): `POST {endpoint}/teamsUser/:exchangeAccessToken?api-version=2023-10-01`, body `token` (Entra access token for the ACS audience with both scopes), `appId`, `userId` (object id). Node: `@azure/communication-identity`, `getTokenForTeamsUser({ teamsUserAadToken, clientId, userObjectId })`. — `https://learn.microsoft.com/en-us/rest/api/communication/identity/communication-identity/exchange-teams-user-access-token`
- Token lifetime equals the Entra access token's remaining lifetime ("matching expiration time"). Refresh with `AzureCommunicationTokenCredential({ tokenRefresher, refreshProactively: true })`: refresh the Entra token, then exchange again; the Entra token should have more than 10 minutes left. — `ACS/concepts/credentials-best-practices`
- Client type: the docs show only a public client ("Allow public client flows ... Yes", MSAL `PublicClientApplication`). A confidential web client with a server-stored refresh token is neither shown nor prohibited. — `ACS/quickstarts/manage-teams-identity`
- Multi-tenant: supported. One multi-tenant app and one ACS resource serve users of other tenants; admin consent URL `https://login.microsoftonline.com/{Tenant_ID}/adminconsent?client_id={Application_ID}`. — `ACS/concepts/interop/custom-teams-endpoint-authentication-overview`
- Browser SDK: `@azure/communication-calling` + `@azure/communication-common`; `callClient.createTeamsCallAgent(credential)`; `teamsCallAgent.startCall({ microsoftTeamsUserId })`, `startCall({ phoneNumber })`, `join({ meetingLink })`, `on('incomingCall')` giving `teamsIncomingCall.accept()`. — `ACS/how-tos/cte-calling-sdk/manage-calls`
- A 1:1 VoIP call needs a Graph chat thread id first (`POST /chats`, `Chat.Create`), then `startCall([teamsUser], { threadId })`; group calls require `threadId`. — `ACS/concepts/interop/custom-teams-endpoint-use-cases`
- Supported: 1:1 and group calls (up to 350), add participant or phone number, video, mute, hold, screen share, transfer, accept incoming VoIP and PSTN calls, call queue and auto attendant calls, join Teams meetings. Not supported: join a group call already in progress, start/stop Teams recording or transcription, park, reactions, "Start a call on behalf of the Teams user". — `ACS/concepts/interop/teams-user-calling`, `ACS/concepts/teams-endpoint`
- PSTN uses the user's Teams Phone licence plus calling plan, direct routing or operator connect, and is billed through Teams. — `ACS/concepts/interop/teams-user/phone-capabilities`
- Licence: any plan with the Teams service plan (Business Basic/Standard/Premium, E3/E5, F1/F3 ...). "No additional Teams licenses are required". The pricing page separately says "Use the Calling SDK to start a call with Teams users | Teams Phone license" — conflict, see Not confirmed. — `ACS/quickstarts/eligible-teams-licenses`, `ACS/concepts/teams-endpoint`, `ACS/concepts/pricing/teams-interop-pricing`
- Incoming calls ring every endpoint of the user: "Teams desktop, mobile, web clients, and applications based on Azure Communication Services calling SDK". The web app rings only while the page is open with a connected agent. Web push is preview and, per Microsoft's sample README, "Only supported for ACS identities. Teams identities and PSTN are not supported"; "iOS Safari - Not supported yet". — `ACS/concepts/interop/custom-teams-endpoint-use-cases`, `ACS/how-tos/calling-sdk/push-notifications`
- PRICING: VoIP audio/video/screen share by a Teams user through the ACS SDK is billed to the ACS resource at "$0.004 per minute" per participant, including time in lobby or on hold. "The Teams license does not cover the usage generated in third-party Teams extensions and Teams apps." No monthly fee stated. The page warns prices may be out of date and the Azure pricing page did not render a rate. — `ACS/concepts/pricing/teams-interop-pricing` (updated 2026-10-26)
- Browsers: latest three major versions; iOS row shows Chrome, Safari, Edge and Webview supported, Firefox not. "iOS WebView(WKWebView) in public preview." Installed home-screen web apps are not mentioned anywhere. — `ACS/concepts/voice-video-calling/calling-sdk-features`
- iOS limits: no outgoing screen share on mobile browsers; cannot select mic or speaker; "Bluetooth headsets aren't supported by Safari on iOS"; "iOS Safari refreshes the page if the user goes to another app and returns"; in WKWebView the microphone is muted on lock or background and the "Connection drops ... about 30 seconds later"; another phone call or Siri mutes the mic; do not connect from more than one tab on mobile. — `ACS/concepts/known-issues`, `ACS/quickstarts/voice-video-calling/get-started-webview`, `ACS/concepts/best-practices`
- Government clouds: Teams-user support is "GCC | Public | ❌" and "GCC-H | US Government | ❌". "Azure Communication Services interoperability isn't compatible with Teams deployments using Microsoft 365 government clouds (GCC) at this time." — `ACS/concepts/interop/teams-user/government-cloud`, `ACS/concepts/teams-interop`
- Chat as a Teams user does not go through ACS: "Communication as Teams user leverages Graph API for chat and Azure Communication Services for calling." — `ACS/concepts/teams-endpoint`
- Limits: call duration 30 hours; one active connected call at a time per client. — `ACS/concepts/voice-video-calling/calling-sdk-features`

### D9. Alternatives
- The Teams JavaScript SDK runs only inside a Teams client (not re-checked in this pass). Without ACS Teams identity the documented options are: (a) deep links (D7), which hand the call to the Teams client after a confirmation; (b) `POST /me/onlineMeetings` with delegated `OnlineMeetings.ReadWrite` (admin consent No), which returns `joinWebUrl` for a standalone meeting not shown on the calendar — the portal sends that link in the chat and both sides join in Teams; (c) joining that meeting inside the portal through the ACS Calling SDK as an external (non-Teams) user under "Teams Meeting Interoperability", which the retirement guide names as supported after 2028 — but the user then joins as an external participant rather than as their Teams identity, and a meeting link does not ring the other person (inference from the identity model, not a quoted statement). — `G/api/application-post-onlinemeetings`, `ACS/acs-retirement-and-breaking-changes-guide`

## E. Cross-cutting

### E10. GCC High
- Endpoints: GCC High `https://graph.microsoft.us` and `https://login.microsoftonline.us`; DoD `https://dod-graph.microsoft.us`; GCC (not High) uses the worldwide endpoints. — `G/deployments`
- Separate app registration per cloud: "you're required to register your application separately in each Azure portal"; tokens "are not interchangeable". — `E/identity-platform/authentication-national-cloud`, `G/deployments`
- "Publisher verification currently isn't supported in national clouds." — `E/identity-platform/publisher-verification-overview`
- All chat and channel APIs in sections A and B show US Government L4 and L5 as available, and create subscription is available in both. — the API pages above, `G/api/subscription-post-subscriptions`
- Documented US Government gaps: list chats "The `OrderBy` OData query parameter is not supported"; list messages in a chat `OrderBy` "isn't supported in the GCC environment"; "All channel-based APIs aren't supported in the context of shared channels"; soft delete of a message not supported in GCC High and DoD; meeting transcripts and recordings lists not supported. — `G/teamwork-national-cloud-differences` (updated 2025-08-15)
- Presence is available in L4 and L5. ACS Teams-user calling is not (D8). Teams client hosts: `gov.teams.microsoft.us` (GCC High), `dod.teams.microsoft.us` (DoD). — `G/api/presence-get`, `T/platform/concepts/sovereign-cloud`

### E11. Consent
- Incremental consent on the same app registration works: scopes can be requested "at any time by including the scopes in the `scope` parameter ... without the need to predefine them"; they are "granted in addition to any other permissions that were already granted". So a separate Teams connection with its own scope set is possible. — `E/identity-platform/consent-types-developer`
- Recommended anyway: list admin-consent scopes on the registration ("a superset of the permissions that the application requests dynamically"). The no-scope admin consent URL uses that list. — same page
- Admin-only delegated scopes in this note: `ChannelMessage.Read.All` (also `ChannelMessage.ReadWrite`, `ChatMember.Read`, `Group.Read.All`, none of which are needed). All other scopes listed here are user-consentable by default. — `G/permissions-reference`
- Tenant-wide admin consent: `https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=...&scope=...&redirect_uri=...&state=...` (not `common`). Success returns `admin_consent=True&tenant={guid}&scope=...`. Older form without scope: `https://login.microsoftonline.com/{tenant}/adminconsent?client_id=...`. — `E/identity-platform/v2-admin-consent`, `E/identity/enterprise-apps/grant-admin-consent`
- A non-admin requesting an admin-only scope gets an error or the admin consent request form (`AADSTS90094`); a missing grant is `AADSTS65001`. — `E/identity-platform/scopes-oidc`, `E/identity-platform/reference-error-codes`
- Tenants on the "verified publishers, low impact permissions" policy have no Microsoft default low-impact list beyond sign-in scopes, so Teams scopes need the tenant admin there. — `E/identity/enterprise-apps/configure-permission-classifications`
- Users in other tenants cannot consent to an unverified multi-tenant app registered after 2020-11-08 for more than sign-in scopes. — `E/identity-platform/publisher-verification-overview`
- New scopes need a new `/authorize` round trip; keep the refresh token it returns. A refresh request's `scope` "must be equivalent to or a subset of the scopes requested in the original" request. — `E/identity-platform/v2-oauth2-auth-code-flow`

### E12. Compliance
- No numeric "do not cache longer than X" rule exists for Teams message data. The Microsoft APIs Terms of Use ("Last Updated: October 2025") apply. — `https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use`
- §3(b)(4): do not "build databases or otherwise create copies of any data ... except as necessary to enable an intended usage scenario". §3(b)(5): request no more than the minimum data and permissions. §5(b): locally stored data must be kept up to date, including deletions. §5(c): "deleting all data when your user abandons your Application". §5(d)/(e): privacy statement with a link for revoking consent. §4: secure storage and breach reporting. — same page
- Teams-specific: polling once per day at most (A3); do not use Teams as a log file (A2); "You might not record or otherwise persist media content from calls or meetings". — `G/api/resources/teams-api-overview`, `G/teams-concept-overview`
- Notifications without resource data need no encryption; with resource data the certificate is mandatory (A3).

## Not confirmed / needs a human or a test
- Whether "communication as Teams user" calling is supported after 2028-09-30. The retirement guide does not name it. Needs a Microsoft answer before investing.
- Whether a Teams Phone licence is required for VoIP calls as a Teams user (two ACS pages disagree).
- Whether the ACS token exchange accepts an Entra token obtained by a confidential web client from a stored refresh token (docs show public client only). Needs a test.
- ACS calling in an installed iPhone home-screen web app: not documented. Needs a device test (mic permission, background, lock screen).
- Current ACS per-minute rate on the Azure pricing page (the doc page says $0.004 and warns it may be stale).
- Delegated subscription to `/users/{id}/chats/getAllMessages` without resource data: listed in the v1.0 permission tables, but the only example uses the beta endpoint and `/me/...` is not listed. Needs a test; fallback is one subscription per open chat.
- One doc page says the Teams subscription maximum is 60 minutes; the subscription reference says 4,320 minutes. Test the accepted expiry.
- Channel messages delta for delegated callers (no reference page).
- Whether a GCC High tenant's users can use a multi-tenant app registered in the commercial cloud (docs only describe a separate registration). Teams notifications in GCC High are not listed as a gap but are not confirmed by a statement.
- Whether `POST /chats` accepts a UPN in `user@odata.bind`; whether `User.ReadBasic.All` resolves members of other tenants; maximum users in a chat or call deep link; deep-link behaviour on iOS.
- Whether a user must be a channel member to post with `ChannelMessage.Send`; delegated reads of cross-tenant shared channels.
- The exact list of "protected APIs" (page removed); remaining wording applies to application access only.

## What this means for the design
1. Read chats: `Chat.Read` alone covers list, members, messages, inline images, unread state and subscriptions; no admin consent, no fee, no protected-API request.
2. Send: add `ChatMessage.Send`; new chats add `Chat.Create`. Marking a chat read needs `Chat.ReadWrite`, which then replaces all three.
3. Channels: `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Send` are user-consentable; reading needs `ChannelMessage.Read.All`, which a tenant admin must approve once.
4. Admin consent once per tenant: `ChannelMessage.Read.All` only (plus anything the tenant's own policy forces, and all scopes if the app is not publisher verified).
5. New messages: webhook subscription without resource data (ids only, 3-day lifetime, lifecycle URL, renew), then fetch text live; do not poll in a loop (once per day rule); fetch on page open is fine.
6. Sends are not idempotent: do not auto-retry a send whose result is unknown; check the chat for the message first.
7. In-portal calling: Graph cannot do it. ACS with a Teams identity can today, at about $0.004 per participant minute, with two extra scopes on the ACS API and a server-side token exchange, but ACS retires as a standalone product on 2028-09-30 and this scenario is not on the supported-after list.
8. iPhone: calls ring in the portal only while it is open in the foreground, there is no web push for Teams identities, calls drop or mute when the app is backgrounded or locked, and the home-screen app case is undocumented.
9. GCC High: separate app registration and endpoints, no publisher verification, chat ordering gap, no shared channels, and no ACS Teams-user calling at all (also not in GCC).
10. Storage: `lastMessagePreview` and notifications with resource data contain text; keep only ids and timestamps, and delete user data on disconnect (API terms §5).

## F. Embedding Teams itself (added 2026-11-23, follow-up question "can we embed the entire Teams?")

Answer: no supported way exists to show the Teams client (chat, channels, calling) inside a third-party web page. Forum quotes below came through the fetch tool's summariser; doc-page quotes are verbatim.

### F1. Teams web client in an iframe
- No Microsoft doc page says in so many words "the Teams web client cannot be iframed", and none publishes its framing headers. The fetch tool does not expose HTTP response headers, so `X-Frame-Options` / CSP `frame-ancestors` of `teams.microsoft.com` and `teams.cloud.microsoft` are NOT confirmed (both URLs returned an "Unsupported Browser" page). A browser dev-tools check would settle it.
- Official direction: "You can embed your own experiences into Teams by building Teams apps. If you'd like to *reverse* this model and integrate Teams or other communication capabilities into your own external app experience, see Azure Communication Services." — `T/platform/samples/integrate-web-apps-overview` (updated 2026-08-17)
- Microsoft staff/moderator forum answers: "Currently this is not possible. It's By-design." (2021, Teams web UI in another application); "You cannot embed the Teams meeting UI on your website." (2024, accepted); "Microsoft Teams currently does not offer a native embed feature for displaying channel conversations or posts directly on external websites" (2025). — `https://techcommunity.microsoft.com/discussions/teamsdeveloper/embedding-microsoft-teams-web-ui-into-another-application/1607736`, `https://learn.microsoft.com/en-us/answers/questions/2084643/is-it-possible-to-integrate-microsoft-teams-meetin`, `https://learn.microsoft.com/en-us/answers/questions/2280639/how-to-embed-microsoft-teams-channel-conversations`
- One conflicting Microsoft-badged forum reply (2024) calls an iframe "a straightforward method" and then says sign-in inside it is a problem; untested. A user reports an undocumented `teams.microsoft.com/embed-client/...` URL working inside SharePoint; no Microsoft documentation for it. Neither is a supported basis. — `https://techcommunity.microsoft.com/discussions/teamsdeveloper/how-to-embed-microsoft-teams-into-my-own-electron-application/4190141`, `https://learn.microsoft.com/en-us/answers/questions/4425854/embed-teams-in-sharepoint-app`
- Sign-in cannot happen in an iframe (official): "Microsoft Entra ID will refuse to render any prompt requiring user interaction (e.g. credential entry, consent, logout etc.) in an iframe by throwing the `X-FRAME OPTIONS SET TO DENY` error". — `E/msal/javascript/browser/iframe-usage` (updated 2026-10-23)
- Same rule in the Teams docs: "Sign-in pages don't render in iFrames as a safeguard against clickjacking." — `T/platform/tabs/how-to/tab-requirements`
- iPhone makes it worse: Entra session cookies in an iframe are third-party cookies and "Safari ... block third-party cookies by default"; "Silent token acquisition no longer works when third-party cookies are blocked". Teams web in Safari is itself "currently in preview". — `E/identity-platform/reference-third-party-cookies-spas`, `https://learn.microsoft.com/en-us/troubleshoot/microsoftteams/teams-sign-in/sign-in-loop`

### F2. Supported embedding products
| Option | Covers | For whom | Status | Cost | Multi-tenant third-party portal |
|---|---|---|---|---|---|
| Microsoft Graph Toolkit (`mgt-chat`, `mgt-new-chat`, `mgt-teams-channel-picker`) | 1:1 and group chat UI only; no channels, no calling | Any Graph app | Retired: "retirement period begins September 1, 2025, with full retirement planned for August 28, 2026"; repo archived 2026-08-28; `mgt-chat` never left preview | Free | Worked, now unsupported |
| Dynamics 365 "embedded chat using Teams" | Chat only | Dynamics 365 apps | Available | Dynamics 365 + Teams licences (not itemised) | No: admin toggle inside Dynamics, no SDK |
| `microsoft/EmbeddedTeamsChat` sample | Chat | Sample code | Archived 2025-05-28 | - | No |
| ACS UI Library (`@azure/communication-react`) | Calling and chat UI components | ACS customers | Retires 2028-09-30, fixes only until then, no replacement listed | - | Not for new work |
| ACS Calling SDK with Teams identity | 1:1 and group calls as the user, own UI | Custom apps | Available; after 2028-09-30 not confirmed (D8) | $0.004 per participant minute | Yes, not in GCC/GCC High |
| ACS Teams Meeting Interoperability | Join a Teams meeting in own UI | Custom apps | Supported after 2028 with a new major SDK; in-meeting chat via ACS retires 2028 | $0.004 per participant minute | Yes, but the user appears as "(External)" anonymous guest and may wait in the lobby |
| Click-2-Call for Teams Voice Apps | Web visitor calls a Teams call queue or auto attendant | Customer-facing sites | Available (announced 2024-03); listed as supported after 2028 | ACS per minute + Teams Phone resource accounts (not itemised) | Not for an employee calling as themselves |
| Teams Phone extensibility (TPE) | PSTN calls through Teams Phone service numbers in a contact-centre app | CCaaS vendors | GA 2025-09-03 | Teams Phone, resource account and calling-plan licences + ACS usage | No user-to-user Teams calling, no chat |
- Sources: `G/toolkit/overview`, `G/toolkit/components/chat`, `https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-toolkit-retirement/`, `https://github.com/microsoftgraph/microsoft-graph-toolkit`, `https://learn.microsoft.com/en-us/dynamics365/sales/teams-integration/enable-teams-chat`, `https://github.com/microsoft/EmbeddedTeamsChat`, `ACS/acs-retirement-and-breaking-changes-guide`, `ACS/concepts/join-teams-meeting`, `ACS/concepts/pricing/teams-interop-pricing`, `ACS/quickstarts/voice-video-calling/get-started-teams-call-queue`, `ACS/concepts/interop/tpe/teams-phone-extensibility-overview`.
- No 2025–2026 announcement of an embeddable Teams chat or calling component for external web apps was found. The current "Teams SDK" is for apps and agents that run inside Teams. The ACS retirement guide says the chat client is the "Teams client, Teams app, or a separately designed and validated Graph-based experience". — `T/platform/tabs/how-to/using-teams-client-library`, `ACS/acs-retirement-and-breaking-changes-guide`

### F3. What Microsoft documents for a portal instead
- Own chat/channel UI over Graph (sections A and B) — the only supported way to show Teams messages inside the portal.
- Deep links to hand over to Teams in a new tab or the desktop client (D7). Behaviour when opened from an iPhone home-screen web app is not documented.
- Reverse embedding: the portal as a personal tab app inside Teams. "Tabs are client-aware webpages embedded in Microsoft Teams, Outlook, and Microsoft 365. They're simple HTML `<iframe/>` tags". Runs in Teams web, desktop and mobile. — `T/platform/tabs/what-are-tabs`, `T/platform/m365-apps/overview`
- Tab requirements: HTTPS; CSP `frame-ancestors` allowing `*.cloud.microsoft`, `teams.microsoft.com`, `*.teams.microsoft.com`; load `@microsoft/teams-js` and call `app.initialize()`; `validDomains` in the app manifest; sign-in must not use a redirect inside the frame (pop-up or Teams SSO), which differs from the portal's current email-code sign-in and from its framing rules. — `T/platform/tabs/how-to/tab-requirements`
- What the tab gives: Teams chat and calling stay native next to the portal, and the tab can hand over with `call.startCall` (Teams web, desktop, Android, iOS) and `chat.openChat` (preview: "Don't use this capability in production"). Nothing from Teams is drawn inside the portal page. — `T/platform/m365-apps/teamsjs-support-m365`
- Distribution: upload to each customer tenant's org catalog with that tenant's Teams admin approval, or publish to the Teams Store with Microsoft validation. No fee stated. — `T/platform/concepts/deploy-and-publish/apps-publish-overview`

### F4. Not confirmed
- The actual framing headers of the Teams web client (tool cannot read headers).
- Whether the npm packages of the retired Graph Toolkit remain installable; licence table for Dynamics embedded chat; licence and cost detail for Click-2-Call.
- Any fee or review timeline for Teams Store publication; whether the portal's sign-in (email code + TOTP) can run inside a Teams tab without change.
