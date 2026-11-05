// The shared mail/calendar/documents contract (T-062 suite) run against the real Gmail provider, over the fake Google
// (MSW) and in-memory twins of the Vault, connection rows, lane config and mail index. Mocks only (rule 10).
// `persistedContentWrites` is backed by a write spy over every twin store plus log capture (T-062 review), not a constant.
import { afterEach } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { describeCommsContract } from "../testing/comms-contract";
import { createGoogleHarness } from "../testing/google-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeGoogle } from "../testing/msw/google/handlers";

// One fake for the whole file, installed as the server's initial handlers: the suite builds its harness once, lazily,
// and `resetHandlers` after each test keeps only the initial ones.
const fake = createFakeGoogle();
useMockServer(...fake.handlers);
afterEach(() => {
  RateLimiter.resetForTests();
});

describeCommsContract({
  name: "google (gmail)",
  expect: { mail: true, calendar: false, documents: false },
  setup: () => {
    return createGoogleHarness({ fake, mailboxes: { PKG: [] } }).contractHarness();
  },
});
