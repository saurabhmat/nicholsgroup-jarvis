// T-230 B review: --primary-foreground is navy in dark mode, so it must never be the text colour on the navy side menu
// (sidebar-* surfaces); use text-sidebar-strong there. packages/ui guards its own shell files; this guards apps/web
// (theme-toggle.tsx had aria-pressed:text-primary-foreground on bg-sidebar-active).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "..", "components");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
  .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
const onSidebar = files.filter(([, src]) => /\bbg-sidebar-[a-z-]+/.test(src));

describe("side-menu text contrast (apps/web)", () => {
  it("finds the components drawn on the side menu", () => {
    expect(onSidebar.map(([f]) => f)).toContain("theme-toggle.tsx");
  });

  it.each(onSidebar)("%s uses text-sidebar-strong, never text-primary-foreground", (_f, src) => {
    expect(src).not.toMatch(/\btext-primary-foreground\b/);
  });
});
