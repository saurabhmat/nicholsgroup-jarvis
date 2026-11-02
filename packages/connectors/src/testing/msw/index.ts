// MSW harness for connector tests (T-034): `@nichols/connectors/testing/msw`. One folder per provider holds that
// provider's base URLs and request handlers; connector tests start a server with the handlers they need. Unhandled
// requests fail the test, so no test can reach a real provider (CLAUDE.md rule 10: mocks and sandboxes only): the
// request itself errors, and because connector code may catch that (the HTTP client turns it into a ConnectorError),
// the test also fails in afterEach. A test that expects an unmocked request calls `takeUnhandled()` to claim it.
import type { RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

export { delay, http, HttpResponse } from "msw";
export * as quickbooks from "./quickbooks/handlers";
export * as stripe from "./stripe/handlers";
export * as gohighlevel from "./gohighlevel/handlers";
export * as google from "./google/handlers";
export * as microsoft from "./microsoft/handlers";
export * as monday from "./monday/handlers";
export * as notion from "./notion/handlers";

/** A mock server for one test file: listens before all tests, resets handlers after each, closes after all. */
export function useMockServer(...handlers: RequestHandler[]) {
  const server = setupServer(...handlers);
  let unhandled = 0;
  beforeAll(() =>
    server.listen({
      // MSW 3: in a callback, `defaults.error()` only prints; rejecting is what blocks the request.
      onUnhandledFrame: async ({ defaults }) => {
        unhandled += 1;
        await defaults.error();
        throw new Error("Unmocked request blocked (CLAUDE.md rule 10)");
      },
    }),
  );
  afterEach(() => {
    server.resetHandlers();
    const n = unhandled;
    unhandled = 0;
    if (n > 0) throw new Error(`${n} request(s) had no mock handler; tests must not reach the network`);
  });
  afterAll(() => server.close());
  /** Unmocked requests since the last check, reset to zero (for a test that expects one). */
  const takeUnhandled = () => {
    const n = unhandled;
    unhandled = 0;
    return n;
  };
  return Object.assign(server, { takeUnhandled });
}
