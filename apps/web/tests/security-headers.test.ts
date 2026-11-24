// T-170 (security suite), area 2, finding F-01 and F-02. `it.fails` pins a known defect: the suite stays green while it exists and this test
// starts FAILING the day the defect is fixed (then remove `.fails`). See docs/security/pilot-test.md.
import { readFileSync } from "node:fs";
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
  it("sets Referrer-Policy (the one header it sets today)", async () => {
    expect(await headerNames()).toContain("referrer-policy");
  });
  // F-01 (MEDIUM): no clickjacking, sniffing or transport headers from the app. The barriers today: the session cookie is SameSite=Lax, which is per SITE,
  // so a page on another SITE cannot frame the portal with the signed-in session, but ANY page on the same registrable domain (a sibling sub-domain) could.
  // Email approvals also need a fresh authenticator code (30 to 900 s), but a Teams send IS the approval and its code window can be up to 12 hours (8 hours
  // in production), so the code is not a second barrier there. The rating becomes HIGH if the portal is ever served from a domain shared with pages that are
  // not fully controlled. The header fix is product code (its own task); this pin turns red the day it lands (then remove `.fails`).
  it.fails("F-01: forbids framing (X-Frame-Options or CSP frame-ancestors), sniffing (X-Content-Type-Options) and sets a CSP", async () => {
    const names = await headerNames();
    const csp = await headerValue("content-security-policy");
    expect(names).toContain("x-content-type-options");
    expect(names.includes("x-frame-options") || /frame-ancestors/.test(csp)).toBe(true);
    expect(csp).not.toBe("");
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
