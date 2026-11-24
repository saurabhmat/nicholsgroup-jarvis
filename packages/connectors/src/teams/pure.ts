// `@nichols/connectors/teams-pure` (T-281, T-283, T-284): the Teams reader's PURE parts, with no server-only import, no Vault, no network: the message converter (untrusted HTML -> safe nodes), the unread rule,
// the call rule, the sign-in-name check, the deep-link builders and the types. Safe to import from a component (types, rendering) and from a test. Nothing here reads anything.
export { callBlockReason, chatIsUnread, normalizeTime, upnOf } from "./reader";
export type { AttachmentStub, CallTargets, ChatList, ChatMessage, ChatPreview, MessagePage, TeamsChat, TeamsMember } from "./reader";
export { bodyToNodes, htmlToNodes, nodesToPlainText, safeHttpsUrl, textToNodes } from "./message-html";
export type { MessageNode } from "./message-html";
export { callUrl, openChannelUrl, openChatUrl, openPostUrl } from "./deep-links";
export type { ChannelKind, ChannelList, ChannelPost, ChannelSummary, PostPage, ReplyPage, TeamList, TeamSummary } from "./channels";
export { HOSTED_IMAGE_MAX_BYTES, hostedRefFromSrc, sniffImage } from "./hosted-content";
export type { HostedScope, HostedTarget, ImageType } from "./hosted-content";
export type { HostedImage } from "./images";
// T-288 review C4: the text rules of a Teams send, shared with the composer (one normalisation, one validation).
export { TEAMS_TEXT_MAX_CHARS, TEAMS_TEXT_PROBLEMS, isWellFormedText, normalizeTeamsText, teamsCodePoints, teamsTextProblem, teamsTextProblemCode } from "./send-text";
export type { TeamsTextProblemCode } from "./send-text";
