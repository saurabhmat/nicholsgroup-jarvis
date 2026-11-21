import "server-only";
// `@nichols/connectors/facade` (T-255): the provider-agnostic comms entry points for apps and modules, wired over the real Vault,
// lane router and lane config. Server-only: importing it from a client component fails the build. It dispatches by the
// authoritative connection row's provider (see ./facade.ts) and checks the lane's enabled providers before any token read.
import { connectionLoader, laneConfigReader } from "../vault/index";
import { googleEntry } from "./google-entry";
import { microsoftCalendarSync, microsoftMailProvider, microsoftMailSync } from "../microsoft/index";
import { createMicrosoftEntry } from "./entries";
import { createCommsFacade } from "./facade";
import { createProviderGate } from "./gate";

export const providerGate = createProviderGate({ laneConfig: laneConfigReader });
export const commsFacade = createCommsFacade({ loader: connectionLoader, gate: providerGate, entries: { google: googleEntry, microsoft: createMicrosoftEntry({ mailSync: microsoftMailSync, mail: microsoftMailProvider, calendarSync: microsoftCalendarSync }) } });

export const { readBody, search, prepareEmailWrite, syncMail, syncCalendar, syncRunners } = commsFacade;
export { PROVIDER_DISABLED_MESSAGE, isProviderDisabledError } from "./gate";
export { laneMailboxes, mailboxAllowed } from "../google/index";
