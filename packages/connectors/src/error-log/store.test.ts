// The error-log store (T-196): inserts the scrubbed row for the lane and connection with the lane's job client; a failure leaves with
// a fixed message and none of the database's text.
import { describe, expect, it } from "vitest";
import { createApiErrorStore } from "./store";
import type { ScrubbedApiError } from "./scrub";

const ROW: ScrubbedApiError = { provider: "quickbooks", endpoint: "/v3/company/{realm}/query", http_status: 400, provider_error_code: "2500", provider_message: "m", provider_tid: "t", kind: "invalid_input", disposition: "fail", retry_after_seconds: null };

describe("createApiErrorStore", () => {
  it("inserts into core.connector_api_errors with the lane and connection", async () => {
    const calls: unknown[] = [];
    const client = { schema: (s: string) => ({ from: (t: string) => ({ insert: async (v: unknown) => { calls.push({ s, t, v }); return { error: null }; } }) }) };
    await createApiErrorStore(async () => client as never).insert("PKG", "00000000-0000-4000-8000-000000009601", ROW);
    expect(calls).toEqual([{ s: "core", t: "connector_api_errors", v: { lane_id: "PKG", connection_id: "00000000-0000-4000-8000-000000009601", ...ROW } }]);
  });
  it("a database error or an unavailable lane leaves with a fixed message", async () => {
    const failing = { schema: () => ({ from: () => ({ insert: async () => ({ error: { message: "row (jane@example.test) violates check" } }) }) }) };
    await expect(createApiErrorStore(async () => failing as never).insert("PKG", "c", ROW)).rejects.toThrow("connector api error store unavailable");
    await expect(createApiErrorStore(async () => { throw new Error("no lane jane@example.test"); }).insert("PKG", "c", ROW)).rejects.toThrow("connector api error store unavailable");
  });
});
