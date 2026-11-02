// MSW harness for connector tests (T-034): `@nichols/connectors/testing/msw`. One folder per provider holds that
// provider's base URLs and request handlers; connector tests start a server with the handlers they need. Unhandled
// requests fail the test, so no test can reach a real provider (CLAUDE.md rule 10: mocks and sandboxes only).
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
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}
