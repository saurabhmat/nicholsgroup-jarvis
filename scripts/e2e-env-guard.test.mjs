// Tests for scripts/e2e-env-guard.sh (used by `pnpm e2e:brain`): the env file is always put back exactly as it was,
// as a regular file or as a symlink, after a failing run, a signal or a hard kill, and the backup is never deleted
// before the restore succeeded. Runs bash in temporary folders with synthetic files only (no real env file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e-env-guard.sh");

/** A fake checkout: <tmp>/repo/root.env (the link target) and <tmp>/repo/apps/web; the backup dir is <tmp>/cache. */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "e2e-env-guard-"));
  const web = path.join(dir, "repo/apps/web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(dir, "repo/root.env"), "SYNTHETIC=1\n");
  return { dir, web, file: path.join(web, "env.local"), cache: path.join(dir, "cache"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs `body` in a bash that sourced the guard, the same way scripts/e2e-brain.sh does (set -euo pipefail). */
function run(s, body) {
  const script = `set -euo pipefail\nsource "${LIB}"\nGUARD_FILE="${s.file}"\nGUARD_DIR="${s.cache}"\n${body}\n`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

// What e2e-brain.sh does around Playwright, with `inner` standing in for the Playwright run.
const runLike = (inner) => `guard_restore\nguard_install_trap\nguard_stash\nPRESENT_DURING_RUN=$([[ -e "$GUARD_FILE" || -L "$GUARD_FILE" ]] && echo yes || echo no)\necho "during:$PRESENT_DURING_RUN"\n${inner}`;

/** Present as anything, a dangling symlink included (existsSync follows links). */
const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isLinkTo = (p, target) => lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;

test("regular file: gone during the run, restored with the same content after a failing run (exit 3)", (t) => {
  const s = sandbox();
  t.after(s.done);
  writeFileSync(s.file, "SYNTHETIC_LOCAL=1\n", { mode: 0o600 });
  const r = run(s, runLike("exit 3"));
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /during:no/);
  assert.equal(readFileSync(s.file, "utf8"), "SYNTHETIC_LOCAL=1\n");
  assert.equal(lstatSync(s.file).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(s.cache, "file")), false); // backup removed only after the restore
});

test("regular file: restored after a command fails under set -e", (t) => {
  const s = sandbox();
  t.after(s.done);
  writeFileSync(s.file, "SYNTHETIC_LOCAL=1\n");
  const r = run(s, runLike("false\necho unreachable"));
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /unreachable/);
  assert.equal(readFileSync(s.file, "utf8"), "SYNTHETIC_LOCAL=1\n");
});

test("symlink with a relative target: recreated with the same target after a failing run, target untouched", (t) => {
  const s = sandbox();
  t.after(s.done);
  symlinkSync("../../root.env", s.file); // like apps/web/.env.local -> ../../.env.local
  const r = run(s, runLike("exit 7"));
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stdout, /during:no/);
  assert.ok(isLinkTo(s.file, "../../root.env"));
  assert.equal(readFileSync(s.file, "utf8"), "SYNTHETIC=1\n"); // resolves again
  assert.equal(readFileSync(path.join(s.dir, "repo/root.env"), "utf8"), "SYNTHETIC=1\n");
  assert.equal(existsSync(path.join(s.cache, "link")), false);
});

test("dangling symlink is still treated as present and recreated", (t) => {
  const s = sandbox();
  t.after(s.done);
  symlinkSync("../../missing.env", s.file);
  const r = run(s, runLike("exit 1"));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /during:no/);
  assert.ok(isLinkTo(s.file, "../../missing.env"));
});

for (const sig of ["TERM", "INT"]) {
  test(`symlink: recreated when the run gets SIG${sig}`, (t) => {
    const s = sandbox();
    t.after(s.done);
    symlinkSync("../../root.env", s.file);
    const r = run(s, runLike(`kill -${sig} $$\nsleep 5`));
    assert.equal(r.status, 130, r.stderr);
    assert.ok(isLinkTo(s.file, "../../root.env"));
  });
}

test("normal end: restored and exit code 0", (t) => {
  const s = sandbox();
  t.after(s.done);
  symlinkSync("../../root.env", s.file);
  const r = run(s, runLike("true"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isLinkTo(s.file, "../../root.env"));
});

for (const kind of ["file", "symlink"]) {
  test(`${kind}: a hard-killed run (no trap) is restored at the start of the next run`, (t) => {
    const s = sandbox();
    t.after(s.done);
    if (kind === "file") writeFileSync(s.file, "SYNTHETIC_LOCAL=1\n");
    else symlinkSync("../../root.env", s.file);
    const killed = run(s, "guard_stash\nkill -KILL $$");
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(present(s.file), false); // the trap never ran: the backup is all there is
    const next = run(s, runLike("exit 0"));
    assert.equal(next.status, 0, next.stderr);
    if (kind === "file") assert.equal(readFileSync(s.file, "utf8"), "SYNTHETIC_LOCAL=1\n");
    else assert.ok(isLinkTo(s.file, "../../root.env"));
  });
}

test("file and backup both present: refuses, touches neither", (t) => {
  const s = sandbox();
  t.after(s.done);
  writeFileSync(s.file, "NEW=1\n");
  mkdirSync(s.cache, { recursive: true });
  writeFileSync(path.join(s.cache, "file"), "OLD=1\n");
  const r = run(s, "guard_restore");
  assert.equal(r.status, 1);
  assert.equal(readFileSync(s.file, "utf8"), "NEW=1\n");
  assert.equal(readFileSync(path.join(s.cache, "file"), "utf8"), "OLD=1\n");
});

test("a restore that cannot write keeps the backup and fails the run", (t) => {
  const s = sandbox();
  t.after(() => {
    chmodSync(s.web, 0o755);
    s.done();
  });
  symlinkSync("../../root.env", s.file);
  // The run makes apps/web read-only, so the link cannot be recreated on exit.
  const r = run(s, runLike(`chmod 555 "${s.web}"\nexit 0`));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RESTORE FAILED/);
  assert.equal(readFileSync(path.join(s.cache, "link"), "utf8"), "../../root.env");
  chmodSync(s.web, 0o755);
  const again = run(s, "guard_restore");
  assert.equal(again.status, 0, again.stderr);
  assert.ok(isLinkTo(s.file, "../../root.env"));
});

test("the backup folder is private (700)", (t) => {
  const s = sandbox();
  t.after(s.done);
  writeFileSync(s.file, "X=1\n");
  const r = run(s, "guard_stash");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lstatSync(s.cache).mode & 0o777, 0o700);
});
