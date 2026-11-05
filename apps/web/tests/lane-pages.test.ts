// Static check: every page under app/[laneId] reaches loadLane (the page-level lane gate), directly or through
// ModulePage, so removing or bypassing the proxy check can never open a lane. A new page that skips it fails here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../app/[laneId]/", import.meta.url).pathname;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [full] : [];
  });
}

const read = (file: string) => readFileSync(file, "utf8");
const COMPONENTS = join(ROOT, "../../components/");

function reachesLoadLane(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const source = read(file);
  if (/\bloadLane\s*\(/.test(source)) return true;
  // Follow the page's own app components (for example ModulePage) one level at a time.
  for (const m of source.matchAll(/from "@\/components\/([\w-]+)"/g)) {
    if (reachesLoadLane(join(COMPONENTS, `${m[1] ?? ""}.tsx`), seen)) return true;
  }
  return false;
}

describe("every lane page calls loadLane", () => {
  const files = pages(ROOT);
  it("finds the module pages", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });
  it.each(files.map((f) => [relative(ROOT, f), f] as const))("%s", (_name, file) => {
    expect(reachesLoadLane(file)).toBe(true);
  });
  it("the shared module page itself calls loadLane", () => {
    expect(read(join(ROOT, "../../components/module-page.tsx"))).toMatch(/\bloadLane\s*\(/);
  });
  it("the layout calls it too", () => {
    expect(read(join(ROOT, "layout.tsx"))).toMatch(/\bloadLane\s*\(/);
  });
});
