// Text cleaning shared by the mail mappers (Gmail headers, Graph fields): the one rule for what a subject or a display name may contain.
// It lives here so the Microsoft code imports no Google code (T-258).

/** Same set as the T-062 schemas refuse (controls, line/paragraph separators, bidi controls). */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function cleanText(s: string): string {
  return s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
}
