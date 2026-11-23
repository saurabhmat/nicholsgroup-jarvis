// Source rules for Messages (T-283, T-284): the properties that are about what the code CONTAINS, pinned so a later change cannot quietly break them.
//   rule 9: no raw HTML reaches the browser (no dangerouslySetInnerHTML, no innerHTML) in anything that draws a chat;
//   Microsoft's terms: no polling (no timer, no EventSource, no WebSocket) in the Messages code; fetches only on a click or once when a chat opens;
//   rule 6: nothing from a chat is kept in the browser (no storage, no cookie) or in the server (no cache, no `unstable_cache`, no `use cache`, no module-level state for content);
//   rule 4/5: Teams is reached only through `@nichols/connectors/teams-reader` (read only), from two files; nothing in apps/web names a write route or a Graph host.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const web = resolve(__dirname, "..");
const read = (f: string) => readFileSync(join(web, f), "utf8");
const MESSAGES = ["components/messages-view.tsx", "components/messages-chats.tsx", "components/messages-client.tsx", "components/messages-page.tsx", "lib/teams-chats.ts", "lib/teams-api.ts", "lib/teams-reads.ts", "lib/teams-format.ts", "lib/teams-errors.ts", "lib/teams-chat-key.ts"];
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // without comments

describe("Messages source rules", () => {
  it.each(MESSAGES)("%s: no raw HTML, no timers, no browser storage, no server cache", (f) => {
    const c = code(f);
    expect(c).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    expect(c).not.toMatch(/\bsetInterval\b|\bsetTimeout\b|requestAnimationFrame|EventSource|WebSocket|navigator\.sendBeacon|serviceWorker/);
    expect(c).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./);
    expect(c).not.toMatch(/unstable_cache|["']use cache["']|revalidate|cacheLife|cacheTag/);
    expect(c).not.toMatch(/console\.(log|info|debug)/);
  });

  it("only two files import the Teams reader; nothing in apps/web names the Graph host, a write route or a mark-read call", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".next-canary", ".next-e2e", "e2e", "test-results"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(p);
      }
    };
    walk(web);
    const importers = files.filter((f) => /@nichols\/connectors\/teams-reader/.test(readFileSync(f, "utf8"))).map((f) => relative(web, f)).sort();
    expect(importers).toEqual(["lib/teams-api.ts", "lib/teams-chats.ts"]); // the reader is server-only; components get types and the pure rules from teams-pure
    expect(read("components/messages-view.tsx")).toMatch(/import type \{ MessageNode \} from "@nichols\/connectors\/teams-pure"/);
    for (const f of ["components/messages-view.tsx", "components/messages-client.tsx", "components/messages-chats.tsx"]) expect(read(f), f).not.toMatch(/connectors\/teams-reader/);
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect(t, relative(web, f)).not.toMatch(/graph\.microsoft\.(com|us)|login\.microsoftonline|markChatReadForUser|\/chats\/[^"'`\s]*\/messages["'`]\s*,\s*\{\s*method/);
    }
  });

  it("the browser code calls only this portal's own routes", () => {
    const urls = [...code("components/messages-client.tsx").matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^\/api\/lanes\/\$\{encodeURIComponent\(laneId\)\}\/messages\/(older|read|call-link)/);
    expect(code("components/messages-client.tsx")).not.toMatch(/fetch\(\s*["'`]https?:/);
  });

  it("every link the page draws from Teams content opens in a new tab with noopener, and none is ever opened by code except the person's click on Call / Video call", () => {
    const view = code("components/messages-view.tsx") + code("components/messages-client.tsx") + code("components/messages-chats.tsx");
    for (const a of view.match(/<a\b[^>]*>/g) ?? []) {
      if (/href=\{(n\.href|a\.href|openUrl|state\.link)\}/.test(a)) {
        expect(a, a).toMatch(/target="_blank"/);
        expect(a, a).toMatch(/rel="noopener noreferrer/);
      }
    }
    expect(view.match(/window\.open\(/g)).toHaveLength(1); // the Call / Video call click handler
    expect(view).not.toMatch(/window\.location|location\.href\s*=|location\.assign|location\.replace/);
    expect(view).not.toMatch(/<img\b|<iframe\b|<object\b|<embed\b|<video\b|<audio\b|<source\b/);
  });

  it("the module-gated page has no cache directive and the Graph reads sit behind the gate: the page function itself calls no loader", () => {
    const page = code("app/[laneId]/messages/page.tsx");
    expect(page).not.toMatch(/loadChatList|loadConversation|teams-reader|listChats|listMessages/);
    expect(page).toMatch(/<ModuleGate module="messages"/);
  });

  it("the routes carry no cache headers except no-store, and no route sets a cookie or a header from content", () => {
    const api = code("lib/teams-api.ts");
    expect(api).toMatch(/"cache-control": "no-store"/);
    expect(api).not.toMatch(/set-cookie|cookies\(/i);
  });
});
