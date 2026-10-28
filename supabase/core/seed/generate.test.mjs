import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateSeedSql, SEED_FILE } from "./generate.mjs";
import { SEED, LANES, PERSONAS, buildSeedData } from "./data.mjs";
import { SECTIONS } from "./sections/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("lanes: exactly PKG, APK, PKI, NC, NL, P and only PKG enabled", () => {
  assert.deepEqual(LANES.map((l) => l.code).sort(), ["APK", "NC", "NL", "P", "PKG", "PKI"]);
  assert.deepEqual(LANES.filter((l) => l.enabled).map((l) => l.code), ["PKG"]);
  for (const lane of LANES) {
    assert.ok(lane.name.length > 0);
    assert.ok(["core", "nl"].includes(lane.dataPlane));
  }
  assert.equal(LANES.find((l) => l.code === "NL").dataPlane, "nl");
});

test("personas: the five roles, synthetic labels, reserved emails, outsider has no memberships", () => {
  assert.deepEqual(PERSONAS.map((p) => p.key), ["owner", "admin_technical", "finance_operator", "viewer", "outsider"]);
  const laneCodes = new Set(LANES.map((l) => l.code));
  for (const p of PERSONAS) {
    assert.match(p.email, /^[a-z0-9-]+@example\.test$/);
    assert.match(p.displayName, /^Synthetic( [A-Z][a-z]+)+$/);
    for (const m of p.memberships) assert.ok(laneCodes.has(m.lane), `${p.key} membership lane ${m.lane}`);
  }
  assert.equal(PERSONAS.find((p) => p.key === "outsider").memberships.length, 0);
  assert.equal(new Set(PERSONAS.map((p) => p.email)).size, PERSONAS.length);
});

test("data is frozen so sections cannot mutate shared definitions", () => {
  const data = buildSeedData(SEED);
  assert.ok(Object.isFrozen(data.lanes) && Object.isFrozen(data.lanes[0]));
  assert.ok(Object.isFrozen(data.personas) && Object.isFrozen(data.personas[0].memberships));
});

test("persona ids are deterministic per seed and change with the seed", () => {
  const a = buildSeedData(SEED).personas.map((p) => p.id);
  assert.deepEqual(buildSeedData(SEED).personas.map((p) => p.id), a);
  assert.notDeepEqual(buildSeedData("another-seed").personas.map((p) => p.id), a);
  assert.equal(new Set(a).size, a.length);
});

test("generation is byte-identical across runs", () => {
  const first = generateSeedSql();
  const second = generateSeedSql();
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
  assert.ok(first.endsWith("\n") && !first.endsWith("\n\n"));
  assert.ok(!first.includes("\r"));
});

test("changing the seed changes the output", () => {
  assert.notEqual(generateSeedSql({ seed: "another-seed" }), generateSeedSql());
});

test("the committed seed.sql is exactly the generator output (run `pnpm db:seed` if this fails)", () => {
  const committed = readFileSync(SEED_FILE, "utf8");
  assert.equal(committed, generateSeedSql());
  assert.equal(path.relative(here, SEED_FILE), path.join("..", "supabase", "seed.sql"));
});

test("output contains the persona auth users and every registered section", () => {
  const sql = generateSeedSql();
  for (const p of buildSeedData(SEED).personas) {
    assert.ok(sql.includes(`'${p.id}'`), `persona ${p.key} id`);
    assert.ok(sql.includes(`'${p.email}'`), `persona ${p.key} email`);
  }
  for (const s of SECTIONS) assert.ok(sql.includes(`-- section: ${s.id}\n`), `section ${s.id}`);
});

test("adding a section does not change the output of existing sections", () => {
  const extra = { id: "zz-extra", description: "test only", build: (ctx) => [`select '${ctx.rng.uuid()}';`] };
  const base = generateSeedSql();
  const withExtra = generateSeedSql({ sections: [extra, ...SECTIONS] });
  for (const chunk of base.split("\n-- section: ").slice(1)) {
    assert.ok(withExtra.includes(chunk), "existing section output must be unchanged");
  }
});

test("section registry is validated", () => {
  const ok = { id: "a", description: "d", build: () => ["select 1;"] };
  assert.throws(() => generateSeedSql({ sections: [ok, { ...ok }] }), /duplicate/);
  assert.throws(() => generateSeedSql({ sections: [{ ...ok, id: "Bad Id" }] }), /id/);
  assert.throws(() => generateSeedSql({ sections: [{ ...ok, build: () => "select 1;" }] }), /array/);
  assert.throws(() => generateSeedSql({ sections: [{ ...ok, build: () => ["select 1"] }] }), /;/);
  assert.throws(() => generateSeedSql({ sections: [{ ...ok, build: () => ["select now();"] }] }), /now\(\)|non-deterministic/);
  assert.throws(() => generateSeedSql({ sections: [{ ...ok, build: () => ["select gen_random_uuid();"] }] }), /non-deterministic/);
});

test("the generator runs the synthetic-data guard and fails closed", () => {
  const leak = { id: "leak", description: "d", build: () => ["select 'someone@gmail.com';"] };
  assert.throws(() => generateSeedSql({ sections: [leak] }), /email/);
});

test("persona users cannot sign in with a password and get no role claims from metadata", () => {
  const sql = generateSeedSql();
  const users = sql.split("\n").filter((l) => l.startsWith("insert into auth.users"));
  assert.equal(users.length, PERSONAS.length);
  for (const line of users) {
    assert.ok(!/crypt\(|gen_salt|\$2[aby]\$/.test(line), "no password hash");
    assert.ok(!/"role"\s*:/.test(line), "no role in metadata");
  }
});
