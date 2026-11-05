import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeNextPath } from "@nichols/core/auth";
import { mfaPath } from "@/lib/mfa-path";

// A plain function behind a spy: vitest 5 reports an error thrown inside a vi.fn() as the test's failure even when the
// code under test catches it.
let lanesImpl: () => Promise<unknown> = async () => [];
const listLanes = vi.fn(() => lanesImpl());
vi.mock("@/lib/guards", () => ({ guards: async () => ({ listLanes }) }));
const { landingPath } = await import("@/lib/landing");

const lanes = (value: unknown) => {
  lanesImpl = async () => value;
};
beforeEach(() => {
  listLanes.mockClear();
  lanes([]);
});

describe("landingPath", () => {
  it("resolves the entry page, with or without a query, to the first allowed lane", async () => {
    lanes([{ laneId: "PKG", name: "x" }, { laneId: "APK", name: "y" }]);
    expect(await landingPath("/")).toBe("/PKG");
    expect(await landingPath("/?utm=1")).toBe("/PKG");
  });

  it("keeps a deep link as it is, without asking for lanes", async () => {
    expect(await landingPath("/PKG/inbox?thread=1")).toBe("/PKG/inbox?thread=1");
    expect(listLanes).not.toHaveBeenCalled();
  });

  it("falls back to the entry page when the user has no lane", async () => {
    lanes([]);
    expect(await landingPath("/")).toBe("/");
  });

  it("falls back to the entry page when lanes cannot be read", async () => {
    lanesImpl = async () => {
      throw new Error("outage");
    };
    expect(await landingPath("/")).toBe("/");
  });

  it("neutralises //evil.example through safeNextPath before it gets here", async () => {
    const next = safeNextPath("//evil.example/x");
    expect(next).toBe("/");
    lanes([{ laneId: "PKG", name: "x" }]);
    expect(await landingPath(next)).toBe("/PKG");
  });
});

describe("mfaPath", () => {
  it("is /mfa for the entry page and carries any other return path", () => {
    expect(mfaPath("/")).toBe("/mfa");
    expect(mfaPath("/PKG/inbox")).toBe("/mfa?next=%2FPKG%2Finbox");
    expect(mfaPath("/PKG/inbox?a=1&b=2")).toBe("/mfa?next=%2FPKG%2Finbox%3Fa%3D1%26b%3D2");
  });

  it("ends at /mfa with no next for an open-redirect attempt", () => {
    expect(mfaPath(safeNextPath("//evil.example"))).toBe("/mfa");
    expect(mfaPath(safeNextPath("https://evil.example/"))).toBe("/mfa");
  });
});
