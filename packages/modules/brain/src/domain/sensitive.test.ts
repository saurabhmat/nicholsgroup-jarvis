import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cardLayout, findSensitiveNumber, luhnOk } from "./sensitive";

// The shared cases (also asserted in SQL by 251_brain_sensitive.test.sql; parity checked below). Synthetic values only.
const tests = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "supabase", "core", "supabase", "tests");
const fixture = JSON.parse(readFileSync(path.join(tests, "fixtures", "brain_sensitive_cases.json"), "utf8")) as {
  cases: { text: string; kind: "ssn" | "card" | "bank" | null }[];
};

/** The SQL literal pgTAP uses for a case: E'...' with backslash escapes, as written by the generator in this file's docs. */
function sqlLiteral(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (cp > 126) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `E'${out}'`;
}

describe("sensitive-number screen (shared cases)", () => {
  for (const c of fixture.cases) {
    it(`${JSON.stringify(c.text)} -> ${c.kind ?? "allowed"}`, () => {
      expect(findSensitiveNumber(c.text)).toBe(c.kind);
    });
  }
  it("the SQL test asserts the same kind for every shared case", () => {
    const sql = readFileSync(path.join(tests, "251_brain_sensitive.test.sql"), "utf8");
    const missing = fixture.cases.filter((c) => {
      const want = c.kind === null ? "null" : `'${c.kind}'`;
      return !sql.includes(`select is(brain.sensitive_number_kind(${sqlLiteral(c.text)}), ${want}`);
    });
    expect(missing.map((c) => c.text)).toEqual([]);
  });
});

describe("sensitive-number screen (dates, layout, Luhn, time)", () => {
  it("lets every pair of dates in a year through", () => {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const refused: string[] = [];
    for (let i = 0; i < 366; i++) {
      for (const gap of [1, 7, 30]) {
        const a = new Date(Date.UTC(2026, 0, 1 + i));
        const b = new Date(Date.UTC(2026, 0, 1 + i + gap));
        const text = `${day(a)} ${day(b)}`;
        if (findSensitiveNumber(text) !== null) refused.push(text);
      }
    }
    expect(refused).toEqual([]);
  });
  it("accepts only card-shaped digit groups", () => {
    expect(cardLayout([16])).toBe(true);
    expect(cardLayout([4, 4, 4, 4])).toBe(true);
    expect(cardLayout([4, 4, 4, 4, 3])).toBe(true);
    expect(cardLayout([4, 6, 5])).toBe(true);
    expect(cardLayout([4, 2, 2, 4, 2, 2])).toBe(false);
    expect(cardLayout([3, 3, 4, 4])).toBe(false);
    expect(cardLayout([12])).toBe(false);
  });
  it("implements Luhn", () => {
    expect(luhnOk("4111111111111111")).toBe(true);
    expect(luhnOk("4111111111111112")).toBe(false);
    expect(luhnOk("79927398713")).toBe(true);
  });
  it("runs in linear time on 32 KB adversarial input (security review H-1)", () => {
    const n = 32_000;
    const inputs = [
      `account${" ".repeat(n)}x`,
      `iban${" ".repeat(n)}x`,
      `${"account ".repeat(n / 8)}x`,
      `${"1 ".repeat(n / 2)}x`,
      `${"1234-".repeat(n / 5)}x`,
      "9".repeat(n),
      `${"account number:** ".repeat(n / 18)}`,
    ];
    for (const text of inputs) {
      const started = performance.now();
      findSensitiveNumber(text);
      expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(250);
    }
  });
});
