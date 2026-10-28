import { test } from "node:test";
import assert from "node:assert/strict";
import { json, lit, values } from "./sql.mjs";

test("lit() quotes and escapes", () => {
  assert.equal(lit("it's"), "'it''s'");
  assert.equal(lit("a\\b"), "'a\\b'");
  assert.equal(lit(null), "null");
  assert.equal(lit(true), "true");
  assert.equal(lit(1.5), "1.5");
  assert.equal(values("a", 1, false, null), "'a', 1, false, null");
});

test("lit() rejects undefined, non-finite numbers, NUL and objects", () => {
  for (const v of [undefined, Number.NaN, Infinity, "a\0b", {}, [], () => 1, 1n]) assert.throws(() => lit(v));
});

test("json() renders jsonb and rejects values JSON.stringify would drop or alter", () => {
  assert.equal(json({ a: [1, "x", null, true] }), `'{"a":[1,"x",null,true]}'::jsonb`);
  assert.equal(json({ q: "it's" }), `'{"q":"it''s"}'::jsonb`);
  for (const v of [undefined, () => 1, { a: undefined }, { a: () => 1 }, [undefined], { a: Number.NaN }, new Date(0), Symbol("s")]) {
    assert.throws(() => json(v), /json\(\)/);
  }
});
