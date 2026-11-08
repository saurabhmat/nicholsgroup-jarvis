// Settings -> AI brain (T-216): the fallback for the chat setup interview (spec §7). Same flow, same checks, same Save
// button; shown only to an owner with the brain view (the route checks again). The full page viewer, editor and history
// are a later task (T-2xx); this section is the setup and reconfigure entry.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@nichols/ui";
import { BrainInterview } from "@/components/brain-interview";

export function BrainSection({ laneId }: { laneId: string }) {
  return (
    <section id="ai-brain" aria-labelledby="ai-brain-title" className="scroll-mt-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ai-brain-title">
            AI brain
          </CardTitle>
          <CardDescription>
            Tell Jarvis about you, your companies and how you like things done, and set up your Personal Assistant. The same questions are available in the assistant chat. You always see the exact change before it is saved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BrainInterview laneId={laneId} mode="page" />
        </CardContent>
      </Card>
    </section>
  );
}
