// Memory import (T-220). Logic and checks live in lib/brain-import.ts.
import { getLLMProvider } from "@nichols/ai/config";
import { handleImport } from "@/lib/brain-import";
import { guards } from "@/lib/guards";

export const maxDuration = 90;

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  return handleImport(request, laneId, { guards, provider: () => getLLMProvider(), now: () => new Date() });
}
