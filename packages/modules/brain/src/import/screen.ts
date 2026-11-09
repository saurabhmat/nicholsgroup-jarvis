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

// External effects only: sending, paying, deleting, approving, publishing, sharing, granting, signing, running tools. Verbs that
// merely describe how the person likes to be served (reply, call, schedule, book, open, email someone) are NOT here, so
// "Always reply in a concise tone" and "Never schedule meetings before 9am" stay facts. "send me ..." is a preference about the
// person's own inbox, not an instruction to send.
const ACTION = "(send|forward|pay|transfer|wire|delete|approve|post|publish|share|grant|sign|submit|purchase|buy|execute)(?!\\s+(me|us|myself)\\b)";
const NEGATION = /^\W*(never|don'?t|do not|please don'?t|please do not|avoid|no\b|ask me (before|first)|always (ask|confirm|check)|check with me|wait for my)/;

/** Always dropped: prompt-injection phrases, tool / permission / approval loosening, credential handling. */
const ALWAYS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|every|these|your|the)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?|restrictions?|polic(y|ies)|safeguards?|context|everything)\b/,
  /\b(system|developer) (prompt|message|instructions?)\b/,
  /\b(you are now|from now on|new instructions?|act as|pretend to be|your (new )?(role|task|job) is)\b/,
  // you may / feel free to + an external effect
  new RegExp(`\\b(you (may|can|could|should|will)|you are (allowed|permitted|authori[sz]ed) to|feel free to|go ahead and|you have permission to)\\b[^.\\n]{0,40}\\b${ACTION}\\b`),
  // skipping, bypassing or removing a check
  /\b(skip|bypass|disable|waive|turn off|override|stop requiring|no need (for|to))\b[^.\n]{0,25}\b(approv\w*|confirm\w*|check\w*|review\w*|safeguards?|rules?|restrictions?|permissions?|authori[sz]\w*|sign-?off)\b/,
  // "never ask for confirmation before you ..."
  /\b(never|don'?t|do not|no need to|stop)\b[^.\n]{0,15}\b(ask|asking|check|checking|confirm|confirming|wait|waiting)\b[^.\n]{0,25}\b(approv\w*|confirm\w*|permission|before|first)\b/,
  // granting access or permission
  /\b(grant|give|gives|giving|allow|allowing)\b[^.\n]{0,25}\b(permissions?|access|rights?|approval|authority)\b/,
  // running tools
  /\b(run|execute|invoke|trigger) (the |a |any |this )?(tool|function|script|command)s?\b/,
  /\buse the (\w+ )?tool (to|for)\b/,
  /\b(function|tool) calls?\b/,
  // credential handling: giving or using one, not merely owning a password manager
  /\b(use|enter|type|paste|store|save|remember|reuse|log ?in with|sign in with)\b[^.\n]{0,25}\b(password|passcode|api[ _-]?key|access token|secret key|credentials?)\b/,
  /\b(my|the|your)\s+(password|passcode|api[ _-]?key|access token|secret key|credentials?)\s*(is|are|:|=)/,
  /\b(password|passcode|api[ _-]?key|access token|secret key)\s*(is|:|=)\s*\S/,
  /\bhere (is|are) (my|the) (password|passcode|api[ _-]?key|token|secret|credentials?)\b/,
  /\b(exfiltrat\w*|jailbreak|prompt injection)\b/,
];

/** Dropped unless the line is a restriction ("Never send ... without my approval" limits the assistant, so it is a fact). */
const PERMISSIVE: readonly RegExp[] = [
  new RegExp(`^\\W*(always|you (must|shall|need to)|make sure( to)?|ensure( that)?|immediately|automatically|please)\\b[^\\n]{0,60}\\b${ACTION}\\b`),
  new RegExp(`\\b${ACTION}\\b[^\\n]{0,60}\\b(automatically|without (asking|approval|confirmation|checking|review|my (approval|permission|confirmation)))`),
  new RegExp(`\\b(automatically|without (asking|approval|confirmation|checking|review))\\b[^\\n]{0,40}\\b${ACTION}\\b`),
];

// Anything that touches the Personal Assistant profile becomes instructions for it, so facts aimed there get a stricter screen:
// no approvals, permissions, tools, sending, spending or acting on the person's behalf, unless the line is a restriction.
const PA_STRICT = /\b(approv\w*|permissions?|authori[sz]\w*|tools?|sends?|sending|forward\w*|pay|pays|paying|payments?|spend\w*|purchas\w*|buy\w*|transfer\w*|autonom\w*|on my behalf|full access|unrestricted|delegat\w*)\b/;

/**
 * True when a sentence reads like an order to an assistant that would extend what it may do, or talks about tools, permissions
 * or credentials in an acting sense. Restrictions on the assistant ("Never send email without asking me") are facts. `strict`
 * (facts for the Personal Assistant profile) also drops anything about approvals, tools, sending, spending or permissions that is not a restriction.
 */
export function isInstructionLike(sentence: string, strict = false): boolean {
  const t = fold(sentence);
  if (ALWAYS.some((p) => p.test(t))) return true;
  const restriction = NEGATION.test(t);
  if (!restriction && PERMISSIVE.some((p) => p.test(t))) return true;
  return strict && !restriction && PA_STRICT.test(t);
}

/** True when ANY sentence or line of the text reads like an instruction (see isInstructionLike). */
export const anyInstructionLike = (text: string, strict = false): boolean => segments(text).some((x) => isInstructionLike(x, strict));

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
export function stripInstructions(text: string, strict = false): { text: string; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const s of segments(text)) {
    if (isInstructionLike(s, strict)) dropped++;
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
