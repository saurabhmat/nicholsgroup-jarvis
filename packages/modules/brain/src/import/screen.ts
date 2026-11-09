// Screens for imported text (T-220, CLAUDE.md rules 6 and 9, spec brain-and-employees §7a). Pure and client-safe.
// Imported text is untrusted: it may supply facts about the owner, never instructions, tools or permissions. Lines that read
// like orders to an assistant are dropped (and counted, never echoed). Credentials and sensitive numbers never reach a page.
// Text that may be Nichols Law client or matter content is flagged (unticked, no quote kept): that content must not land in
// the core data plane (pilot-scope rule 13).
import { containsSecret } from "../domain/secrets";
import { findSensitiveNumber, type SensitiveNumberKind } from "../domain/sensitive";

const INVISIBLE = /[​-‏⁠-⁤﻿­͏᠎‪-‮⁦-⁩]|[\u{e0000}-\u{e007f}]/gu;

/** NFKC, no invisible or bidi characters, lower case: spacing and width tricks cannot hide a pattern. */
export function fold(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").toLowerCase();
}

const ACTION = "(send|forward|delete|remove|archive|approve|pay|transfer|wire|execute|run|call|email|e-mail|reply|post|share|grant|bypass|skip|disable|enable|schedule|book|buy|purchase|sign|submit|publish|export|upload|download|open|click|visit|ignore|override)";
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // "ignore previous instructions", "disregard the above", "forget everything"
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|every|these|your|the)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|restrictions?|polic(y|ies)|safeguards?|context|everything)\b/,
  /\b(system|developer) (prompt|message|instructions?)\b/,
  /\b(you are now|from now on|new instructions?|act as|pretend to be|your (new )?(role|task|job) is)\b/,
  // imperative lines addressed to an assistant: "always send ...", "never ask me ...", "you must approve ..."
  new RegExp(`^\\W*(always|never|you (must|should|shall|will|need to)|make sure( to)?|ensure( that)?|do not|don't|please|immediately|automatically)\\b[^\\n]{0,80}\\b${ACTION}\\b`),
  new RegExp(`\\b(always|automatically|immediately|without (asking|approval|confirmation|checking|review))\\b[^\\n]{0,40}\\b${ACTION}\\b`),
  // tool, permission and approval talk
  /\b(function calls?|tool calls?|(use|call|run|invoke|trigger|enable|disable) (the |a |any )?tools?|permissions?|auto-?approv\w*|approval (rules?|gate)|jailbreak|exfiltrat\w*|prompt injection|api[ _-]?keys?|passwords?|secrets?|credentials?|access tokens?)\b/,
  /\bwithout (asking|approval|confirmation|review|my (approval|permission))\b/,
];

/** True when a sentence reads like an order to an assistant, or talks about tools, permissions or credentials. */
export function isInstructionLike(sentence: string): boolean {
  const t = fold(sentence);
  return INSTRUCTION_PATTERNS.some((p) => p.test(t));
}

/** Sentences and lines: the unit at which instruction-like text is dropped. */
export function segments(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Removes instruction-like sentences from untrusted text before anything reads it. Returns the cleaned text (one segment
 * per line) and how many segments were dropped. Dropped text is never returned, stored or logged.
 */
export function stripInstructions(text: string): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const s of segments(text)) {
    if (isInstructionLike(s)) dropped++;
    else kept.push(s);
  }
  return { text: kept.join("\n"), dropped };
}

const LEGAL = [
  /nichols[\s\-_.&]*law/,
  /\b(attorney[- ]client|privileged|client[- ]matter|matter (no|number|#)|case (no|number|#)|docket|retainer|iolta|trust account|opposing counsel|plaintiff|defendant|litigation|settlement agreement|esq)\b/,
];

/** A heuristic: the text may be client or matter content of a law practice. Flags (never blocks) a candidate. */
export const looksLikeLegalMatter = (text: string): boolean => LEGAL.some((p) => p.test(fold(text)));

/** The explicit exclusion (pilot-scope rule 13): the Nichols Law name itself. Saving such text is refused. */
export const namesExcludedEntity = (text: string): boolean => /nichols[\s\-_.&]*law/.test(fold(text));

export type ScreenResult = { ok: true } | { ok: false; reason: "secret" | `sensitive_${SensitiveNumberKind}` };

/** Credentials and sensitive numbers (SSN, card, bank): never kept in a candidate or a page. */
export function screenSensitive(text: string): ScreenResult {
  const folded = text.normalize("NFKC").replace(INVISIBLE, "");
  if (containsSecret(folded)) return { ok: false, reason: "secret" };
  const kind = findSensitiveNumber(folded);
  return kind === null ? { ok: true } : { ok: false, reason: `sensitive_${kind}` };
}

/** Whitespace and case folded, for finding a quote in the text it came from. */
export const squash = (text: string): string => fold(text).replace(/\s+/g, " ").trim();
