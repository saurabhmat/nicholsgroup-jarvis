// T-278 review (S1): every production read of `core.connections` in apps and packages is classified here, so an UNFILTERED read (one that would list a `microsoft_teams` row as if it were a
// mailbox or a data feed) is caught by a test, not only files that happen to name the provider. A new `.from("connections")` makes this list fail until someone decides which kind it is.
//   filtered   the query names the providers it wants (a Teams row is never among them)
//   by-id      the query is for ONE connection the caller already holds (update, load, token read); it lists nothing
//   all        lists every provider ON PURPOSE: the connection-health job, which has a Teams checker
//   excluded   lists every provider except Teams, explicitly
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
function production(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", "dist", ".turbo", ".git", "test-stubs", ".next-canary"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
    }
  };
  walk(join(root, "apps"));
  walk(join(root, "packages"));
  return files;
}

type Kind = "filtered" | "by-id" | "all" | "excluded";
/** [kind, how many `.from("connections")` queries the file has]: a second query in a listed file changes the count and must be re-reviewed. */
const READS: Record<string, [Kind, number]> = {
  "apps/web/lib/calendar-page.ts": ["filtered", 1], // .in("provider", google, microsoft), the caller's own
  "apps/web/lib/composio-connection.ts": ["filtered", 1], // transport composio rows of a toolkit
  "apps/web/lib/google-connection.ts": ["filtered", 1], // .eq("provider", provider) for google / microsoft
  "apps/web/lib/home.ts": ["excluded", 1], // .neq("provider", "microsoft_teams"): Home's feeds and attention list
  "apps/web/lib/quickbooks-connection.ts": ["filtered", 1], // provider quickbooks
  "apps/web/lib/teams-connection.ts": ["filtered", 1], // provider microsoft_teams, on purpose (the Teams section)
  "packages/connectors/src/composio/store.ts": ["filtered", 4], // transport composio
  "packages/connectors/src/health/store.ts": ["all", 5], // token health: every usable native connection, Teams has its own checker and skip
  "packages/connectors/src/microsoft/identity.ts": ["by-id", 1],
  "packages/connectors/src/quickbooks/features.ts": ["by-id", 1],
  "packages/connectors/src/quickbooks/reconnect.ts": ["by-id", 2],
  "packages/connectors/src/sync/store.ts": ["by-id", 1],
  "packages/connectors/src/sync/targets.ts": ["filtered", 1], // .in("provider", mail / calendar providers)
  "packages/connectors/src/teams/identity.ts": ["by-id", 1],
  "packages/connectors/src/vault/connections.ts": ["filtered", 5], // ensure/find by provider and account, listMailAccounts .in(google, microsoft)
  "packages/connectors/src/vault/loader.ts": ["by-id", 1],
  "packages/modules/approvals/src/server/wire.ts": ["by-id", 1],
  "packages/modules/briefing/src/jobs/index.ts": ["filtered", 1], // .in("provider", google, microsoft): who owns a mailbox
};
const rel = (f: string) => relative(root, f);

describe("every read of core.connections is classified", () => {
  const readers = production().filter((f) => /\.from\(\s*["']connections["']\s*\)/.test(readFileSync(f, "utf8")));

  it("the list of reading files is exactly the classified one, with exactly the classified number of queries each", () => {
    expect(readers.map(rel).sort()).toEqual(Object.keys(READS).sort());
    for (const f of readers) expect((readFileSync(f, "utf8").match(/\.from\(\s*["']connections["']\s*\)/g) ?? []).length, rel(f)).toBe(READS[rel(f)]?.[1]);
  });

  it.each(Object.entries(READS).map(([file, [kind]]) => [file, kind] as const))("%s (%s) is what it says it is", (file, kind) => {
    const src = readFileSync(join(root, file), "utf8");
    if (kind === "filtered") expect(src, file).toMatch(/provider|transport/);
    if (kind === "by-id") expect(src, file).toMatch(/\.eq\(\s*["']id["']/);
    if (kind === "excluded") expect(src, file).toMatch(/\.neq\(\s*["']provider["'],\s*["']microsoft_teams["']\s*\)/);
    if (kind === "all") expect(src, file).not.toMatch(/\.in\(\s*["']provider["']\s*,\s*\[[^\]]*microsoft_teams/);
    // no `.in("provider", [...])` list of a reader names Teams (the Teams section reads with .eq)
    expect(src.match(/\.in\(\s*["']provider["']\s*,[^)]*\)/g)?.some((m) => m.includes("microsoft_teams")) ?? false, file).toBe(false);
  });

  it("the files that read connections AND name the Teams provider are the reviewed ones (Home excludes it, the Teams section and identity read it, the store sets its owner)", () => {
    const named = production().filter((f) => /["']microsoft_teams["']/.test(readFileSync(f, "utf8")) && /\.from\(\s*["']connections["']\s*\)/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(named).toEqual(["apps/web/lib/home.ts", "apps/web/lib/teams-connection.ts", "packages/connectors/src/teams/identity.ts", "packages/connectors/src/vault/connections.ts"]);
  });
});
