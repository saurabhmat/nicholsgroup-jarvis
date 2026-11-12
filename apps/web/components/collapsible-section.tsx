"use client";
// A titled card whose body is collapsed until the heading button is clicked (T-234 part 1: "Next 7 days" under Today's
// calendar). The body is rendered by the server and passed in; only the open state lives here, so a later refresh of the
// page data (part 5) keeps it as the user left it; with a persistId it is also kept in sessionStorage for a full reload. Content is hidden with the `hidden` attribute (out of the tab order).
import { useId, type ReactNode } from "react";
import { Card } from "@nichols/ui";
import { usePersistedOpen } from "./home-scope";

export function CollapsibleSection({ title, note, children, testId, persistId }: { title: string; note?: string; children: ReactNode; testId?: string; persistId?: string }) {
  const [open, setOpen] = usePersistedOpen(persistId);
  const bodyId = useId();
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-testid={testId} data-open={open ? "true" : "false"} className="min-w-0 gap-0">
      <h2 className="font-heading text-card-title font-semibold text-foreground">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center justify-between gap-2 text-left sm:min-h-0">
          <span id={titleId}>{title}</span>
          <span className="flex items-center gap-2 text-small font-normal text-muted-foreground">
            {note ? <span>{note}</span> : null}
            <span aria-hidden>{open ? "Hide" : "Show"}</span>
          </span>
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="mt-3">
        {children}
      </div>
    </Card>
  );
}
