// The registered entries of the comms facade (T-255). Google is the existing Gmail + Google Calendar wiring, unchanged. Microsoft: the mail
// metadata sync is real since T-258, the live body and search since T-259 and the calendar sync since T-067 (they are passed in, so this file builds no
// client and reads no token itself); since T-262 `prepareWrite` builds the proposal payload (it makes no request). Every other operation answers `unsupported_op`.
import type { LaneId } from "@nichols/core";
import type { CalendarSyncRunResult } from "../comms/cal-sync";
import type { MailSyncRunResult } from "../comms/mail-sync";
import type { MailProvider } from "../comms/provider";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { CommsEntry, FacadeConn } from "./facade";
import { ConnectorError } from "../contract/errors";

export const MICROSOFT_UNSUPPORTED_MESSAGE = "Microsoft mail and calendar are not available yet";

const unsupported = async (): Promise<never> => {
  throw new ConnectorError({ kind: "unsupported_op", message: MICROSOFT_UNSUPPORTED_MESSAGE });
};

/**
 * The Microsoft entry with NO runner wired: every call answers `unsupported_op`. It is what the facade had before T-258 and is kept for tests and
 * for any build without the Graph wiring; the facade in `./index.ts` uses `createMicrosoftEntry` below.
 */
export const microsoftEntry: CommsEntry = Object.freeze({
  provider: "microsoft" as const,
  readBody: unsupported,
  search: unsupported,
  prepareWrite: unsupported,
  mailSync: Object.freeze({ run: unsupported }),
  calendarSync: Object.freeze({ run: unsupported }),
});

/**
 * The Microsoft entry over a mail sync runner, (T-259) the mail provider's live reads and (T-067) a calendar sync runner. All are for `microsoft` rows only: the
 * facade has already checked the row's provider and the owner, and the provider runs its own guard again. Without `mail` the live reads answer `unsupported_op`;
 * without `calendarSync` the calendar stream does.
 */
export function createMicrosoftEntry(deps: {
  mailSync: { run(laneId: LaneId, conn: LaneBoundConnection<"microsoft">): Promise<MailSyncRunResult> };
  mail?: Pick<MailProvider<"microsoft">, "readBody" | "search" | "prepareWrite">;
  calendarSync?: { run(laneId: LaneId, conn: LaneBoundConnection<"microsoft">): Promise<CalendarSyncRunResult> };
}): CommsEntry {
  const calendarSync = deps.calendarSync;
  const mail = deps.mail;
  return Object.freeze({
    provider: "microsoft" as const,
    readBody: mail
      ? async (laneId: LaneId, conn: FacadeConn, messageId: string) => {
          const res = await mail.readBody(laneId, conn as LaneBoundConnection<"microsoft">, messageId);
          // Revealed here, for display to the signed-in user only: the caller renders it as plain text and must not store or log it.
          return { text: res.data.reveal(), truncated: res.data.truncated };
        }
      : unsupported,
    search: mail ? (laneId: LaneId, conn: FacadeConn, query: Parameters<CommsEntry["search"]>[2]) => mail.search(laneId, conn as LaneBoundConnection<"microsoft">, query) : unsupported,
    prepareWrite: mail ? (laneId: LaneId, conn: FacadeConn, intent: Parameters<CommsEntry["prepareWrite"]>[2]) => mail.prepareWrite(laneId, conn as LaneBoundConnection<"microsoft">, intent) : unsupported,
    mailSync: Object.freeze({ run: (laneId: LaneId, conn: FacadeConn) => deps.mailSync.run(laneId, conn as LaneBoundConnection<"microsoft">) }),
    calendarSync: Object.freeze({ run: calendarSync ? (laneId: LaneId, conn: FacadeConn) => calendarSync.run(laneId, conn as LaneBoundConnection<"microsoft">) : unsupported }),
  });
}
