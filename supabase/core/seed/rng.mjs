// Deterministic RNG for synthetic seed data. NOT for anything security-related.
// Stream = SHA-256(seed, label, block counter), read 4 bytes at a time. node:crypto's SHA-256 is identical on every
// Node version and platform, so the same seed always yields byte-identical seed SQL.
// Labels name independent streams: a section or entity uses its own label, so adding one never shifts another.
import { createHash } from "node:crypto";

const asKey = (value, what) => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Number.isSafeInteger(value)) return String(value);
  throw new TypeError(`rng ${what} must be a non-empty string or a safe integer`);
};

/**
 * @param {string | number} seed
 * @param {string} label
 */
export function createRng(seed, label) {
  return streamFor(asKey(seed, "seed"), [asKey(label, "label")]);
}

/** A stream is keyed by the seed and the full label path (JSON-encoded, so no separator can be forged). */
function streamFor(seedKey, labelPath) {
  let block = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;

  const refill = () => {
    // JSON encoding keeps keys unambiguous: ("ab","c") never collides with ("a","bc"), and derive("b/c") never
    // collides with derive("b").derive("c").
    buf = createHash("sha256").update(JSON.stringify([seedKey, labelPath, block])).digest();
    block += 1;
    pos = 0;
  };

  const nextUint32 = () => {
    if (pos + 4 > buf.length) refill();
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };

  const next = () => nextUint32() / 2 ** 32;

  /** Uniform integer in [min, max], unbiased (rejection sampling). */
  const int = (min, max) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError("int(min, max) needs integers with min <= max");
    const span = max - min + 1;
    if (span > 2 ** 32) throw new RangeError("int() range must be at most 2^32 values");
    const limit = 2 ** 32 - (2 ** 32 % span);
    let v;
    do v = nextUint32();
    while (v >= limit);
    return min + (v % span);
  };

  const pick = (items) => {
    if (!Array.isArray(items) || items.length === 0) throw new RangeError("pick() needs a non-empty array");
    return items[int(0, items.length - 1)];
  };

  /** RFC 4122 version-4 shaped UUID built from the stream (deterministic, not random). */
  const uuid = () => {
    const b = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 4) b.writeUInt32BE(nextUint32(), i);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  /** Independent child stream; does not depend on how much of this stream was consumed. */
  const derive = (sub) => streamFor(seedKey, [...labelPath, asKey(sub, "label")]);

  return Object.freeze({ nextUint32, next, int, pick, uuid, derive });
}
