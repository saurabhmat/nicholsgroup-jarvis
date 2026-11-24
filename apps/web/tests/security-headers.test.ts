// T-170 (security suite), area 2, findings F-01 (closed by T-299: the tests below now assert the headers) and F-02. `it.fails` pins a known defect: the suite stays green
// while it exists and that test starts FAILING the day the defect is fixed (then remove `.fails`). See docs/security/pilot-test.md.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import nextConfig from "../next.config";

type Rule = { source: string; headers: { key: string; value: string }[] };
const rulesOf = async (): Promise<Rule[]> => ((await nextConfig.headers?.()) ?? []) as Rule[];
/** What the config sends for a path: every matching rule in order, a later rule replacing an earlier one for the same header name (Next's resolve-routes). Each rule is compiled by Next's OWN function (the one the build uses for `headers()`), so the match is the framework's, not this test's idea of it. */
async function configHeaders(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rule of await rulesOf()) {
    if (!new RegExp(buildCustomRoute("header", rule).regex).test(path)) continue;
    for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}
const directives = (policy: string | undefined) => (policy ?? "").split(";").map((d) => d.trim()).filter(Boolean);
const BASE = { "referrer-policy": "strict-origin-when-cross-origin", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff" };
const IMAGE_PATH = "/api/lanes/PKG/messages/image";
/** The headers a source file gives a response itself, read from an object literal by name (the image route's IMAGE_HEADERS). */
function ownHeaders(file: string, name: string): Record<string, string> {
  const text = readFileSync(join(__dirname, file), "utf8");
  const body = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\} as const;`).exec(text)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/"([a-z-]+)":\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1] ?? "", m[2] ?? m[3] ?? ""]));
}
function sourceFiles(): string[] {
  const roots = ["../app", "../lib", "../components", "../proxy.ts", "../../../packages/core/src/auth", "../../../packages/connectors/src", "../../../packages/modules"].map((r) => join(__dirname, r));
  const files: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p) && !/\.test\.[a-z]+$/.test(p) && !/\/(node_modules|dist|testing)\//.test(p)) files.push(p);
  };
  for (const r of roots) walk(r);
  return files;
}

describe("response headers set by the app", () => {
  // F-01 (was MEDIUM, closed in code by T-299): the app sent no clickjacking or sniffing header. An Approve or a Teams Send is one click for a signed-in person (a Teams send
  // IS the approval, and its authenticator window can be up to 12 hours), and the session cookie is SameSite=Lax, which is per SITE: a page on the same registrable domain
  // could have framed the portal with the session. These tests read the CONFIG the framework applies, with the framework's own path matcher; nobody has seen the headers in
  // a browser here: that is the production check (report, step 2).
  it("the rules: one for every path, then the Teams image route and the connect routes (later wins), with no conditions", async () => {
    const rules = await rulesOf();
    expect(rules.map((r) => r.source)).toEqual(["/:path*", "/api/lanes/:laneId/messages/image", "/api/connect/:provider/:step"]);
    expect(rules.every((r) => !("has" in r) && !("missing" in r) && !("basePath" in r) && !("locale" in r))).toBe(true);
    for (const r of rules) expect(new Set(r.headers.map((h) => h.key.toLowerCase())).size).toBe(r.headers.length);
  });
  it.each(["/", "/PKG", "/PKG/messages", "/PKG/messages/", "/sign-in", "/mfa", "/api/lanes/PKG/messages/send", "/api/inngest", "/api/webhooks/microsoft", "/_next/static/chunks/x.js", "/favicon.ico", "/a/b/c/d/e.json"])(
    "F-01: %s gets exactly the four headers: no framing by any site (both headers), no sniffing, and no script or style policy",
    async (path) => {
      expect(await configHeaders(path)).toEqual(BASE);
    },
  );
  it("the Teams image route keeps the general headers and gets its own stricter policy and referrer rule from the config too", async () => {
    const h = await configHeaders(IMAGE_PATH);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(directives(h["content-security-policy"])).toEqual(["default-src 'none'", "sandbox", "frame-ancestors 'none'"]);
    expect(h["referrer-policy"]).toBe("no-referrer");
    // The route below it is not affected.
    expect(await configHeaders("/api/lanes/PKG/messages/image/x")).toEqual(BASE);
  });
  it("whichever side wins (the framework's server keeps the config's value and drops a handler's header of the same name; a host may do the reverse), the image route's browser gets the same value", async () => {
    const config = await configHeaders(IMAGE_PATH);
    const own = ownHeaders("../lib/teams-api.ts", "IMAGE_HEADERS");
    expect(Object.keys(own)).toEqual(expect.arrayContaining(["content-security-policy", "referrer-policy", "x-content-type-options"]));
    const shared = Object.keys(own).filter((k) => k in config);
    expect(shared.sort()).toEqual(["content-security-policy", "referrer-policy", "x-content-type-options"]);
    for (const k of shared) expect(own[k]).toBe(config[k]);
  });
  it.each(["/api/connect/google/start", "/api/connect/google/callback", "/api/connect/microsoft/callback", "/api/connect/teams/start", "/api/connect/composio/callback"])(
    "%s (an OAuth redirect) keeps the general headers and sends no referrer, as its own handler asks",
    async (path) => {
      expect(await configHeaders(path)).toEqual({ ...BASE, "referrer-policy": "no-referrer" });
    },
  );
  it("the connect handlers' own referrer rule equals the config's (whichever side wins)", () => {
    for (const f of ["../../../packages/connectors/src/oauth/handlers.ts", "../../../packages/connectors/src/composio/handlers.ts"]) {
      const own = [...readFileSync(join(__dirname, f), "utf8").matchAll(/"referrer-policy":\s*"([^"]*)"/gi)].map((m) => m[1]);
      expect(own.length).toBeGreaterThan(0);
      expect(new Set(own)).toEqual(new Set(["no-referrer"]));
    }
  });
  it("every Content-Security-Policy the config can send forbids framing", async () => {
    for (const r of await rulesOf()) for (const h of r.headers) if (h.key.toLowerCase() === "content-security-policy") expect(directives(h.value)).toContain("frame-ancestors 'none'");
  });
  it("no other file names a framing, policy or referrer header (comments count too): a handler's copy would be dropped by the framework and the proxy's copy would REPLACE the config's", () => {
    // By name, whatever the value or the quoting (a literal, a variable, a template, set / append / delete): the only places are the config, the image route's own headers and
    // the connect handlers' referrer rule, each kept equal to the config by a test above. A name assembled from pieces ("content-" + "security-policy") is not seen: this is a
    // lint-style guard, and the production check (report, step 2) is the proof of what a browser receives.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const named = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).map((f) => f.slice(f.indexOf("/apps/web/") >= 0 ? f.indexOf("/apps/web/") + 10 : f.indexOf("/packages/") + 1));
    expect(named(/x-frame-options/i)).toEqual([]);
    expect(named(/frame-ancestors/i)).toEqual(["lib/teams-api.ts"]);
    expect(named(/content-security-policy/i)).toEqual(["lib/teams-api.ts"]);
    expect(named(/referrer-policy/i).sort()).toEqual(["lib/teams-api.ts", "packages/connectors/src/composio/handlers.ts", "packages/connectors/src/oauth/handlers.ts"]);
  });
  it("the proxy sets no header of these kinds (its headers replace the config's)", () => {
    const text = readFileSync(join(__dirname, "../proxy.ts"), "utf8");
    expect(/x-frame-options|content-security-policy|frame-ancestors|referrer-policy|x-content-type-options/i.test(text)).toBe(false);
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
