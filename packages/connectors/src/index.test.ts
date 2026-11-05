import { describe, expect, it } from "vitest";
import * as root from "./index";

describe("@nichols/connectors", () => {
  it("exposes its package id", () => {
    expect(root.PACKAGE_ID).toBe("connectors");
  });

  it("exports the read-side contract", () => {
    expect(root.ConnectionSchema).toBeDefined();
    expect(root.SourceResultSchema).toBeDefined();
    expect(root.ConnectorError).toBeDefined();
    expect(root.assertLaneBound).toBeDefined();
  });

  it("does not export the write side, internals or the test kit from the root", () => {
    const names = Object.keys(root);
    expect(names.some((n) => /executeWrite|Writer|ApprovedAction/i.test(n))).toBe(false);
    expect(names.some((n) => /mint|buildProviderSchemas/i.test(n))).toBe(false);
    expect(names.some((n) => /describeConnectorContract|contractChecks|Mock|TestProvider/i.test(n))).toBe(false);
  });
});
