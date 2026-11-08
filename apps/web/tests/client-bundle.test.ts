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

describe("canary set (T-219)", () => {
  it("covers the Composio key and auth config ids, none of them NEXT_PUBLIC_, all distinct and long enough to match nothing else", () => {
    for (const name of ["COMPOSIO_API_KEY", "COMPOSIO_GMAIL_AUTH_CONFIG_ID", "COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID"]) {
      expect(typeof (CANARIES as Record<string, string>)[name], name).toBe("string");
      expect(((CANARIES as Record<string, string>)[name] as string).length, name).toBeGreaterThan(24);
    }
    const values = Object.values(CANARIES) as string[];
    expect(new Set(values).size).toBe(values.length);
  });

  it("finds a Composio key planted in a client chunk, in any encoding", () => {
    const dir = path.join(scratch, "composio");
    mkdirSync(path.join(dir, "static"), { recursive: true });
    const key = (CANARIES as Record<string, string>).COMPOSIO_API_KEY as string;
    writeFileSync(path.join(dir, "static", "leak.js"), `var k="${Buffer.from(key).toString("base64")}";`);
    const { hits } = scanForCanaries(dir) as { hits: { name: string }[] };
    expect([...new Set(hits.map((h) => h.name))]).toEqual(["COMPOSIO_API_KEY"]);
  });
});
