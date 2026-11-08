// T-219: static boundary and canary checks for the Composio connector (all on source text, no network).
//  - `@composio/core` is imported only by sdk.ts, and the API key is revealed only there;
//  - nothing logs with console except the route handlers' coarse error lines (name only);
//  - the allow-list contains no write, send, delete or settings tool (writes join with the approvals executors, T-225);
//  - the chat never connects: no assistant/AI/chat code reaches the Composio connect flow, it may only link to Settings;
//  - the only caller of the connect flow is Settings → Connections' routes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWED_TOOL_SLUGS, TOOLKIT_SPECS } from "./constants";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");

function* files(dir: string, ext = /\.(ts|tsx|mjs)$/): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name === ".next-canary") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full, ext);
    else if (ext.test(name)) yield full;
  }
}
const isTest = (f: string) => /\.test\.(ts|tsx|mjs)$/.test(f) || f.includes(`${path.sep}tests${path.sep}`) || f.includes(`${path.sep}e2e${path.sep}`);
const text = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => path.relative(repo, f);

describe("SDK and key boundary", () => {
  it("only sdk.ts imports @composio/core, anywhere in the repo's source", () => {
    const importers = [...files(path.join(repo, "packages")), ...files(path.join(repo, "apps"))]
      .filter((f) => !isTest(f) && /from\s+["']@composio\//.test(text(f)))
      .map(rel);
    expect(importers).toEqual(["packages/connectors/src/composio/sdk.ts"]);
  });

  it("the API key is revealed in sdk.ts only, never logged or interpolated", () => {
    const prod = [...files(here)].filter((f) => !isTest(f));
    const revealers = prod.filter((f) => /\.reveal\(\)/.test(text(f))).map((f) => path.basename(f));
    expect(revealers).toEqual(["sdk.ts"]);
    for (const f of prod) {
      const src = text(f);
      expect(/COMPOSIO_API_KEY[^\n]*(log|console|warn|info|error)\b/.test(src), `${path.basename(f)} mentions the key near a logger`).toBe(false);
      if (path.basename(f) !== "handlers.ts") expect(/console\./.test(src), `${path.basename(f)} uses console`).toBe(false);
    }
  });

  it("route handlers log only an error name, never an error object or message", () => {
    const src = text(path.join(here, "handlers.ts"));
    for (const m of src.matchAll(/console\.error\([^)]*\)/g)) expect(m[0]).toMatch(/e instanceof Error \? e\.name : typeof e/);
  });
});

describe("allow-list", () => {
  it("contains read tools only: no send, create, delete, update, modify, trash, move, watch, forward, label or settings tool", () => {
    const forbidden = /(SEND|CREATE|DELETE|REMOVE|UPDATE|PATCH|MODIFY|TRASH|INSERT|MOVE|WATCH|FORWARD|IMPORT|QUICK_ADD|BATCH|SETTINGS|ACL|FILTER|STOP|CLEAR|REPLY|DRAFT)/;
    for (const [toolkit, slugs] of Object.entries(ALLOWED_TOOL_SLUGS)) {
      for (const slug of slugs) {
        expect(slug.startsWith(toolkit === "gmail" ? "GMAIL_" : "GOOGLECALENDAR_"), slug).toBe(true);
        expect(forbidden.test(slug), slug).toBe(false);
      }
    }
  });
  it("the identity and test tools used by Settings are on the allow-list", () => {
    for (const [toolkit, spec] of Object.entries(TOOLKIT_SPECS)) {
      expect(ALLOWED_TOOL_SLUGS[toolkit as keyof typeof ALLOWED_TOOL_SLUGS]).toEqual(expect.arrayContaining([spec.identityTool, spec.testTool]));
    }
  });
});

describe("the chat never connects (spec §8.2)", () => {
  const chatRoots = [
    path.join(repo, "packages/ai/src"),
    path.join(repo, "packages/modules"),
    path.join(repo, "apps/web/app/api/lanes"),
    path.join(repo, "apps/web/lib/assistant.ts"),
    path.join(repo, "apps/web/components/assistant-chat.tsx"),
    path.join(repo, "apps/web/components/assistant-page.tsx"),
  ];
  const chatFiles = () => chatRoots.flatMap((r) => (r.endsWith(".ts") || r.endsWith(".tsx") ? [r] : [...files(r)])).filter((f) => !isTest(f));

  it("no assistant, AI or module code imports the Composio connector or calls a connect route", () => {
    const list = chatFiles();
    expect(list.length).toBeGreaterThan(5); // the scan looked at real code
    for (const f of list) {
      const src = text(f);
      expect(/connectors\/composio|composioFlow|composioCheck|api\/connect\/composio|connectedAccounts/.test(src), rel(f)).toBe(false);
    }
  });

  it("the connect flow is called only by the Composio routes under /api/connect/composio", () => {
    const callers = [...files(path.join(repo, "apps/web"))]
      .filter((f) => !isTest(f) && /composioFlow|connectors\/composio/.test(text(f)))
      .map(rel)
      .sort();
    for (const c of callers) expect(c, c).toMatch(/^apps\/web\/(app\/api\/connect\/composio\/|lib\/composio-|components\/composio-)/);
  });
});
