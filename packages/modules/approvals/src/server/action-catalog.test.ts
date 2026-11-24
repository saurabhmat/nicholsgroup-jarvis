// T-170 (security suite), area 6: the catalog of action types. Subjects are enumerated from three places that must agree: the TypeScript
// registry (ACTION_TYPES), the latest SQL definition of act.is_allowed_type / the lane policy class check (read from supabase migrations),
// and the connector writers' own constants (read from source). A new action type, a new policy class or a new writer fails here until it
// is classified on purpose. Static: no database, no network.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_TYPES, EMAIL_ACTION_TYPES, QBO_DISCONNECT, TEAMS_ACTION_TYPES, WRITE_ROLES } from "./types";

const repo = resolve(__dirname, "../../../../..");
const migrations = join(repo, "supabase/core/supabase/migrations");
const read = (p: string) => readFileSync(join(repo, p), "utf8");

/** The text of the LAST migration (by file name) that contains `needle`. */
function latest(needle: RegExp): string {
  const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
  const hit = files.filter((f) => needle.test(readFileSync(join(migrations, f), "utf8"))).pop();
  if (!hit) throw new Error(`no migration matches ${String(needle)}`);
  return readFileSync(join(migrations, hit), "utf8");
}
const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

const dbTypes = quoted(/function act\.is_allowed_type[\s\S]*?\$\$;/.exec(latest(/function act\.is_allowed_type/))?.[0].match(/in \(([^)]*)\)/)?.[1] ?? "");
const dbClasses = quoted(/write_actions_allowed <@ array\[([^\]]*)\]/.exec(latest(/write_actions_allowed <@ array/))?.[1] ?? "");
// Which classes act.type_allowed maps to a type (the latest definition).
const typeAllowedSql = /function act\.type_allowed[\s\S]*?\$\$;/.exec(latest(/function act\.type_allowed/))?.[0] ?? "";
const mappedClasses = new Set([...typeAllowedSql.matchAll(/'([a-z_]+)' = any \(p\.write_actions_allowed\)/g)].map((m) => m[1] as string));

/** Policy classes the lane policy accepts but that no action type, executor or SQL gate uses (finding F-03): inert by construction. */
const INERT_CLASSES: Record<string, string> = {
  calendar: "no calendar action type, writer or gate exists; a lane that lists it can do nothing extra",
  monday: "no monday.item.* action type, writer or gate exists (spec 8 only describes it)",
  notion: "no notion action type, writer or gate exists",
};
/** Connector-side write constants that have no approvals action type (unreachable from the approval chain). */
const WRITER_ONLY: Record<string, string> = { "google.revoke_grant": "googleWriter exists but act.is_allowed_type refuses the type: unreachable (F-03)" };

describe("approval action type catalog", () => {
  it("the TypeScript registry equals the database's allowed types", () => {
    expect(dbTypes.length).toBeGreaterThan(0);
    expect([...ACTION_TYPES].sort()).toEqual([...dbTypes].sort());
  });

  it("every action type has a write-role entry and every database type is covered by a policy class that act.type_allowed checks", () => {
    for (const t of ACTION_TYPES) expect(WRITE_ROLES[t], t).toBeDefined();
    expect(Object.keys(WRITE_ROLES).sort()).toEqual([...ACTION_TYPES].sort());
    for (const t of ACTION_TYPES) expect(typeAllowedSql, `type_allowed mentions ${t}`).toContain(t);
  });

  it("every policy class is either checked by act.type_allowed or on the reviewed inert list; the inert list has no stale entry", () => {
    expect(dbClasses.length).toBeGreaterThan(0);
    for (const c of dbClasses) expect(mappedClasses.has(c) || c in INERT_CLASSES, `policy class ${c} is neither gated nor classified inert`).toBe(true);
    for (const c of Object.keys(INERT_CLASSES)) {
      expect(dbClasses, `stale inert entry ${c}`).toContain(c);
      expect(mappedClasses.has(c), `${c} became gated: remove it from the inert list and add approval tests`).toBe(false);
    }
    for (const c of mappedClasses) expect(dbClasses, `gated class ${c} is not accepted by the lane policy`).toContain(c);
  });

  it("every action type has a connector writer (source constants) and a reconcile read-side; connector action constants with no approvals type are reviewed", () => {
    const sources = {
      googleEmail: read("packages/connectors/src/google/email-writer.ts"),
      microsoftEmail: read("packages/connectors/src/microsoft/email-writer.ts"),
      teams: read("packages/connectors/src/teams/send-schema.ts"),
      qbo: read("packages/connectors/src/quickbooks/writer.ts"),
      googleRevoke: read("packages/connectors/src/google/writer.ts"),
    };
    for (const t of EMAIL_ACTION_TYPES) {
      expect(sources.googleEmail, t).toContain(`"${t}"`);
      expect(sources.microsoftEmail, t).toContain(`"${t}"`);
    }
    for (const t of TEAMS_ACTION_TYPES) expect(sources.teams, t).toContain(`"${t}"`);
    expect(sources.qbo).toContain(`"${QBO_DISCONNECT}"`);
    for (const [t] of Object.entries(WRITER_ONLY)) {
      expect(ACTION_TYPES as readonly string[], `${t} became an approvals type: remove it from WRITER_ONLY`).not.toContain(t);
      expect(sources.googleRevoke).toContain(`"${t}"`);
    }
    // Every writer-side constant of the form `"<word>.<word>"` in a writer's action list is an approvals type or reviewed.
    expect(read("packages/modules/approvals/src/server/reconcile-email.ts")).toMatch(/email/i);
    expect(read("packages/modules/approvals/src/server/reconcile-qbo.ts")).toContain("qbo.disconnect");
    expect(read("packages/modules/approvals/src/server/reconcile-teams.ts")).toMatch(/teams/i);
  });

  it("no allowed type name matches the deny list (payment, transfer, delete, permission ...) and nothing outside the registry is a writer type", () => {
    const deny = /(payment|transfer|disbursement|qbo_post|quickbooks|stripe|gohighlevel|delete|permission|remove|purge)/;
    for (const t of ACTION_TYPES) expect(t.toLowerCase()).not.toMatch(deny);
    // The connectors' write subpath names no further `*.send|post|create|update|delete` action constants beyond the reviewed ones.
    const write = read("packages/connectors/src/write/index.ts");
    const constants = [...write.matchAll(/export \{[^}]*\b([A-Z_]+_ACTIONS?|[A-Z_]+_ACTION_TYPES|[A-Z_]+_REVOKE_ACTION)\b/g)].map((m) => m[1]);
    expect(constants.sort()).toEqual(["GOOGLE_EMAIL_ACTIONS", "GOOGLE_REVOKE_ACTION", "MICROSOFT_EMAIL_ACTIONS", "QBO_REVOKE_ACTION", "TEAMS_ACTION_TYPES"]);
  });
});
