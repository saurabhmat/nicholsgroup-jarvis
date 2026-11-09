// T-230 A: measurement only (not part of e2e:brain). Signs in as the owner persona, warms up, then records per route:
// - hard load (page.goto): TTFB, first contentful paint, end of the response stream;
// - soft navigation (sidebar click): click -> skeleton visible, click -> page heading visible;
// - the Server-Timing header and the epoch window of each navigation (server `[timing]` log lines carry epoch `at`).
// Run: PERF_MEASURE=1 SERVER_TIMING=1 E2E_SPECS=e2e/perf-measure.spec.ts pnpm e2e:brain --project=desktop   (writes PERF_OUT).
// LOCAL stack only, synthetic persona.
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { completeMfa, nextTotpWindow, signInWithEmailCode } from "./helpers";
import { clearMailbox } from "./mailpit";
import { personas } from "./personas";

test.skip(!process.env.PERF_MEASURE, "measurement run only (PERF_MEASURE=1)");
test.setTimeout(600_000);

const ROUTES = [
  { key: "home", path: "/PKG", link: "Home", heading: /^Good morning/ },
  { key: "inbox", path: "/PKG/inbox", link: "Inbox", heading: /^Inbox/ },
  { key: "calendar", path: "/PKG/calendar", link: "Calendar", heading: /^Calendar/ },
  { key: "settings", path: "/PKG/settings", link: "Settings", heading: /^Settings/ },
  { key: "onboarding", path: "/PKG/onboarding", link: /^Get started/, heading: /^Set up your/ },
] as const;
const RUNS = Number(process.env.PERF_RUNS ?? 7);

type Soft = { route: string; run: number; startEpoch: number; endEpoch: number; skeletonMs: number | null; contentMs: number | null; rscSendMs: number | null; rscFirstByteMs: number | null; rscEndMs: number | null; serverTiming: string[] };
type Hard = { route: string; run: number; startEpoch: number; endEpoch: number; ttfbMs: number; fcpMs: number | null; endMs: number; serverTiming: string };

async function armSoft(page: Page, heading: RegExp): Promise<void> {
  await page.evaluate((src) => {
    const re = new RegExp(src);
    const w = window as unknown as { __nav: { click: number | null; skel: number | null; content: number | null } };
    w.__nav = { click: null, skel: null, content: null };
    document.addEventListener("click", () => (w.__nav.click = performance.now()), { capture: true, once: true });
    const tick = () => {
      const n = w.__nav;
      if (n.click !== null) {
        const skeleton = document.querySelector("[data-testid=page-skeleton]");
        if (n.skel === null && skeleton) n.skel = performance.now();
        if (n.content === null && !skeleton && [...document.querySelectorAll("h1")].some((h) => re.test(h.textContent ?? ""))) n.content = performance.now();
      }
      if (n.content === null) requestAnimationFrame(tick);
    };
    tick();
  }, heading.source);
}

test("measure route timings", async ({ page }, info) => {
  const { member } = personas(info);
  await clearMailbox();
  await signInWithEmailCode(page, member);
  await nextTotpWindow(page);
  await completeMfa(page, member);
  await expect(page).toHaveURL(/\/PKG$/, { timeout: 30_000 });

  const hard: Hard[] = [];
  const soft: Soft[] = [];
  let jwtAlg: string | null = null;
  const cookies = await page.context().cookies();
  const auth = cookies.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.value).join("");
  try {
    const joined = auth.startsWith("base64-") ? Buffer.from(auth.slice(7), "base64url").toString() : decodeURIComponent(auth);
    const token = (JSON.parse(joined) as { access_token: string }).access_token; // read here only to report the header's alg; never printed
    jwtAlg = (JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()) as { alg: string }).alg;
  } catch (e) {
    jwtAlg = `unreadable (${(e as Error).name}; cookies: ${cookies.map((c) => c.name).join(",")}; prefix: ${auth.slice(0, 7)})`;
  }

  const serverTiming: string[] = [];
  page.on("response", (r) => {
    const h = r.headers()["server-timing"];
    if (h && r.request().resourceType() !== "image") serverTiming.push(h);
  });

  // Warm-up: every route once (compiles nothing in a build, but fills caches and the connection pool).
  for (const r of ROUTES) await page.goto(r.path);

  for (let run = 0; run < RUNS; run++) {
    for (const r of ROUTES) {
      const startEpoch = Date.now();
      const st: string[] = [];
      const res = await page.goto(r.path, { waitUntil: "load" });
      st.push(res?.headers()["server-timing"] ?? "");
      await expect(page.getByRole("heading", { level: 1, name: r.heading }).first()).toBeAttached();
      const t = await page.evaluate(() => {
        const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const fcp = performance.getEntriesByName("first-contentful-paint")[0];
        return { ttfb: n.responseStart, end: n.responseEnd, fcp: fcp ? fcp.startTime : null };
      });
      hard.push({ route: r.key, run, startEpoch, endEpoch: Date.now(), ttfbMs: t.ttfb, fcpMs: t.fcp, endMs: t.end, serverTiming: st[0] ?? "" });
      await page.waitForTimeout(400);
    }
  }

  const menu = page.getByRole("navigation", { name: "Main" });
  for (let run = 0; run < RUNS; run++) {
    for (const r of [ROUTES[1], ROUTES[2], ROUTES[3], ROUTES[4], ROUTES[0]]) {
      await page.waitForTimeout(1200); // idle: let prefetches and the previous page settle
      serverTiming.length = 0;
      await page.evaluate(() => performance.clearResourceTimings());
      await armSoft(page, r.heading);
      const startEpoch = Date.now();
      await menu.getByRole("link", { name: r.link }).click();
      await page.waitForFunction(() => (window as unknown as { __nav: { content: number | null } }).__nav.content !== null, undefined, { timeout: 30_000 });
      const n = await page.evaluate((path) => {
        const w = window as unknown as { __nav: { click: number; skel: number | null; content: number } };
        // The page's own RSC request for this navigation (not a prefetch): when it was sent, first byte, and fully received.
        const rsc = performance
          .getEntriesByType("resource")
          .filter((e) => e.name.includes("_rsc=") && new URL(e.name).pathname === path && e.startTime >= w.__nav.click - 5)
          .map((e) => e as PerformanceResourceTiming)
          .sort((a, b) => b.responseEnd - a.responseEnd)[0];
        return { ...w.__nav, rsc: rsc ? { send: rsc.requestStart - w.__nav.click, ttfb: rsc.responseStart - w.__nav.click, end: rsc.responseEnd - w.__nav.click } : null };
      }, r.path);
      soft.push({
        route: r.key,
        run,
        startEpoch,
        endEpoch: Date.now(),
        skeletonMs: n.skel === null ? null : n.skel - n.click,
        contentMs: n.content - n.click,
        rscSendMs: n.rsc?.send ?? null,
        rscFirstByteMs: n.rsc?.ttfb ?? null,
        rscEndMs: n.rsc?.end ?? null,
        serverTiming: [...serverTiming],
      });
    }
  }
  writeFileSync(process.env.PERF_OUT ?? "test-results/perf.json", JSON.stringify({ jwtAlg, runs: RUNS, hard, soft }, null, 1));
});
