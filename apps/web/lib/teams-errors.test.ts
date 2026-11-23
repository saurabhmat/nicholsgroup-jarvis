// What a failed Teams read means for the page (T-283): decided from the kind and Retry-After only.
import { describe, expect, it } from "vitest";
import { teamsFailure } from "./teams-errors";

const e = (kind: string, extra: Record<string, unknown> = {}) => ({ info: { kind, message: "Microsoft said: secret chat text", ...extra } });

describe("teamsFailure", () => {
  it("429 is busy with the seconds Microsoft asked for (rounded up, at most five minutes); no seconds is still busy", () => {
    expect(teamsFailure(e("rate_limited", { retry_after_seconds: 7, http_status: 429 }))).toEqual({ kind: "busy", seconds: 7 });
    expect(teamsFailure(e("rate_limited", { retry_after_seconds: 7.2 }))).toEqual({ kind: "busy", seconds: 8 });
    expect(teamsFailure(e("rate_limited", { retry_after_seconds: 99999 }))).toEqual({ kind: "busy", seconds: 300 });
    expect(teamsFailure(e("rate_limited", { retry_after_seconds: null }))).toEqual({ kind: "busy", seconds: null });
    expect(teamsFailure(e("rate_limited", { retry_after_seconds: -3 }))).toEqual({ kind: "busy", seconds: null });
  });
  it("the other kinds", () => {
    expect(teamsFailure(e("reconnect_required"))).toEqual({ kind: "reconnect" });
    expect(teamsFailure(e("not_found"))).toEqual({ kind: "not_found" });
    for (const k of ["forbidden", "connection_unavailable", "unsupported_op"]) expect(teamsFailure(e(k))).toEqual({ kind: "forbidden" });
    for (const k of ["timeout", "transient", "provider_error", "invalid_input", "weird"]) expect(teamsFailure(e(k))).toEqual({ kind: "unavailable" });
  });
  it("anything that is not a connector error is unavailable, and no text of the error is in the result", () => {
    for (const x of [new Error("secret chat text"), null, undefined, "x", 5, {}]) expect(teamsFailure(x)).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(teamsFailure(e("forbidden")))).not.toContain("secret");
  });
});
