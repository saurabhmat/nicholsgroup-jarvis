"use client";
// The setup-interview entry on the Assistant page when the chat model is NOT configured (H-042 fix). The interview is
// driven by the question bank, not the model, so it stays available; this gives it the same "Set up my brain" /
// "Set up my Personal Assistant" entry the chat shows, instead of opening the interview unasked.
import { useState } from "react";
import { Button } from "@nichols/ui";
import { BrainInterview } from "@/components/brain-interview";

const ENTRIES = [
  { kind: "setup", label: "Set up my brain" },
  { kind: "assistant", label: "Set up my Personal Assistant" },
] as const;

export function BrainSetupEntry({ laneId }: { laneId: string }) {
  const [start, setStart] = useState<{ kind: "setup" | "assistant"; key: number } | null>(null);
  return (
    <div className="flex flex-col gap-4" data-testid="brain-setup-entry">
      <div className="flex flex-wrap gap-2">
        {ENTRIES.map((e) => (
          <button
            key={e.kind}
            type="button"
            onClick={() => setStart((s) => ({ kind: e.kind, key: (s?.key ?? 0) + 1 }))}
            className="min-h-11 rounded-full border border-primary bg-primary-tint px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
            aria-pressed={start?.kind === e.kind}
          >
            {e.label}
          </button>
        ))}
        {start ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setStart(null)}>
            Close
          </Button>
        ) : null}
      </div>
      {/* Remount per click, so a second request restarts from the saved state (same as the chat). */}
      {start ? <BrainInterview key={start.key} laneId={laneId} mode="chat" startAt={start.kind} /> : null}
    </div>
  );
}
