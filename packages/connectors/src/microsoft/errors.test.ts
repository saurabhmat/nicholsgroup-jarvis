// The Graph error map (T-256): every status leaves as retry, reconnect_required or failed-with-a-fixed-message.
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { classifyGraphFailure, mapGraphError } from "./errors";
import { graphErrorCode } from "./http";

const info = (over: Partial<Parameters<typeof classifyGraphFailure>[0]>) => ({ kind: "provider_error" as const, http_status: null, retry_after_seconds: null, ...over });

describe("classifyGraphFailure", () => {
  it.each([
    [400, "failed"],
    [401, "failed"],
    [403, "failed"],
    [404, "failed"],
    [409, "failed"],
    [410, "failed"],
    [429, "retry"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [504, "retry"],
  ])("%i -> %s", (status, outcome) => {
    expect(classifyGraphFailure(info({ http_status: status })).outcome).toBe(outcome);
  });
  it("timeouts and network failures retry; a reconnect_required stays one", () => {
    expect(classifyGraphFailure(info({ kind: "timeout" })).outcome).toBe("retry");
    expect(classifyGraphFailure(info({ kind: "transient" })).outcome).toBe("retry");
    expect(classifyGraphFailure(info({ kind: "reconnect_required", http_status: 400 })).outcome).toBe("reconnect_required");
  });
  it("no Graph API status is reconnect_required: only the token manager decides that", () => {
    for (const s of [400, 401, 403, 404, 410, 429, 500, 503]) expect(classifyGraphFailure(info({ http_status: s })).outcome).not.toBe("reconnect_required");
  });
  it("keeps the Retry-After for a retry", () => {
    expect(classifyGraphFailure(info({ http_status: 429, retry_after_seconds: 9 })).retryAfterSeconds).toBe(9);
  });
});

describe("mapGraphError", () => {
  it("replaces the message by the fixed one and keeps status, code, request id, Retry-After and endpoint", () => {
    const e = new ConnectorError({ kind: "rate_limited", message: "microsoft GET /me failed with 429", http_status: 429, provider_error_code: "TooManyRequests", provider_tid: "abc-123", retry_after_seconds: 4, endpoint: "/me" });
    const m = mapGraphError(e) as ConnectorError;
    expect(m.info).toMatchObject({ kind: "rate_limited", http_status: 429, provider_error_code: "TooManyRequests", provider_tid: "abc-123", retry_after_seconds: 4, endpoint: "/me" });
    expect(m.message).toMatch(/^Microsoft is limiting requests/);
  });
  it("leaves our own refusals (no HTTP status) and foreign errors untouched", () => {
    const own = new ConnectorError({ kind: "invalid_input", message: "Path is not an allowed Graph path" });
    expect(mapGraphError(own)).toBe(own);
    const foreign = new Error("x");
    expect(mapGraphError(foreign)).toBe(foreign);
  });
  it("a 410 is not_found and keeps its code for the delta sync (T-258)", () => {
    const m = mapGraphError(new ConnectorError({ kind: "not_found", message: "m", http_status: 410, provider_error_code: "syncStateNotFound" })) as ConnectorError;
    expect(m.info).toMatchObject({ kind: "not_found", provider_error_code: "syncStateNotFound" });
  });
});

describe("graphErrorCode", () => {
  it("reads the OAuth `error` string and the Graph `error.code`, nothing else", () => {
    expect(graphErrorCode({ error: "invalid_grant", error_description: "AADSTS70008: secret text", error_codes: [70008] })).toBe("invalid_grant");
    expect(graphErrorCode({ error: { code: "ErrorItemNotFound", message: "secret text" } })).toBe("ErrorItemNotFound");
    expect(graphErrorCode({ error: { message: "only text" } })).toBeUndefined();
    expect(graphErrorCode(null)).toBeUndefined();
    expect(graphErrorCode("nope")).toBeUndefined();
  });
});
