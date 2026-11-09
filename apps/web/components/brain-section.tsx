// Settings -> AI brain (T-226): a compact status list of the bank's sections (status chip and Edit, which opens the guided
// wizard at that step) and a "Continue setup" button. The full interview lives on /<lane>/onboarding. Read-only: the data is
// the same state the interview API returns; shown only to an owner with the brain view (the wizard page checks again).
import Link from "next/link";
import { Badge, buttonVariants, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from "@nichols/ui";
import type { OnboardingView } from "@/lib/onboarding";

export function BrainSection({ laneId, view }: { laneId: string; view: OnboardingView }) {
  const base = `/${encodeURIComponent(laneId)}/onboarding`;
  return (
    <section id="ai-brain" aria-labelledby="ai-brain-title" className="scroll-mt-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="ai-brain-title">
            AI brain
          </CardTitle>
          <CardDescription>
            What Jarvis knows about you, your companies and how you like things done.{" "}
            {view.done === null ? "The status could not be read just now." : `${String(view.done)} of ${String(view.total)} sections done.`} You always see the exact change before it is saved.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border" data-testid="brain-status-list">
            {view.sections.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 break-words font-medium text-foreground">{s.title}</span>
                {view.done === null ? null : <Badge variant={s.done ? "success" : "muted"}>{s.done ? "Done" : "Not done"}</Badge>}
                <Link href={`${base}?step=${encodeURIComponent(s.id)}`} prefetch={false} className="inline-flex min-h-11 items-center px-2 text-primary underline underline-offset-2">
                  Edit<span className="sr-only"> {s.title}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div>
            <Link href={base} prefetch={false} className={cn(buttonVariants(), "min-h-11 w-full sm:w-auto")}>
              Continue setup
            </Link>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
