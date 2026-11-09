// Import memories page (T-220): the lane gate first (loadLane), then the owner's brain view (the same gate as the onboarding page
// and the import route; anyone else gets the same 404 as an unknown page). The proxy answers the 404 status before streaming for
// every path under /<lane>/onboarding (lib/onboarding-gate.ts), so this page needs no gate of its own there.
import { notFound } from "next/navigation";
import { PageHeader } from "@nichols/ui";
import { getLLMProvider } from "@nichols/ai/config";
import { loadLane } from "@/lib/lane-page";
import { onboardingFor } from "@/lib/onboarding-progress";
import { BrainImport } from "./brain-import";

export async function OnboardingImportPage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  if (!(await onboardingFor(lane.laneId))) notFound();
  // Only whether the AI is configured is known here (never a key or a model name): paste and file imports need it, the .zip does not.
  const aiConfigured = getLLMProvider().configured;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="Import" accent="memories" />
      <BrainImport laneId={lane.laneId} aiConfigured={aiConfigured} />
    </div>
  );
}
