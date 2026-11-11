// QuickBooks "Check connection" (T-198, the QuickBooks row of Settings -> Connections since T-233):
// POST /api/connection-test/qbo/check?lane=PKG. Owner or admin_technical of the lane at AAL2. One read-only CompanyInfo
// call; the logic and its tests are in lib/connection-test.ts.
import { checkQuickBooksConnection } from "@nichols/connectors/connection-test";
import { createConnectionCheckHandler } from "@/lib/connection-test";
import { guards } from "@/lib/guards";

const handler = createConnectionCheckHandler({ guards, check: checkQuickBooksConnection });

export async function POST(request: Request) {
  return handler(request);
}
