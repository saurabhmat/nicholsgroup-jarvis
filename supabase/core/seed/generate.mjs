#!/usr/bin/env node
// Builds supabase/core/supabase/seed.sql (the `[db.seed] sql_paths` file that `supabase db reset --local` applies)
// from the registered sections. Deterministic: same seed => byte-identical file. Runs the synthetic-data guard
// before writing and fails closed. Never touches a database.
// Usage: node supabase/core/seed/generate.mjs [--check]   (--check fails if the committed file is out of date)
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SEED, buildSeedData } from "./data.mjs";
import { GENERATOR_HEADER, assertSyntheticOnly } from "./guard.mjs";
import { tokenize } from "./lexer.mjs";
import { createRng } from "./rng.mjs";
import { SECTIONS } from "./sections/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = path.join(here, "..", "supabase", "seed.sql");

const SECTION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Functions and keywords whose result differs between resets or depends on the wall clock. Matched on code only
// (comments removed, quoted identifiers unquoted), so `now /* x */ (` and `"now"(` are caught too.
const NON_DETERMINISTIC_CODE_RE = new RegExp(
  "\\b(?:now|random|random_normal|setseed|gen_random_uuid|gen_random_bytes|uuid_generate_v1|uuid_generate_v1mc|" +
    "uuid_generate_v4|gen_salt|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\\s*\\(|" +
    "\\b(?:current_timestamp|current_date|current_time|localtimestamp|localtime)\\b",
  "i",
);
// Special date/time input strings that resolve at execution time ('now'::timestamptz, 'today', ...).
const NON_DETERMINISTIC_LITERALS = new Set(["now", "today", "tomorrow", "yesterday"]);
// Control characters (incl. \n and \r) are not allowed in a one-line description.
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** Validates one section statement with the lexer; throws with the section id on any problem. */
function checkStatement(id, s) {
  const fail = (why) => {
    throw new Error(`seed section ${id}: ${why}: ${s.slice(0, 80)}`);
  };
  if (!s.endsWith(";")) fail("every statement must end with ';'");
  if (s.includes("\r")) fail("no carriage returns");
  let tokens;
  try {
    tokens = tokenize(s);
  } catch (err) {
    fail(err.message);
  }
  let code = "";
  for (const t of tokens) {
    if (t.type === "dollar" || t.type === "estring" || t.type === "ustring") {
      fail(`${t.type} literal not allowed (every literal must come from lit())`);
    }
    if (t.type === "string" && NON_DETERMINISTIC_LITERALS.has(t.value.trim().toLowerCase())) {
      fail("non-deterministic date literal (use ctx.data.epoch)");
    }
    if (t.type === "code") code += t.value;
    else if (t.type === "ident") code += t.value;
    else code += " ";
  }
  if (!code.trimEnd().endsWith(";")) fail("every statement must end with ';' outside comments");
  if (NON_DETERMINISTIC_CODE_RE.test(code)) fail("non-deterministic SQL (use ctx.rng / ctx.data.epoch instead)");
}

/**
 * @param {{ seed?: string | number, sections?: ReadonlyArray<import("./sections/index.mjs").SeedSection> }} [options]
 * @returns {string}
 */
export function generateSeedSql({ seed = SEED, sections = SECTIONS } = {}) {
  const data = buildSeedData(seed);
  const ids = new Set();
  const parts = [`-- seed: ${JSON.stringify(String(seed))}`, ""];

  for (const section of sections) {
    const { id, description, build } = section ?? {};
    if (typeof id !== "string" || !SECTION_ID_RE.test(id)) throw new Error(`seed section id must be lowercase kebab-case: ${String(id)}`);
    if (ids.has(id)) throw new Error(`duplicate seed section id: ${id}`);
    ids.add(id);
    if (typeof description !== "string" || description.trim().length === 0 || CONTROL_CHAR_RE.test(description)) {
      throw new Error(`seed section ${id}: description must be one non-empty line without control characters`);
    }
    if (typeof build !== "function") throw new Error(`seed section ${id}: build must be a function`);

    const statements = build({ data, rng: createRng(seed, `section:${id}`) });
    if (!Array.isArray(statements)) throw new Error(`seed section ${id}: build() must return an array of SQL statements`);
    parts.push(`-- section: ${id}`, `-- ${description}`);
    for (const stmt of statements) {
      if (typeof stmt !== "string") throw new Error(`seed section ${id}: statements must be strings`);
      const s = stmt.trim();
      checkStatement(id, s);
      parts.push(s);
    }
    parts.push("");
  }

  const sql = `${GENERATOR_HEADER}${parts.join("\n").trimEnd()}\n`;
  assertSyntheticOnly(sql);
  return sql;
}

function main(argv) {
  const check = argv.includes("--check");
  const rel = path.relative(process.cwd(), SEED_FILE);
  const fail = (msg) => {
    console.error(`db:seed FAILED: ${msg}`);
    process.exit(1);
  };

  let sql;
  try {
    sql = generateSeedSql();
  } catch (err) {
    fail(err.message);
  }

  if (check) {
    let committed = "";
    try {
      committed = readFileSync(SEED_FILE, "utf8");
    } catch {
      fail(`${rel} is missing. Run \`pnpm db:seed\`.`);
    }
    if (committed !== sql) fail(`${rel} is out of date. Run \`pnpm db:seed\` and commit it.`);
    console.log("db:seed:check ok");
    return;
  }

  const staged = `${SEED_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(staged, sql);
    renameSync(staged, SEED_FILE);
  } catch (err) {
    rmSync(staged, { force: true });
    fail(`could not write ${rel}: ${err.message}`);
  }
  console.log(`db:seed wrote ${rel}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
