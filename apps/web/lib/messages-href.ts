// The address of the Messages page for a chat (T-283, T-290, T-295): `?conn=<connection id>&chat=<key>` and, for "More chats", `?more=<cursor>`. The connection id (the person's own; a name, never a
// permission: the page and every route re-check it) is part of the address only for an account's row when the person has two or more usable accounts (`conn` is null otherwise, so the address of
// a one-account page is what it always was). A plain module (no directive, no server import), so the server components and the client list share it.
import { laneHref } from "@nichols/ui";

export const hrefFor = (laneId: string, chatKey: string | null, more: string | null, conn: string | null = null): string => {
  const q = new URLSearchParams();
  if (chatKey && conn) q.set("conn", conn);
  if (chatKey) q.set("chat", chatKey);
  if (more) q.set("more", more);
  const s = q.toString();
  return `${laneHref(laneId, "messages")}${s ? `?${s}` : ""}`;
};
