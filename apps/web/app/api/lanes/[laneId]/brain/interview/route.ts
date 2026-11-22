// Setup interview (T-216). Logic and checks live in lib/brain-interview.ts.
import { handleInterview } from "@/lib/brain-interview";
import { guards } from "@/lib/guards";
import { hiddenModuleResponse } from "@/lib/lane-modules";

export const maxDuration = 30;

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  const hidden = await hiddenModuleResponse(laneId, "brain"); // T-265: a limited company that hides this module has no endpoint
  if (hidden) return hidden;
  return handleInterview(request, laneId, { guards, now: () => new Date() });
}
