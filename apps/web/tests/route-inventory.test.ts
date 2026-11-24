// T-170 (security suite), area 2. Catalog of every route.ts, page.tsx and "use server" file under app/. The files are enumerated from the
// file system and compared with the classification below: a NEW file fails until it is classified on purpose, a stale entry fails too.
// For each entry the claimed protections are checked against the source of the route AND the handler library it names (static check; the
// behaviour of each guard is covered by the guard and route tests listed in docs/security/pilot-test-plan.md).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
// ---------------------------------------------------------------- how the claims are checked
// 1. STATIC, PER HANDLER: comments are removed, then the handler's OWN code (not the whole file, and never a type or a doc line) must contain the CALL of
//    each guard the table claims. Handlers that share a library (the Teams routes, approvals, the two OAuth handlers) are cut out by name.
// 2. BEHAVIOUR: each route names the test files that prove its guards, and for every guard it claims a test with a matching title must exist there
//    (title match, honestly: the static check proves the call is present, the named test proves it is honoured).
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const slice = (text: string, startRe: RegExp, endRe: RegExp): string => {
  const start = text.search(startRe);
  if (start < 0) throw new Error(`no ${String(startRe)}`);
  const rest = text.slice(start + 1);
  const end = rest.search(endRe);
  return text.slice(start, end < 0 ? undefined : start + 1 + end);
};
const SESSION_CALL = /\b(requireSession|requireLane|requireRole|requireStepUp)\s*\(|\bauthorizer\s*\(|\bauth\s*\(\)|\bbegin\s*\(|\bwhoByQuery\s*\(/;
const LANE_CALL = /\b(requireLane|requireRole)\s*\(|\bauthorizer\s*\(|\bbegin\s*\(|\bwhoByQuery\s*\(/;
const ROLE_CALL = /\brequireRole\s*\(|\bconnectRolesFor\s*\(|\bauthorizer\s*\(|\bbegin\s*\(|\bwhoByQuery\s*\(/;
const STEP_CALL = /\brequireStepUp\s*\(|\bstepUp:\s*true/;
const ORIGIN_CALL = /headers\.get\(\s*["'](sec-fetch-site|origin)["']\s*\)|\bsameSite\s*\(/;

/** Where each handler's own code lives: [repo-relative file, start pattern, end pattern]; absent = the whole route file plus the named lib files (single-handler libs). */
const TEAMS = `${WEB_LIB}/teams-api.ts`;
const teamsMethod = (name: string): [string, RegExp, RegExp] => [TEAMS, new RegExp(`\\n    ${name}: `), /\n    (\/\*\*|[a-zA-Z]+: )|\n  \};/];
const HANDLER_SCOPE: Record<string, [string, RegExp, RegExp][]> = {
  "api/lanes/[laneId]/approvals/route.ts": [[`${WEB_LIB}/approvals.ts`, /export async function handleApprovals\b/, /\nexport (async )?function (?!handleApprovals)/]],
  "api/lanes/[laneId]/messages/activity/route.ts": [teamsMethod("activity"), teamsMethod("seen")],
  "api/lanes/[laneId]/messages/call-link/route.ts": [teamsMethod("callLink")],
  "api/lanes/[laneId]/messages/chats/route.ts": [teamsMethod("chats")],
  "api/lanes/[laneId]/messages/image/route.ts": [[TEAMS, /\n  const imageInner = /, /\n  return \{/]],
  "api/lanes/[laneId]/messages/newer/route.ts": [teamsMethod("newer")],
  "api/lanes/[laneId]/messages/older/route.ts": [teamsMethod("older")],
  "api/lanes/[laneId]/messages/read/route.ts": [teamsMethod("read")],
  "api/lanes/[laneId]/messages/send/route.ts": [teamsMethod("send")],
  "api/connect/[provider]/start/route.ts": [[`${CONN}/oauth/handlers.ts`, /\n    async start\(/, /\n    async callback\(/]],
  "api/connect/[provider]/callback/route.ts": [[`${CONN}/oauth/handlers.ts`, /\n    async callback\(/, /\n  \};|\n    async [a-z]+\(/]],
  "api/connect/composio/start/route.ts": [[`${CONN}/composio/handlers.ts`, /\n    async start\(/, /\n    async callback\(/]],
  "api/connect/composio/callback/route.ts": [[`${CONN}/composio/handlers.ts`, /\n    async callback\(/, /\n    async test\(/]],
  "api/connect/composio/test/route.ts": [[`${CONN}/composio/handlers.ts`, /\n    async test\(/, /\n  \};/]],
};
/** Test files that prove the guards of each route (behaviour tests with fakes for the guards, real handler code). */
const W = "apps/web";
const PROOF: Record<string, string[]> = {
  "api/connect/[provider]/start/route.ts": [`${CONN}/oauth/handlers-env.test.ts`, `${CONN}/oauth/connect-roles.test.ts`, `${CONN}/oauth/flow.test.ts`, `${W}/tests/connect-authorizer.test.ts`],
  "api/connect/[provider]/callback/route.ts": [`${CONN}/oauth/flow.test.ts`, `${CONN}/oauth/handlers-consent.test.ts`, `${W}/tests/connect-authorizer.test.ts`],
  "api/connect/composio/start/route.ts": [`${CONN}/composio/handlers.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/connect/composio/callback/route.ts": [`${CONN}/composio/handlers.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/connect/composio/test/route.ts": [`${CONN}/composio/handlers.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/connection-test/qbo/check/route.ts": [`${W}/tests/connection-test.test.ts`],
  "api/inngest/route.ts": ["packages/core/src/inngest/route.test.ts"],
  "api/lanes/[laneId]/approvals/route.ts": [`${W}/lib/approvals.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/lanes/[laneId]/assistant/route.ts": [`${W}/lib/assistant.test.ts`],
  "api/lanes/[laneId]/brain/import/route.ts": [`${W}/lib/brain-import.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/lanes/[laneId]/brain/interview/route.ts": [`${W}/lib/brain-interview.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/lanes/[laneId]/connections/[connectionId]/disconnect-teams/route.ts": [`${W}/tests/microsoft-disconnect.test.ts`, `${W}/tests/disconnect-teams-route.test.ts`],
  "api/lanes/[laneId]/connections/[connectionId]/disconnect/route.ts": [`${W}/tests/microsoft-disconnect.test.ts`],
  "api/lanes/[laneId]/connector-errors/export/route.ts": [`${W}/tests/connector-error-export.test.ts`],
  "api/lanes/[laneId]/messages/activity/route.ts": [`${W}/tests/teams-activity-routes.test.ts`],
  "api/lanes/[laneId]/messages/call-link/route.ts": [`${W}/tests/teams-messages-routes.test.ts`],
  "api/lanes/[laneId]/messages/chats/route.ts": [`${W}/tests/teams-messages-routes.test.ts`],
  "api/lanes/[laneId]/messages/image/route.ts": [`${W}/tests/teams-image-route.test.ts`],
  "api/lanes/[laneId]/messages/newer/route.ts": [`${W}/tests/teams-messages-routes.test.ts`],
  "api/lanes/[laneId]/messages/older/route.ts": [`${W}/tests/teams-messages-routes.test.ts`],
  "api/lanes/[laneId]/messages/read/route.ts": [`${W}/tests/teams-messages-routes.test.ts`],
  "api/lanes/[laneId]/messages/send/route.ts": [`${W}/tests/teams-send-route.test.ts`],
  "api/lanes/[laneId]/route.ts": [`${W}/tests/guards.test.ts`, `${W}/tests/lane-page.test.ts`],
  "api/lanes/[laneId]/sync-now/route.ts": [`${W}/tests/sync-now.test.ts`],
  "api/session/step-up/route.ts": [`${W}/tests/guards.test.ts`, "packages/core/src/auth/auth.test.ts"],
  "api/webhooks/[provider]/route.ts": [`${W}/tests/webhook-route.test.ts`, `${CONN}/webhooks/spoofing-catalog.test.ts`],
  "api/webhooks/microsoft/route.ts": [`${W}/tests/microsoft-webhook-route.test.ts`, `${CONN}/webhooks/spoofing-catalog.test.ts`],
  "auth/confirm/route.ts": ["packages/core/src/auth/actions.test.ts", `${W}/tests/proxy.test.ts`],
};
const TITLE: Record<"session" | "aal2" | "lane" | "role" | "stepUp" | "origin", RegExp> = {
  session: /no session|signed.?out|unauthor|401|session/i,
  aal2: /aal1|aal2|mfa|second factor|two.?factor/i,
  lane: /lane|404|member|not.?found|forbidden|company/i,
  role: /role|owner|viewer|admin|finance_operator|403/i,
  stepUp: /step.?up|authenticator|totp/i,
  origin: /cross.?site|origin|same.?site|csrf|forged/i,
};
const titlesOf = (file: string): string[] => [...src(file).matchAll(/^\s*(?:it|test)(?:\.each\([^)]*\))?\(\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')/gm)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

function handlerCode(file: string, n: Needs): string {
  const scope = HANDLER_SCOPE[file];
  if (scope) return scope.map(([f, a, b]) => strip(slice(src(f), a, b))).join("\n");
  return [src(join(APP, file)), ...n.via.map(src)].map(strip).join("\n");
}

describe("route.ts inventory", () => {
  const found = all.filter((f) => f.endsWith("route.ts")).sort();
  it("every route file is classified and every classified file exists", () => {
    expect(found).toEqual(Object.keys(ROUTES).sort());
    expect(Object.keys(PROOF).sort()).toEqual(Object.keys(ROUTES).sort());
  });
  it.each(Object.entries(ROUTES))("%s: the handler's own code calls the guards the table claims", (file, n) => {
    const own = strip(src(join(APP, file)));
    const code = handlerCode(file, n);
    const exported = [...own.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)].map((m) => m[1]).sort();
    if (file.includes("api/inngest")) expect(has(own, /inngestRoute/)).toBe(true);
    else expect(exported).toEqual([...n.methods].sort());
    if (n.session) expect(has(code + own, SESSION_CALL), "calls a session guard").toBe(true);
    if (n.lane) expect(has(code + own, LANE_CALL), "resolves the lane through a guard").toBe(true);
    if (n.role) expect(has(code + own, ROLE_CALL), "checks a role").toBe(true);
    if (n.stepUp) expect(has(code, STEP_CALL), "requires step-up in the handler itself").toBe(true);
    if (n.origin) expect(has(code, ORIGIN_CALL), "same-origin / same-site check in the handler itself").toBe(true);
    if (n.moduleGate) expect(has(own, /hiddenModuleResponse\s*\(/), "module gate").toBe(true);
    if (!n.session) {
      expect(n.publicBecause, "a public route states why").toBeTruthy();
      expect(has(own, /requireSession\s*\(|requireLane\s*\(|requireRole\s*\(/), "a public route does not half-use session guards").toBe(false);
    }
    // The Inngest endpoint is the one route that is a job runner (ESLint JOB_RUNNERS): it wires jobs, it is not reachable with a user session.
    if (!file.includes("api/inngest")) expect(has(own, /getLaneJobClient|getSupabaseSecretKey|service_role/), "a route never takes the service client itself").toBe(false);
  });
  it("the Teams routes that share teams-api.ts get their session, lane, role and (for send) step-up from one `begin` helper: it calls all of them", () => {
    const begin = strip(slice(src(TEAMS), /\n  async function begin\(/, /\n  async function accountsOf\(/));
    expect(begin).toMatch(/\brequireLane\s*\(/);
    expect(begin).toMatch(/\brequireRole\s*\(/);
    expect(begin).toMatch(/\brequireStepUp\s*\(/);
    // only send asks for step-up, and it does so in its own code
    for (const [file, scope] of Object.entries(HANDLER_SCOPE)) if (file.includes("/messages/") && !file.endsWith("/send/route.ts")) expect(scope.map(([f, a, b]) => strip(slice(src(f), a, b))).join(""), file).not.toMatch(/stepUp:\s*true/);
  });
  const GUARDS = [
    ["session", (n: Needs) => n.session],
    ["aal2", (n: Needs) => n.aal2],
    ["lane", (n: Needs) => n.lane],
    ["role", (n: Needs) => n.role],
    ["stepUp", (n: Needs) => n.stepUp],
    ["origin", (n: Needs) => n.origin],
  ] as const;
  it.each(Object.entries(ROUTES))("%s: a behaviour test with a matching title exists for every guard it claims", (file, n) => {
    const proofFiles = PROOF[file] ?? [];
    expect(proofFiles.length).toBeGreaterThan(0);
    const titles = proofFiles.flatMap((f) => {
      expect(existsSync(join(REPO, f)), `${f} exists`).toBe(true);
      return titlesOf(f);
    });
    expect(titles.length, "the proof files hold tests").toBeGreaterThan(0);
    for (const [guard, needed] of GUARDS) if (needed(n)) expect(titles.some((t) => TITLE[guard].test(t)), `${file}: no test titled for ${guard} in ${proofFiles.join(", ")}`).toBe(true);
  });
  it("the Inngest endpoint is signed in production: signing key set, unauthenticated sync off", () => {
    const t = strip(src("packages/core/src/inngest/index.ts"));
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
  it("every lane page CALLS loadLane, directly or through an app component it imports (followed file by file; a name that merely contains `Page` does not count)", () => {
    const COMPONENTS = join(WEB, "components");
    const reaches = (file: string, seen = new Set<string>()): boolean => {
      if (seen.has(file)) return false;
      seen.add(file);
      const code = strip(readFileSync(file, "utf8"));
      if (/\bloadLane\s*\(/.test(code)) return true;
      return [...code.matchAll(/from "@\/components\/([\w-]+)"/g)].some((m) => existsSync(join(COMPONENTS, `${m[1] ?? ""}.tsx`)) && reaches(join(COMPONENTS, `${m[1] ?? ""}.tsx`), seen));
    };
    for (const f of lanePages) expect(reaches(join(APP, f)), f).toBe(true);
    expect(reaches(join(COMPONENTS, "module-page.tsx"))).toBe(true);
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
