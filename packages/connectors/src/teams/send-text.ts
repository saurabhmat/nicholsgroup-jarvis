// The text rules of a Teams send, PURE (no Buffer, no zod, no I/O) so the browser and the server run the very same code (T-288 review C4): `@nichols/connectors/teams-pure` re-exports it and
// `send-schema.ts` builds its Zod schema on it. The database says the same thing in act.teams_shape_ok.
import { TEAMS_MAX_TEXT_BYTES } from "./constants";

export const TEAMS_TEXT_MAX_CHARS = 10_000;
// No control character except newline (\n) and tab (\t); C1 controls too.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** What the person typed, made canonical before it is hashed, shown for approval or sent: line breaks as `\n`, NFC, trimmed. Idempotent. */
export function normalizeTeamsText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

/** Code points, not UTF-16 units: the same count as Postgres `char_length`. */
export const teamsCodePoints = (s: string): number => Array.from(s).length;

/** No lone surrogate (`String.prototype.isWellFormed` is newer than this build's lib): encoding a lone surrogate throws. */
export function isWellFormedText(s: string): boolean {
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
}

export type TeamsTextProblemCode = "not_text" | "malformed" | "not_normalised" | "spaces" | "empty" | "control" | "too_long" | "too_big";
/** Fixed sentences only: never the text. */
export const TEAMS_TEXT_PROBLEMS: Readonly<Record<TeamsTextProblemCode, string>> = Object.freeze({
  not_text: "The message is not text",
  malformed: "The message holds an invalid character",
  not_normalised: "The message is not normalised",
  spaces: "The message has spaces at its ends",
  empty: "The message is empty",
  control: "The message holds a control character",
  too_long: "The message is longer than 10,000 characters",
  too_big: "The message is larger than 80 KB",
});

/** The code of the first rule a (canonical) text breaks, or null. */
export function teamsTextProblemCode(text: unknown): TeamsTextProblemCode | null {
  if (typeof text !== "string") return "not_text";
  if (!isWellFormedText(text)) return "malformed";
  if (text.normalize("NFC") !== text) return "not_normalised";
  if (text !== text.trim()) return "spaces";
  if (text === "") return "empty";
  if (CONTROL.test(text)) return "control";
  if (teamsCodePoints(text) > TEAMS_TEXT_MAX_CHARS) return "too_long";
  if (new TextEncoder().encode(text).length > TEAMS_MAX_TEXT_BYTES) return "too_big";
  return null;
}
export const teamsTextProblem = (text: unknown): string | null => {
  const c = teamsTextProblemCode(text);
  return c === null ? null : TEAMS_TEXT_PROBLEMS[c];
};
