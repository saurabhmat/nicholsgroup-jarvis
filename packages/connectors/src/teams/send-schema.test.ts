// The target and payload of a Teams send (T-286, T-287): what is accepted and what is not, the normaliser, and that the stored form is exactly what is hashed. Pure.
import { describe, expect, it } from "vitest";
import { TEAMS_ACTION_TYPES, TEAMS_SEND_FEATURE, isTeamsActionType, normalizeTeamsText, parseTeamsSend, teamsProposalContent, teamsTextProblem } from "./send-schema";

const CHAT = "19:abc123def456@thread.v2";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHANNEL = "19:chan123@thread.tacv2";
const REQ = "5e11d0c0-0000-4000-8000-000000000001";
const P = (text: string) => ({ content_type: "text", text });

describe("normalizeTeamsText", () => {
  it("line breaks become newlines, NFC, trimmed; idempotent", () => {
    expect(normalizeTeamsText("  a\r\nb\rc  ")).toBe("a\nb\nc");
    expect(normalizeTeamsText("é")).toBe("é");
    const once = normalizeTeamsText(" \t x\r\ny \n");
    expect(normalizeTeamsText(once)).toBe(once);
  });
});

describe("teamsTextProblem (the same rules as act.teams_shape_ok)", () => {
  it("accepts newline, tab, emoji and exactly 10,000 characters", () => {
    for (const t of ["x", "a\nb\tc", "emoji 😀 ok", "x".repeat(10_000), "😀".repeat(10_000)]) expect(teamsTextProblem(t), t.slice(0, 20)).toBeNull();
  });
  it("refuses empty, blank at the ends, too long, control characters, a carriage return, a lone surrogate, text that is not NFC, and non-strings", () => {
    for (const t of ["", " x", "x ", "\nx", "x".repeat(10_001), "😀".repeat(10_001), "bell\u0007", "nul\u0000", "a\rb", "c1\u0085", "del\u007f", "lone\ud800", "é"]) expect(teamsTextProblem(t), JSON.stringify(t).slice(0, 20)).not.toBeNull();
    for (const t of [null, undefined, 5, {}, ["x"]]) expect(teamsTextProblem(t)).not.toBeNull();
  });
  it("never repeats the text in what it says", () => {
    expect(teamsTextProblem("CANARY\u0007")).not.toContain("CANARY");
  });
});

describe("parseTeamsSend and teamsProposalContent", () => {
  it("round-trips each type: the stored form is exactly the target keys and the payload", () => {
    const cases = [
      ["teams.chat.send", { chat_id: CHAT, client_request_id: REQ }],
      ["teams.channel.post", { team_id: TEAM, channel_id: CHANNEL, client_request_id: REQ }],
      ["teams.channel.reply", { team_id: TEAM, channel_id: CHANNEL, reply_to_id: "1700000000001", client_request_id: REQ }],
    ] as const;
    for (const [type, target] of cases) {
      const send = parseTeamsSend(type, target, P("hello"));
      expect(send, type).not.toBeNull();
      expect(teamsProposalContent(send as NonNullable<typeof send>)).toEqual({ target, payload: P("hello") });
      expect(TEAMS_SEND_FEATURE[type]).toBe(type === "teams.chat.send" ? "chat_send" : "channels_send");
    }
  });
  it("is strict: an extra or missing key, a wrong id, another content type, an extra payload key and unknown types are all refused", () => {
    const chat = { chat_id: CHAT, client_request_id: REQ };
    const bad: [unknown, unknown, unknown][] = [
      ["teams.chat.send", { ...chat, x: "1" }, P("x")], ["teams.chat.send", { chat_id: CHAT }, P("x")], ["teams.chat.send", { ...chat, chat_id: "19:a/b" }, P("x")],
      ["teams.chat.send", { ...chat, client_request_id: REQ.toUpperCase() }, P("x")], ["teams.chat.send", chat, { content_type: "html", text: "x" }], ["teams.chat.send", chat, { ...P("x"), mentions: [] }],
      ["teams.chat.send", chat, { content_type: "text" }], ["teams.channel.post", { team_id: "nope", channel_id: CHANNEL, client_request_id: REQ }, P("x")],
      ["teams.channel.reply", { team_id: TEAM, channel_id: CHANNEL, client_request_id: REQ }, P("x")], ["teams.chat.delete", chat, P("x")], [null, chat, P("x")], ["teams.chat.send", null, P("x")], ["teams.chat.send", chat, null],
    ];
    for (const [t, tg, p] of bad) expect(parseTeamsSend(t, tg, p), JSON.stringify([t, tg]).slice(0, 80)).toBeNull();
  });
  it("lists exactly three types", () => {
    expect([...TEAMS_ACTION_TYPES]).toEqual(["teams.chat.send", "teams.channel.post", "teams.channel.reply"]);
    expect(isTeamsActionType("teams.chat.delete")).toBe(false);
    expect(isTeamsActionType("email.send")).toBe(false);
  });
});
