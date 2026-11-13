// T-243: no clock read ahead of a dynamic point on /[laneId] and /[laneId]/settings. Next 16 with cacheComponents + partialPrefetching reports
// `Date.now()` / `new Date()` read before the request's dynamic data as a prerender error for the route (seen in the Vercel logs for exactly these
// two routes). The fix: the pages call connection() before reading the clock, the shared shell (every route) takes the time from the server
// instead of defaulting to `new Date()` in a component that can be prerendered. These source checks keep that from creeping back; the build-log
// check (scripts/check-build-log.mjs) is the end-to-end one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findClockErrors } from "../scripts/check-build-log.mjs";

const web = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(web, rel), "utf8");
// Line comments first (a `//` comment may mention "/*"), then block comments.
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("page modules read the clock only after connection()", () => {
  it.each(["components/home-page.tsx", "components/settings-page.tsx"])("%s: connection() is awaited before the first `new Date()` and before the lane lookup", (file) => {
    const src = stripComments(read(file));
    const conn = src.indexOf("await connection()");
    const clock = src.indexOf("new Date()");
    const lane = src.indexOf("await loadLane(");
    expect(src).toMatch(/import \{ connection \} from "next\/server"/);
    expect(conn).toBeGreaterThan(-1);
    expect(clock).toBeGreaterThan(conn);
    expect(lane).toBeGreaterThan(conn);
  });
});

describe("the shared shell takes its time from the server", () => {
  it("nav.ts: no function defaults a parameter to the current time", () => {
    const src = stripComments(readFileSync(path.resolve(web, "../../packages/ui/src/lib/nav.ts"), "utf8"));
    expect(src).not.toMatch(/=\s*new Date\(\)/);
    expect(src).not.toMatch(/Date\.now\(\)/);
  });
  it("app-shell.tsx reads no clock; the lane layout computes the time after the lane check and passes it down", () => {
    expect(stripComments(readFileSync(path.resolve(web, "../../packages/ui/src/components/app-shell.tsx"), "utf8"))).not.toMatch(/new Date\(|Date\.now\(/);
    const layout = stripComments(read("app/[laneId]/layout.tsx"));
    expect(layout.indexOf("await Promise.all")).toBeGreaterThan(-1);
    expect(layout.indexOf("new Date()")).toBeGreaterThan(layout.indexOf("await Promise.all"));
    expect(layout).toMatch(/<Shell now=\{now\}/);
    expect(stripComments(read("components/shell.tsx"))).not.toMatch(/new Date\(|Date\.now\(/);
  });
});

describe("check-build-log", () => {
  const clean = ["▲ Next.js 16.4.2 (Turbopack)", "✓ Compiled successfully in 45s", "Route (app)", "├ ◐ /[laneId]"].join("\n");
  it("a clean build log has no findings", () => {
    expect(findClockErrors(clean)).toEqual([]);
  });
  it("finds the Cache Components clock errors for a route", () => {
    const bad = `${clean}\nError: Route "/[laneId]" used \`Date.now()\` before accessing either uncached data (e.g. \`fetch()\`) or Request data (e.g. \`cookies()\`).\nError: Route "/[laneId]/settings" used \`new Date()\` inside a Server Component\nError occurred prerendering page "/[laneId]".`;
    const hits = findClockErrors(bad) as string[];
    expect(hits).toHaveLength(3);
    expect(hits.join("\n")).toContain("/[laneId]/settings");
  });
});
