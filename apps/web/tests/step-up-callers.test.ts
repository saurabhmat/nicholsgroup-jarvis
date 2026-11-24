// T-288 (D-67): the Teams send widens ONE bound (the Teams window, 300 - 43,200) and nothing else. This pins every caller of the step-up guard and every reader of the step-up time, so a new caller, or a
// caller that starts passing the Teams option, fails here and has to be looked at on purpose. Email approvals keep `facts.stepUpMaxAgeS` (30 - 900) with no option, so the guard's default bound (30 - 3,600) applies to them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
function production(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".next-e2e", "dist", ".turbo", ".git", "test-stubs"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\./.test(name) && !name.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(join(root, "apps"));
  walk(join(root, "packages"));
  return files;
}
const text = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(root, f);

describe("every caller of requireStepUp and every reader of the step-up time (T-288)", () => {
  it("the calls are exactly: the step-up probe and the approvals route with no option (default bound 30 - 3,600), and the Teams send with the Teams window option", () => {
    const calls: string[] = [];
    for (const f of production()) {
      if (rel(f).startsWith("packages/eslint-plugin/")) continue;
      for (const m of text(f).matchAll(/\.requireStepUp\(([^\n]*)\)/g)) calls.push(`${rel(f)}: ${m[1]}`);
    }
    expect(calls.sort()).toEqual(
      [
        "apps/web/app/api/session/step-up/route.ts: maxAge",
        "apps/web/lib/approvals.ts: facts.stepUpMaxAgeS",
        'apps/web/lib/teams-api.ts: await deps.send.window(laneId as LaneId), { window: "teams" }); // throws AuthError step_up_required -> 403 {error: "step_up_required"}',
      ].sort().map((c) => c.replace(/\); \/\/.*$/, "")),
    );
  });

  it("only the guard itself and the Teams route logic name the Teams window option; email code never does", () => {
    const named = production().filter((f) => /window:\s*"teams"/.test(text(f))).map(rel).filter((f) => !f.startsWith("packages/eslint-plugin/")).sort();
    expect(named).toEqual(["apps/web/lib/teams-api.ts", "packages/core/src/auth/index.ts"]);
  });

  it("the step-up time (`mfaVerifiedAt`) is read only by the guard and the session reader", () => {
    const named = production().filter((f) => /mfaVerifiedAt/.test(text(f))).map(rel).sort();
    expect(named).toEqual(["packages/core/src/auth/index.ts"]);
  });

  it("the Teams window of a lane is read in one place on the server (approvals wire); the request-facing probe passes no option", () => {
    expect(text(join(root, "apps/web/app/api/session/step-up/route.ts"))).not.toMatch(/teams/i);
    expect(text(join(root, "packages/modules/approvals/src/server/wire.ts"))).toMatch(/teams_step_up_max_age_s/);
  });
});
