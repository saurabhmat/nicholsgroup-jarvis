// Setup interview (T-216). Logic and checks live in lib/brain-interview.ts.
import { handleInterview } from "@/lib/brain-interview";
import { guards } from "@/lib/guards";

export const maxDuration = 30;

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  return handleInterview(request, laneId, { guards, now: () => new Date() });
}
