// SQL literal helpers for seed sections. Every literal in section output must come from these helpers: the generator
// rejects dollar quoting, E'' and U&'' strings. seed.sql sets standard_conforming_strings = on, so a backslash inside
// '...' is an ordinary character.

/** Quote a value as a SQL literal: strings (with '' escaping), finite numbers, booleans, null. */
export function lit(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("lit(): number must be finite");
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\0")) throw new TypeError("lit(): NUL byte in string");
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new TypeError(`lit(): unsupported type ${typeof value} (pass null explicitly)`);
}

/** Rejects values JSON.stringify would silently drop or alter (undefined, functions, symbols, non-finite numbers). */
const checkJson = (value, where) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`json(): non-finite number at ${where}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkJson(v, `${where}[${i}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) checkJson(v, `${where}.${k}`);
    return;
  }
  throw new TypeError(`json(): unsupported value at ${where} (${value === undefined ? "undefined" : typeof value})`);
};

/** jsonb literal; keys keep their insertion order, so output is deterministic for literal objects. */
export function json(value) {
  checkJson(value, "$");
  return `${lit(JSON.stringify(value))}::jsonb`;
}

/** Comma-separated literals, e.g. for a values (...) list. */
export function values(...items) {
  return items.map(lit).join(", ");
}
