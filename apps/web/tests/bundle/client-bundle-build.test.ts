// QB-17 (T-050): a canary in every INTUIT_* server secret (and the Supabase secret key) must not appear anywhere the
// browser can receive from a real production build. Slow (a full `next build`, minutes), so it is not in `pnpm test`:
// run `pnpm test:bundle` (root) or `pnpm --filter @nichols/web test:bundle`. The scanner itself is tested in
// tests/client-bundle.test.ts.
//
// Positive control: the same build carries a NEXT_PUBLIC_ canary, which Next.js inlines wherever code reads it. The scan
// must find exactly that one; otherwise the build did not see the environment (or the scan looked in the wrong place)
// and a clean result for the secrets would prove nothing.
import { rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWithCanaries, CANARIES, CONTROL_CANARIES, DIST_DIR, scanForCanaries } from "../../scripts/client-bundle-check.mjs";

type Hit = { file: string; name: string };

describe("production build", () => {
  it(
    "contains no INTUIT_* or Supabase secret canary in anything served to the browser, and the scan finds the NEXT_PUBLIC_ control",
    () => {
      const dist = buildWithCanaries() as string;
      try {
        const all = scanForCanaries(dist, { ...CANARIES, ...CONTROL_CANARIES }) as { hits: Hit[]; scanned: number };
        // The scan must have looked at real build output.
        expect(all.scanned).toBeGreaterThan(50);
        const control = Object.keys(CONTROL_CANARIES);
        expect([...new Set(all.hits.filter((h) => control.includes(h.name)).map((h) => h.name))], "positive control not found in the build").toEqual(control);
        const leaks = all.hits.filter((h) => !control.includes(h.name));
        expect(leaks.map((h) => `${h.name} in ${h.file}`)).toEqual([]);
        const statics = scanForCanaries(path.join(dist, "static"), CANARIES) as { hits: unknown[]; scanned: number };
        expect(statics.scanned).toBeGreaterThan(3);
        expect(statics.hits).toEqual([]);
      } finally {
        rmSync(path.join(path.dirname(dist), DIST_DIR), { recursive: true, force: true });
      }
    },
    10 * 60 * 1000,
  );
});
