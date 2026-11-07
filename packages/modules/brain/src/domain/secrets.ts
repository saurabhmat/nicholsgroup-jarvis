// Secret-pattern scan for brain text (T-210). Owner-authored pages, profiles and skills become prompt text, so they must
// never carry a credential. Reuses looksLikeSecretValue (the shared value-level list) over the whole text, each line,
// and each token of 8+ characters, plus a Bearer/Basic credential anywhere. brain.text_has_secret() does the same in SQL
// (authoritative: it also backs a CHECK constraint); this copy gives the user a clear message before the round trip.
// Known false positive, accepted (as in lane config): a word that starts with a vendor prefix, e.g. `re_engaged`.
import { looksLikeSecretValue } from "@nichols/core/secrets";

// Two splits (see brain.text_has_secret): the first keeps URLs and user:pass@host whole, the second breaks on `:=?&#@%`
// and quotes so `NAME=sk_live_...` and `token:ghp_...` expose the value (T-210 security review H-1).
const TOKEN_SPLIT = /[^A-Za-z0-9_:/.@?&#=%+~-]+/;
const TOKEN_SPLIT_VALUE = /[^A-Za-z0-9_./+~-]+/;
// A credential name followed by a value: `name=<8+>` (env/URL form) or `name: <8+ with a digit>` (prose form).
const KEY_VALUE =
  /(secret|token|password|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|signing[-_]?key|client[-_]?secret|credential)s?["']?(\s*=\s*["']?[^\s"']{8,}|\s*:\s*["']?(?=[^\s"']*[0-9])[^\s"']{8,})/i;
const BEARER = /(bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}/i;
const MIN_TOKEN = 8;

export function containsSecret(text: string): boolean {
  if (looksLikeSecretValue(text) || BEARER.test(text) || KEY_VALUE.test(text)) return true;
  for (const line of text.split("\n")) {
    if (line !== "" && looksLikeSecretValue(line)) return true;
  }
  for (const split of [TOKEN_SPLIT, TOKEN_SPLIT_VALUE]) {
    for (const token of text.split(split)) {
      if (token.length >= MIN_TOKEN && looksLikeSecretValue(token)) return true;
    }
  }
  return false;
}
