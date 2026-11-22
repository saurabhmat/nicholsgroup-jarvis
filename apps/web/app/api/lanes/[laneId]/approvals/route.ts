// Approvals API (T-232). Logic and checks live in lib/approvals.ts. The reply actions (T-234 part 3) read the one thread live
// with the same guarded reader as the thread view, and draft with the lane-policy-gated AI provider.
import { getLLMProvider } from "@nichols/ai/config";
import { approvalsDeps, approveAndExecuteEmail } from "@nichols/approvals/wire";
import { readBody as readMailBody } from "@nichols/connectors/facade";
import type { LaneId } from "@nichols/core";
import { handleApprovals } from "@/lib/approvals";
import { guards } from "@/lib/guards";
import { hiddenModuleResponse } from "@/lib/lane-modules";
import { createLimiter } from "@/lib/reply";

export const maxDuration = 60; // approve also sends the email and reads it back; a draft is one model call

// One AI draft per thread per user per minute (per process).
const draftLimiter = createLimiter({ windowMs: 60_000, max: 1 });

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  const hidden = await hiddenModuleResponse(laneId, "approvals"); // T-265: a limited company that hides this module has no endpoint
  if (hidden) return hidden;
  return handleApprovals(request, laneId, {
    guards,
    approvals: approvalsDeps,
    approve: approveAndExecuteEmail,
    reply: {
      readBody: (l, c, m, owner) => readMailBody(l as LaneId, c, m, owner),
      llm: () => {
        const p = getLLMProvider({ timeoutMs: 45_000, maxRetries: 1 });
        return p.configured ? { configured: true, provider: p.provider } : { configured: false };
      },
      limiter: draftLimiter,
      now: Date.now,
    },
  });
}
