// The request body of the memory import API (T-220). Strict: unknown actions and keys are refused.
import { z } from "zod";
import { IMPORT_TARGETS } from "./targets";

export const IMPORT_SOURCES = ["claude_paste", "chatgpt_paste", "claude_export", "chatgpt_export"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const proposalId = z.string().regex(/^[0-9a-f]{64}$/);
/** The ticked candidates, with the text the user may have edited. The target and section come from the stored candidate, never from here. */
const items = z.array(z.strictObject({ id: uuid, text: z.string().min(1).max(500) })).min(1).max(100);
const pageText = z.string().min(1).max(50_000);

export const importRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("extract"), source: z.enum(IMPORT_SOURCES), text: pageText }),
  z.strictObject({ action: z.literal("propose"), importId: uuid, items }),
  z.strictObject({ action: z.literal("save"), importId: uuid, items, proposalId }),
  z.strictObject({ action: z.literal("discard"), importId: uuid }),
  z.strictObject({ action: z.literal("page_propose"), target: z.enum(IMPORT_TARGETS), text: pageText }),
  z.strictObject({ action: z.literal("page_save"), target: z.enum(IMPORT_TARGETS), text: pageText, proposalId }),
]);
export type ImportRequest = z.infer<typeof importRequestSchema>;
