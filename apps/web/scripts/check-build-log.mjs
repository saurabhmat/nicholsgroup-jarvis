// T-243 (manual tool, not wired into CI or a package script gate): fails when a `next build` or runtime log (read from stdin or a file) holds a clock / prerender error of Cache Components, for example
//   Route "/[laneId]" used `Date.now()` before accessing either uncached data (e.g. `fetch()`) or Request data ...
// Usage: pnpm --filter @nichols/web build 2>&1 | node scripts/check-build-log.mjs      or      node scripts/check-build-log.mjs build.log
// Prints only the matching lines (route and message, never environment values). Exit 0 = clean, 1 = found, 2 = no input.
import { readFileSync } from "node:fs";

export const PATTERNS = [
  /used\s+`(?:Date\.now\(\)|new Date\(\)|Date\(\)|Math\.random\(\)|performance\.now\(\))`/i,
  /current time in a Server Component/i,
  /before accessing either uncached data/i,
  /Error occurred prerendering page/i,
  /Uncached data was accessed outside of <Suspense>/i,
  /Dynamic API usage|blocking route/i,
];

/** The lines of `log` that match a clock / prerender error pattern. */
export function findClockErrors(log) {
  return log.split(/\r?\n/).filter((line) => PATTERNS.some((p) => p.test(line)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  let log = "";
  try {
    log = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  } catch {
    console.error("check-build-log: no input");
    process.exit(2);
  }
  if (log.trim() === "") {
    console.error("check-build-log: empty input");
    process.exit(2);
  }
  const hits = findClockErrors(log);
  if (hits.length > 0) {
    console.error(`check-build-log: ${String(hits.length)} prerender error line(s):`);
    for (const h of hits.slice(0, 20)) console.error(`  ${h.trim().slice(0, 300)}`);
    process.exit(1);
  }
  console.log("check-build-log: no clock or prerender errors in the build log");
}
