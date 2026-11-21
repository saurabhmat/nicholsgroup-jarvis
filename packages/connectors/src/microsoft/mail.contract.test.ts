// The shared comms contract (T-062 suite) run against the REAL Microsoft mail provider, over the fake Graph (MSW) and in-memory twins of the Vault,
// connection rows, lane config and mail index (T-258). Mocks only (rule 10). `readBody` and `search` are real since T-259 and run the normal contract tests; `prepareWrite` (T-262) is declared
// unsupported: the suite checks it is guarded first and then answers `unsupported_op` with no request and no token read. Calendar is T-067.
import { afterEach } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { describeCommsContract } from "../testing/comms-contract";
import { createMicrosoftMailHarness } from "../testing/microsoft-mail-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMail } from "../testing/msw/microsoft/mail";

const fake = createFakeMicrosoft();
const mail = createFakeMail(fake);
useMockServer(...fake.handlers, ...mail.handlers);
afterEach(() => {
  RateLimiter.resetForTests();
});

describeCommsContract({
  name: "microsoft (graph mail)",
  expect: { mail: true, calendar: false, documents: false },
  unsupportedMail: ["prepareWrite"],
  setup: () => createMicrosoftMailHarness({ fake, mail, headerFlags: {} }).contractHarness(),
});
