// Approvals API (T-232). Logic and checks live in lib/approvals.ts.
import { approvalsDeps } from "@nichols/approvals/wire";
import { handleApprovals } from "@/lib/approvals";
import { guards } from "@/lib/guards";

export const maxDuration = 60; // approve also sends the email and reads it back

export async function POST(request: Request, ctx: { params: Promise<{ laneId: string }> }) {
  const { laneId } = await ctx.params;
  return handleApprovals(request, laneId, { guards, approvals: approvalsDeps });
}
