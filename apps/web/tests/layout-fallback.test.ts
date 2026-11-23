// T-276: a typed address or a reload used to paint nothing until the layout's reads finished. The fallback is static and data-free: it must not read params,
// cookies, headers or the clock (Cache Components: it is part of the prerendered shell), and it must not be `null`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "..", "app", "[laneId]", "layout.tsx"), "utf8");
const fallback = source.slice(source.indexOf("function ShellFallback"), source.indexOf("export default function LaneLayout"));

describe("the lane layout's fallback (T-276)", () => {
  it("is a real block, not nothing", () => {
    expect(source).not.toMatch(/<Suspense fallback=\{null\}>/);
    expect(source).toMatch(/<Suspense fallback=\{<ShellFallback \/>\}>/);
    expect(fallback).toMatch(/side-menu-fallback/);
    expect(fallback).toMatch(/<PageSkeleton \/>/);
  });
  it("reads no request data and no clock", () => {
    expect(fallback.length).toBeGreaterThan(100);
    for (const banned of ["params", "cookies", "headers", "Date", "Math.random", "performance", "connection", "guards", "loadLane"]) expect(fallback, banned).not.toContain(banned);
  });
});
