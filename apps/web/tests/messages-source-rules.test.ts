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

  it("only three files import the Teams reader (the routes, the chat loaders, the channel loaders); nothing in apps/web names the Graph host, a write route or a mark-read call", () => {
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
    expect(importers).toEqual(["lib/teams-api.ts", "lib/teams-channels.ts", "lib/teams-chats.ts"]); // T-291 added lib/teams-channels.ts (the channel loaders, same server-only rule); // the reader is server-only; components get types and the pure rules from teams-pure
    expect(read("components/messages-view.tsx")).toMatch(/import type \{ MessageNode \} from "@nichols\/connectors\/teams-pure"/);
    for (const f of ["components/messages-view.tsx", "components/messages-client.tsx", "components/messages-chats.tsx", "components/messages-channels.tsx", "components/messages-image.tsx"]) expect(read(f), f).not.toMatch(/connectors\/teams-reader/);
    // the picture component's only request is ONE status probe of the portal's own route: the address is rebuilt from a static relative prefix, checked against the own-route pattern immediately
    // before the request, and the request names that checked variable; no other host, no XMLHttpRequest
    const img = read("components/messages-image.tsx");
    expect([...img.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(img).toMatch(/const probe = `\/api\/lanes\/\$\{src\.slice\("\/api\/lanes\/"\.length\)\}`;\s*if \(!OWN_ROUTE\.test\(probe\)\) throw [^\n]*\n\s*const r = await fetch\(probe, \{ credentials: "same-origin", cache: "no-store" \}\);/);
    expect(img).not.toMatch(/XMLHttpRequest|https?:\/\//);
    // the only way a `blob:` address reaches an <img> is the probe's own answer: one createObjectURL, from that response's blob, typed by an allowed image type
    expect([...img.matchAll(/createObjectURL\(/g)]).toHaveLength(1);
    expect(img).toMatch(/const b = await r\.blob\(\);\s*if \(alive\.current && IMAGE_TYPES\.has\(b\.type\)\) \{\s*showBlob\(URL\.createObjectURL\(b\)\);/);
    expect([...img.matchAll(/<img [^>]*src=\{([^}]*)\}/g)].map((m) => m[1])).toEqual(["blob ?? src"]);
    expect(img).toMatch(/revokeObjectURL/);
    for (const f of files) {
      const t = readFileSync(f, "utf8");
      expect(t, relative(web, f)).not.toMatch(/graph\.microsoft\.(com|us)|login\.microsoftonline|markChatReadForUser|\/chats\/[^"'`\s]*\/messages["'`]\s*,\s*\{\s*method/);
    }
  });

  it("the browser code calls only this portal's own routes", () => {
    const urls = [...code("components/messages-client.tsx").matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^\/api\/lanes\/\$\{encodeURIComponent\(laneId\)\}\/messages\/(older|read|call-link|newer)/);
    expect(code("components/messages-client.tsx")).not.toMatch(/fetch\(\s*["'`]https?:/);
  });

  // T-290: the ONE loop of the Messages page asks the portal's OWN database; it is in one file and pinned here.
  it("the live Messages code (T-290): exactly one timer, it only asks the portal's own activity route; the re-reads and the dot go to own routes; no storage, no raw HTML, no Microsoft host", () => {
    const live = code("components/messages-live.tsx");
    expect([...live.matchAll(/\bsetInterval\(/g)]).toHaveLength(1);
    expect(live).toMatch(/timer = setInterval\(\(\) => void \(begun \? poll\(\) : tryBegin\(\)\), ACTIVITY_POLL_MS\)/);
    expect(live).not.toMatch(/\bsetTimeout\b|requestAnimationFrame|EventSource|WebSocket|navigator\.sendBeacon|serviceWorker/);
    // `poll` asks the database only: it names getActivity, never a re-read route
    const poll = live.slice(live.indexOf("async function poll()"), live.indexOf("async function begin()"));
    expect(poll).toMatch(/getActivity\(laneId, ac\.signal\)/);
    expect(poll).not.toMatch(/\bfetch\(|messages\/(chats|newer|older|read)/);
    // the loop's comment says what it is
    expect(read("components/messages-live.tsx")).toMatch(/THE LOOP BELOW DOES\s*\/\/ NOT POLL MICROSOFT/);
    // the one fetch of the file is the chat-list re-read, to an own route; everything else goes through the activity client
    const urls = [...live.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\/api\/lanes\/\$\{encodeURIComponent\(laneId\)\}\/messages\/chats/);
    const client = code("lib/messages-activity-client.ts");
    expect([...client.matchAll(/fetch\(/g)]).toHaveLength(2);
    expect([...client.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1])).toEqual(["/api/lanes/${encodeURIComponent(laneId)}/messages/activity", "/api/lanes/${encodeURIComponent(laneId)}/messages/activity"]);
    for (const f of ["components/messages-live.tsx", "components/messages-dot.tsx", "lib/messages-activity-client.ts", "components/teams-live-status.tsx", "lib/messages-live-config.ts"]) {
      const c = code(f);
      expect(c, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|document\.write|\beval\(|localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|graph\.microsoft|teams\.microsoft|@nichols\/connectors/);
      expect(c, f).not.toMatch(/console\.(log|info|debug)/);
    }
    // the dot never draws anything that came from a chat: it takes no text from the answer
    expect(code("components/messages-dot.tsx")).not.toMatch(/\.title|\.text|preview|sender|chatId/);
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
