// Live reads of Microsoft mail (T-259, spec §8.3): the body of one message and the text of a search. Pure helpers: no request is made here.
// Both inputs and outputs are untrusted (rule 9). A body is returned to the caller in an `UntrustedBody` and is never stored, logged or put in an
// error (rule 6): this file never builds a message from content, and its errors are fixed texts.
import { z } from "zod";
import { htmlToText, cut } from "../comms/html-text";

/** The most characters of the caller's search words that are sent (the encoded query must stay under the Graph client's raw-query limit). */
export const MAX_SEARCH_CHARS = 200;
/** The most results asked of Graph for one search (the facade's own limit is 100). */
export const MAX_SEARCH_RESULTS = 100;

// Graph's search language: the boolean and proximity operators and the ranking keyword. Upper case is what Graph reads as an operator; they are lower-cased.
const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR", "ONEAR", "XRANK", "WORDS"]);
/** Letters of any script, marks (so words of scripts that need them stay whole), digits, and the few characters of addresses and names. */
const NOT_PLAIN = /[^\p{L}\p{M}\p{N} @._-]/gu;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The caller's text reduced to plain words for Graph's `$search` (plan-review "T-259 ... V-14": quoting alone does not stop operators, the
 * documentation's own examples put property restrictions and `OR` inside the quotes). After NFKC (so full-width forms of an operator or a quote
 * cannot slip through) default-ignorable code points (zero-width characters, variation selectors, the grapheme joiner) are REMOVED, so an operator with an
 * invisible mark attached is still seen as one; every character that is not a letter, mark, digit, space or one of `@ . _ -` becomes a space (so no `"`,
 * `\`, `:`, parentheses, `*` or comparison sign remains); leading `-` and `+` are stripped from each word (no exclusion prefix); a word with no letter or
 * digit is dropped; spaces collapse. The words are then cut at MAX_SEARCH_CHARS code points on a word boundary FIRST, and only then are stand-alone
 * `AND`, `OR`, `NOT`, `NEAR`, `ONEAR`, `XRANK` and `WORDS` lower-cased, so a cut can never leave an upper-case operator. Null when nothing is left.
 */
export function plainSearchWords(query: string): string | null {
  const words = query
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .replace(NOT_PLAIN, " ")
    .split(" ")
    .map((w) => w.replace(/^[-+]+/, ""))
    .filter((w) => w !== "" && HAS_WORD_CHAR.test(w));
  const kept: string[] = [];
  let length = 0;
  for (const w of words) {
    const add = (kept.length === 0 ? 0 : 1) + [...w].length;
    if (length + add > MAX_SEARCH_CHARS) {
      if (kept.length === 0) kept.push([...w].slice(0, MAX_SEARCH_CHARS).join("")); // one word longer than the bound: cut by code points
      break;
    }
    kept.push(w);
    length += add;
  }
  if (kept.length === 0) return null;
  return kept.map((w) => (OPERATORS.has(w) ? w.toLowerCase() : w)).join(" ");
}

/** The `$search` part of a raw query: `$search="<words>"`, percent-encoded (the raw query allows ASCII URL characters only; the quote is `%22`). */
export function searchParam(words: string): string {
  return `$search=%22${encodeURIComponent(words)}%22`;
}

const BodyAnswerSchema = z.object({ body: z.object({ contentType: z.string().max(20), content: z.string().nullish() }) });

/**
 * The text of a single-message answer. The type comes from `body.contentType` IN THE ANSWER (not from the preference we sent): `html` is converted
 * exactly as the Gmail reader converts HTML, anything else that is `text` is used as is. Cut at `maxChars`. Null when the answer is not a body.
 */
export function bodyFromAnswer(answer: unknown, maxChars: number): { text: string; truncated: boolean } | null {
  const parsed = BodyAnswerSchema.safeParse(answer);
  if (!parsed.success) return null;
  const type = parsed.data.body.contentType.toLowerCase();
  if (type !== "html" && type !== "text") return null;
  const content = parsed.data.body.content ?? "";
  // Markup is cut before conversion (the text is at most maxChars; markup rarely outweighs it 4:1), as the Gmail reader does.
  const capChars = Math.min(maxChars * 4, 1_000_000);
  const raw = type === "html" ? htmlToText(content.slice(0, capChars)) : content.slice(0, capChars);
  return cut(raw.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim(), maxChars);
}
