// T-257: the tenant admin consent link (exact URL, no secret, no state stored) and the return from it. Synthetic values only (rule 10).
import { describe, expect, it, vi } from "vitest";
import { adminConsentState, buildAdminConsentUrl, consentReturn, createMicrosoftConnectInfo, scopesAllowWrites } from "./consent";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const CLIENT = "synthetic-graph-client-id-5521";
const REDIRECT = "https://portal.example.test/api/connect/microsoft/callback";
const READ = ["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"];
const base = { clientId: CLIENT, redirectUri: REDIRECT, cloud: "commercial", tenantIds: [TENANT_A], scopes: READ, laneId: "PKG" };

describe("the link", () => {
  it("is exactly the v2.0 admin consent URL of the lane's one tenant, with the client id, the registered redirect URI, the Graph scopes and the fixed marker", () => {
    const want = `https://login.microsoftonline.com/${TENANT_A}/v2.0/adminconsent?client_id=${CLIENT}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${[
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Calendars.Read",
    ].map(encodeURIComponent).join("+")}&state=PKG.adminconsent`;
    expect(buildAdminConsentUrl(base)).toBe(want);
  });
  it("uses `organizations` when several tenants are listed; never `common` or `consumers`", () => {
    const url = buildAdminConsentUrl({ ...base, tenantIds: [TENANT_A, TENANT_B] }) ?? "";
    expect(new URL(url).pathname).toBe("/organizations/v2.0/adminconsent");
    expect(url).not.toMatch(/\/common\/|\/consumers\//);
  });
  it("asks for the write scopes only when the connect does (the lane's own scope list)", () => {
    const scope = new URL(buildAdminConsentUrl({ ...base, scopes: [...READ, "Mail.ReadWrite", "Mail.Send"] }) ?? "").searchParams.get("scope");
    expect(scope?.split(" ")).toEqual(["User.Read", "Mail.Read", "Calendars.Read", "Mail.ReadWrite", "Mail.Send"].map((s) => `https://graph.microsoft.com/${s}`));
    expect(new URL(buildAdminConsentUrl(base) ?? "").searchParams.get("scope")).not.toMatch(/ReadWrite|Send/);
  });
  it("only the commercial cloud has a link: any other cloud gets none", () => {
    expect(buildAdminConsentUrl({ ...base, cloud: "gcc_high" })).toBeNull();
    expect(buildAdminConsentUrl({ ...base, cloud: "" })).toBeNull();
  });
  it("no link without a valid tenant list, a client id, the app's own callback path or a valid lane", () => {
    expect(buildAdminConsentUrl({ ...base, tenantIds: [] })).toBeNull();
    expect(buildAdminConsentUrl({ ...base, tenantIds: ["common"] })).toBeNull();
    expect(buildAdminConsentUrl({ ...base, tenantIds: [TENANT_A, "not-a-tenant"] })).toBeNull();
    expect(buildAdminConsentUrl({ ...base, clientId: "" })).toBeNull();
    expect(buildAdminConsentUrl({ ...base, redirectUri: "https://portal.example.test/somewhere/else" })).toBeNull();
    expect(buildAdminConsentUrl({ ...base, laneId: "pkg" })).toBeNull();
  });
  it("carries no secret and no per-request value: the same inputs always give the same link, and it holds only the five parameters", () => {
    const a = buildAdminConsentUrl(base);
    expect(buildAdminConsentUrl(base)).toBe(a);
    expect([...new URL(a ?? "").searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state"]);
    expect(a).not.toMatch(/secret|code_challenge|nonce|token/i);
  });
  it("the marker state never looks like a connect state", () => {
    expect(adminConsentState("PKG")).toBe("PKG.adminconsent");
    expect(adminConsentState("PKG")).not.toMatch(/^[A-Z]{1,8}\.[A-Za-z0-9_-]{43}/);
  });
});

describe("the wired builder (link and wording switch from one scope list)", () => {
  type Deps = Parameters<typeof createMicrosoftConnectInfo>[0];
  const deps = () => {
    const client = vi.fn<Deps["client"]>(() => ({ clientId: CLIENT, redirectUri: REDIRECT }));
    const scopesFor = vi.fn<Deps["scopesFor"]>(async () => READ);
    return { client, scopesFor };
  };
  const settings = { cloud: "commercial", tenantIds: [TENANT_A] };
  it("builds the link from the settings it is given; writes is false for the read scopes", async () => {
    const d = deps();
    expect(await createMicrosoftConnectInfo(d)("PKG", settings)).toEqual({ url: buildAdminConsentUrl(base), writes: false });
  });
  it("writes is true exactly when the same scope list that builds the link has Mail.ReadWrite or Mail.Send", async () => {
    const withWrites = [...READ, "Mail.ReadWrite", "Mail.Send"];
    const info = await createMicrosoftConnectInfo({ ...deps(), scopesFor: async () => withWrites })("PKG", settings);
    expect(info.writes).toBe(true);
    expect(new URL(info.url ?? "").searchParams.get("scope")).toMatch(/Mail\.Send/);
    expect(scopesAllowWrites(READ)).toBe(false);
    expect(scopesAllowWrites(["mail.send"])).toBe(true);
  });
  it("a lane on another cloud has no link and reads no client; the wording switch is still from the scopes", async () => {
    const d = deps();
    expect(await createMicrosoftConnectInfo(d)("PKG", { cloud: "gcc_high", tenantIds: [TENANT_A] })).toEqual({ url: null, writes: false });
    expect(d.client).not.toHaveBeenCalled();
  });
  it("a missing environment is no link; an unreadable policy is no link and writes true (never 'read-only' on a guess)", async () => {
    expect(await createMicrosoftConnectInfo({ ...deps(), client: () => { throw new Error("GRAPH_CLIENT_ID missing"); } })("PKG", settings)).toEqual({ url: null, writes: false });
    expect(await createMicrosoftConnectInfo({ ...deps(), scopesFor: async () => { throw new Error("db down"); } })("PKG", settings)).toEqual({ url: null, writes: true });
  });
});

describe("the return", () => {
  const q = (s: string) => new URLSearchParams(s);
  it("a granted return is ok, an error return is not; both name only the lane", () => {
    expect(consentReturn("microsoft", q("admin_consent=True&tenant=whatever&scope=x&state=PKG.adminconsent"))).toEqual({ laneId: "PKG", ok: true });
    expect(consentReturn("microsoft", q("admin_consent=true&state=PKG.adminconsent"))).toEqual({ laneId: "PKG", ok: true });
    expect(consentReturn("microsoft", q("error=access_denied&error_description=AADSTS65004&state=PKG.adminconsent"))).toEqual({ laneId: "PKG", ok: false });
    expect(consentReturn("microsoft", q("state=PKG.adminconsent"))).toEqual({ laneId: "PKG", ok: false });
    expect(consentReturn("microsoft", q("admin_consent=True&error=x&state=PKG.adminconsent"))).toEqual({ laneId: "PKG", ok: false });
    expect(consentReturn("microsoft", q("admin_consent=True&admin_consent=False&state=PKG.adminconsent"))).toEqual({ laneId: "PKG", ok: false });
  });
  it("a request with a `code` (even empty) is never a consent return: it is a connect", () => {
    expect(consentReturn("microsoft", q("admin_consent=True&code=abc&state=PKG.adminconsent"))).toBeNull();
    expect(consentReturn("microsoft", q("admin_consent=True&code=&state=PKG.adminconsent"))).toBeNull();
  });
  it("a real connect state, no state, a doubled state or a malformed marker is not a consent return", () => {
    const real = `PKG.${"A".repeat(43)}`;
    expect(consentReturn("microsoft", q(`admin_consent=True&state=${real}`))).toBeNull();
    expect(consentReturn("microsoft", q(`error=access_denied&state=${real}`))).toBeNull();
    expect(consentReturn("microsoft", q("admin_consent=True"))).toBeNull();
    expect(consentReturn("microsoft", q("admin_consent=True&state=PKG.adminconsent&state=PKG.adminconsent"))).toBeNull();
    for (const s of ["pkg.adminconsent", "PKG.adminconsent.x", "PKG.AdminConsent", "TOOLONGLANE.adminconsent", ".adminconsent", "PKG.adminconsent "]) {
      expect(consentReturn("microsoft", q(`admin_consent=True&state=${encodeURIComponent(s)}`)), s).toBeNull();
    }
  });
  it("only Microsoft has this branch", () => {
    expect(consentReturn("google", q("admin_consent=True&state=PKG.adminconsent"))).toBeNull();
    expect(consentReturn("qbo", q("admin_consent=True&state=PKG.adminconsent"))).toBeNull();
  });
});
