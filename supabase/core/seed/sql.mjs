// SQL literal helpers for seed sections. Values are always rendered as literals; never build SQL from untrusted input.

/** Quote a value as a SQL literal: strings (with '' escaping), finite numbers, booleans, null. */
export function lit(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("lit(): number must be finite");
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\0")) throw new TypeError("lit(): NUL byte in string");
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new TypeError(`lit(): unsupported type ${typeof value}`);
}

/** jsonb literal; keys keep their insertion order, so output is deterministic for literal objects. */
export function json(value) {
  return `${lit(JSON.stringify(value))}::jsonb`;
}

/** Comma-separated literals, e.g. for a values (...) list. */
export function values(...items) {
  return items.map(lit).join(", ");
}
