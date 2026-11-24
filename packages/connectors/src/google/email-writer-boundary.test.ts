// Rule 5 boundary for the Gmail write path (T-232): no production file outside the connector's own wiring and
// packages/modules/approvals may name the email writer or import the write subpath. A test file is not production.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("the Gmail write path is reachable only from approvals", () => {
  it("only the writer, its wiring, the write subpath and packages/modules/approvals name it", () => {
    const root = resolve(__dirname, "../../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", "dist", ".turbo", ".git"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
      }
    };
    walk(join(root, "apps"));
    walk(join(root, "packages"));
    const offenders = files
      .filter((f) => /googleEmailWriter|createGoogleEmailWriter|google\/email-writer|@nichols\/connectors\/write\b|\/messages\/send|\/gmail\/v1\/users\/me\/drafts/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith("packages/modules/approvals/") && !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    // T-288: the three web files below name the PORTAL's own Teams route `/api/lanes/<lane>/messages/send` (its path text matches the Gmail endpoint's `/messages/send`); they build no Gmail request and
    // import neither writer. Added deliberately, one by one: the route file, the Messages API logic and the composer that calls the route.
    expect(offenders).toEqual([
      "apps/web/app/api/lanes/[laneId]/messages/send/route.ts",
      "apps/web/components/messages-send.tsx",
      "apps/web/lib/teams-api.ts",
      "packages/connectors/src/google/email-writer.ts",
      "packages/connectors/src/google/index.ts",
      "packages/connectors/src/quickbooks/writer.ts",
      "packages/connectors/src/write/index.ts",
    ]);
  });
});
