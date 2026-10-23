// Prints the next approved task whose dependencies are done and whose needs are met
// (from docs/backlog.md). Usage: node scripts/next-task.mjs [--explain] [path/to/backlog.md]
//
// Fails closed. The backlog grammar is an allowlist:
// - A task block starts at `### T-xxx` and ends at the next heading (any level) or `---` rule.
//   Every non-blank line in it must be one of `- status:`, `- depends:`, `- needs:`, `- acceptance:`,
//   each at most once; `status` and `depends` are required. Anything else blocks that task.
// - Structural problems throw (stdout stays empty, exit 1): code fences anywhere, duplicate task ids,
//   field-like lines outside a task block after the first task, not exactly one `## Needs human`
//   heading, a task heading before the Needs human section ends, duplicate needs items.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class BacklogError extends Error {}

const TASK_HEAD = /^###\s+(T-\d+)(?=\s|$)/;
const HEADING = /^#{1,6}\s/;
const RULE = /^---+\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const FIELD = /^- (status|depends|needs|acceptance):[ \t]*(.*?)\s*$/;
// Catches field-ish lines in any spelling outside task blocks (e.g. "- **needs:**", "> + Depends on:").
const FIELD_LIKE = /^[\s>]*[-*+]?\s*\**\s*(status|depends?|needs?|deps|requires?|blocked)\b[^:]{0,20}:/i;
const DEP_TOKEN = /^T-\d+$/;
// A need is an H/D id, optionally followed by a parenthetical note that names no other id.
const NEED_TOKEN = /^([HD]-\d+)(?:\s+\(([^()]*)\))?$/;
const ANY_NEED_ID = /\b[HD]-\d+\b/;
const NEEDS_HEAD = /^##\s+Needs human\s*$/;
const NEEDS_END = /^#{1,2}\s/;
const NEEDS_ITEM = /^- \[([ xX])\]\s+([HD]-\d+)(?![\w.-])/;

const lines = md => md.split(/\r?\n/).map((text, i) => [i + 1, text]);

function assertNoFences(md) {
  for (const [n, line] of lines(md)) {
    if (FENCE.test(line)) throw new BacklogError(`code fences are not allowed in the backlog (line ${n})`);
  }
}

function parseList(value, parseToken, label) {
  if (value === "-") return { items: [], bad: [] };
  if (value === "") return { items: [], bad: [`empty ${label} (use "-" for none)`] };
  const items = [];
  const bad = [];
  for (const raw of value.split(",")) {
    const token = raw.trim();
    const id = parseToken(token);
    if (id) items.push(id);
    else bad.push(`${label} token "${token}" is not valid`);
  }
  return { items: [...new Set(items)], bad };
}

const depToken = t => (DEP_TOKEN.test(t) ? t : undefined);
const needToken = t => {
  const m = t.match(NEED_TOKEN);
  return m && !(m[2] && ANY_NEED_ID.test(m[2])) ? m[1] : undefined;
};

/** Parse task blocks into [{ id, status, deps, needs, errors }]. */
export function parseTasks(md) {
  assertNoFences(md);
  const tasks = [];
  const seen = new Map();
  let cur = null;
  for (const [n, line] of lines(md)) {
    const head = line.match(TASK_HEAD);
    if (head) {
      const id = head[1];
      if (seen.has(id)) throw new BacklogError(`duplicate task id ${id} (lines ${seen.get(id)} and ${n})`);
      seen.set(id, n);
      cur = { id, status: undefined, deps: [], needs: [], errors: [], fields: new Set() };
      tasks.push(cur);
      continue;
    }
    if (HEADING.test(line) || RULE.test(line)) {
      cur = null;
      continue;
    }
    if (!cur) {
      if (tasks.length && FIELD_LIKE.test(line))
        throw new BacklogError(`task field outside a task block (line ${n}): "${line.trim()}"`);
      continue;
    }
    if (line.trim() === "") continue;
    const m = line.match(FIELD);
    if (!m) {
      cur.errors.push(`line ${n}: unexpected line "${line.trim()}"`);
      continue;
    }
    const [, key, value] = m;
    if (cur.fields.has(key)) {
      cur.errors.push(`line ${n}: repeated "${key}" field`);
      continue;
    }
    cur.fields.add(key);
    if (key === "status") {
      if (/^[a-z-]+$/.test(value)) cur.status = value;
      else cur.errors.push(`line ${n}: status "${value}" is not a single word`);
    } else if (key === "depends" || key === "needs") {
      const { items, bad } = parseList(value, key === "depends" ? depToken : needToken, key);
      cur[key === "depends" ? "deps" : "needs"] = items;
      cur.errors.push(...bad.map(b => `line ${n}: ${b}`));
    }
  }
  return tasks.map(({ fields, ...t }) => {
    for (const required of ["status", "depends"]) if (!fields.has(required)) t.errors.push(`missing "${required}" field`);
    return t;
  });
}

/** Parse the single "## Needs human" section; returns the Set of checked ids. */
export function parseNeedsHuman(md) {
  assertNoFences(md);
  const met = new Set();
  const listed = new Set();
  let sections = 0;
  let inSection = false;
  for (const [n, line] of lines(md)) {
    if (NEEDS_HEAD.test(line)) {
      sections++;
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (TASK_HEAD.test(line)) throw new BacklogError(`task heading inside "## Needs human" (line ${n})`);
    if (NEEDS_END.test(line) || RULE.test(line)) {
      inSection = false;
      continue;
    }
    const m = line.match(NEEDS_ITEM);
    if (!m) continue;
    const [, mark, id] = m;
    if (listed.has(id)) throw new BacklogError(`needs item ${id} is listed twice (line ${n})`);
    listed.add(id);
    if (mark !== " ") met.add(id);
  }
  if (sections !== 1) throw new BacklogError(`expected exactly one "## Needs human" heading, found ${sections}`);
  return met;
}

/** Evaluate every approved task: { id, ready, unmetDeps, unmetNeeds, errors }. */
export function evaluate(md) {
  const tasks = parseTasks(md);
  const met = parseNeedsHuman(md);
  const done = new Set(tasks.filter(t => t.status === "done" && t.errors.length === 0).map(t => t.id));
  return tasks
    .filter(t => t.status === "approved")
    .map(t => {
      const unmetDeps = t.deps.filter(d => !done.has(d));
      const unmetNeeds = t.needs.filter(n => !met.has(n));
      const ready = t.errors.length === 0 && unmetDeps.length === 0 && unmetNeeds.length === 0;
      return { id: t.id, ready, unmetDeps, unmetNeeds, errors: t.errors };
    });
}

export function nextTask(md) {
  return evaluate(md).find(t => t.ready)?.id;
}

export function explain(md) {
  const rows = evaluate(md);
  if (rows.length === 0) return "No approved tasks.";
  return rows
    .map(t => {
      if (t.ready) return `${t.id}: ready`;
      const reasons = [];
      if (t.errors.length) reasons.push(`malformed: ${t.errors.join("; ")}`);
      if (t.unmetDeps.length) reasons.push(`unmet deps: ${t.unmetDeps.join(", ")}`);
      if (t.unmetNeeds.length) reasons.push(`unmet needs: ${t.unmetNeeds.join(", ")}`);
      return `${t.id}: blocked (${reasons.join("; ")})`;
    })
    .join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  const wantExplain = args.includes("--explain");
  const path = args.find(a => !a.startsWith("--")) ?? "docs/backlog.md";
  try {
    const md = readFileSync(path, "utf8");
    if (wantExplain) console.log(explain(md));
    else {
      const next = nextTask(md);
      if (next) console.log(next);
    }
  } catch (err) {
    console.error(`next-task: ${err instanceof BacklogError ? "backlog error: " : ""}${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
