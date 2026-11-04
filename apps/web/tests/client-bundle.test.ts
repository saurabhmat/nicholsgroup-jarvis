// QB-17 (T-050): the canary scanner, proven on planted files (fast; part of the default `vitest run`). The real
// `next build` that feeds it is tests/bundle/client-bundle-build.test.ts, run by `pnpm test:bundle`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CANARIES, CONTROL_CANARIES, scanForCanaries } from "../scripts/client-bundle-check.mjs";

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

  it("finds the NEXT_PUBLIC_ positive control, and the control is not one of the secrets", () => {
    const dir = path.join(scratch, "control");
    mkdirSync(dir, { recursive: true });
    const [name, value] = Object.entries(CONTROL_CANARIES)[0] as [string, string];
    writeFileSync(path.join(dir, "chunk.js"), `var k="${value}";`);
    const { hits } = scanForCanaries(dir, CONTROL_CANARIES) as { hits: { name: string }[] };
    expect(hits.map((h) => h.name)).toEqual([name]);
    expect(name).toMatch(/^NEXT_PUBLIC_/);
    expect(Object.keys(CANARIES).some((k) => k.startsWith("NEXT_PUBLIC_"))).toBe(false);
    // Scanning the secrets alone does not match the control value.
    expect((scanForCanaries(dir) as { hits: unknown[] }).hits).toEqual([]);
  });
});
