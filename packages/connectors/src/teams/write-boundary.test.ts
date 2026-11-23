// Rule 5 boundary for the Teams write path (T-279): the Teams Graph write client may be BUILT only by packages/modules/approvals (T-286); nothing builds one in this build, and no
// production file other than the write client and its HTTP wrapper names a POST to a Teams route. A test file is not production. The first assertions prove the scan finds what it must.
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
  it("only the write client names the factory or the client type (the scan finds them), and nothing builds one yet", () => {
    const named = production()
      .filter((f) => /createTeamsWriteClient|TeamsWriteClient/.test(text(f)))
      .map(rel)
      .filter((f) => !f.startsWith("packages/eslint-plugin/src/"))
      .sort();
    // the client's own file, and nothing else: no wiring (teams/index.ts), no reader, no route, no job. T-286 adds the approvals wiring to this list.
    expect(named).toEqual(["packages/connectors/src/teams/write-client.ts"]);
    const callers = production().filter((f) => /(?<!function )createTeamsWriteClient\s*\(/.test(text(f))).map(rel);
    expect(callers).toEqual([]);
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

  it("the write subpath does not export a Teams writer or client yet, and the read client's wiring (index.ts) does not build a write client", () => {
    expect(text(join(root, "packages/connectors/src/write/index.ts"))).not.toMatch(/teams/i);
    expect(text(join(root, "packages/connectors/src/teams/index.ts"))).not.toMatch(/write-client|createTeamsWriteClient/);
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
    expect(reader.match(/log\.(debug|info|warn|error)\(/g) ?? []).toHaveLength(1);
    expect(reader).toMatch(/log\.warn\("teams\.chats\.expand_fallback", \{ laneId \}\)/);
    // every request goes through the guarded read client with an explicit user actor and no retry
    expect(reader).toMatch(/actor: \{ kind: "user", userId \}, retry: false/);
    expect(reader).not.toMatch(/kind: "service"/);
  });
});
