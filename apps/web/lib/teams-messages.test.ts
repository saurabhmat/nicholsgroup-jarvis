// T-280: the Messages page's connect states (spec 11), decided from the Settings section view.
import { describe, expect, it } from "vitest";
import { channelAccountsOf, channelsAvailability, messagesStateOf, openChannelAccountOf } from "./teams-messages";
import type { TeamsConnectionView, TeamsSectionView } from "./teams-connection";

const c = (over: Partial<TeamsConnectionView> = {}): TeamsConnectionView => ({ id: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links"], ...over });
const v = (over: Partial<TeamsSectionView> = {}): TeamsSectionView => ({ connections: [c()], laneFeatures: ["chat_read", "call_links"], maxAccounts: 1, needsAdminConsent: false, ...over });

describe("messagesStateOf", () => {
  it("no section (the caller may not connect an account here)", () => expect(messagesStateOf(null)).toEqual({ kind: "no_access" }));
  it("settings or rows unreadable: unavailable, never 'not connected'", () => {
    expect(messagesStateOf(v({ settingsUnknown: true }))).toEqual({ kind: "unavailable" });
    expect(messagesStateOf(v({ unavailable: true, connections: [] }))).toEqual({ kind: "unavailable" });
  });
  it("Teams not enabled: not enabled without a connection, paused with one", () => {
    expect(messagesStateOf(v({ paused: true, connections: [] }))).toEqual({ kind: "not_enabled" });
    expect(messagesStateOf(v({ paused: true, connections: [c({ mine: false })] }))).toEqual({ kind: "not_enabled" }); // another person's row is not the viewer's
    expect(messagesStateOf(v({ paused: true }))).toEqual({ kind: "paused" });
    expect(messagesStateOf(v({ paused: true, connections: [c({ state: "reconnect_required" })] }))).toEqual({ kind: "paused" });
  });
  it("enabled and no own connection (or only a disconnected one): not connected; other people's rows do not count", () => {
    expect(messagesStateOf(v({ connections: [] }))).toEqual({ kind: "not_connected" });
    expect(messagesStateOf(v({ connections: [c({ state: "disconnected" })] }))).toEqual({ kind: "not_connected" });
    expect(messagesStateOf(v({ connections: [c({ mine: false })] }))).toEqual({ kind: "not_connected" });
  });
  it("a sign-in that needs reconnecting", () => {
    expect(messagesStateOf(v({ connections: [c({ state: "reconnect_required" })] }))).toMatchObject({ kind: "reconnect", connectionId: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test" });
  });
  it("connected: who, degraded or not, the features the lane lists that the connection lacks, and the admin approval text for channels", () => {
    expect(messagesStateOf(v())).toMatchObject({ kind: "connected", connectionId: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", degraded: false, missing: [], adminConsent: false, laneFeatures: ["chat_read", "call_links"] });
    expect(messagesStateOf(v({ connections: [c({ state: "degraded" })] }))).toMatchObject({ kind: "connected", degraded: true });
    expect(messagesStateOf(v({ laneFeatures: ["chat_read", "call_links", "chat_send"] }))).toMatchObject({ missing: ["chat_send"], adminConsent: false });
    expect(messagesStateOf(v({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true }))).toMatchObject({ missing: ["channels_read"], adminConsent: true });
    expect(messagesStateOf(v({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true, connections: [c({ has: ["chat_read", "channels_read"] })] }))).toMatchObject({ missing: [], adminConsent: false });
  });
});

describe("T-278 review", () => {
  it("C5: an unserved cloud is a paused page with that reason, even with no connection of one's own", () => {
    expect(messagesStateOf(v({ paused: true, unsupportedCloud: true, connections: [] }))).toEqual({ kind: "paused", unsupportedCloud: true });
    expect(messagesStateOf(v({ paused: true }))).toEqual({ kind: "paused" });
  });
});

describe("channelsAvailability (T-291): decided from the connect state alone, before any Microsoft read", () => {
  const state = (over: Parameters<typeof v>[0] = {}) => {
    const s = messagesStateOf(v(over));
    if (s.kind !== "connected") throw new Error("expected connected");
    return s;
  };
  it("the company does not list channels_read: off (even when the connection has the feature)", () => {
    expect(channelsAvailability(state())).toEqual({ kind: "off" });
    expect(channelsAvailability(state({ connections: [c({ has: ["chat_read", "channels_read"] })] }))).toEqual({ kind: "off" });
  });
  it("the company lists it and the connection lacks it (made before, or approval not given at connect): reconnect, with the administrator's approval text", () => {
    expect(channelsAvailability(state({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true }))).toMatchObject({ kind: "reconnect", adminConsent: true, accounts: [{ connectionId: "00000000-0000-4000-8000-0000000000c1" }] });
  });
  it("the company lists it and the connection has it: ready", () => {
    expect(channelsAvailability(state({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true, connections: [c({ has: ["chat_read", "channels_read"] })] }))).toEqual({ kind: "ready" });
  });
});

describe("channels with several accounts (T-296; spec 22.4, 22.9)", () => {
  const A = "00000000-0000-4000-8000-0000000000c1";
  const B = "00000000-0000-4000-8000-0000000000c2";
  const D = "00000000-0000-4000-8000-0000000000d1";
  const CH = ["chat_read", "channels_read"] as const;
  const state = (conns: TeamsConnectionView[]) => {
    const s = messagesStateOf(v({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true, maxAccounts: 2, connections: conns }));
    if (s.kind !== "connected") throw new Error("expected connected");
    return s;
  };
  const two = () => state([c({ id: A, account: "me@one.example.test", has: [...CH] }), c({ id: B, account: "me@two.example.test", has: [...CH] })]);

  it("the accounts that can read channels are the usable ones that have the feature; one lacking it is not read", () => {
    expect(channelAccountsOf(two()).map((a) => a.connectionId)).toEqual([A, B]);
    const s = state([c({ id: A, account: "me@one.example.test", has: [...CH] }), c({ id: B, account: "me@two.example.test", has: ["chat_read"] }), c({ id: D, account: "me@three.example.test", state: "reconnect_required", has: [...CH] })]);
    expect(channelAccountsOf(s).map((a) => a.connectionId)).toEqual([A]);
    expect(channelsAvailability(s)).toEqual({ kind: "ready" });
  });

  it("no account has channels: reconnect, listing the usable accounts, with the approval text", () => {
    const s = state([c({ id: A, account: "me@one.example.test" }), c({ id: B, account: "me@two.example.test" })]);
    expect(channelsAvailability(s)).toMatchObject({ kind: "reconnect", adminConsent: true });
    expect((channelsAvailability(s) as { accounts: unknown[] }).accounts).toHaveLength(2);
  });

  it("the address names the account: only the person's own usable channel accounts open; nothing falls back", () => {
    const s = two();
    expect(openChannelAccountOf(s, { conn: B })?.connectionId).toBe(B);
    expect(openChannelAccountOf(s, { conn: A })?.connectionId).toBe(A);
    for (const conn of [D, "../x", A.toUpperCase(), `${A}x`, "", undefined, ["a", "b"]]) {
      // no `conn` with two accounts opens nothing (no guess); a bad or foreign one never falls back to another account
      expect(openChannelAccountOf(s, { conn: conn as never }), String(conn)).toBeUndefined();
    }
  });

  it("an old address without `conn` opens only when exactly one account can read channels", () => {
    const one = state([c({ id: A, account: "me@one.example.test", has: [...CH] }), c({ id: B, account: "me@two.example.test", has: ["chat_read"] })]);
    expect(openChannelAccountOf(one, {})?.connectionId).toBe(A);
    expect(openChannelAccountOf(one, { conn: B })).toBeUndefined(); // an account without channels does not open them
  });
});
