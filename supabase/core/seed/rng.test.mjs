import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng } from "./rng.mjs";

const take = (rng, n) => Array.from({ length: n }, () => rng.nextUint32());

test("same seed and label give the same sequence", () => {
  assert.deepEqual(take(createRng("s1", "a"), 50), take(createRng("s1", "a"), 50));
});

test("a different seed or label gives a different sequence", () => {
  const base = take(createRng("s1", "a"), 20);
  assert.notDeepEqual(take(createRng("s2", "a"), 20), base);
  assert.notDeepEqual(take(createRng("s1", "b"), 20), base);
});

test("known first values (pins the algorithm across Node versions)", () => {
  const rng = createRng("pin", "root");
  assert.equal(rng.uuid(), createRng("pin", "root").uuid());
  // Recorded once; changing the algorithm must be a deliberate, reviewed change.
  assert.equal(createRng("pin", "root").nextUint32(), PINNED_FIRST_UINT32);
});

test("label separator cannot be forged by concatenation", () => {
  assert.notDeepEqual(take(createRng("ab", "c"), 5), take(createRng("a", "bc"), 5));
});

test("next() is in [0, 1) and int() stays in range and hits both ends", () => {
  const rng = createRng("range", "x");
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const f = rng.next();
    assert.ok(f >= 0 && f < 1);
    const n = rng.int(3, 7);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 7);
    seen.add(n);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7]);
});

test("int() rejects bad ranges", () => {
  const rng = createRng("range", "y");
  assert.throws(() => rng.int(5, 4));
  assert.throws(() => rng.int(0.5, 4));
  assert.throws(() => rng.int(0, 2 ** 33));
});

test("pick() is deterministic and rejects empty arrays", () => {
  const items = ["a", "b", "c", "d"];
  assert.equal(createRng("p", "q").pick(items), createRng("p", "q").pick(items));
  assert.throws(() => createRng("p", "q").pick([]));
});

test("uuid() is a well-formed v4 UUID and unique within a stream", () => {
  const rng = createRng("uuid", "u");
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = rng.uuid();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 500);
});

test("derive() gives an independent stream that does not depend on parent consumption", () => {
  const a = createRng("d", "root");
  const b = createRng("d", "root");
  take(b, 10);
  assert.deepEqual(take(a.derive("child"), 5), take(b.derive("child"), 5));
  assert.notDeepEqual(take(createRng("d", "root").derive("child"), 5), take(createRng("d", "root"), 5));
});

test("seed and label must be non-empty strings or integers", () => {
  assert.throws(() => createRng("", "x"));
  assert.throws(() => createRng("s", ""));
  assert.throws(() => createRng(1.5, "x"));
  assert.doesNotThrow(() => createRng(42, "x"));
});

// sha256('["pin","root",0]') starts with 01778d37 (cross-checked with `sha256sum`).
const PINNED_FIRST_UINT32 = 0x01778d37;
