// The address of the Messages page for a chat (T-283, T-290): `?chat=<key>` and, for "More chats", `?more=<cursor>`. A plain module (no directive, no server import), so the server components and
// the client list share it.
import { laneHref } from "@nichols/ui";

export const hrefFor = (laneId: string, chatKey: string | null, more: string | null): string => {
  const q = new URLSearchParams();
  if (chatKey) q.set("chat", chatKey);
  if (more) q.set("more", more);
  const s = q.toString();
  return `${laneHref(laneId, "messages")}${s ? `?${s}` : ""}`;
};
