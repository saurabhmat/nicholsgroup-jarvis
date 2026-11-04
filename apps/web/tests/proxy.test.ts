import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const refreshSession = vi.fn();
const laneVerdict = vi.fn();
vi.mock("@nichols/core/auth", async (importActual) => {
  const actual = await importActual<typeof import("@nichols/core/auth")>();
  return {
    ...actual, // the real laneSegment and safeNextPath
    refreshSession: (...args: unknown[]) => refreshSession(...args),
    laneVerdict: (...args: unknown[]) => laneVerdict(...args),
    createGuards: () => ({}),
    cookieSessionReader: () => async () => null,
  };
});

const { proxy } = await import("../proxy");

const get = (path: string) => proxy(new NextRequest(new URL(path, "http://127.0.0.1:3100")));

beforeEach(() => {
  refreshSession.mockReset().mockResolvedValue({ signedIn: true, aal: "aal2" });
  laneVerdict.mockReset().mockResolvedValue("allowed");
});

describe("proxy lane check", () => {
  it("passes an allowed lane through and asks for a verdict only for the segment", async () => {
    const res = await get("/PKG/finance");
    expect(res.status).toBe(200);
    expect(laneVerdict).toHaveBeenCalledWith(expect.anything(), "PKG");
  });

  it("answers 404 for a denied lane, with no-store and vary: cookie even when the session was not refreshed", async () => {
    laneVerdict.mockResolvedValue("denied");
    const res = await get("/APK");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("cookie");
    expect(await res.text()).not.toContain("APK");
  });

  it.each(["/robots.txt", "/sitemap.xml", "/.well-known/x", "/manifest.webmanifest", "/%2Ewell-known/security.txt"])("does not treat %s as a lane", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(laneVerdict).not.toHaveBeenCalled();
  });

  it.each(["/pkg", "/%50KG", "/%50KG/finance", "/PKG;--"])("checks %s as a lane id (the real verdict refuses it)", async (path) => {
    await get(path);
    expect(laneVerdict).toHaveBeenCalledTimes(1);
    expect(laneVerdict.mock.calls[0]?.[1]).not.toBe("PKG");
  });

  it("sends signed-out requests to sign-in and AAL1 requests to /mfa without a lane check", async () => {
    refreshSession.mockResolvedValue({ signedIn: false, aal: null });
    expect((await get("/PKG")).headers.get("location")).toContain("/sign-in");
    refreshSession.mockResolvedValue({ signedIn: true, aal: "aal1" });
    expect((await get("/PKG/inbox")).headers.get("location")).toContain("/mfa?next=%2FPKG%2Finbox");
    expect(laneVerdict).not.toHaveBeenCalled();
  });
});
