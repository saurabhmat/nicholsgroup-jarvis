// T-280: the Messages page's connect states (spec 11), decided from the Settings section view.
import { describe, expect, it } from "vitest";
import { channelsAvailability, messagesStateOf } from "./teams-messages";
import type { TeamsConnectionView, TeamsSectionView } from "./teams-connection";

const c = (over: Partial<TeamsConnectionView> = {}): TeamsConnectionView => ({ id: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", state: "connected", mine: true, has: ["chat_read", "call_links"], ...over });
const v = (over: Partial<TeamsSectionView> = {}): TeamsSectionView => ({ connections: [c()], laneFeatures: ["chat_read", "call_links"], needsAdminConsent: false, ...over });

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
    expect(messagesStateOf(v({ connections: [c({ state: "reconnect_required" })] }))).toEqual({ kind: "reconnect", connectionId: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test" });
  });
  it("connected: who, degraded or not, the features the lane lists that the connection lacks, and the admin approval text for channels", () => {
    expect(messagesStateOf(v())).toEqual({ kind: "connected", connectionId: "00000000-0000-4000-8000-0000000000c1", account: "me@teams.example.test", degraded: false, missing: [], adminConsent: false, laneFeatures: ["chat_read", "call_links"] });
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
    expect(channelsAvailability(state({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true }))).toEqual({ kind: "reconnect", adminConsent: true });
  });
  it("the company lists it and the connection has it: ready", () => {
    expect(channelsAvailability(state({ laneFeatures: ["chat_read", "channels_read"], needsAdminConsent: true, connections: [c({ has: ["chat_read", "channels_read"] })] }))).toEqual({ kind: "ready" });
  });
});
