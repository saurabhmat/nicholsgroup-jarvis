import { describe, expect, it } from "vitest";
import { codeChallenge, hashState, laneOfState, newCodeVerifier, newState } from "./pkce";

describe("PKCE and state", () => {
  it("is S256: SHA-256, base64url without padding (checked against the published SHA-256 of \"abc\")", () => {
    const sha256OfAbc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(codeChallenge("abc")).toBe(Buffer.from(sha256OfAbc, "hex").toString("base64url"));
    expect(codeChallenge("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  it("makes 43-character verifiers and lane-prefixed states from fresh randomness", () => {
    const v = newCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCodeVerifier()).not.toBe(v);
    const s = newState("PKG");
    expect(laneOfState(s)).toBe("PKG");
    expect(newState("PKG")).not.toBe(s);
    expect(() => newState("pkg")).toThrow(TypeError);
  });

  it("reads the lane only from a well-formed state", () => {
    for (const bad of [undefined, 42, "", "PKG", "PKG.", "pkg." + "a".repeat(43), "PKG." + "a".repeat(42), "PKG." + "a".repeat(44), "TOOLONGLANE." + "a".repeat(43)]) {
      expect(laneOfState(bad)).toBeNull();
    }
  });

  it("hashes states as lowercase hex SHA-256 (the format core.oauth_states checks)", () => {
    expect(hashState("PKG.x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
