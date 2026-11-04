// QB-17 (T-050): a canary in every INTUIT_* server secret (and the Supabase secret key) must not appear anywhere the
// browser can receive from a real production build. The scanner is proven first on planted files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWithCanaries, CANARIES, DIST_DIR, scanForCanaries } from "../scripts/client-bundle-check.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "bundle-scan-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("canary scanner", () => {
  it("finds a canary in plain, URL-encoded, base64 and JSON-escaped form, and ignores clean files", () => {
    const dir = path.join(scratch, "planted");
    mkdirSync(path.join(dir, "static"), { recursive: true });
    const secret = CANARIES.INTUIT_CLIENT_SECRET as string;
    writeFileSync(path.join(dir, "static", "plain.js"), `var a="${secret}";`);
    writeFileSync(path.join(dir, "static", "b64.js"), `var a="${Buffer.from(secret).toString("base64")}";`);
    writeFileSync(path.join(dir, "static", "url.js"), `var a="${encodeURIComponent(CANARIES.INTUIT_REDIRECT_URI as string)}";`);
    writeFileSync(path.join(dir, "static", "clean.js"), 'var a="nothing to see";');
    const { hits, scanned } = scanForCanaries(dir) as { hits: { file: string; name: string }[]; scanned: number };
    expect(scanned).toBe(4);
    expect(hits.map((h) => h.file).sort()).toEqual([path.join("static", "b64.js"), path.join("static", "plain.js"), path.join("static", "url.js")]);
  });
});

describe("production build", () => {
  it(
    "contains no INTUIT_* or Supabase secret canary in anything served to the browser",
    () => {
      const dist = buildWithCanaries() as string;
      try {
        const { hits, scanned } = scanForCanaries(dist) as { hits: { file: string; name: string }[]; scanned: number };
        // The scan must have looked at real client output.
        expect(scanned).toBeGreaterThan(50);
        const { hits: staticHits, scanned: staticScanned } = scanForCanaries(path.join(dist, "static")) as { hits: unknown[]; scanned: number };
        expect(staticScanned).toBeGreaterThan(3);
        expect(staticHits).toEqual([]);
        expect(hits.map((h) => `${h.name} in ${h.file}`)).toEqual([]);
      } finally {
        rmSync(path.join(path.dirname(dist), DIST_DIR), { recursive: true, force: true });
      }
    },
    10 * 60 * 1000,
  );
});
