// The target and payload of a Teams send (T-286, T-287; docs/specs/messages.md 10.1). Pure: no I/O, no Vault, no network, safe in a test and in the approvals module. The database says the same
// thing in act.teams_shape_ok (SQL); the two are kept in step by tests on both sides.
//   teams.chat.send      target { chat_id, client_request_id }                              feature chat_send
//   teams.channel.post   target { team_id, channel_id, client_request_id }                  feature channels_send
//   teams.channel.reply  target { team_id, channel_id, reply_to_id, client_request_id }     feature channels_send
//   payload { content_type: "text", text }
// `text` is PLAIN TEXT only (rule 9: nothing here ever becomes HTML, a mention, an image or an attachment): 1 to 10,000 characters (code points) after trimming, NFC, at most 80 KB as UTF-8 (Microsoft's
// recommended bound, vendor facts A2), well-formed Unicode, and no control character except newline and tab (so no carriage return: the app writes newline only). Ids are validated in the same
// formats the Teams request templates use, before any request is built.
import type { TeamsFeature } from "@nichols/core/lane-config";
import { z } from "zod";
import { TEAMS_PARAM_FORMATS } from "./constants";
import { TEAMS_TEXT_MAX_CHARS, normalizeTeamsText, teamsTextProblem } from "./send-text";

export const TEAMS_ACTION_TYPES = ["teams.chat.send", "teams.channel.post", "teams.channel.reply"] as const;
export type TeamsActionType = (typeof TEAMS_ACTION_TYPES)[number];
export const isTeamsActionType = (t: unknown): t is TeamsActionType => typeof t === "string" && (TEAMS_ACTION_TYPES as readonly string[]).includes(t);
/** The payload schema version stored with every Teams action (part of the hash). */
export const TEAMS_PAYLOAD_VERSION = 1;
/** The lane policy class in `core.lane_policies.write_actions_allowed` that allows every Teams type. */
export const TEAMS_POLICY_CLASS = "teams_send";
/** The lane feature (`lane_config.teams.features`) and, as `teams_<feature>`, the connection feature each type needs. */
export const TEAMS_SEND_FEATURE: Readonly<Record<TeamsActionType, TeamsFeature>> = Object.freeze({
  "teams.chat.send": "chat_send",
  "teams.channel.post": "channels_send",
  "teams.channel.reply": "channels_send",
});

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The text rules are in ./send-text (pure: the browser runs the same code).
export { TEAMS_TEXT_MAX_CHARS, normalizeTeamsText, teamsTextProblem };

const Text = z.string().superRefine((t, ctx) => {
  const problem = teamsTextProblem(t);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});
const RequestId = z.string().regex(UUID_LOWER);
const ChatId = z.string().regex(TEAMS_PARAM_FORMATS.chatId as RegExp);
const ChannelId = z.string().regex(TEAMS_PARAM_FORMATS.channelId as RegExp);
const TeamId = z.string().regex(TEAMS_PARAM_FORMATS.teamId as RegExp);
const MessageId = z.string().regex(TEAMS_PARAM_FORMATS.messageId as RegExp);

export const TeamsPayloadSchema = z.strictObject({ content_type: z.literal("text"), text: Text });
export const TeamsChatTargetSchema = z.strictObject({ chat_id: ChatId, client_request_id: RequestId });
export const TeamsChannelPostTargetSchema = z.strictObject({ team_id: TeamId, channel_id: ChannelId, client_request_id: RequestId });
export const TeamsChannelReplyTargetSchema = z.strictObject({ team_id: TeamId, channel_id: ChannelId, reply_to_id: MessageId, client_request_id: RequestId });

export type TeamsSend =
  | { type: "teams.chat.send"; chatId: string; clientRequestId: string; text: string }
  | { type: "teams.channel.post"; teamId: string; channelId: string; clientRequestId: string; text: string }
  | { type: "teams.channel.reply"; teamId: string; channelId: string; replyToId: string; clientRequestId: string; text: string };

/** The stored target and payload of a send (exactly what is hashed). */
export type TeamsProposalContent = { target: Record<string, string>; payload: { content_type: "text"; text: string } };

/** Validates a send the app is about to propose. `null`: not valid (never says why with text from the message). The text must already be `normalizeTeamsText`d. */
export function parseTeamsSend(actionType: unknown, target: unknown, payload: unknown): TeamsSend | null {
  const p = TeamsPayloadSchema.safeParse(payload);
  if (!p.success || !isTeamsActionType(actionType)) return null;
  const text = p.data.text;
  switch (actionType) {
    case "teams.chat.send": {
      const t = TeamsChatTargetSchema.safeParse(target);
      return t.success ? { type: actionType, chatId: t.data.chat_id, clientRequestId: t.data.client_request_id, text } : null;
    }
    case "teams.channel.post": {
      const t = TeamsChannelPostTargetSchema.safeParse(target);
      return t.success ? { type: actionType, teamId: t.data.team_id, channelId: t.data.channel_id, clientRequestId: t.data.client_request_id, text } : null;
    }
    case "teams.channel.reply": {
      const t = TeamsChannelReplyTargetSchema.safeParse(target);
      return t.success ? { type: actionType, teamId: t.data.team_id, channelId: t.data.channel_id, replyToId: t.data.reply_to_id, clientRequestId: t.data.client_request_id, text } : null;
    }
  }
}

/** The stored form of a validated send. */
export function teamsProposalContent(send: TeamsSend): TeamsProposalContent {
  const payload = { content_type: "text" as const, text: send.text };
  switch (send.type) {
    case "teams.chat.send":
      return { target: { chat_id: send.chatId, client_request_id: send.clientRequestId }, payload };
    case "teams.channel.post":
      return { target: { team_id: send.teamId, channel_id: send.channelId, client_request_id: send.clientRequestId }, payload };
    case "teams.channel.reply":
      return { target: { team_id: send.teamId, channel_id: send.channelId, reply_to_id: send.replyToId, client_request_id: send.clientRequestId }, payload };
  }
}
