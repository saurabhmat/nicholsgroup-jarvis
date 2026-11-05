import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./lexer.mjs";

const types = (sql) => tokenize(sql).map((t) => [t.type, t.value]);

test("standard strings with '' escapes", () => {
  assert.deepEqual(types("select 'it''s', 'a';"), [
    ["code", "select "],
    ["string", "it's"],
    ["code", ", "],
    ["string", "a"],
    ["code", ";"],
  ]);
});

test("-- inside a string is not a comment, and a string inside a comment is not a string", () => {
  assert.deepEqual(types("select 'a\n-- ''', 'b';").filter(([t]) => t === "string"), [
    ["string", "a\n-- '"],
    ["string", "b"],
  ]);
  assert.deepEqual(types("-- 'x\nselect 1;").map(([t]) => t), ["line-comment", "code"]);
});

test("line comments end at \\n or \\r", () => {
  assert.deepEqual(types("-- c\rselect 'X';"), [
    ["line-comment", " c"],
    ["code", "\rselect "],
    ["string", "X"],
    ["code", ";"],
  ]);
});

test("nested block comments", () => {
  assert.deepEqual(types("/* a /* b */ 'c' */ select 1;").map(([t]) => t), ["block-comment", "code"]);
  assert.throws(() => tokenize("/* a /* b */ select 1;"), /unterminated block comment/);
});

test("dollar quotes with and without tags; $1 is not a dollar quote", () => {
  assert.deepEqual(types("select $$Jane$$, $t$a$$b$t$;").filter(([t]) => t === "dollar"), [
    ["dollar", "Jane"],
    ["dollar", "a$$b"],
  ]);
  assert.deepEqual(types("select $1;").map(([t]) => t), ["code"]);
  assert.throws(() => tokenize("select $x$abc;"), /unterminated dollar/);
});

test("E'' strings honour backslash escapes; U&'' strings are recognised; identifiers ending in e are not", () => {
  assert.deepEqual(types("select E'a\\'b', U&'\\0041';").filter(([t]) => t !== "code"), [
    ["estring", "a\\'b"],
    ["ustring", "\\0041"],
  ]);
  assert.deepEqual(types("select type'x';").filter(([t]) => t !== "code"), [["string", "x"]]);
});

test("quoted identifiers", () => {
  assert.deepEqual(types('select "Jane ""D""";').filter(([t]) => t !== "code"), [["ident", 'Jane "D"']]);
  assert.throws(() => tokenize('select "x;'), /unterminated quoted identifier/);
});

test("unterminated strings throw", () => {
  assert.throws(() => tokenize("select 'abc;"), /unterminated string/);
});
