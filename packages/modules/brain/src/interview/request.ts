// The request body of the setup interview API (T-216). Strict: unknown actions and keys are refused.
import { z } from "zod";

const answers = z.record(z.string().max(4), z.unknown());
export const interviewRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("state") }),
  z.strictObject({ action: z.literal("propose"), group: z.string().max(8), answers }),
  z.strictObject({ action: z.literal("save"), group: z.string().max(8), answers, proposalId: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ action: z.literal("complete"), group: z.string().max(8) }),
  z.strictObject({ action: z.literal("confirm") }),
  z.strictObject({ action: z.literal("activate") }),
]);
export type InterviewRequest = z.infer<typeof interviewRequestSchema>;
