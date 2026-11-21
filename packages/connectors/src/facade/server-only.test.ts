// T-255: the facade must not widen what client bundles can import.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("the facade stays server-only", () => {
  it("its entry point imports server-only first, and no client component or hook imports it", () => {
    const root = resolve(__dirname, "../../../..");
    expect(readFileSync(resolve(__dirname, "index.ts"), "utf8").startsWith('import "server-only";')).toBe(true);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", ".turbo", ".git"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) {
          const text = readFileSync(p, "utf8");
          if (/["']use client["']/.test(text.slice(0, 200)) && /@nichols\/connectors\/facade/.test(text)) offenders.push(relative(root, p));
        }
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    expect(offenders).toEqual([]);
  });

  // T-255 review (security M1): `@nichols/connectors/google` still exports the Gmail and calendar providers and their sync runners, which
  // run neither the provider gate nor the T-247 owner check. Nothing outside the connectors may import that subpath: mail and calendar
  // reads, syncs and writes go through the facade (or, for writes, the approvals module).
  it("no file outside packages/connectors imports @nichols/connectors/google (the ungated Google entry points)", () => {
    const root = resolve(__dirname, "../../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", ".turbo", ".git"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (relative(root, p) !== join("packages", "connectors")) walk(p);
        } else if (/\.(ts|tsx|mts|mjs)$/.test(name) && /@nichols\/connectors\/google\b/.test(readFileSync(p, "utf8"))) offenders.push(relative(root, p));
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    expect(offenders).toEqual([]);
  });
});
