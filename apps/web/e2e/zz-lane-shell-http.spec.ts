// T-023 at HTTP level, no browser needed: the lane in the URL is verified on the server. Named zz- so it runs after the
// browser specs, which enrol the authenticators this spec then reuses (api-session.ts).
import { expect, request, test } from "@playwright/test";
import { aal2Cookie } from "./api-session";

const KEY = process.env.E2E_SUPABASE_PUBLISHABLE_KEY ?? ""; // set by scripts/e2e-reset.mjs from the local stack
const OWNER = "owner@example.test"; // owner of every seeded lane; only PKG is enabled
const OUTSIDER = "outsider@example.test"; // member of no lane

test.describe.configure({ mode: "serial" });
test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "HTTP-level checks run once");
});
test.setTimeout(120_000);

async function client(cookie?: string) {
  return request.newContext({ baseURL: "http://127.0.0.1:3100", maxRedirects: 0, extraHTTPHeaders: cookie ? { cookie } : {} });
}

test("signed out: lane URLs go to sign-in", async () => {
  const c = await client();
  const res = await c.get("/PKG");
  expect(res.status()).toBe(307);
  expect(res.headers().location).toContain("/sign-in");
  await c.dispose();
});

test("a member sees only the lanes that are enabled and allowed, and 404 for every other lane", async () => {
  const c = await client(await aal2Cookie(OWNER, KEY));
  const entry = await c.get("/");
  // The entry point redirects while streaming (status 200 with an in-document redirect to the user's first lane).
  expect(await entry.text()).toMatch(/url=\/PKG\b|NEXT_REDIRECT;replace;\/PKG;/);

  const home = await c.get("/PKG");
  expect(home.status()).toBe(200);
  const html = await home.text();
  expect(html).toContain("Pub K Group");
  expect(html).toContain('href="/PKG/finance"');
  // The owner belongs to every seeded lane, but only PKG is enabled: no other lane is listed or linked.
  for (const hidden of ["Ask Pub K", "Pub K Institute", "Nichols Capital", "Nichols Law", "Personal", "/APK", "/NL"]) expect(html).not.toContain(hidden);

  for (const segment of ["finance", "inbox", "calendar", "approvals", "assistant", "projects", "settings", "more"]) {
    expect((await c.get(`/PKG/${segment}`)).status(), segment).toBe(200);
  }
  // Root files and well-known paths are not lanes (T-024): the proxy leaves them alone for a signed-in user. Nothing
  // serves them yet, so the app answers as for any unknown path; what matters is that the proxy's lane 404 is not used.
  for (const path of ["/robots.txt", "/sitemap.xml", "/.well-known/x", "/manifest.webmanifest"]) {
    const res = await c.get(path);
    // The app's own not-found page loads Next assets; the proxy's plain 404 body has none (it shares the wording).
    expect(await res.text(), path).toContain("/_next/");
  }
  // Only the canonical lane code is a lane: lowercase and non-canonical encodings are refused with the proxy's 404,
  // which is never cached or shared.
  for (const path of ["/pkg", "/%50KG", "/%50KG/finance"]) {
    const res = await c.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()["cache-control"], path).toBe("private, no-store");
    expect(res.headers()["vary"], path).toContain("cookie");
    expect(await res.text(), path).not.toContain("Pub K Group");
  }
  for (const path of ["/APK", "/APK/finance", "/NL", "/PKI", "/ZZZ", "/PKG;--", "/PKG/search", "/PKG/commitments"]) {
    const res = await c.get(path);
    expect(res.status(), path).toBe(404);
    expect(await res.text()).not.toContain("Pub K Group");
  }
  await c.dispose();
});

test("a user who belongs to no lane gets the same 404 for an existing lane as for an unknown one", async () => {
  const c = await client(await aal2Cookie(OUTSIDER, KEY));
  const entry = await c.get("/");
  expect(entry.status()).toBe(200);
  expect(await entry.text()).toContain("no company access");
  const real = await c.get("/PKG");
  const unknown = await c.get("/ZZZ");
  expect(real.status()).toBe(404);
  expect(unknown.status()).toBe(404);
  expect(await real.text()).not.toContain("Pub K Group");
  expect((await c.get("/PKG/finance")).status()).toBe(404);
  await c.dispose();
});
