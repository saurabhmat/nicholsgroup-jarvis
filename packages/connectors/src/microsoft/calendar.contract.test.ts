// The shared comms contract (T-062 suite) run against the REAL Microsoft calendar provider, over the fake Graph (MSW) and in-memory twins of the Vault,
// connection rows, lane config and calendar index (T-067). Mocks only (rule 10). Microsoft reports a deleted event as a removal, not a cancelled stub, so the
// suite runs with `removedEventsAreStubs: false`; `prepareWrite` is unsupported (phase 4) and the suite checks it is guarded first.
import { afterEach } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { describeCommsContract } from "../testing/comms-contract";
import { attachMicrosoftCalendar } from "../testing/microsoft-calendar-harness";
import { createMicrosoftMailHarness } from "../testing/microsoft-mail-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeCalendar } from "../testing/msw/microsoft/calendar";
import { createFakeMail } from "../testing/msw/microsoft/mail";

const fake = createFakeMicrosoft();
const mail = createFakeMail(fake);
const cal = createFakeCalendar(fake);
useMockServer(...fake.handlers, ...mail.handlers, ...cal.handlers);
afterEach(() => {
  RateLimiter.resetForTests();
});

describeCommsContract({
  name: "microsoft (graph calendar)",
  expect: { mail: false, calendar: true, documents: false },
  setup: () => attachMicrosoftCalendar(createMicrosoftMailHarness({ fake, mail }), cal).contractHarness(),
});
