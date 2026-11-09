import { describe, expect, it } from "vitest";
import { originNotice, plainHost } from "./origin-notice";

const APP = "https://portal.example.test";

describe("origin notice", () => {
  it("is null on the app's own host, whatever the case or default port", () => {
    expect(originNotice("portal.example.test", APP)).toBeNull();
    expect(originNotice("PORTAL.example.test", APP)).toBeNull();
    expect(originNotice("portal.example.test:443", APP)).toBeNull();
    expect(originNotice("localhost:3000", "http://localhost:3000")).toBeNull();
  });

  it("names both hosts when the page is on another host (preview or alias)", () => {
    expect(originNotice("jarvis-git-x.vercel.test", APP)).toEqual({ currentHost: "jarvis-git-x.vercel.test", appHost: "portal.example.test", appUrl: "https://portal.example.test" });
    expect(originNotice("portal.example.test:8443", APP)?.currentHost).toBe("portal.example.test:8443");
  });

  it("shows the app URL's origin only: no path, query, credentials or fragment", () => {
    const n = originNotice("other.example.test", "https://user:canary-pass-31@portal.example.test/api/secret-path?token=canary-q#frag");
    expect(n?.appUrl).toBe("https://portal.example.test");
    expect(JSON.stringify(n)).not.toMatch(/canary|secret-path|user/);
  });

  it("says nothing when a host cannot be read or the app URL is unset or not http(s)", () => {
    expect(originNotice(null, APP)).toBeNull();
    expect(originNotice("other.example.test", undefined)).toBeNull();
    expect(originNotice("other.example.test", "not a url")).toBeNull();
    expect(originNotice("other.example.test", "javascript:alert(1)")).toBeNull();
    expect(originNotice("other.example.test", "ftp://portal.example.test")).toBeNull();
  });

  it("only plain hosts pass from a header (no path, query, user info, spaces or markup)", () => {
    expect(plainHost("a.example.test")).toBe("a.example.test");
    expect(plainHost("a.example.test, b.example.test")).toBe("a.example.test");
    for (const bad of ["a.example.test/path", "a.example.test?x=1", "u@a.example.test", "a b", "<b>a</b>", "", "-a.test", "a.test:99999x", "a.example.test#x"]) expect(plainHost(bad), bad).toBeNull();
  });
});
