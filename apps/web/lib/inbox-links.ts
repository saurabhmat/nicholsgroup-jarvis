// Links into Jarvis's own inbox (T-234 part 2). "Open" on Home goes here, never to a Google page: the thread view shows the message
// (read live, never stored) and offers "Open in Gmail" from there. The id is Gmail's message id, encoded as one path segment.
import { laneHref } from "@nichols/ui";

export const inboxHref = (laneId: string, messageId: string): string => laneHref(laneId, `inbox/${encodeURIComponent(messageId)}`);
