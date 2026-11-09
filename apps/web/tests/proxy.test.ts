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
    createGuards: (read: () => Promise<unknown>) => ({ read }),
  };
});

const onboardingVerdict = vi.fn();
vi.mock("@/lib/onboarding-gate", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/onboarding-gate")>();
  return { ...actual, onboardingVerdict: (...args: unknown[]) => onboardingVerdict(...args) }; // the real isOnboardingPath
});

const { proxy, config } = await import("../proxy");

const get = (path: string) => proxy(new NextRequest(new URL(path, "http://127.0.0.1:3100")));

beforeEach(() => {
  refreshSession.mockReset().mockResolvedValue({ signedIn: true, aal: "aal2" });
  laneVerdict.mockReset().mockResolvedValue("allowed");
  onboardingVerdict.mockReset().mockResolvedValue("allowed");
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

describe("proxy onboarding check (H-042: a real 404 before streaming)", () => {
  it.each(["/PKG/onboarding", "/PKG/onboarding?step=A-1", "/PKG/onboarding/", "/PKG/%6Fnboarding"])("answers 404 for %s when the user lacks the owner role or brain view", async (path) => {
    onboardingVerdict.mockResolvedValue("denied");
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(onboardingVerdict).toHaveBeenCalledWith(expect.anything(), "PKG");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("cookie");
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).not.toMatch(/onboarding|brain|wizard/i); // the same body as any refused page
  });

  it("passes an owner with the brain view through", async () => {
    expect((await get("/PKG/onboarding")).status).toBe(200);
  });

  it("passes an unknown verdict (outage) through: the page decides and renders nothing for a non-owner", async () => {
    onboardingVerdict.mockResolvedValue("unknown");
    expect((await get("/PKG/onboarding")).status).toBe(200);
  });

  it("asks only for onboarding paths; there it replaces the lane verdict (its role check includes the lane)", async () => {
    for (const path of ["/PKG", "/PKG/settings", "/PKG/assistant", "/PKG/onboardingx", "/onboarding"]) await get(path);
    expect(onboardingVerdict).not.toHaveBeenCalled();
    laneVerdict.mockClear();
    onboardingVerdict.mockResolvedValue("denied"); // a lane the user cannot open is "forbidden" from requireRole too
    expect((await get("/APK/onboarding")).status).toBe(404);
    expect(onboardingVerdict).toHaveBeenCalledWith(expect.anything(), "APK");
    expect(laneVerdict).not.toHaveBeenCalled();
  });

  it("does not check signed-out or AAL1 requests (they are redirected first)", async () => {
    refreshSession.mockResolvedValue({ signedIn: false, aal: null });
    expect((await get("/PKG/onboarding")).status).toBe(307);
    refreshSession.mockResolvedValue({ signedIn: true, aal: "aal1" });
    expect((await get("/PKG/onboarding")).status).toBe(307);
    expect(onboardingVerdict).not.toHaveBeenCalled();
  });
});

describe("proxy reuse and timing (T-230 A)", () => {
  it("builds the guards from the session refreshSession verified (no second read)", async () => {
    const session = { userId: "u1", accessToken: "tok", aal: "aal2", mfaVerifiedAt: null };
    refreshSession.mockResolvedValue({ signedIn: true, aal: "aal2", session });
    await get("/PKG/finance");
    const guardsArg = laneVerdict.mock.calls[0]?.[0] as { read: () => Promise<unknown> };
    expect(await guardsArg.read()).toBe(session);
  });

  it("skips the status-only lane check for script fetches (client navigations and prefetches: Sec-Fetch-Dest empty); the page still checks", async () => {
    const res = await proxy(new NextRequest(new URL("/PKG/finance", "http://127.0.0.1:3100"), { headers: { "sec-fetch-dest": "empty" } }));
    expect(res.status).toBe(200);
    expect(laneVerdict).not.toHaveBeenCalled();
    // A document load, and a request with no Sec-Fetch headers at all, are still checked: a denied lane is still a 404.
    laneVerdict.mockResolvedValue("denied");
    expect((await get("/PKG/finance")).status).toBe(404);
    const doc = await proxy(new NextRequest(new URL("/PKG/finance", "http://127.0.0.1:3100"), { headers: { "sec-fetch-dest": "document" } }));
    expect(doc.status).toBe(404);
    const onboarding = await proxy(new NextRequest(new URL("/PKG/onboarding", "http://127.0.0.1:3100"), { headers: { "sec-fetch-dest": "empty" } }));
    expect(onboarding.status).toBe(200);
    expect(onboardingVerdict).not.toHaveBeenCalled();
  });

  it("sets Server-Timing (names and durations only) when enabled, and never when it is not", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_TIMING", "");
    expect((await get("/PKG")).headers.get("server-timing")).toBeNull();
    vi.stubEnv("SERVER_TIMING", "1");
    const header = (await get("/PKG")).headers.get("server-timing");
    expect(header).toMatch(/^proxy\.auth;dur=[\d.]+, proxy\.lane;dur=[\d.]+$/);
    laneVerdict.mockResolvedValue("denied");
    expect((await get("/APK")).headers.get("server-timing")).toMatch(/^proxy\.auth;dur=/);
    vi.unstubAllEnvs();
  });
});

describe("proxy matcher (T-036)", () => {
  const matches = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

  it("does not run for provider webhooks, which carry no session", () => {
    expect(matches("/api/webhooks/quickbooks")).toBe(false);
    expect(matches("/api/webhooks/stripe/")).toBe(false);
  });

  it("still runs for other API routes and pages", () => {
    expect(matches("/api/connect/quickbooks/start")).toBe(true);
    expect(matches("/api/webhooksx")).toBe(true);
    expect(matches("/PKG/finance")).toBe(true);
  });
});
