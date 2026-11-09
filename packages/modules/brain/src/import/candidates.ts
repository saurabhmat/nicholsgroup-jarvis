// Candidate facts from the model (T-220). The model only PROPOSES: its output is parsed here, screened, bounded, and turned
// into candidate rows the user can tick. Nothing in this file writes anything (rules 7 and 9). Pure and client-safe.
import { z } from "zod";
import { IMPORT_SECTIONS, IMPORT_TARGETS, isImportSection, laneFor, targetPath, type ImportTarget } from "./targets";
import { anyInstructionLike, looksLikeLegalMatter, namesExcludedEntity, screenSensitive, squash } from "./screen";

export const MAX_IMPORT_CHARS = 50_000;
export const MAX_CANDIDATES = 100;
export const MAX_FACT_CHARS = 400;
export const MAX_QUOTE_CHARS = 300;

/** The model's reply: strict about shape, tolerant about extra keys (dropped). */
export const modelOutputSchema = z.object({
  items: z
    .array(
      z.object({
        fact: z.string().min(1).max(2000),
        quote: z.string().max(4000).nullish(),
        target: z.enum(IMPORT_TARGETS),
        section: z.string().min(1).max(120),
      }),
    )
    .max(300),
});

/** Pulls the JSON object out of a model reply (plain, or inside a code fence). null when there is none. */
export function parseModelJson(reply: string): unknown {
  const t = reply.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  const body = fenced?.[1] ?? t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export type CandidateFlag = "possible_nl_content" | "instruction_dropped";
export type DraftCandidate = {
  fact: string;
  evidence: string | null;
  targetPath: string;
  targetSection: string;
  targetLane: string;
  flags: CandidateFlag[];
};
export type DroppedCounts = {
  /** Lines of the pasted text, and facts, that read like instructions. Never echoed. */
  instructions: number;
  /** Facts with a credential or a sensitive number. */
  sensitive: number;
  /** Items the model returned that do not fit a target and section, or were empty or repeated. */
  other: number;
};

const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Turns the model's reply into candidates. `sourceText` is the (already instruction-stripped) text the model saw: a quote is
 * kept only when it really appears in it. Candidate order is the model's order; duplicates are dropped.
 */
export function buildCandidates(
  reply: unknown,
  sourceText: string,
  ctx: { home: string; current: string },
  preDropped = 0,
): { candidates: DraftCandidate[]; dropped: DroppedCounts } {
  const dropped: DroppedCounts = { instructions: preDropped, sensitive: 0, other: 0 };
  const parsed = modelOutputSchema.safeParse(reply);
  if (!parsed.success) return { candidates: [], dropped };
  const haystack = squash(sourceText);
  const seen = new Set<string>();
  const out: DraftCandidate[] = [];
  for (const item of parsed.data.items) {
    if (out.length >= MAX_CANDIDATES) {
      dropped.other++;
      continue;
    }
    const fact = oneLine(item.fact);
    if (fact === "" || fact.length > MAX_FACT_CHARS || !isImportSection(item.target as ImportTarget, item.section)) {
      dropped.other++;
      continue;
    }
    const key = `${item.target}|${item.section}|${squash(fact)}`;
    if (seen.has(key)) {
      dropped.other++;
      continue;
    }
    if (namesExcludedEntity(fact)) {
      dropped.other++; // Nichols Law content is out of scope (rule 13): not stored
      continue;
    }
    if (anyInstructionLike(fact, item.target === "pa")) {
      dropped.instructions++;
      continue;
    }
    if (!screenSensitive(fact).ok) {
      dropped.sensitive++;
      continue;
    }
    seen.add(key);
    const flags: CandidateFlag[] = [];
    let evidence: string | null = null;
    const quote = item.quote == null ? "" : oneLine(item.quote);
    if (quote !== "") {
      if (anyInstructionLike(quote, item.target === "pa")) flags.push("instruction_dropped");
      else if (screenSensitive(quote).ok && haystack.includes(squash(quote))) evidence = quote.slice(0, MAX_QUOTE_CHARS);
    }
    if (looksLikeLegalMatter(fact) || (evidence !== null && looksLikeLegalMatter(evidence)) || (quote !== "" && looksLikeLegalMatter(quote))) {
      flags.push("possible_nl_content");
      evidence = null; // no quote is kept for possible Nichols Law content
    }
    out.push({
      fact,
      evidence,
      targetPath: targetPath(item.target),
      targetSection: item.section,
      targetLane: laneFor(item.target, ctx),
      flags,
    });
  }
  return { candidates: out, dropped };
}

export { IMPORT_SECTIONS };
