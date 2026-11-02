// The token vault is reachable only inside packages/connectors (T-033): not from the package root or any subpath.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../index";

describe("token vault boundary", () => {
  it("is not exported from the package root", () => {
    for (const name of ["getToken", "storeToken", "rotateToken", "revokeToken", "createTokenVault", "connectionLoader", "SecretValue", "reveal"]) {
      expect(Object.keys(root)).not.toContain(name);
    }
  });

  it("has no package subpath", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(Object.values(pkg.exports).filter((p) => p.includes("/vault/") || p.includes("/log/"))).toEqual([]);
  });
});
