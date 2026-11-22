// Memory import (T-220). Logic and checks live in lib/brain-import.ts.
import { getLLMProvider } from "@nichols/ai/config";
import { handleImport } from "@/lib/brain-import";
import { guards } from "@/lib/guards";
import { hiddenModuleResponse } from "@/lib/lane-modules";

export const maxDuration = 90;

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  const hidden = await hiddenModuleResponse(laneId, "brain"); // T-265: a limited company that hides this module has no endpoint
  if (hidden) return hidden;
  return handleImport(request, laneId, { guards, provider: () => getLLMProvider(), now: () => new Date() });
}
