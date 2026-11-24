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
  // F-01 (MEDIUM): no clickjacking, sniffing or transport headers from the app. Mitigated today by SameSite=Lax cookies, the TOTP step-up on every
  // approval, and Vercel's own HSTS on the production domain, so not HIGH.
  it.fails("F-01: forbids framing (X-Frame-Options or CSP frame-ancestors), sniffing (X-Content-Type-Options) and sets a CSP", async () => {
    const names = await headerNames();
    const csp = await headerValue("content-security-policy");
    expect(names).toContain("x-content-type-options");
    expect(names.includes("x-frame-options") || /frame-ancestors/.test(csp)).toBe(true);
    expect(csp).not.toBe("");
  });
});

describe("e-mail code sign-in", () => {
  // F-02 (LOW): the wrong-code counter is kept in an unsigned cookie the client controls, so it can be reset by deleting the cookie. The real limit is
  // Supabase's OTP rate limit (and AAL1 reaches no data), so LOW. The fix is a server-side counter keyed by address.
  it.fails("F-02: the wrong-code counter is not held in a client cookie", () => {
    const text = readFileSync(join(__dirname, "../app/sign-in/actions.ts"), "utf8");
    expect(/cookies\(\)\)\.set\(PENDING, JSON\.stringify\(value\)/.test(text) && /attempts/.test(text)).toBe(false);
  });
});
