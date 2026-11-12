// The briefing's model output contract (T-235 part 1): ONE Zod schema is the source of truth; the JSON schema sent to the
// model (Messages API structured outputs, `output_config.format`) is generated from it, and the reply is validated with it.
// Everything downstream (checkContent: known refs, grounding, masking) still runs on the validated value.
import { z } from "zod";
import { extractJson } from "@nichols/briefing/domain";
import type { LLMOutputSchema } from "@nichols/ai";

const text = z.string();
export const BriefingOutputSchema = z.object({
  lines: z.array(text),
  attention: z.array(z.object({ ref: text, what: text, why: text, next: text })),
  deadlines: z.array(z.object({ ref: text.nullable(), text, due: text.nullable() })),
  priorities: z.array(z.object({ text, reason: text, refs: z.array(text) })),
  // Lanes with drafts off may omit these two: the default keeps that from costing a retry (the API schema still lists them as required).
  replies: z.array(z.object({ ref: text, status: z.enum(["ready", "awaiting_input"]), context: text, text })).default([]),
  more_replies: z.array(text).default([]),
});
export type BriefingOutput = z.infer<typeof BriefingOutputSchema>;

/** What goes in `LLMRequest.outputSchema`. Generated from the Zod schema, so the two cannot drift. `$schema` is dropped (the API
 * rejects it); the provider additionally runs the SDK's transformJSONSchema (closed objects, no type arrays). */
const GENERATED = z.toJSONSchema(BriefingOutputSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
delete GENERATED.$schema;
export const BRIEFING_OUTPUT_SCHEMA: LLMOutputSchema = { name: "briefing", schema: GENERATED };

/** A validation problem as codes only: the path and the Zod issue code (and the expected type name). Never a value. */
export type OutputIssue = { path: string; code: string; expected?: string };

const FENCE = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/;

/** The JSON value in the reply: the whole text, else the fenced block, else the first {...} (leading or trailing prose). */
export function parseReplyJson(reply: string): unknown {
  const t = reply.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fenced = FENCE.exec(t);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  return extractJson(t);
}

export type OutputParse = { ok: true; value: BriefingOutput } | { ok: false; issues: OutputIssue[] };

export function parseBriefingOutput(reply: string): OutputParse {
  const raw = parseReplyJson(reply);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [{ path: "", code: "not_json" }] };
  const r = BriefingOutputSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues.slice(0, 20).map((i): OutputIssue => {
    const expected = (i as { expected?: unknown }).expected;
    return { path: i.path.map(String).join("."), code: i.code, ...(typeof expected === "string" ? { expected } : {}) };
  });
  return { ok: false, issues };
}

/** The correction request for the one retry: paths and codes only, no email content. */
export function correctionMessage(issues: readonly OutputIssue[]): string {
  const list = issues.map((i) => `- ${i.path === "" ? "(root)" : i.path}: ${i.code}${i.expected ? ` (expected ${i.expected})` : ""}`).join("\n");
  return `Your previous reply did not match the required JSON schema:\n${list}\nReply again with the complete corrected briefing as one JSON object only, no prose and no code fence.`;
}
