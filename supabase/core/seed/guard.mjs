// Guard: generated seed SQL may contain only synthetic data (CLAUDE.md rule 10). Runs inside the generator (fails
// closed) and in tests. Checks:
//  1. every email address anywhere (comments too) is on exactly `example.test`;
//  2. every domain-like token inside a string literal is on a reserved name (RFC 2606 / 6761);
//  3. every capitalized word inside a string literal is a lane name word, lane code or persona label word;
//  4. known real people / company domains appear nowhere (case-insensitive).
import { ALLOWED_NAME_WORDS, SYNTHETIC_EMAIL_DOMAIN } from "./data.mjs";

const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

// People and organisations from the planning docs. Matching is substring and case-insensitive.
const DENYLIST = ["robert", "sophie", "saurabh", "gopal", "pubkgroup", "pub-k.org", "pub-k.com", "nicholscapital", "nicholsgroup", "nicholslaw"];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g;
const LITERAL_RE = /'((?:[^']|'')*)'/g;
const DOMAIN_RE = /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const CAPITALIZED_RE = /\b[A-Z][A-Za-z]*\b/g;

const isReservedDomain = (domain) => {
  const d = domain.toLowerCase();
  const tld = d.split(".").pop();
  return RESERVED_TLDS.has(tld) || [...RESERVED_DOMAINS].some((r) => d === r || d.endsWith(`.${r}`));
};

/** Text of every string literal, skipping full-line `--` comments. */
const literals = (sql) => {
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return [...code.matchAll(LITERAL_RE)].map((m) => m[1].replaceAll("''", "'"));
};

/** @returns {string[]} human-readable violations; empty when the SQL is clean. */
export function findSyntheticViolations(sql) {
  const out = [];
  const allowedWords = new Set(ALLOWED_NAME_WORDS);

  for (const m of sql.matchAll(EMAIL_RE)) {
    if (m[1] !== SYNTHETIC_EMAIL_DOMAIN) out.push(`email not on ${SYNTHETIC_EMAIL_DOMAIN}: ${m[0]}`);
  }

  for (const text of literals(sql)) {
    for (const d of text.match(DOMAIN_RE) ?? []) {
      if (!isReservedDomain(d)) out.push(`non-reserved domain in literal: ${d}`);
    }
    for (const w of text.match(CAPITALIZED_RE) ?? []) {
      if (!allowedWords.has(w)) out.push(`name-like word not allowed in literal: ${w}`);
    }
  }

  const lower = sql.toLowerCase();
  for (const term of DENYLIST) {
    if (lower.includes(term)) out.push(`denylisted real name or domain: ${term}`);
  }
  return [...new Set(out)];
}

export function assertSyntheticOnly(sql) {
  const violations = findSyntheticViolations(sql);
  if (violations.length > 0) {
    throw new Error(`seed output is not synthetic-only:\n  - ${violations.join("\n  - ")}`);
  }
}
