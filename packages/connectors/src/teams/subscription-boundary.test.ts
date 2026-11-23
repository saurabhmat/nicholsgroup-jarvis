// The boundary of the Teams subscription client (T-289; the pattern of microsoft/subscription-boundary.test.ts): a Teams subscription is created, renewed and stopped by the renewal job's code only.
// No production file outside the Teams wiring, the client itself and the subscription logic may name the client or send a request to `/subscriptions` for Teams; the receiver, the retention
// registry, the facade, the routes and the apps never do; the Teams READ and WRITE clients cannot reach it and it cannot reach them. A test file is not production.
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
const T = "packages/connectors/src/teams";

describe("the Teams subscription client is reachable only from the renewal job's code", () => {
  it("only the client, its wiring and the subscription logic name the client (the scan finds them)", () => {
    const named = production()
      .filter((f) => /createTeamsSubscriptionClient|TeamsSubscriptionClient/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(named).toEqual([`${T}/index.ts`, `${T}/subscription-client.ts`, `${T}/subscriptions.ts`]);
  });

  it("the logic imports the client as a TYPE only and takes the instance as a parameter; the Teams wiring is the one place that builds it, once", () => {
    const logic = text(join(root, `${T}/subscriptions.ts`));
    expect(logic).toMatch(/import type \{ TeamsSubscriptionClient \} from "\.\/subscription-client"/);
    expect(logic).not.toMatch(/createTeamsSubscriptionClient/);
    const wiring = text(join(root, `${T}/index.ts`));
    expect(wiring.match(/createTeamsSubscriptionClient\(/g)).toHaveLength(1);
  });

  it("the subscription instance and its renewer are named only by the Teams wiring and the renewal registry", () => {
    const named = production()
      .filter((f) => /\bteamsSubscriptionRenewer\b|\bteamsSubscriptions\b/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(named).toEqual(["packages/connectors/src/health/index.ts", `${T}/index.ts`]);
    const registry = text(join(root, "packages/connectors/src/health/index.ts"));
    expect(registry).toMatch(/microsoft_teams: teamsSubscriptionRenewer/);
  });

  it("the Teams read client, the write client and the writer never name a subscription, and the subscription files never name a message route or the write client", () => {
    for (const f of ["api.ts", "write-client.ts", "writer.ts", "writer-entry.ts", "reader.ts", "channels.ts", "images.ts"]) expect(text(join(root, T, f)), f).not.toMatch(/subscription/i);
    for (const f of ["subscription-client.ts", "subscriptions.ts", "notices-store.ts", "notices-entry.ts"]) {
      const t = text(join(root, T, f));
      expect(t, f).not.toMatch(/write-client|createTeamsWriteClient|TEAMS_WRITE_ROUTES|TEAMS_READ_ROUTES|teamsApi|\/chats\/\{|markChatReadForUser|setReaction|softDelete/);
      expect(t, f).not.toMatch(/\bfetch\s*\(|console\./);
    }
  });

  it("the receiver, the retention registry, the facade and the routes never import the Teams subscription logic or client: the receiver only queues", () => {
    for (const f of ["packages/connectors/src/webhooks/microsoft.ts", "packages/connectors/src/webhooks/index.ts", "apps/web/app/api/webhooks/microsoft/route.ts", "packages/connectors/src/retention/tables.ts"]) {
      const source = text(join(root, f));
      const imports = [...source.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
      for (const spec of imports) expect(spec, `${f}: ${spec}`).not.toMatch(/teams\/(index|subscription|subscriptions|wiring|api|http|guard|token-manager)|subscription-client/i);
      expect(source, f).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("the Inngest function that records a notice has no Graph client: it imports no connector at all (core cannot), and the connector entry it is given names no HTTP client, token or guard", () => {
    const fn = text(join(root, "packages/core/src/inngest/teams-activity.ts"));
    expect([...fn.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])).toEqual(["inngest", "./events"]);
    expect(fn).not.toMatch(/\bfetch\s*\(|graph\.microsoft/);
    const entry = text(join(root, `${T}/notices-entry.ts`));
    expect([...entry.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])).toEqual(["@nichols/core", "../vault/index"]);
  });

  it("includeResourceData is never sent: no production file names it as an object key (the client's own comments say why it cannot be sent)", () => {
    for (const f of production().filter((p) => /includeResourceData/.test(text(p)))) expect(text(f), rel(f)).not.toMatch(/includeResourceData\s*:/);
  });

  it("the disconnect wiring registers the activity purger beside the read markers and the send actions", () => {
    const wiring = text(join(root, `${T}/index.ts`));
    for (const name of ["chat_reads", "send_actions", "activity"]) expect(wiring).toContain(`name: "${name}"`);
    expect(wiring).toMatch(/teamsNoticesStore\.purgeConnection/);
  });
});
