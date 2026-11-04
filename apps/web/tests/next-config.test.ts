// T-050 security L4: NEXT_DIST_DIR is honoured only as exactly ".next-canary", and never on Vercel.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function distDir(env: Record<string, string | undefined>): Promise<string | undefined> {
  vi.resetModules();
  vi.stubEnv("NEXT_DIST_DIR", env.NEXT_DIST_DIR ?? "");
  vi.stubEnv("VERCEL", env.VERCEL ?? "");
  const mod = await import("../next.config");
  return mod.default.distDir;
}

describe("next.config distDir", () => {
  it("is the default when NEXT_DIST_DIR is unset", async () => {
    expect(await distDir({})).toBeUndefined();
  });

  it("honours exactly .next-canary off Vercel", async () => {
    expect(await distDir({ NEXT_DIST_DIR: ".next-canary" })).toBe(".next-canary");
  });

  it.each(["public/x", ".next-canary/", ".next", "../x", ".next-canary2", "/tmp/x", " .next-canary"])("ignores %s", async (value) => {
    expect(await distDir({ NEXT_DIST_DIR: value })).toBeUndefined();
  });

  it("ignores even .next-canary on Vercel", async () => {
    expect(await distDir({ NEXT_DIST_DIR: ".next-canary", VERCEL: "1" })).toBeUndefined();
  });
});
