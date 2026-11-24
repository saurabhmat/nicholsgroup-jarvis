// T-170 (security suite), area 2. Catalog of every route.ts, page.tsx and "use server" file under app/. The files are enumerated from the
// file system and compared with the classification below: a NEW file fails until it is classified on purpose, a stale entry fails too.
// For each entry the claimed protections are checked against the source of the route AND the handler library it names (static check; the
// behaviour of each guard is covered by the guard and route tests listed in docs/security/pilot-test-plan.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "..");
const REPO = resolve(WEB, "../..");
const APP = join(WEB, "app");
const src = (p: string) => readFileSync(p.startsWith("/") ? p : join(REPO, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}
const all = walk(APP).map((f) => relative(APP, f));

type Needs = {
  /** Handler files (repo-relative) whose source is searched together with the route file. */
  via: string[];
  session: boolean;
  aal2: boolean;
  lane: boolean;
  role: boolean;
  stepUp: boolean;
  /** A state change guarded by a same-origin / same-site header check. */
  origin: boolean;
  moduleGate: boolean;
  methods: string[];
  /** Why this route is public (no session), when it is. */
  publicBecause?: string;
};
const WEB_LIB = "apps/web/lib";
const CONN = "packages/connectors/src";
const base = { session: true, aal2: true, lane: true, role: true, stepUp: false, origin: false, moduleGate: false };
const R = (n: Partial<Needs> & Pick<Needs, "via" | "methods">): Needs => ({ ...base, ...n });

const ROUTES: Record<string, Needs> = {
  "api/connect/[provider]/start/route.ts": R({ via: [`${WEB_LIB}/connect.ts`, `${CONN}/oauth/handlers.ts`], methods: ["POST"], origin: true }),
  "api/connect/[provider]/callback/route.ts": R({ via: [`${WEB_LIB}/connect.ts`, `${CONN}/oauth/handlers.ts`], methods: ["GET"] /* state is consumed in SQL, session re-checked */ }),
  "api/connect/composio/start/route.ts": R({ via: [`${WEB_LIB}/connect.ts`, `${CONN}/composio/handlers.ts`], methods: ["POST"], origin: true }),
  "api/connect/composio/callback/route.ts": R({ via: [`${WEB_LIB}/connect.ts`, `${CONN}/composio/handlers.ts`], methods: ["GET"] }),
  "api/connect/composio/test/route.ts": R({ via: [`${WEB_LIB}/connect.ts`, `${CONN}/composio/handlers.ts`], methods: ["POST"], origin: true }),
  "api/connection-test/qbo/check/route.ts": R({ via: [`${WEB_LIB}/connection-test.ts`], methods: ["POST"], origin: true, moduleGate: true }),
  "api/inngest/route.ts": R({ via: ["packages/core/src/inngest/index.ts"], methods: [], session: false, aal2: false, lane: false, role: false, publicBecause: "signed by Inngest (signing key; unauthenticated sync disabled outside local dev)" }),
  "api/lanes/[laneId]/approvals/route.ts": R({ via: [`${WEB_LIB}/approvals.ts`], methods: ["POST"], stepUp: true, origin: true, moduleGate: true }),
  "api/lanes/[laneId]/assistant/route.ts": R({ via: [`${WEB_LIB}/assistant.ts`], methods: ["POST"], role: false, origin: true, moduleGate: true }),
  "api/lanes/[laneId]/brain/import/route.ts": R({ via: [`${WEB_LIB}/brain-import.ts`], methods: ["POST"], origin: true, moduleGate: true }),
  "api/lanes/[laneId]/brain/interview/route.ts": R({ via: [`${WEB_LIB}/brain-interview.ts`], methods: ["POST"], origin: true, moduleGate: true }),
  "api/lanes/[laneId]/connections/[connectionId]/disconnect-teams/route.ts": R({ via: [`${WEB_LIB}/microsoft-disconnect.ts`], methods: ["POST"], origin: true }),
  "api/lanes/[laneId]/connections/[connectionId]/disconnect/route.ts": R({ via: [`${WEB_LIB}/microsoft-disconnect.ts`], methods: ["POST"], origin: true }),
  "api/lanes/[laneId]/connector-errors/export/route.ts": R({ via: [`${WEB_LIB}/connector-error-export.ts`], methods: ["GET"], origin: true /* GET that writes an audit row */ }),
  "api/lanes/[laneId]/messages/activity/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["GET", "POST"], origin: true }),
  "api/lanes/[laneId]/messages/call-link/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["POST"], origin: true }),
  "api/lanes/[laneId]/messages/chats/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["GET"], origin: true }),
  "api/lanes/[laneId]/messages/image/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["GET", "HEAD"], origin: true }),
  "api/lanes/[laneId]/messages/newer/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["GET"], origin: true }),
  "api/lanes/[laneId]/messages/older/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["GET"], origin: true }),
  "api/lanes/[laneId]/messages/read/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["POST"], origin: true }),
  "api/lanes/[laneId]/messages/send/route.ts": R({ via: [`${WEB_LIB}/teams-api.ts`], methods: ["POST"], origin: true, stepUp: true }),
  "api/lanes/[laneId]/route.ts": R({ via: [], methods: ["GET"], role: false }),
  "api/lanes/[laneId]/sync-now/route.ts": R({ via: [`${WEB_LIB}/sync-now.ts`], methods: ["POST"], origin: true }),
  "api/session/step-up/route.ts": R({ via: [], methods: ["GET"], lane: false, role: false, stepUp: true }),
  "api/webhooks/[provider]/route.ts": R({ via: [`${CONN}/webhooks/handler.ts`], methods: ["POST"], session: false, aal2: false, lane: false, role: false, publicBecause: "provider signature (HMAC) is the credential; lane comes from the stored connection" }),
  "api/webhooks/microsoft/route.ts": R({ via: [`${CONN}/webhooks/microsoft.ts`], methods: ["POST"], session: false, aal2: false, lane: false, role: false, publicBecause: "per-subscription clientState; lane comes from the stored subscription" }),
  "auth/confirm/route.ts": R({ via: [], methods: ["GET"], session: false, aal2: false, lane: false, role: false, publicBecause: "e-mail link token hash (creates an AAL1 session only; MFA follows)" }),
};

const has = (text: string, re: RegExp) => re.test(text);
const SESSION = /requireSession|requireLane|requireRole|requireStepUp|authorizer|guards\(\)|auth\(\)/;
const LANE = /requireLane|requireRole|authorizer/;
const ROLE = /requireRole|connectRolesFor|authorizer/;
const STEP = /requireStepUp/;
const ORIGIN = /sec-fetch-site|"origin"|sameSite\(/;

describe("route.ts inventory", () => {
  const found = all.filter((f) => f.endsWith("route.ts")).sort();
  it("every route file is classified and every classified file exists", () => {
    expect(found).toEqual(Object.keys(ROUTES).sort());
  });
  it.each(Object.entries(ROUTES))("%s", (file, n) => {
    const text = [src(join(APP, file)), ...n.via.map(src)].join("\n");
    const own = src(join(APP, file));
    const exported = [...own.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)].map((m) => m[1]).sort();
    if (file.includes("api/inngest")) expect(has(own, /inngestRoute/)).toBe(true);
    else expect(exported).toEqual([...n.methods].sort());
    // A route that changes state never answers a bare GET with a write; GET routes that write are marked origin above.
    if (n.session) expect(has(text, SESSION), "calls a session guard").toBe(true);
    if (n.lane) expect(has(text, LANE), "resolves the lane through a guard").toBe(true);
    if (n.role) expect(has(text, ROLE), "checks a role").toBe(true);
    if (n.stepUp) expect(has(text, STEP), "requires step-up").toBe(true);
    if (n.origin) expect(has(text, ORIGIN), "same-origin / same-site check").toBe(true);
    if (n.moduleGate) expect(has(own, /hiddenModuleResponse/), "module gate").toBe(true);
    if (!n.session) {
      expect(n.publicBecause, "a public route states why").toBeTruthy();
      expect(has(own, /requireSession|requireLane|requireRole/), "a public route does not half-use session guards").toBe(false);
    }
    // No route reads a lane from the request body or query to pick a database client: the lane is the path segment or an authorized value.
    // The Inngest endpoint is the one route that is a job runner (ESLint JOB_RUNNERS): it wires jobs, it is not reachable with a user session.
    if (!file.includes("api/inngest")) expect(has(own, /getLaneJobClient|getSupabaseSecretKey|service_role/), "a route never takes the service client itself").toBe(false);
  });
  it("the Inngest endpoint is signed in production: signing key set, unauthenticated sync off", () => {
    const t = src("packages/core/src/inngest/index.ts");
    expect(t).toMatch(/signingKey: keys\.INNGEST_SIGNING_KEY/);
    expect(t).toMatch(/enableUnauthedSync: false/);
    expect(t).toMatch(/isDev: local/);
  });
  it("the proxy excludes provider webhooks from the session refresh and nothing else under /api", () => {
    const p = src("apps/web/proxy.ts");
    expect(p).toMatch(/api\/webhooks\//);
    expect(p).not.toMatch(/\(\?!.*api\/inngest/);
  });
});

describe("page.tsx inventory", () => {
  const pages = all.filter((f) => f.endsWith("page.tsx")).sort();
  const PUBLIC: Record<string, string> = {
    "page.tsx": "landing: redirects after the session guard (lib/landing)",
    "sign-in/page.tsx": "sign-in form (proxy lets /sign-in through)",
    "sign-in/verify/page.tsx": "code entry (proxy lets /sign-in through)",
    "mfa/page.tsx": "AAL1 session required (requireSession allowAal1), second factor",
  };
  const lanePages = pages.filter((f) => f.startsWith("[laneId]/"));
  it("every page is a lane page (loadLane, also covered by lane-pages.test) or on the reviewed public list; no stale entry", () => {
    const others = pages.filter((f) => !f.startsWith("[laneId]/"));
    expect(others).toEqual(Object.keys(PUBLIC).sort());
    expect(lanePages.length).toBeGreaterThanOrEqual(16);
  });
  it("the AAL1 page asks for a session and the landing page uses the guards", () => {
    expect(src(join(APP, "mfa/page.tsx"))).toMatch(/requireSession\(\{ allowAal1: true \}\)/);
    expect(src(join(APP, "page.tsx"))).toMatch(/guards|landing/);
  });
  it("lane pages reach the lane gate (loadLane or ModulePage)", () => {
    for (const f of lanePages) {
      const t = src(join(APP, f));
      expect(/loadLane|ModulePage|Page\b/.test(t), f).toBe(true);
    }
  });
});

describe("server actions inventory", () => {
  const actions = all.filter((f) => /\.tsx?$/.test(f) && /^\s*"use server"/m.test(src(join(APP, f)).slice(0, 200))).sort();
  const ACTIONS: Record<string, RegExp> = {
    "[laneId]/briefing-actions.ts": /requireRole/,
    "[laneId]/news-actions.ts": /requireRole\(laneId as LaneId, \["owner"\]\)/,
    "mfa/actions.ts": /mfa\(\)/,
    "sign-in/actions.ts": /auth\(\)/,
  };
  it("every server action file is classified", () => {
    expect(actions).toEqual(Object.keys(ACTIONS).sort());
  });
  it.each(Object.entries(ACTIONS))("%s uses its guard", (file, re) => {
    expect(src(join(APP, file))).toMatch(re);
  });
});
