// The boundary of the Graph subscription client (T-068, T-264): subscriptions are created, renewed and stopped by the watch/renew code only. No production file outside the Microsoft wiring,
// the client itself and the subscription logic may name the client or build a request to `/subscriptions`; the receiver, the renewal job's registry, the mail write client, the routes and
// the apps never do. A test file is not production. The first assertion is the proof that the scan itself works (it must find the files that are allowed to).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
function production(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", ".turbo", ".git", "test-stubs"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
    }
  };
  walk(join(root, "apps"));
  walk(join(root, "packages"));
  return files;
}
const rel = (f: string) => relative(root, f);
const text = (f: string) => readFileSync(f, "utf8");

describe("the Graph subscription client is reachable only from the watch/renew code", () => {
  it("only the client, its wiring and the subscription logic name the client", () => {
    const offenders = production()
      .filter((f) => /createGraphSubscriptionClient|GraphSubscriptionClient|microsoft\/subscription-client|\.\/subscription-client/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(offenders).toEqual(["packages/connectors/src/microsoft/index.ts", "packages/connectors/src/microsoft/subscription-client.ts", "packages/connectors/src/microsoft/subscriptions.ts"]);
  });

  it("the logic imports the client as a TYPE only and takes the instance as a parameter; the wiring is the one place that builds it", () => {
    const logic = text(join(root, "packages/connectors/src/microsoft/subscriptions.ts"));
    expect(logic).toMatch(/import type \{ GraphSubscriptionClient \} from "\.\/subscription-client"/);
    expect(logic).not.toMatch(/createGraphSubscriptionClient/);
    const wiring = text(join(root, "packages/connectors/src/microsoft/index.ts"));
    expect(wiring.match(/createGraphSubscriptionClient\(/g)).toHaveLength(1);
  });

  it("no production file other than the client and the logic sends a request (constants.ts holds the template check, http.ts the path rule of the `subscriptions` kind) to a /subscriptions path", () => {
    const files = production()
      .filter((f) => /["'`]\/subscriptions/.test(text(f)))
      .map(rel)
      .sort();
    expect(files).toEqual(["packages/connectors/src/microsoft/constants.ts", "packages/connectors/src/microsoft/http.ts", "packages/connectors/src/microsoft/subscription-client.ts", "packages/connectors/src/microsoft/subscriptions.ts"]);
  });

  it("the mail write client's allow-list is untouched: no subscription route in it", () => {
    const writer = text(join(root, "packages/connectors/src/microsoft/write-client.ts"));
    expect(writer).not.toMatch(/subscriptions/i);
  });

  it("the receiver, the registry, the facade and the routes never import the subscription logic or the client: the receiver only queues", () => {
    for (const f of ["packages/connectors/src/webhooks/microsoft.ts", "packages/connectors/src/webhooks/index.ts", "apps/web/app/api/webhooks/microsoft/route.ts"]) {
      const source = text(join(root, f));
      const imports = [...source.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
      for (const spec of imports) expect(spec, `${f}: ${spec}`).not.toMatch(/subscription-client|\/subscriptions$|graph|microsoft\/(api|http|guard|token-manager)/i);
      expect(source, f).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("includeResourceData is never sent: no production file names it", () => {
    const named = production().filter((f) => /includeResourceData/.test(text(f))).map(rel).sort();
    // only the client's own comment documents why it cannot be sent, and the logic's comment; no object key anywhere
    for (const f of named) expect(text(join(root, f)), f).not.toMatch(/includeResourceData\s*:/);
  });
});
