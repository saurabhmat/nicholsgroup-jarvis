// The Teams scope table (T-279, spec 4.4): least privilege per feature, a fixed order, the known-scope list for the tolerant grant rule, the feature keys and the admin-consent facts.
import { describe, expect, it } from "vitest";
import { TEAMS_ADMIN_CONSENT_FEATURES, TEAMS_BASE_SCOPES, TEAMS_CALLBACK_PATH, TEAMS_FEATURE_KEYS, TEAMS_FEATURE_SCOPES, TEAMS_KNOWN_SCOPES, teamsFeatureKey, teamsScopesFor } from "./constants";

describe("scopes", () => {
  it("the base scopes are the sign-in scopes and the signed-in user's own profile", () => {
    expect([...TEAMS_BASE_SCOPES]).toEqual(["openid", "offline_access", "User.Read"]);
    expect(teamsScopesFor([])).toEqual(["openid", "offline_access", "User.Read"]);
  });

  it("the phase-1 lane (chat_read + call_links) asks for exactly five scopes", () => {
    expect(teamsScopesFor(["chat_read", "call_links"])).toEqual(["openid", "offline_access", "User.Read", "Chat.Read", "User.ReadBasic.All"]);
    expect(teamsScopesFor(["call_links", "chat_read"])).toEqual(teamsScopesFor(["chat_read", "call_links"])); // order of the lane's list does not matter
  });

  it("each feature adds exactly its own scopes (spec 4.4), and the union has no duplicates", () => {
    expect(TEAMS_FEATURE_SCOPES).toEqual({
      chat_read: ["Chat.Read"],
      call_links: ["User.ReadBasic.All"],
      chat_send: ["ChatMessage.Send"],
      channels_read: ["Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"],
      channels_send: ["ChannelMessage.Send"],
    });
    const all = teamsScopesFor(["chat_read", "chat_send", "call_links", "channels_read", "channels_send"]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(3 + 1 + 1 + 1 + 3 + 1);
  });

  it("never requests a broader or unrelated scope (spec 4.4 'never requested')", () => {
    const all = teamsScopesFor(["chat_read", "chat_send", "call_links", "channels_read", "channels_send"]).join(" ");
    for (const never of ["Chat.ReadWrite", "Chat.Create", "Presence", "Files", "Sites", "Group", "ChannelMessage.ReadWrite", "ChatMember", "Mail", "Calendars", ".default", "Teams.ManageCalls", "Calls", "OnlineMeetings"]) expect(all).not.toContain(never);
  });

  it("the known-scope list is exactly the table plus the OpenID names, lower-case", () => {
    const expected = ["openid", "offline_access", "profile", "email", "user.read", "chat.read", "user.readbasic.all", "chatmessage.send", "team.readbasic.all", "channel.readbasic.all", "channelmessage.read.all", "channelmessage.send"];
    expect([...TEAMS_KNOWN_SCOPES].sort()).toEqual(expected.sort());
  });

  it("connection features are written for all five lane features, with the teams_ prefix; only channels_read needs admin consent", () => {
    expect(TEAMS_FEATURE_KEYS).toEqual(["teams_chat_read", "teams_call_links", "teams_chat_send", "teams_channels_read", "teams_channels_send"]);
    expect(teamsFeatureKey("chat_read")).toBe("teams_chat_read");
    expect(TEAMS_ADMIN_CONSENT_FEATURES).toEqual(["channels_read"]);
  });

  it("the callback path is exactly the one the human registered", () => {
    expect(TEAMS_CALLBACK_PATH).toBe("/api/connect/teams/callback");
  });
});
