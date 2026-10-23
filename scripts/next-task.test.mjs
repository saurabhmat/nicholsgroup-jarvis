import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTasks, parseNeedsHuman, evaluate, nextTask, explain, BacklogError } from "./next-task.mjs";

const HUMAN = `## Needs human

### Credentials and accounts
- [x] H-001 done thing
- [ ] H-002 open thing

### Decisions (details)
- [x] D-1 decided
- [ ] D-2 undecided
- [ ] D-15 design (PL-26)

---
`;

const task = (id, { status = "approved", depends = "-", needs } = {}) =>
  `### ${id} Title\n- status: ${status}\n- depends: ${depends}\n${needs !== undefined ? `- needs: ${needs}\n` : ""}- acceptance: x\n\n`;

const doc = (...tasks) => `# Backlog\n\n${HUMAN}\n# Release A\n\n## Phase 1\n${tasks.join("")}`;

test("no needs line is unaffected", () => {
  assert.equal(nextTask(doc(task("T-001"))), "T-001");
});

test("met needs", () => {
  assert.equal(nextTask(doc(task("T-001", { needs: "H-001, D-1" }))), "T-001");
});

test("unmet H blocks", () => {
  const md = doc(task("T-001", { needs: "H-002" }));
  assert.equal(nextTask(md), undefined);
  assert.deepEqual(evaluate(md)[0].unmetNeeds, ["H-002"]);
});

test("unmet D blocks, trailing text ignored", () => {
  const md = doc(task("T-001", { needs: "D-15 (PL-26)" }));
  assert.equal(nextTask(md), undefined);
  assert.deepEqual(evaluate(md)[0].unmetNeeds, ["D-15"]);
});

test("unknown id counts as unmet", () => {
  const md = doc(task("T-001", { needs: "H-999" }));
  assert.equal(nextTask(md), undefined);
  assert.deepEqual(evaluate(md)[0].unmetNeeds, ["H-999"]);
});

test("multiple needs, one unmet", () => {
  const md = doc(task("T-001", { needs: "H-001, D-2, D-1" }));
  assert.equal(nextTask(md), undefined);
  assert.deepEqual(evaluate(md)[0].unmetNeeds, ["D-2"]);
});

test("needs with parenthetical tokens like (Google) are fine", () => {
  assert.equal(nextTask(doc(task("T-001", { needs: "H-001 (Google), D-1" }))), "T-001");
});

test("deps and needs together", () => {
  const md = doc(
    task("T-001", { status: "done" }),
    task("T-002", { depends: "T-001", needs: "H-002" }),
    task("T-003", { depends: "T-001", needs: "H-001" }),
  );
  assert.deepEqual(evaluate(md).map(t => [t.id, t.ready]), [["T-002", false], ["T-003", true]]);
  assert.equal(nextTask(md), "T-003");
});

test("deps not done blocks", () => {
  const md = doc(task("T-001", { status: "proposed" }), task("T-002", { depends: "T-001" }));
  assert.equal(nextTask(md), undefined);
  assert.deepEqual(evaluate(md)[0].unmetDeps, ["T-001"]);
});

test("first ready in file order", () => {
  const md = doc(
    task("T-005", { needs: "H-002" }),
    task("T-003"),
    task("T-004"),
  );
  assert.equal(nextTask(md), "T-003");
});

test("prose between phases does not pollute the last task of a phase", () => {
  const md = `${HUMAN}
## Phase 1
${task("T-001", { status: "proposed" })}
## Phase 2
Note: this phase runs after T-001 and waits on H-002.

---

${task("T-002")}`;
  const t = parseTasks(md);
  assert.deepEqual(t.map(x => x.id), ["T-001", "T-002"]);
  assert.deepEqual(t[0], { id: "T-001", status: "proposed", deps: [], needs: [], errors: [] });
  assert.equal(nextTask(md), "T-002");
});

test("Needs-human sub-headings are not tasks", () => {
  const md = doc(task("T-001"));
  assert.deepEqual(parseTasks(md).map(t => t.id), ["T-001"]);
  assert.deepEqual([...parseNeedsHuman(md)].sort(), ["D-1", "H-001"]);
});

test("checked items outside the Needs human section are ignored", () => {
  const md = `## Other\n- [x] H-002 sneaky\n\n${HUMAN}\n## Phase\n${task("T-001", { needs: "H-002" })}`;
  assert.equal(nextTask(md), undefined);
});

test("--explain output", () => {
  const md = doc(
    task("T-001", { status: "done" }),
    task("T-002", { depends: "T-001" }),
    task("T-003", { depends: "T-009", needs: "H-002, D-1" }),
    task("T-004", { status: "proposed" }),
  );
  assert.equal(
    explain(md),
    "T-002: ready\nT-003: blocked (unmet deps: T-009; unmet needs: H-002)",
  );
  assert.equal(explain(doc(task("T-001", { status: "proposed" }))), "No approved tasks.");
});

// --- fail-closed parsing (security reviews of T-000) ---

const blocked = (md, re) => {
  assert.equal(nextTask(md), undefined);
  assert.match(explain(md), re);
};
const block = (...lines) => doc(`### T-001 X\n${lines.join("\n")}\n\n`);

test("repeated needs line blocks the task instead of replacing the earlier one", () => {
  blocked(block("- status: approved", "- depends: -", "- needs: H-002", "- needs: H-001"),
    /T-001: blocked \(malformed: line \d+: repeated "needs" field; unmet needs: H-002\)/);
});

test("repeated depends line blocks the task", () => {
  blocked(doc(task("T-002", { status: "proposed" }), `### T-001 X\n- status: approved\n- depends: T-002\n- depends: -\n\n`),
    /repeated "depends" field/);
});

test("repeated status line blocks the task, and a malformed done task does not satisfy deps", () => {
  blocked(block("- status: approved", "- status: approved", "- depends: -"), /repeated "status" field/);
  const md = doc(`### T-001 X\n- status: done\n- status: approved\n- depends: -\n\n`, task("T-002", { depends: "T-001" }));
  assert.equal(nextTask(md), undefined);
});

test("missing status or depends field blocks the task", () => {
  blocked(block("- status: approved"), /missing "depends" field/);
  assert.equal(evaluate(block("- depends: -")).length, 0);
});

test("duplicate task ids throw", () => {
  const md = doc(task("T-001", { status: "proposed" }), task("T-002", { depends: "T-001" }), task("T-001", { status: "done" }));
  assert.throws(() => nextTask(md), BacklogError);
  assert.throws(() => nextTask(md), /duplicate task id T-001/);
});

test("malformed needs tokens are unmet, not ignored", () => {
  for (const needs of ["h-002", "TBD", "H 002", "D-1.5", "H-001 or H-002", "H-001 (and H-002)", "H-001,"]) {
    blocked(doc(task("T-001", { needs })), /malformed: line \d+: needs token/);
  }
});

test("'-' means none; an empty value is an error", () => {
  assert.equal(nextTask(doc(task("T-001", { needs: "-" }))), "T-001");
  blocked(block("- status: approved", "- depends:"), /empty depends/);
  blocked(block("- status: approved", "- depends: -", "- needs:"), /empty needs/);
});

test("malformed depends tokens block the task", () => {
  blocked(doc(task("T-001", { depends: "T-002 or T-003" })), /depends token "T-002 or T-003"/);
});

test("any other line inside a task block blocks the task", () => {
  for (const line of ["- Needs: H-002", "  - needs: H-002", "* needs: H-002", "- needs : H-002", "- **needs:** H-002",
    "+ needs: H-002", "- need: H-002", "- depends on: T-009", "> - needs: H-002", "- needs\u200b: H-002", "Some prose"]) {
    blocked(block("- status: approved", "- depends: -", line), /unexpected line/);
  }
});

test("task fields after a heading or --- rule are a backlog error", () => {
  for (const sep of ["### Details", "#### Notes", "Notes\n---", "---"]) {
    const md = block("- status: approved", "- depends: -", sep, "- needs: H-002");
    assert.throws(() => nextTask(md), /task field outside a task block/);
  }
  for (const line of ["- **needs:** H-002", "> + Depends on: T-009", "Status: approved"]) {
    assert.throws(() => nextTask(block("- status: approved", "- depends: -", "---", line)), /outside a task block/);
  }
});

test("status with trailing text is not approved", () => {
  blocked(block("- status: approved?? (pending)", "- depends: -"), /No approved tasks\./);
  assert.equal(evaluate(block("- status: approved (pending)", "- depends: -")).length, 0);
});

test("a second or differently named Needs human section", () => {
  const md = `${HUMAN}\n## Needs human (old)\n- [x] H-002\n\n## P\n${task("T-001", { needs: "H-002" })}`;
  assert.equal(nextTask(md), undefined); // "(old)" is not the section; H-002 stays unmet
  assert.throws(() => nextTask(`${HUMAN}\n## Needs human\n- [x] H-003 x\n\n## P\n${task("T-001")}`), /exactly one "## Needs human"/);
  assert.throws(() => nextTask(`## P\n${task("T-001")}`), /exactly one "## Needs human"/);
});

test("a task heading inside Needs human is a backlog error", () => {
  const md = `## Needs human\n- [ ] H-003 x\n${task("T-001", { needs: "H-003" })}- [x] H-003 confirmed\n`;
  assert.throws(() => nextTask(md), /task heading inside "## Needs human"/);
});

test("a needs item listed twice throws", () => {
  const md = `## Needs human\n- [ ] H-002 a\n- [x] H-002 b\n\n## P\n${task("T-001")}`;
  assert.throws(() => nextTask(md), /needs item H-002 is listed twice/);
});

test("code fences are a backlog error", () => {
  for (const fence of ["```", "~~~", "    ```", "````"]) {
    assert.throws(() => nextTask(doc(`${fence}\n`, task("T-001"))), /code fences are not allowed/);
  }
});

test("task heading needs a word boundary after the id", () => {
  assert.deepEqual(parseTasks(doc("### T-001x Fake\n\n")).map(t => t.id), []);
});

const script = fileURLToPath(new URL("./next-task.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("CLI smoke: real backlog prints nothing or a single task id", () => {
  const out = execFileSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8" });
  assert.match(out, /^(T-\d+\n)?$/);
});

test("CLI --explain runs on the real backlog", () => {
  const out = execFileSync(process.execPath, [script, "--explain"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(out, /^(T-\d+: (ready|blocked \(.+\))|No approved tasks\.)(\n|$)/);
});

test("CLI: backlog error prints nothing on stdout and exits 1", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const bad = `${dir}/.next-task-fixture.md`;
  writeFileSync(bad, `${HUMAN}\n## P\n${task("T-001")}${task("T-001")}`);
  try {
    const r = spawnSync(process.execPath, [script, bad], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /backlog error: duplicate task id T-001/);
  } finally {
    rmSync(bad);
  }
});

test("CLI: missing backlog file exits 1 with a message", () => {
  const r = spawnSync(process.execPath, [script, "does/not/exist.md"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /next-task: .*does\/not\/exist\.md/);
});
