// The registered entries of the comms facade (T-255). Google is the existing Gmail + Google Calendar wiring, unchanged. Microsoft is
// registered but answers `unsupported_op` on every call until its own tasks land (T-256 Graph client and token manager, T-066 connect,
// T-258 mail sync, T-259 live body, T-067 calendar sync): nothing here calls Graph, reads a token or builds a client.
import type { CommsEntry } from "./facade";
import { ConnectorError } from "../contract/errors";

export const MICROSOFT_UNSUPPORTED_MESSAGE = "Microsoft mail and calendar are not available yet";

const unsupported = async (): Promise<never> => {
  throw new ConnectorError({ kind: "unsupported_op", message: MICROSOFT_UNSUPPORTED_MESSAGE });
};

export const microsoftEntry: CommsEntry = Object.freeze({
  provider: "microsoft" as const,
  readBody: unsupported,
  search: unsupported,
  prepareWrite: unsupported,
  mailSync: Object.freeze({ run: unsupported }),
  calendarSync: Object.freeze({ run: unsupported }),
});
