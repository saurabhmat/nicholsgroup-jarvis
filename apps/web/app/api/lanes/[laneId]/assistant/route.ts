// Assistant chat stream (T-105). Logic and checks live in lib/assistant.ts.
import { getLLMProvider } from "@nichols/ai/config";
import { getAudit } from "@nichols/core/lane-router";
import { handleChat } from "@/lib/assistant";
import { guards } from "@/lib/guards";

export const maxDuration = 120;

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  return handleChat(request, laneId, { guards, provider: () => getLLMProvider(), audit: getAudit, now: () => new Date() });
}
