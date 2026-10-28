import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSyntheticOnly, findSyntheticViolations } from "./guard.mjs";
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
