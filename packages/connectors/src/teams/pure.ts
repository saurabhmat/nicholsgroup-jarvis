// `@nichols/connectors/teams-pure` (T-281, T-283, T-284): the Teams reader's PURE parts, with no server-only import, no Vault, no network: the message converter (untrusted HTML -> safe nodes), the unread rule,
// the call rule, the sign-in-name check, the deep-link builders and the types. Safe to import from a component (types, rendering) and from a test. Nothing here reads anything.
export { callBlockReason, chatIsUnread, normalizeTime, upnOf } from "./reader";
export type { AttachmentStub, CallTargets, ChatList, ChatMessage, ChatPreview, MessagePage, TeamsChat, TeamsMember } from "./reader";
export { bodyToNodes, htmlToNodes, nodesToPlainText, safeHttpsUrl, textToNodes } from "./message-html";
export type { MessageNode } from "./message-html";
export { callUrl, openChatUrl } from "./deep-links";
