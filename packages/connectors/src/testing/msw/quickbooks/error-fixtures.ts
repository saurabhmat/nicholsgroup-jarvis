// Intuit error responses for the QB-14 error map (T-195). HAND-WRITTEN in the shape Intuit documents for the Accounting API
// ({"Fault":{"Error":[{"Message","Detail","code"}],"type"}, "time"}; the gateway's 401 uses lower-case keys) with SYNTHETIC
// values (CLAUDE.md rule 10). No live call recorded these: the exact codes the sandbox returns are confirmed in the QB-14
// manual check. Every body carries a `Detail` with text that looks like customer data on purpose, so a test can prove the
// connector never passes it on.
export const DETAIL_CANARY = "Synthetic Person owes 1234567890 to Synthetic Vendor LLC";

const fault = (code: string, message: string, type: string, element?: string) => ({
  Fault: { Error: [{ Message: message, Detail: `${message}: ${DETAIL_CANARY}`, code, ...(element ? { element } : {}) }], type },
  time: "2026-11-13T10:00:00.000-08:00",
});

export const intuitFixtures = {
  /** 400: a field is missing or refers to something that does not exist (validation, code 2xxx). */
  validation400: { status: 400, body: fault("2500", "Invalid Reference Id", "ValidationFault", "AccountRef") },
  /** 400: a business rule (code 6xxx), e.g. a duplicate name. */
  business400: { status: 400, body: fault("6240", "Duplicate Name Exists Error", "ValidationFault") },
  /** 400: the query could not be parsed (code 4000, QueryParserError). */
  syntax400: { status: 400, body: fault("4000", "QueryParserError: Encountered \"foo\" at line 1, column 15.", "ValidationFault") },
  /** 400 with a code that is not in our map. */
  unknown400: { status: 400, body: fault("9999", "Something else", "ValidationFault") },
  /** 401 from the API gateway: lower-case keys, the token is expired or invalid. */
  auth401: {
    status: 401,
    body: { warnings: null, intuitObject: null, fault: { error: [{ message: "message=AuthenticationFailed; errorCode=003200; statusCode=401", detail: `Token expired: AuthenticationFailed: ${DETAIL_CANARY}`, code: "3200" }], type: "AUTHENTICATION" }, requestId: null, time: 1_794_000_000_000 },
  },
  /** 403: the app is not (or no longer) authorized for this company. */
  appAuthorization403: { status: 403, body: fault("3100", "ApplicationAuthorizationFailed", "AUTHENTICATION") },
  /** 403: the QuickBooks user may not do this (permission). */
  permission403: { status: 403, body: fault("120", "Authorization Failure", "AUTHORIZATION") },
  /** 404: the resource does not exist. */
  notFound404: { status: 404, body: fault("610", "Object Not Found", "ValidationFault") },
  /** 429: ThrottleExceeded. A Retry-After header is added by the test when it needs one. */
  throttle429: { status: 429, body: fault("003001", "message=ThrottleExceeded; errorCode=003001; statusCode=429", "ERROR") },
  /** 500: SystemFault. */
  server500: { status: 500, body: fault("10000", "An application error has occurred while processing your request", "SystemFault") },
  /** 503: the service is down. */
  unavailable503: { status: 503, body: fault("10001", "Service Unavailable", "SystemFault") },
} as const;

export type IntuitFixtureName = keyof typeof intuitFixtures;
