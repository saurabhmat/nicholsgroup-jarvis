// What the browser's address says about the Messages screen (T-296; spec docs/specs/messages.md 11, 22.6). Plain functions (no directive): the client scope (components/messages-scope.tsx) and the
// server components share them. A chat KEY and a connection id in the address are names, never permissions: the page and every route re-check them.
import { isConnId } from "./teams-accounts";
import { decodeChannelKey, isTeamId } from "./teams-channel-key";
import { decodeChatKey } from "./teams-chat-key";

export type MessagesTab = "chats" | "channels";
/** `list`: the chat list (a phone shows it alone); `chat`: a conversation is open (a phone shows it alone); `channels`: the Channels tab (its own two panes). */
export type MessagesView = { tab: MessagesTab; view: "list" | "chat" | "channels"; /** A chat, or a channel's posts, has the screen on a phone. */ open: boolean; /** The open chat's key (valid shape) on the Chats tab. */ chatKey: string | null; /** The account named for it, when the address names one. */ conn: string | null };

/** `?tab=channels` opens the Channels tab; anything else is Chats (as before). */
export const tabOf = (v: string | string[] | undefined | null): MessagesTab => (v === "channels" ? "channels" : "chats");

type Query = { get(name: string): string | null };

/**
 * Pure (the tests call it): the screen state from the address. `chatConns`: the ids of the person's usable accounts, as the server computed them for this page (the same rule as the page's
 * `openAccountOf`): a chat opens as the account `conn` names, or, with no `conn`, only when the person has exactly one. A chat that no account opens leaves the list on the screen.
 */
export function viewOf(q: Query, chatConns: readonly string[]): MessagesView {
  const tab = tabOf(q.get("tab"));
  if (tab === "channels") {
    const open = isTeamId(q.get("team")) && decodeChannelKey(q.get("channel")) !== null;
    return { tab, view: "channels", open, chatKey: null, conn: null };
  }
  const key = q.get("chat");
  const conn = q.get("conn");
  const shaped = decodeChatKey(key) !== null;
  const connOk = conn === null ? chatConns.length === 1 : isConnId(conn) && chatConns.includes(conn);
  const open = shaped && connOk;
  return { tab, view: open ? "chat" : "list", open, chatKey: shaped ? key : null, conn: conn !== null && isConnId(conn) ? conn : null };
}
