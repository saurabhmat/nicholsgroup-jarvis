// T-243: the manual build-log check (scripts/check-build-log.mjs; `pnpm --filter @nichols/web build 2>&1 | node scripts/check-build-log.mjs`).
// It is a tool for a person to run on a build or runtime log, not part of CI.
import { describe, expect, it } from "vitest";
import { findClockErrors } from "../scripts/check-build-log.mjs";

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
