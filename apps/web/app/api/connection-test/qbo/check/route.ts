// Temporary QuickBooks connection test (T-198): POST /api/connection-test/qbo/check?lane=PKG from the Settings page.
// Owner or admin_technical of the lane at AAL2, switched on per lane in lane_config. One read-only CompanyInfo call;
// the logic and its tests are in lib/connection-test.ts. Removed or folded into T-045 when that ships.
import { checkQuickBooksConnection } from "@nichols/connectors/connection-test";
import { createConnectionCheckHandler } from "@/lib/connection-test";
import { guards } from "@/lib/guards";

const handler = createConnectionCheckHandler({ guards, check: checkQuickBooksConnection });

export async function POST(request: Request) {
  return handler(request);
}
