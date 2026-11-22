// Assistant chat stream (T-105). Logic and checks live in lib/assistant.ts.
import { getLLMProvider } from "@nichols/ai/config";
import { getAudit } from "@nichols/core/lane-router";
import { handleChat } from "@/lib/assistant";
import { guards } from "@/lib/guards";
import { hiddenModuleResponse } from "@/lib/lane-modules";

export const maxDuration = 120;

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  const hidden = await hiddenModuleResponse(laneId, "assistant"); // T-265: a limited company that hides this module has no endpoint
  if (hidden) return hidden;
  return handleChat(request, laneId, { guards, provider: () => getLLMProvider(), audit: getAudit, now: () => new Date() });
}
