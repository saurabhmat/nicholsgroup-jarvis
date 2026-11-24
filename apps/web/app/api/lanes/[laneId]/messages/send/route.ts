// POST /api/lanes/<lane>/messages/send (T-288): "Send = your approval" for a Teams chat message. THE one file outside the approvals package that may name `sendTeamsMessage` (rule 5; the lint
// restriction and the boundary test say so): every other check (same site, AAL2, the Teams step-up window, module, the caller's own connection, the gates) is in lib/teams-api.ts and in the approvals module.
import { sendTeamsMessage, teamsStepUpWindow } from "@nichols/approvals/wire";
import { teamsSendFailureText } from "@nichols/approvals/server";
import { guards } from "@/lib/guards";
import { createTeamsRoutes } from "@/lib/teams-api";

const routes = createTeamsRoutes({ guards, send: { window: teamsStepUpWindow, run: sendTeamsMessage, failureText: teamsSendFailureText } });

export async function POST(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/messages/send">) {
  return routes.send(request, (await ctx.params).laneId);
}
