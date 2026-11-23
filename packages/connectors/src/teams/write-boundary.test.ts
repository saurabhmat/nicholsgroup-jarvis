// Rule 5 boundary for the Teams write path (T-279, T-286, T-287): the Teams Graph write client is BUILT in exactly one file, the approvals-only writer wiring (teams/writer-entry.ts), which only the
// connectors write subpath re-exports to packages/modules/approvals; no production file other than the write client and its HTTP wrapper names a POST to a Teams route; and no route, page, job or
// tool can reach the writer. A test file is not production. The first assertions prove the scan finds what it must.
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

describe("the Teams write path is reachable only from approvals", () => {
  it("only the write client, the writer (a type) and the writer wiring name the factory or the client type (the scan finds them), and exactly one file builds a client", () => {
    const named = production()
      .filter((f) => /createTeamsWriteClient|TeamsWriteClient/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    // the client's own file, the message writer (it holds the client as a parameter and imports its TYPE only), and the one wiring file: no teams/index.ts, no reader, no route, no job.
    expect(named).toEqual(["packages/connectors/src/teams/write-client.ts", "packages/connectors/src/teams/writer-entry.ts", "packages/connectors/src/teams/writer.ts"]);
    const callers = production().filter((f) => /(?<!function )createTeamsWriteClient\s*\(/.test(text(f))).map(rel);
    expect(callers).toEqual(["packages/connectors/src/teams/writer-entry.ts"]);
    expect(text(join(root, "packages/connectors/src/teams/writer.ts"))).toMatch(/import type \{ TeamsWriteClient \} from "\.\/write-client"/);
    expect(text(join(root, "packages/connectors/src/teams/writer.ts"))).not.toMatch(/import \{[^}]*createTeamsWriteClient/);
  });

  it("the message writer and its reconciler are named only by the writer wiring, the write subpath and the approvals module; the wiring file is imported by the write subpath only", () => {
    const named = production()
      .filter((f) => /\bteamsMessageWriter\b|\bteamsMessageReconciler\b/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(named).toEqual(["packages/connectors/src/teams/writer-entry.ts", "packages/connectors/src/write/index.ts", "packages/modules/approvals/src/server/wire.ts"]);
    const importers = production()
      .filter((f) => /from "(\.\.?\/)+(teams\/)?writer-entry"/.test(text(f)))
      .map(rel)
      .sort();
    expect(importers).toEqual(["packages/connectors/src/write/index.ts"]);
    // the shared wiring (guard, token manager) is imported by the Teams index and the writer wiring only
    const wiring = production()
      .filter((f) => /from "(\.\/|\.\.\/teams\/)wiring"/.test(text(f)))
      .map(rel)
      .sort();
    expect(wiring).toEqual(["packages/connectors/src/teams/index.ts", "packages/connectors/src/teams/writer-entry.ts"]);
    // nothing outside approvals imports the write subpath (apps, other modules, jobs, tools)
    const importsWrite = production()
      .filter((f) => /(?:from|import\()\s*["']@nichols\/connectors\/write["']/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/modules/approvals/") && !f.startsWith("packages/eslint-plugin/src/"));
    expect(importsWrite).toEqual([]);
  });

  it("no production file other than the Teams write client sends a POST to a Teams route, and the HTTP wrapper only allows the write templates for the write kind", () => {
    const posters = production()
      .filter((f) => rel(f).startsWith("packages/connectors/src/teams/") && /method:\s*"(POST|PATCH|PUT|DELETE)"/.test(text(f)))
      .map(rel)
      .sort();
    expect(posters).toEqual(["packages/connectors/src/teams/write-client.ts"]);
    const read = text(join(root, "packages/connectors/src/teams/api.ts"));
    expect(read).not.toMatch(/TEAMS_WRITE_ROUTES|"POST"|"write"/);
    const http = text(join(root, "packages/connectors/src/teams/http.ts"));
    expect(http).toMatch(/req\.method === "GET" && isTeamsReadPath/);
    expect(http).toMatch(/req\.method === "POST" && isTeamsWritePath/);
  });

  it("the write subpath exports the Teams writer and its reconciler (the approvals module's door) but never the write client, and the read client's wiring (index.ts) does not build a write client or a writer", () => {
    const write = text(join(root, "packages/connectors/src/write/index.ts"));
    expect(write).toMatch(/export \{ teamsMessageReconciler, teamsMessageWriter \} from "\.\.\/teams\/writer-entry"/);
    expect(write).not.toMatch(/createTeamsWriteClient|TeamsWriteClient|write-client/);
    const index = text(join(root, "packages/connectors/src/teams/index.ts"));
    expect(index).not.toMatch(/write-client|createTeamsWriteClient|writer-entry|teamsMessageWriter|createTeamsMessageWriter/);
    expect(text(join(root, "packages/connectors/src/teams/wiring.ts"))).not.toMatch(/write-client|createTeamsWriteClient|writer-entry|teamsMessageWriter|createTeamsMessageWriter/);
  });

  it("the Teams send entries (propose, approve-and-execute, execute) are named only inside the approvals module: no route, page, job or tool calls them yet (T-286 review L3)", () => {
    const named = production()
      .filter((f) => /\b(proposeTeamsAction|approveAndExecuteTeamsAction|executeApprovedTeamsAction|approveAndExecuteTeams|executeApprovedTeams)\b/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    expect(named.filter((f) => !f.startsWith("packages/modules/approvals/src/"))).toEqual([]);
    expect(named).toEqual(["packages/modules/approvals/src/server/index.ts", "packages/modules/approvals/src/server/teams.ts", "packages/modules/approvals/src/server/wire.ts"]);
  });

  it("the message writer reaches Microsoft only through the guarded read client and the write client: no fetch, no HTTP method, no token read, no other write route", () => {
    const t = text(join(root, "packages/connectors/src/teams/writer.ts"));
    expect(t).not.toMatch(/\bfetch\(|XMLHttpRequest|method:\s*"|createTeamsHttp|getToken|tokens\.|accessToken|markChatReadForUser|setReaction|softDelete|console\./);
    expect(t).toMatch(/retry: false/);
    // the POST templates it can name are exactly the three the write client allows
    expect([...t.matchAll(/path = s\.type === [\s\S]*?: "(\/[^"]+)";/g)].length).toBe(1);
    for (const f of ["send-schema.ts", "actions-purge-store.ts"]) expect(text(join(root, "packages/connectors/src/teams", f)), f).not.toMatch(/\bfetch\(|"POST"|createTeamsWriteClient/);
  });

  it("the Teams connector never names a subscription route (notices are T-289) or a mail route", () => {
    for (const f of production().filter((p) => rel(p).startsWith("packages/connectors/src/teams/"))) {
      const t = text(f);
      expect(t, rel(f)).not.toMatch(/["'`]\/subscriptions/);
      expect(t, rel(f)).not.toMatch(/["'`]\/me\/(messages|mailFolders|events|calendar)/i);
    }
  });

  it("the \"write\" kind of the Teams HTTP wrapper (the one that can POST) is requested only by the write client, across apps and packages; the HTTP wrapper itself is built only where the lint rule allows", () => {
    const users = production()
      .filter((f) => /createTeamsHttp\s*\([\s\S]{0,1500}?["']write["']\s*,?\s*\)/.test(text(f)))
      .map(rel)
      .filter((f) => f !== "packages/connectors/src/teams/http.ts")
      .sort();
    expect(users).toEqual(["packages/connectors/src/teams/write-client.ts"]);
    const builders = production()
      .filter((f) => /createTeamsHttp\s*\(/.test(text(f)) && !/function createTeamsHttp/.test(text(f)))
      .map(rel)
      .sort();
    expect(builders).toEqual(["packages/connectors/src/teams/api.ts", "packages/connectors/src/teams/provider.ts", "packages/connectors/src/teams/write-client.ts", "packages/connectors/src/testing/teams-harness.ts"]);
  });

  it("the chat reader (T-281) can only read: it names no write client, no write route, no HTTP method but the read client's GET, no direct fetch, and its one log line holds no content", () => {
    for (const name of ["reader.ts", "reader-entry.ts", "deep-links.ts", "message-html.ts", "chat-reads-store.ts"]) {
      const t = text(join(root, "packages/connectors/src/teams", name));
      expect(t, name).not.toMatch(/write-client|TEAMS_WRITE_ROUTES|createTeamsWriteClient|isTeamsWritePath/);
      expect(t, name).not.toMatch(/\bfetch\(|XMLHttpRequest|"POST"|"PATCH"|"PUT"|"DELETE"|markChatReadForUser|setReaction|softDelete/);
      expect(t, name).not.toMatch(/console\./);
    }
    const reader = text(join(root, "packages/connectors/src/teams/reader.ts"));
    // exactly two fixed log lines, both content-free: a name and the lane id, nothing taken from a response
    const lines = [...reader.matchAll(/log\.(debug|info|warn|error)\(([^;]*)\);/g)].map((m) => m[2]);
    expect(lines).toEqual(['"teams.chats.expand_fallback", { laneId }', '"teams.chats.no_cursor", { laneId }']);
    // every request goes through the guarded read client with an explicit user actor and no retry
    expect(reader).toMatch(/actor: \{ kind: "user", userId \}, retry: false/);
    expect(reader).not.toMatch(/kind: "service"/);
  });
});
