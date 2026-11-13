// GET /api/lanes/<lane>/connector-errors/export (T-196): the connector error log as CSV or JSON for Intuit support. Owner or
// admin_technical of the lane at AAL2; audited. Logic and checks: lib/connector-error-export.ts.
import { getAudit } from "@nichols/core/lane-router";
import { createConnectorErrorExportHandler } from "@/lib/connector-error-export";
import { guards } from "@/lib/guards";

const handler = createConnectorErrorExportHandler({ guards, audit: () => getAudit() });

export async function GET(request: Request, ctx: RouteContext<"/api/lanes/[laneId]/connector-errors/export">) {
  return handler(request, (await ctx.params).laneId);
}
