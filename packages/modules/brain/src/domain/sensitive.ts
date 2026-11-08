// Sensitive-number screen for brain text (decided by Saurabh, Nov 7, 2026; architecture "never stored" list). Brain pages
// (and their paths), employee names, instructions and config, skills, and imported facts refuse:
//   - ssn:  ###-##-#### not inside a longer dashed number;
//   - card: digits in a card layout (one run of 13–19, 4-4-4-4 with an optional 1–3 tail, 4-6-4/5) passing Luhn; groups
//           may be split by one or two spaces, dashes or dots, and a following expiry/CVV does not hide the number;
//   - bank: an account number (8–17 digits) after "account"/"acct", a routing number (9 digits) after "routing"/"ABA",
//           or an IBAN after "IBAN"; markdown between label and number (`**`, `|`, `:`, `-`, a newline) is skipped.
// Text is NFKC-normalised and Unicode dashes become "-" first (full-width digits, en dashes). Phone numbers, dates,
// last-4s and short ledger account numbers ("Account 400100") still save. Known false positive, accepted: an unbroken
// 13–19 digit id that happens to pass Luhn.
//
// Linear time by construction (security review H-1): every regex is either linear or runs on a fixed 80-char window.
// brain.sensitive_number_kind() (migration 20261107100000) is the same rule in SQL and is authoritative; the shared
// cases in supabase/core/supabase/tests/fixtures/brain_sensitive_cases.json keep the two in step.

export type SensitiveNumberKind = "ssn" | "card" | "bank";

const DASHES = /[‐-―−]/g;
const SSN = /(?<![0-9])(?<![0-9]-)[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9])(?!-[0-9])/;
const DIGIT_SEQUENCE = /[0-9]+(?:[ \t.-]{1,2}[0-9]+)*/g;
const LABEL = /(?:^|[^a-z])(account|acct|routing|aba|iban)(?![a-z])/g;
const WINDOW = 80;
const GAP = "(?:[ \\t]{0,3}(?:number|num|no|nr)(?![a-z]))?[ \\t*_|:#.=\\n-]{0,10}(?:is[ \\t]{1,3})?";
const NOT_DATE = "(?![0-9]{4}-[0-9]{2}-[0-9]{2}(?![0-9]))(?![0-9]{1,2}-[0-9]{1,2}-[0-9]{2,4}(?![0-9]))";
const AFTER_LABEL: Record<string, RegExp> = {
  account: new RegExp(`^${GAP}${NOT_DATE}[0-9](?:[ -]?[0-9]){7,16}(?![0-9/])`),
  routing: new RegExp(`^${GAP}[0-9](?:[ -]?[0-9]){8}(?![0-9/])`),
  iban: new RegExp(`^[ \\t*_|:#.=\\n-]{0,10}[a-z]{2}[0-9]{2}(?:[ -]?[a-z0-9]){10,30}`),
};
const LABEL_RULE: Record<string, string> = { account: "account", acct: "account", routing: "routing", aba: "routing", iban: "iban" };

/** NFKC plus Unicode dashes to "-", as brain.sensitive_number_kind does. */
export function normalizeForScreen(text: string): string {
  return text.normalize("NFKC").replace(DASHES, "-");
}

export function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Group lengths that look like a written card number (see brain.card_layout). */
export function cardLayout(lengths: readonly number[]): boolean {
  const k = lengths.length;
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total < 13 || total > 19) return false;
  if (k === 1) return true;
  if (k === 3 && lengths[0] === 4 && lengths[1] === 6 && (lengths[2] === 4 || lengths[2] === 5)) return true;
  if (k >= 4 && lengths.slice(0, -1).every((l) => l === 4)) {
    const last = lengths[k - 1] as number;
    return last >= 1 && last <= 4;
  }
  return false;
}

function hasCard(text: string): boolean {
  for (const m of text.matchAll(DIGIT_SEQUENCE)) {
    const groups = m[0].split(/[^0-9]+/);
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      const lengths: number[] = [];
      for (let j = i; j < groups.length; j++) {
        // Prune (same result as cardLayout): every group before the last is 4 digits, except 4-6-x.
        const prev = j > i ? (groups[j - 1] as string).length : 4;
        if (prev !== 4 && !(j === i + 2 && (groups[i] as string).length === 4 && prev === 6)) break;
        const g = groups[j] as string;
        digits += g;
        lengths.push(g.length);
        if (digits.length > 19) break;
        if (digits.length >= 13 && cardLayout(lengths) && luhnOk(digits)) return true;
      }
    }
  }
  return false;
}

function hasBank(lower: string): boolean {
  for (const m of lower.matchAll(LABEL)) {
    const rule = AFTER_LABEL[LABEL_RULE[m[1] as string] as string] as RegExp;
    const end = (m.index ?? 0) + m[0].length;
    if (rule.test(lower.slice(end, end + WINDOW))) return true;
  }
  return false;
}

/** The first kind of sensitive number found, or null. Checked in the order ssn, card, bank. */
export function findSensitiveNumber(text: string): SensitiveNumberKind | null {
  const t = normalizeForScreen(text);
  if (SSN.test(t)) return "ssn";
  if (hasCard(t)) return "card";
  if (hasBank(t.toLowerCase())) return "bank";
  return null;
}
