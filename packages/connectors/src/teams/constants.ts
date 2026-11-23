// Microsoft Teams constants (T-279; docs/specs/messages.md 4.4, 5, 6; decision D-66). Provider facts only, nothing company-specific: a lane's tenants, domains, cloud and features
// come from `lane_config.teams` (CLAUDE.md rule 2). Scopes and endpoints are the ones in `.agent/notes/T-277-vendor-facts.md` (checked against Microsoft's documentation on Nov 23, 2026).
import type { TeamsFeature } from "@nichols/core/lane-config";

export const TEAMS_PROVIDER = "microsoft_teams" as const;
/** The connect slug; the registered redirect URI ends with `TEAMS_CALLBACK_PATH` (the human already registered it in the Teams Entra app). */
export const TEAMS_SLUG = "teams";
export const TEAMS_CALLBACK_PATH = `/api/connect/${TEAMS_SLUG}/callback`;

/** Always requested: the OpenID scopes (id_token and refresh token) and the signed-in user's own profile (`GET /me`). */
export const TEAMS_BASE_SCOPES = ["openid", "offline_access", "User.Read"] as const;
/** The delegated Graph scopes each lane feature needs (spec 4.4). A lane that lists no feature requests only the base scopes. */
export const TEAMS_FEATURE_SCOPES: Readonly<Record<TeamsFeature, readonly string[]>> = Object.freeze({
  chat_read: Object.freeze(["Chat.Read"]),
  call_links: Object.freeze(["User.ReadBasic.All"]),
  chat_send: Object.freeze(["ChatMessage.Send"]),
  channels_read: Object.freeze(["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"]),
  channels_send: Object.freeze(["ChannelMessage.Send"]),
});
/** Fixed order, so the requested scope string is the same for the same features. */
const FEATURE_ORDER: readonly TeamsFeature[] = ["chat_read", "call_links", "chat_send", "channels_read", "channels_send"];

/** The scopes the connect requests for a lane's features: the base scopes plus the union for the features, in a fixed order, without duplicates. */
export function teamsScopesFor(features: readonly TeamsFeature[]): string[] {
  const out: string[] = [...TEAMS_BASE_SCOPES];
  for (const f of FEATURE_ORDER) if (features.includes(f)) for (const s of TEAMS_FEATURE_SCOPES[f]) if (!out.includes(s)) out.push(s);
  return out;
}

/**
 * Every scope this app's registration may hold (the table above plus the OpenID scopes), lower-case. A token response lists every scope already consented for the app in that
 * tenant (observed Nov 22, 2026), so a granted scope that was not requested is accepted ONLY if it is on this list; anything else (a `Mail.*` scope, another resource) refuses the grant.
 */
export const TEAMS_KNOWN_SCOPES: ReadonlySet<string> = new Set(
  [...TEAMS_BASE_SCOPES, "profile", "email", ...FEATURE_ORDER.flatMap((f) => TEAMS_FEATURE_SCOPES[f])].map((s) => s.toLowerCase()),
);

/** The connection feature (a boolean in `core.connections.features`) a lane feature is recorded as. Always written, so a reconnect under fewer features clears a `true`. */
export const teamsFeatureKey = (f: TeamsFeature): string => `teams_${f}`;
export const TEAMS_FEATURE_KEYS: readonly string[] = FEATURE_ORDER.map(teamsFeatureKey);

/** The lane features whose scopes need a tenant administrator's consent (`ChannelMessage.Read.All`; spec 4.4). */
export const TEAMS_ADMIN_CONSENT_FEATURES: readonly TeamsFeature[] = ["channels_read"];

// ---- the exact request templates (spec 6). Ids are path parameters, validated and encoded by the HTTP client, never concatenated.
/** Read routes: "GET <template>" -> the lane AND connection feature it needs (null: none; the signed-in user's own profile). */
export const TEAMS_READ_ROUTES: Readonly<Record<string, TeamsFeature | null>> = Object.freeze({
  "/me": null,
  "/me/chats": "chat_read",
  "/chats/{chatId}": "chat_read",
  "/chats/{chatId}/members": "chat_read",
  "/chats/{chatId}/messages": "chat_read",
  "/chats/{chatId}/messages/{messageId}": "chat_read",
  "/chats/{chatId}/messages/{messageId}/hostedContents/{hostedId}/$value": "chat_read",
  "/users/{userId}": "call_links",
  "/me/joinedTeams": "channels_read",
  "/teams/{teamId}/channels": "channels_read",
  "/teams/{teamId}/channels/{channelId}/messages": "channels_read",
  "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies": "channels_read",
  "/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents/{hostedId}/$value": "channels_read",
});
/** Write routes ("POST <template>") -> the feature each needs. Only the approvals wiring can build a client that sends them (spec 6, 10). */
export const TEAMS_WRITE_ROUTES: Readonly<Record<string, TeamsFeature>> = Object.freeze({
  "/chats/{chatId}/messages": "chat_send",
  "/teams/{teamId}/channels/{channelId}/messages": "channels_send",
  "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies": "channels_send",
});

export const isTeamsReadPath = (path: string): boolean => Object.hasOwn(TEAMS_READ_ROUTES, path);
export const isTeamsWritePath = (path: string): boolean => Object.hasOwn(TEAMS_WRITE_ROUTES, path);

// ---- path parameter formats (spec 6 "Id formats"; our own bounds where the fact sheet gives none)
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One bound everywhere (the page key, the database check, this client): 200 characters in all, `19:` included (SL5). */
const THREAD_ID = /^19:[A-Za-z0-9._@:-]{1,197}$/;
const MESSAGE_ID = /^[A-Za-z0-9._:=@-]{1,256}$/;
export const TEAMS_PARAM_FORMATS: Readonly<Record<string, RegExp>> = Object.freeze({
  chatId: THREAD_ID,
  channelId: THREAD_ID,
  teamId: UUID_LOWER,
  userId: UUID_LOWER,
  messageId: MESSAGE_ID,
  hostedId: MESSAGE_ID,
});

/** The Graph origin and path prefix that the connect's `/me` call and every Teams request use (commercial cloud; `gcc_high` is refused by the guard, spec 15). */
export const TEAMS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Our own pacing (Microsoft documents 1 request/s per user for list chats and 1 per chat for messages, vendor facts A2): per connection, in their own buckets. */
export const TEAMS_CHATS_RATE_LIMIT = { requests: 1, perMs: 1000 } as const;
export const TEAMS_CHAT_MESSAGES_RATE_LIMIT = { requests: 1, perMs: 1000 } as const;
export const TEAMS_DEFAULT_RATE_LIMIT = { requests: 4, perMs: 1000 } as const;
/** A send: Microsoft allows 1 POST per second per user and per chat (vendor facts A2). Pacing only: a POST is still never retried. */
export const TEAMS_SEND_RATE_LIMIT = { requests: 1, perMs: 1000 } as const;
/** Our own cap on requests in flight per Teams connection. */
export const TEAMS_MAX_CONCURRENT = 4;

/** Largest text of a send (Microsoft recommends a message under 80 KB, vendor facts A2). */
export const TEAMS_MAX_TEXT_BYTES = 80 * 1024;

/** The fixed text Settings and Messages show when a tenant administrator must approve the app (spec 5; no link: the v2 admin-consent URL needs a registered redirect URI and no route exists for it). */
export const TEAMS_ADMIN_CONSENT_TEXT =
  "Your organisation's Microsoft admin must approve the portal's Teams app once (Entra admin centre → Enterprise applications → the app → Permissions → Grant admin consent).";
