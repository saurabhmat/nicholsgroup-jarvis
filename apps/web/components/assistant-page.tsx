// Assistant (T-106 demo scope, approved by Saurabh Nov 8, 2026). Server part: lane check, the caller's tool categories
// and whether the AI is configured; the conversation itself is client state only (nothing stored until T-103).
import { Alert, AlertDescription, AlertTitle, PageHeader } from "@nichols/ui";
import { getLLMProvider } from "@nichols/ai/config";
import { AssistantChat } from "@/components/assistant-chat";
import { BrainInterview } from "@/components/brain-interview";
import { brainSetupAvailable } from "@/lib/brain-interview";
import { toolCategories } from "@/lib/assistant";
import { guards } from "@/lib/guards";
import { loadLane } from "@/lib/lane-page";

const CATEGORY_LABEL: Record<string, string> = { email: "Email", calendar: "Calendar" };

export async function AssistantPage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const { client } = await (await guards()).requireLane(lane.laneId);
  const categories = await toolCategories(client as never, lane.laneId);
  // Only the categories this demo has tools for.
  const usable = categories.filter((c) => c in CATEGORY_LABEL).map((c) => CATEGORY_LABEL[c] as string);
  const configured = getLLMProvider().configured;
  // The setup interview needs no model: it is offered to an owner with the brain view even when the chat is not set up.
  const brainSetup = await brainSetupAvailable(await guards(), lane.laneId).catch(() => false);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="Assistant" accent="ask about your day" />
      {!configured ? (
        <Alert variant="alert">
          <AlertTitle>The assistant is not set up yet</AlertTitle>
          <AlertDescription>An administrator needs to finish the AI configuration for this portal.</AlertDescription>
        </Alert>
      ) : usable.length === 0 && !brainSetup ? (
        <Alert>
          <AlertTitle>Nothing the assistant can read here</AlertTitle>
          <AlertDescription>Your role or this company&apos;s policy does not allow the assistant to read mail or calendar.</AlertDescription>
        </Alert>
      ) : (
        <AssistantChat laneId={lane.laneId} sources={usable} brainSetup={brainSetup} />
      )}
      {(!configured || usable.length === 0) && brainSetup ? <BrainInterview laneId={lane.laneId} mode="chat" /> : null}
    </div>
  );
}
