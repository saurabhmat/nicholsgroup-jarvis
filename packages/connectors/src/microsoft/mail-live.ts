// Live reads of Microsoft mail (T-259, spec §8.3): the body of one message and the text of a search. Pure helpers: no request is made here.
// Both inputs and outputs are untrusted (rule 9). A body is returned to the caller in an `UntrustedBody` and is never stored, logged or put in an
// error (rule 6): this file never builds a message from content, and its errors are fixed texts.
import { z } from "zod";
import { htmlToText, cut } from "../comms/html-text";

/** The most characters of the caller's search words that are sent (the encoded query must stay under the Graph client's raw-query limit). */
export const MAX_SEARCH_CHARS = 200;
/** The most results asked of Graph for one search (the facade's own limit is 100). */
export const MAX_SEARCH_RESULTS = 100;

const OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
/** Letters of any script, marks (so words of scripts that need them stay whole), digits, and the few characters of addresses and names. */
const NOT_PLAIN = /[^\p{L}\p{M}\p{N} @._-]/gu;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The caller's text reduced to plain words for Graph's `$search` (plan-review "T-259 ... V-14": quoting alone does not stop operators, the
 * documentation's own examples put property restrictions and `OR` inside the quotes). After NFKC (so full-width forms of an operator or a quote
 * cannot slip through), every character that is not a letter, mark, digit, space or one of `@ . _ -` becomes a space (so no `"`, `\`, `:`, parentheses,
 * `*` or comparison sign remains); stand-alone `AND`, `OR`, `NOT`, `NEAR` are lower-cased (Graph reads only upper-case ones as operators); a word with
 * no letter or digit is dropped; spaces collapse; the result is cut at MAX_SEARCH_CHARS code points. Null when nothing is left.
 */
export function plainSearchWords(query: string): string | null {
  const words = query
    .normalize("NFKC")
    .replace(NOT_PLAIN, " ")
    .split(" ")
    .filter((w) => w !== "" && HAS_WORD_CHAR.test(w))
    .map((w) => (OPERATORS.has(w) ? w.toLowerCase() : w));
  // Cut by code points (never inside a surrogate pair) and never leaving a trailing space.
  const out = [...words.join(" ")].slice(0, MAX_SEARCH_CHARS).join("").trim();
  return out === "" ? null : out;
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
