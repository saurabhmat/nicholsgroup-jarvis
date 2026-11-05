import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERATOR_HEADER, assertSyntheticOnly, findSyntheticViolations } from "./guard.mjs";
import { values } from "./sql.mjs";
import { generateSeedSql } from "./generate.mjs";

const lit = (s) => `select '${s}';\n`;

test("the generated seed passes the guard", () => {
  assert.deepEqual(findSyntheticViolations(generateSeedSql()), []);
  assert.doesNotThrow(() => assertSyntheticOnly(generateSeedSql()));
});

test("the generated seed has emails only on example.test", () => {
  const emails = generateSeedSql().match(/[^\s'"@(),]+@[^\s'"@(),]+/g) ?? [];
  assert.ok(emails.length > 0);
  for (const e of emails) assert.match(e, /@example\.test$/);
});

test("rejects emails on real or non-reserved domains, anywhere (also comments)", () => {
  for (const sql of [
    lit("someone@gmail.com"),
    lit("a@pub-k.org"),
    "-- contact x@company.com\n",
    lit("x@example.test.evil.com"),
    lit("x@sub.example.test"),
    lit("x@EXAMPLE.TEST"),
  ]) {
    assert.ok(findSyntheticViolations(sql).some((v) => v.includes("email")), sql);
  }
});

test("rejects non-reserved domains or URLs inside string literals", () => {
  for (const s of ["https://portal.pub-k.org/x", "nicholscapital.com", "api.stripe.com"]) {
    assert.ok(findSyntheticViolations(lit(s)).some((v) => v.includes("domain")), s);
  }
  assert.deepEqual(findSyntheticViolations(lit("http://localhost.test/x")), []);
});

test("rejects capitalized words that are not lane names or persona labels", () => {
  for (const s of ["Jane Doe", "Acme Corp", "Synthetic Jane", "{\"name\":\"Bob\"}"]) {
    assert.ok(findSyntheticViolations(lit(s)).some((v) => v.includes("name")), s);
  }
  for (const s of ["Pub K Group", "Nichols Law", "Personal", "Synthetic Finance Operator", "lower case words"]) {
    assert.deepEqual(findSyntheticViolations(lit(s)), [], s);
  }
});

test("handles escaped quotes inside literals", () => {
  assert.ok(findSyntheticViolations(lit("it''s Jane")).some((v) => v.includes("Jane")));
});

test("rejects known real people and company domains anywhere, case-insensitively", () => {
  for (const sql of ["-- built for robert\n", lit("sophie"), "-- SAURABH\n", "-- gopal\n", "-- pubkgroup\n", "-- pub-k.org\n"]) {
    assert.ok(findSyntheticViolations(sql).some((v) => v.includes("denylisted")), sql);
  }
});

test("assertSyntheticOnly throws with every violation listed", () => {
  assert.throws(() => assertSyntheticOnly(lit("Jane") + lit("a@gmail.com")), (err) => {
    assert.match(err.message, /Jane/);
    assert.match(err.message, /gmail/);
    return true;
  });
});

// Bypasses from the T-007 review.

test("a literal containing a newline and -- does not hide the next literal", () => {
  const sql = `insert into t values (${values("a\n-- '", "Jane Doe")});\n`;
  assert.ok(findSyntheticViolations(sql).some((v) => v.includes("Jane")));
});

test("dollar-quoted, E'' and U&'' strings are rejected and still name-checked", () => {
  const v = findSyntheticViolations("select $$Jane Doe$$;\n");
  assert.ok(v.some((x) => x.includes("dollar")));
  assert.ok(v.some((x) => x.includes("Jane")));
  assert.ok(findSyntheticViolations("select E'x';\n").some((x) => x.includes("estring")));
  assert.ok(findSyntheticViolations("select U&'\\0041';\n").some((x) => x.includes("ustring")));
});

test("names are checked in comments, block comments and quoted identifiers", () => {
  for (const sql of ["-- for Jane\n", "/* Jane */ select 1;\n", 'select 1 as "Jane";\n', "-- x\rselect 'Jane';\n"]) {
    assert.ok(findSyntheticViolations(sql).some((v) => v.includes("Jane")), sql);
  }
});

test("Unicode capitals and Unicode email domains are caught", () => {
  assert.ok(findSyntheticViolations(lit("Émile")).some((v) => v.includes("Émile")));
  assert.ok(findSyntheticViolations(lit("ärzte Ölberg")).some((v) => v.includes("Ölberg")));
  assert.ok(findSyntheticViolations(lit("a@exämple.test")).some((v) => v.includes("email")));
  assert.ok(findSyntheticViolations(lit("a@bücher.de")).some((v) => v.includes("email")));
});

test("SSN-like numbers and long digit runs in literals are rejected; UUIDs are fine", () => {
  assert.ok(findSyntheticViolations(lit("123-45-6789")).some((v) => v.includes("SSN")));
  assert.ok(findSyntheticViolations(lit("acct 123456789")).some((v) => v.includes("digits")));
  assert.deepEqual(findSyntheticViolations(lit("00000000-0000-0000-0000-000000000000")), []);
  assert.deepEqual(findSyntheticViolations(lit("12345678")), []);
});

test("unparseable SQL is a violation", () => {
  assert.ok(findSyntheticViolations("select 'open;\n").some((v) => v.includes("unparseable")));
});

test("only the exact generator header is exempt; the same fence elsewhere is flagged", () => {
  assert.deepEqual(findSyntheticViolations(GENERATOR_HEADER), []);
  assert.ok(findSyntheticViolations(`select 1;\n${GENERATOR_HEADER}`).some((v) => v.includes("dollar")));
  assert.ok(findSyntheticViolations(GENERATOR_HEADER.replace("example.test')", "example.test') or true")).length > 0);
});
