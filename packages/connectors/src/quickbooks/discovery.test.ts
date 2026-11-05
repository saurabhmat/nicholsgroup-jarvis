// Discovery (QB-5): endpoints come from Intuit's OpenID discovery document for the environment, are cached, and only
// intuit.com https endpoints are accepted. Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../http/rate-limit";
import { createFakeIntuit, DISCOVERY_ORIGIN, discoveryDocument, OAUTH_TOKEN, REVOKE_URL, AUTHORIZE_URL } from "../testing/msw/quickbooks/handlers";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { createDiscovery, parseDiscoveryDocument } from "./discovery";
import { ConnectorError } from "../contract/errors";
import { createHttpClient } from "../http/client";
import { createConnectorLogger } from "../log/index";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const fast = (laneId: string) => createHttpClient({ provider: "quickbooks", baseUrl: DISCOVERY_ORIGIN, laneId, requestIdHeader: "intuit_tid", retryBaseMs: 1, retryMaxMs: 2, logger: createConnectorLogger({ sink: () => undefined }) });

describe("discovery document", () => {
  it("reads the sandbox document for INTUIT_ENVIRONMENT=sandbox and the production one for production", async () => {
    const fake = createFakeIntuit();
    server.use(...fake.handlers);
    const seen: string[] = [];
    server.events.on("request:start", ({ request }) => seen.push(new URL(request.url).pathname));
    const d = createDiscovery();
    expect(await d.get("PKG", "sandbox")).toEqual({ authorization: AUTHORIZE_URL, token: OAUTH_TOKEN, revocation: REVOKE_URL });
    expect(await d.get("PKG", "production")).toEqual({ authorization: AUTHORIZE_URL, token: OAUTH_TOKEN, revocation: REVOKE_URL });
    expect(seen).toEqual(["/.well-known/openid_sandbox_configuration", "/.well-known/openid_configuration"]);
  });

  it("caches per environment, shares one in-flight request, and refetches after the TTL", async () => {
    const fake = createFakeIntuit();
    server.use(...fake.handlers);
    const clock = { t: 1_000_000 };
    const d = createDiscovery({ now: () => clock.t });
    await Promise.all([d.get("PKG", "sandbox"), d.get("PKG", "sandbox"), d.get("APK", "sandbox")]);
    expect(fake.state.discoveryRequests).toBe(1);
    await d.get("PKG", "sandbox");
    expect(fake.state.discoveryRequests).toBe(1);
    clock.t += 23 * 3600_000;
    await d.get("PKG", "sandbox");
    expect(fake.state.discoveryRequests).toBe(1);
    clock.t += 2 * 3600_000;
    await d.get("PKG", "sandbox");
    expect(fake.state.discoveryRequests).toBe(2);
  });

  it("keeps serving a recent copy when Intuit cannot be reached, and gives up after a week", async () => {
    const fake = createFakeIntuit();
    server.use(...fake.handlers);
    const clock = { t: 1_000_000 };
    const d = createDiscovery({ now: () => clock.t, http: fast });
    const first = await d.get("PKG", "sandbox");
    server.use(http.get(`${DISCOVERY_ORIGIN}/.well-known/openid_sandbox_configuration`, () => new HttpResponse(null, { status: 503 })));
    clock.t += 30 * 3600_000;
    expect(await d.get("PKG", "sandbox")).toEqual(first);
    clock.t += 8 * 24 * 3600_000;
    await expect(d.get("PKG", "sandbox")).rejects.toBeInstanceOf(ConnectorError);
  });

  it("refuses an unknown environment", async () => {
    await expect(createDiscovery().get("PKG", "staging" as never)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
  });
});

describe("parseDiscoveryDocument", () => {
  const good = discoveryDocument();
  it("accepts the real shape", () => {
    expect(parseDiscoveryDocument(good).token).toBe(OAUTH_TOKEN);
  });

  it.each([
    ["http authorization", { authorization_endpoint: "http://appcenter.intuit.com/connect/oauth2" }],
    ["foreign token host", { token_endpoint: "https://evil.example.test/oauth2/v1/tokens/bearer" }],
    ["lookalike host", { token_endpoint: "https://oauth.platform.intuit.com.evil.test/x" }],
    ["suffix lookalike", { revocation_endpoint: "https://notintuit.com/revoke" }],
    ["userinfo in URL", { token_endpoint: "https://user:pw@oauth.platform.intuit.com/oauth2/v1/tokens/bearer" }],
    ["query on the token endpoint", { token_endpoint: `${OAUTH_TOKEN}?x=1` }],
    ["custom port", { token_endpoint: "https://oauth.platform.intuit.com:8443/oauth2/v1/tokens/bearer" }],
    ["not a URL", { revocation_endpoint: "nope" }],
    // Pinned per endpoint (security L2): another intuit.com host is not good enough.
    ["token endpoint on another intuit.com host", { token_endpoint: "https://appcenter.intuit.com/oauth2/v1/tokens/bearer" }],
    ["authorization endpoint on the token host", { authorization_endpoint: "https://oauth.platform.intuit.com/connect/oauth2" }],
    ["revocation endpoint on a sandbox api host", { revocation_endpoint: "https://sandbox-quickbooks.api.intuit.com/v2/oauth2/tokens/revoke" }],
    ["bare intuit.com", { token_endpoint: "https://intuit.com/oauth2/v1/tokens/bearer" }],
    ["trailing-dot host", { token_endpoint: "https://oauth.platform.intuit.com./oauth2/v1/tokens/bearer" }],
    ["missing field", { token_endpoint: undefined }],
  ])("refuses %s", (_name, patch) => {
    expect(() => parseDiscoveryDocument({ ...good, ...patch })).toThrow(ConnectorError);
  });

  it("refuses a body that is not a document", () => {
    expect(() => parseDiscoveryDocument(null)).toThrow(ConnectorError);
    expect(() => parseDiscoveryDocument("x")).toThrow(ConnectorError);
  });
});
