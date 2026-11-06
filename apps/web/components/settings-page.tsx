// Settings (T-023 placeholder), the connect result banner, the Google connection (T-199) plus the temporary QuickBooks connection test (T-198). The lane gate runs first, as on
// every page; the test section is shown only to owner or admin_technical at AAL2 when the lane switched it on, and the
// check route enforces the same on its own (this only decides what is drawn).
import { Alert, AlertDescription, AlertTitle } from "@nichols/ui";
import { connectResultFor } from "@/lib/connect-result";
import { loadLane } from "@/lib/lane-page";
import { guards } from "@/lib/guards";
import { connectionTestVisible } from "@/lib/connection-test";
import { googleSectionFor } from "@/lib/google-connection";
import { ConnectionTestSection } from "./connection-test-section";
import { GoogleConnectionSection } from "./google-connection-section";
import { ModulePage } from "./module-page";

export async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ laneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const lane = await loadLane((await params).laneId);
  // The result of a connect the OAuth callback sent back here (fixed, allowlisted text; connect roles only).
  const result = await connectResultFor(await guards(), lane.laneId, await searchParams);
  const showTest = await connectionTestVisible(await guards(), lane.laneId);
  const google = await googleSectionFor(await guards(), lane.laneId);
  return (
    <div className="flex flex-col gap-6">
      <ModulePage module="settings" params={params} />
      {result ? (
        <Alert variant={result.tone} data-testid="connect-result">
          <AlertTitle>{result.title}</AlertTitle>
          <AlertDescription>{result.description}</AlertDescription>
        </Alert>
      ) : null}
      {google ? <GoogleConnectionSection laneId={lane.laneId} view={google} /> : null}
      {showTest ? <ConnectionTestSection laneId={lane.laneId} /> : null}
    </div>
  );
}
