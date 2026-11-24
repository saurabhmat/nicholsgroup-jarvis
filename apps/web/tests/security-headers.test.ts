// T-170 (security suite), area 2, findings F-01 (closed by T-299: the tests below now assert the headers) and F-02. `it.fails` pins a known defect: the suite stays green
// while it exists and that test starts FAILING the day the defect is fixed (then remove `.fails`). See docs/security/pilot-test.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

async function headerNames(): Promise<string[]> {
  const rules = (await nextConfig.headers?.()) ?? [];
  return rules.flatMap((r) => r.headers.map((h) => `${h.key.toLowerCase()}`));
}
async function headerValue(key: string): Promise<string> {
  const rules = (await nextConfig.headers?.()) ?? [];
  return rules.flatMap((r) => r.headers).find((h) => h.key.toLowerCase() === key)?.value ?? "";
}

describe("response headers set by the app", () => {
  // F-01 (was MEDIUM, closed by T-299): the app sent no clickjacking or sniffing header. An Approve or a Teams Send is one click for a signed-in person (a Teams send IS the
  // approval, and its authenticator window can be up to 12 hours), and the session cookie is SameSite=Lax, which is per SITE: a page on the same registrable domain could
  // have framed the portal with the session. Now every response forbids framing and sniffing. Production check: report, step 2.
  it("one rule covers every path (pages, API routes, static files)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((r) => r.source)).toEqual(["/:path*"]);
    expect(rules.every((r) => !("has" in r) && !("missing" in r))).toBe(true);
  });
  it("keeps Referrer-Policy", async () => {
    expect(await headerValue("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
  it("F-01: forbids framing by any site, with both headers (frame-ancestors for current browsers, X-Frame-Options for older ones)", async () => {
    expect(await headerValue("x-frame-options")).toBe("DENY");
    const directives = (await headerValue("content-security-policy")).split(";").map((d) => d.trim());
    expect(directives).toContain("frame-ancestors 'none'");
  });
  it("F-01: forbids content sniffing", async () => {
    expect(await headerValue("x-content-type-options")).toBe("nosniff");
  });
  it("sets no header twice and no script or style policy (a full Content-Security-Policy is a separate decision)", async () => {
    const names = await headerNames();
    expect(new Set(names).size).toBe(names.length);
    expect(await headerValue("content-security-policy")).toBe("frame-ancestors 'none'");
  });
  it("a route that sends its own Content-Security-Policy still forbids framing in it (the Teams image route)", () => {
    const text = readFileSync(join(__dirname, "../lib/teams-api.ts"), "utf8");
    const own = [...text.matchAll(/"content-security-policy":\s*"([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(own.length).toBeGreaterThan(0);
    for (const policy of own) expect(policy.split(";").map((d) => d.trim())).toContain("frame-ancestors 'none'");
  });
  it("no route handler or page sets a framing header of its own that could loosen the rule", () => {
    const loose = /x-frame-options["']?\s*[:,]\s*["'](?!DENY)|frame-ancestors\s+(?!'none')/i;
    const roots = [join(__dirname, "../app"), join(__dirname, "../lib"), join(__dirname, "../components"), join(__dirname, "../proxy.ts")];
    const files: string[] = [];
    const walk = (p: string) => {
      if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p);
    };
    for (const r of roots) walk(r);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => loose.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("e-mail code sign-in", () => {
  // F-02 (LOW): the wrong-code counter is kept in an unsigned cookie the client controls: it is not a control at all (delete the cookie, count again). The
  // real limits are the auth server's own verification rate limit, the code's expiry (10 minutes), AAL2 being required for any data, and the TOTP attempt hook
  // core.mfa_verification_attempt (5 failures per 15 minutes, pgTAP 070), which must be enabled in the hosted project (report, step 10).
  it.fails("F-02: the wrong-code counter is not held in a client cookie", () => {
    const text = readFileSync(join(__dirname, "../app/sign-in/actions.ts"), "utf8");
    expect(/cookies\(\)\)\.set\(PENDING, JSON\.stringify\(value\)/.test(text) && /attempts/.test(text)).toBe(false);
  });
});
