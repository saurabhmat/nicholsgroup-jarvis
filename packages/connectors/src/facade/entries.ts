// The registered entries of the comms facade (T-255). Google is the existing Gmail + Google Calendar wiring, unchanged. Microsoft: the mail
// metadata sync is real since T-258 (it is passed in, so this file builds no client and reads no token itself); every other operation
// answers `unsupported_op` until its own task lands (T-259 live body and search, T-262 writes, T-067 calendar sync).
import type { LaneId } from "@nichols/core";
import type { MailSyncRunResult } from "../comms/mail-sync";
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

/** The Microsoft entry over a mail sync runner (a runner of `microsoft` rows only: the facade has already checked the row's provider). */
export function createMicrosoftEntry(deps: { mailSync: { run(laneId: LaneId, conn: LaneBoundConnection<"microsoft">): Promise<MailSyncRunResult> } }): CommsEntry {
  return Object.freeze({
    provider: "microsoft" as const,
    readBody: unsupported,
    search: unsupported,
    prepareWrite: unsupported,
    mailSync: Object.freeze({ run: (laneId: LaneId, conn: FacadeConn) => deps.mailSync.run(laneId, conn as LaneBoundConnection<"microsoft">) }),
    calendarSync: Object.freeze({ run: unsupported }),
  });
}
