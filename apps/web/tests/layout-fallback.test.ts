// @vitest-environment jsdom
// T-276: a typed address or a reload used to paint nothing until the layout's reads finished. The fallback is static and data-free: it must not read params,
// cookies, headers or the clock (Cache Components: it is part of the prerendered shell), and it must not be `null`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShellFallback } from "@/components/shell-fallback";

const layout = readFileSync(join(__dirname, "..", "app", "[laneId]", "layout.tsx"), "utf8");
const source = readFileSync(join(__dirname, "..", "components", "shell-fallback.tsx"), "utf8");

describe("the lane layout's fallback (T-276)", () => {
  it("is used by the layout instead of nothing", () => {
    expect(layout).not.toMatch(/<Suspense fallback=\{null\}>/);
    expect(layout).toMatch(/<Suspense fallback=\{<ShellFallback \/>\}>/);
  });
  it("renders with no props: the side-menu block and the page skeleton, and no lane text", () => {
    const { container } = render(createElement(ShellFallback));
    expect(container.querySelector('[data-slot="side-menu-fallback"]')).toBeTruthy();
    expect(screen.getByTestId("page-skeleton")).toBeTruthy();
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(container.textContent).toBe("Loading");
  });
  it("reads no request data and no clock", () => {
    for (const banned of ["params", "cookies", "headers", "Date", "Math.random", "performance", "connection", "guards", "loadLane"]) expect(source.replace(/\/\*[\s\S]*?\*\//g, ""), banned).not.toContain(banned);
  });
});
