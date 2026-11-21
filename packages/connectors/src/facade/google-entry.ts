// The Google entry of the comms facade: Gmail and Google Calendar through the existing providers (unchanged behaviour).
import type { LaneBoundConnection } from "../contract/lane-bound";
import { calSync, gmailProvider, mailSync } from "../google/index";
import type { CommsEntry, FacadeConn } from "./facade";

const asGoogle = (conn: FacadeConn) => conn as LaneBoundConnection<"google">;

export const googleEntry: CommsEntry = {
  provider: "google" as const,
  async readBody(laneId, conn, messageId) {
    const res = await gmailProvider.readBody(laneId, asGoogle(conn), messageId);
    // Revealed here, for display to the signed-in user only: the caller renders it as plain text and must not store or log it.
    return { text: res.data.reveal(), truncated: res.data.truncated };
  },
  search: (laneId, conn, query) => gmailProvider.search(laneId, asGoogle(conn), query),
  prepareWrite: (laneId, conn, intent) => gmailProvider.prepareWrite(laneId, asGoogle(conn), intent),
  mailSync: Object.freeze({ run: (laneId: Parameters<typeof mailSync.run>[0], conn: FacadeConn) => mailSync.run(laneId, asGoogle(conn)) }),
  calendarSync: Object.freeze({ run: (laneId: Parameters<typeof calSync.run>[0], conn: FacadeConn) => calSync.run(laneId, asGoogle(conn)) }),
};
Object.freeze(googleEntry);
