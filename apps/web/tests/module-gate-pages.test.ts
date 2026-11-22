// T-265 guard: every page under app/[laneId] is either wrapped by the module gate (a company that hides the module never draws it) or is
// listed here as always visible. A new page that is neither fails this test, so a module cannot be added without deciding.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "app", "[laneId]");
const ALWAYS_VISIBLE = new Set(["page.tsx" /* Home */, "settings/page.tsx", "more/page.tsx"]);

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pages(p);
    return name === "page.tsx" ? [relative(ROOT, p).split("\\").join("/")] : [];
  });
}

describe("module gate on pages (T-265)", () => {
  const all = pages(ROOT);
  it("finds the pages", () => {
    expect(all.length).toBeGreaterThan(8);
    for (const known of ALWAYS_VISIBLE) expect(all).toContain(known);
  });
  it.each(all.filter((p) => !ALWAYS_VISIBLE.has(p)))("%s is wrapped by <ModuleGate module=...>", (p) => {
    expect(readFileSync(join(ROOT, p), "utf8")).toMatch(/<ModuleGate module="[a-z]+"/);
  });
});
