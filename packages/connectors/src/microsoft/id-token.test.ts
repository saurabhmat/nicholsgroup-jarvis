// The id_token rules on their own (T-066, V-6): pure function, no network.
import { describe, expect, it } from "vitest";
import { nonceOf } from "../oauth/pkce";
import { encodeFakeIdToken } from "../testing/msw/microsoft/handlers";
import { checkIdToken, IdTokenRefused } from "./id-token";

const TID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = Date.parse("2026-11-21T12:00:00Z");
const check = { cloud: "commercial" as const, tenantIds: [TID.toUpperCase()], clientId: "client-1", nonce: nonceOf("verifier"), now: NOW };
const claims = (over: Record<string, unknown> = {}) => ({ tid: TID, iss: `https://login.microsoftonline.com/${TID}/v2.0`, aud: "client-1", exp: NOW / 1000 + 60, nonce: nonceOf("verifier"), ...over });
const failure = (token: unknown) => {
  try {
    checkIdToken(token, check);
  } catch (e) {
    expect(e).toBeInstanceOf(IdTokenRefused);
    return (e as IdTokenRefused).failure;
  }
  return null;
};

describe("checkIdToken", () => {
  it("returns only the tenant; the lane's list is compared case-insensitively", () => {
    expect(checkIdToken(encodeFakeIdToken(claims()), check)).toEqual({ tenantId: TID });
  });
  it("refuses with a fixed message that carries nothing from the token", () => {
    try {
      checkIdToken(encodeFakeIdToken(claims({ aud: "secret-audience-value" })), check);
      throw new Error("accepted");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-audience-value");
    }
  });
  it("exp must be strictly in the future; the personal-account tenant is wrong_tenant even when listed", () => {
    expect(failure(encodeFakeIdToken(claims({ exp: NOW / 1000 })))).toBe("invalid");
    expect(failure(encodeFakeIdToken(claims({ exp: NOW / 1000 + 1 })))).toBeNull();
    const personal = "9188040d-6c67-4c5b-b112-36a304b66dad";
    try {
      checkIdToken(encodeFakeIdToken(claims({ tid: personal, iss: `https://login.microsoftonline.com/${personal}/v2.0` })), { ...check, tenantIds: [personal] });
      throw new Error("accepted");
    } catch (e) {
      expect((e as IdTokenRefused).failure).toBe("wrong_tenant");
    }
  });
  it("an empty expected nonce never matches (a flow without a nonce cannot pass)", () => {
    expect(() => checkIdToken(encodeFakeIdToken(claims({ nonce: "" })), { ...check, nonce: "" })).toThrow(IdTokenRefused);
  });
  it("not a string, empty, or not three parts", () => {
    for (const t of [undefined, null, 5, {}, "", "a.b"]) expect(failure(t), String(t)).toBe("invalid");
  });
});
