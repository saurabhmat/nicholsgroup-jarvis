"use client";
// "Test" for one Composio account (T-219): POSTs to the test route and shows only what it returns (a status and a time).
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle, Button } from "@nichols/ui";
import { describeComposioCheck, parseComposioCheck, type ComposioCheckResult } from "@/lib/composio-check-view";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "done"; result: ComposioCheckResult } | { kind: "failed" };

export function ComposioTestButton({ laneId, toolkit }: { laneId: string; toolkit: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "busy" });
    try {
      const res = await fetch(`/api/connect/composio/test?lane=${encodeURIComponent(laneId)}&toolkit=${encodeURIComponent(toolkit)}`, { method: "POST", cache: "no-store" });
      const result = res.ok ? parseComposioCheck(await res.json()) : null;
      setState(result ? { kind: "done", result } : { kind: "failed" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  const view = state.kind === "done" ? describeComposioCheck(state.result.status) : null;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="outline" onClick={run} disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "Testing" : "Test"}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {state.kind === "failed" ? (
          <Alert variant="alert" role="none">
            <AlertTitle>Could not test</AlertTitle>
            <AlertDescription>The test did not complete. Make sure you are signed in with your authenticator code, then try again.</AlertDescription>
          </Alert>
        ) : null}
        {state.kind === "done" && view ? (
          <Alert variant={view.variant} role="none">
            <AlertTitle>{view.title}</AlertTitle>
            <AlertDescription>
              {view.description} Checked at {new Date(state.result.checked_at).toLocaleTimeString()}.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
