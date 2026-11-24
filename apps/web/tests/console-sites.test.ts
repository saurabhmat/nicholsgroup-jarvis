// T-170 (security suite), area 3: every `console.*` call in non-test source is a place a secret could leak around the redacting connector
// logger. The sites are enumerated from the file system. A NEW file with a console call fails until it is added to REVIEWED (names, ids and
// counts only), and no call anywhere may pass a bare caught error, request, response, headers, body, token, session or cookie value.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const SKIP = new Set(["node_modules", "dist", ".next", ".next-e2e", ".next-canary", ".turbo", ".git", "test-results", "test-stubs", "e2e", "scripts", "coverage"]);
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}
const sources = [...walk(join(REPO, "apps")), ...walk(join(REPO, "packages"))]
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
  .map((f) => relative(REPO, f));

/** The statement of each console call: from `console.x(` to the balanced closing parenthesis (strings skipped). */
function calls(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[^\w.])console\.(log|warn|error|info|debug|dir|table|trace)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(\/\/|\*)/.test(text.slice(lineStart, m.index + (m[1] ?? "").length + 7))) continue; // a comment
    let depth = 1;
    let i = re.lastIndex;
    let quote = "";
    for (; i < text.length && depth > 0; i++) {
      const c = text.charAt(i);
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out.push(text.slice(re.lastIndex, i - 1));
  }
  return out;
}
const withCalls = sources.map((f) => ({ f, calls: calls(readFileSync(join(REPO, f), "utf8")) })).filter((x) => x.calls.length > 0);

/** Files that log, with why that is acceptable: every call passes names, ids, counts and fixed text only (checked below). */
const REVIEWED = new Set([
  "apps/web/app/[laneId]/briefing-actions.ts",
  "apps/web/app/[laneId]/news-actions.ts",
  "apps/web/app/api/lanes/[laneId]/route.ts",
  "apps/web/app/api/session/step-up/route.ts",
  "apps/web/components/card-boundary.tsx",
  "apps/web/components/section-boundary.tsx",
  "apps/web/lib/approvals.ts",
  "apps/web/lib/assistant.ts",
  "apps/web/lib/brain-import-model.ts",
  "apps/web/lib/brain-import.ts",
  "apps/web/lib/brain-interview.ts",
  "apps/web/lib/briefing-run.ts",
  "apps/web/lib/briefing-schedule.ts",
  "apps/web/lib/briefing.ts",
  "apps/web/lib/calendar-page.ts",
  "apps/web/lib/connect-follow-up.ts",
  "apps/web/lib/connection-test.ts",
  "apps/web/lib/connector-error-export.ts",
  "apps/web/lib/coverage.ts",
  "apps/web/lib/finance-page.ts",
  "apps/web/lib/home-finance-detail.ts",
  "apps/web/lib/home-finance.ts",
  "apps/web/lib/home.ts",
  "apps/web/lib/inbox.ts",
  "apps/web/lib/job-failures.ts",
  "apps/web/lib/microsoft-disconnect.ts",
  "apps/web/lib/news-run.ts",
  "apps/web/lib/reply.ts",
  "apps/web/lib/server-timing.ts",
  "apps/web/lib/sync-now.ts",
  "apps/web/lib/teams-api.ts",
  "apps/web/lib/teams-chats.ts",
  "packages/ai/src/anthropic.ts",
  "packages/connectors/src/composio/handlers.ts",
  "packages/connectors/src/log/index.ts",
  "packages/connectors/src/oauth/handlers.ts",
  "packages/connectors/src/testing/contract-kit.ts",
  "packages/core/src/inngest/failure-tracking.ts",
  "packages/modules/approvals/src/server/email.ts",
  "packages/modules/approvals/src/server/qbo.ts",
  "packages/modules/approvals/src/server/reconcile.ts",
  "packages/modules/approvals/src/server/teams.ts",
  "packages/modules/brain/src/server/interview.ts",
]);

const BARE = /(?:^|,\s*|\{\s*|:\s*)(e|err|error|cause|res|response|request|req|headers|body|token|session|cookies?|secret|payload|data)\s*(?=[,)}]|$)/;

/** The call's arguments with string literals emptied; for template strings only the `${...}` expressions are kept. */
function expressions(call: string): string {
  let out = "";
  let i = 0;
  while (i < call.length) {
    const c = call.charAt(i);
    if (c === "'" || c === '"') {
      i++;
      while (i < call.length && call.charAt(i) !== c) i += call.charAt(i) === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      i++;
      while (i < call.length && call.charAt(i) !== "`") {
        if (call.charAt(i) === "$" && call.charAt(i + 1) === "{") {
          let depth = 1;
          let j = i + 2;
          while (j < call.length && depth > 0) {
            depth += call.charAt(j) === "{" ? 1 : call.charAt(j) === "}" ? -1 : 0;
            j++;
          }
          out += ` ${call.slice(i + 2, j - 1)} `;
          i = j;
        } else i += call.charAt(i) === "\\" ? 2 : 1;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
// Names that carry a credential, a provider message or a request object. A `.message` of ANY caught value is refused too (`e.message`, `(e as Error).message`,
// `error?.message`): provider text can hold a token; use the error's name, a fixed code, or the redacting connector logger.
const SECRET_NAME = /\b(accessToken|refreshToken|idToken|clientSecret|apiKey|api_key|access_token|refresh_token|token|secret|password|authorization|cookie|cookies|bearer|credentials?)\b/i;
const MESSAGE = /\.message\b|\.stack\b|\.cause\b|\.body\b|\.headers\b/;

describe("console call sites", () => {
  it("finds the sites (the scan is not empty)", () => {
    expect(withCalls.length).toBeGreaterThanOrEqual(30);
  });
  it("the set of files that log is the reviewed set (a new file that logs needs a review: use the connector logger for anything near a provider)", () => {
    expect(withCalls.map((x) => x.f).sort()).toEqual([...REVIEWED].sort());
  });
  it.each(withCalls.map((x) => [x.f, x.calls] as const))("%s passes no bare error, request, response, header, body or token to the console", (_f, cs) => {
    for (const c of cs) expect(BARE.test(c), c.slice(0, 160)).toBe(false);
  });
  it("no log call passes an error message, stack, cause, body or headers, or any identifier that names a credential, as an argument or inside a template string", () => {
    for (const { f, calls: cs } of withCalls) {
      for (const c of cs) {
        // The one reviewed exception: a ConnectorError's `info.message` is redacted by the connector layer when the error is built (canary-sinks.test.ts proves it).
        const e = expressions(c).replace(/\b[a-z]\.info\.message\b/g, "info");
        expect(MESSAGE.test(e), `${f}: ${c.slice(0, 120)}`).toBe(false);
        expect(SECRET_NAME.test(e), `${f}: ${c.slice(0, 120)}`).toBe(false);
      }
    }
  });
  it("the scanner itself catches the shapes it claims to (a self-test)", () => {
    const bad = ["x", "(e as Error).message", "e?.message", "accessToken", "`t ${refreshToken}`", "{ token }", "res.headers", "err.stack", "obj.cause"];
    for (const b of bad.slice(1)) expect(MESSAGE.test(expressions(b)) || SECRET_NAME.test(expressions(b)), b).toBe(true);
    expect(SECRET_NAME.test(expressions('"fixed text about a token", { laneId, count: 3 }'))).toBe(false);
    expect(calls("console.dir(accessToken)").length + calls("console.error(`x ${token}`)").length).toBe(2);
  });
  it("no log call interpolates an env or secret accessor, a header object or a token variable", () => {
    for (const { f, calls: cs } of withCalls) for (const c of cs) expect(/\$\{[^}]*(token|secret|authorization|cookie|password|apiKey|api_key)[^}]*\}/i.test(c), `${f}: ${c.slice(0, 120)}`).toBe(false);
  });
});
