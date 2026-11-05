"use client";
// "Check connection" (T-198): POSTs to the check route and shows only what it returns: a status, the time and Intuit's
// request id. Tokens, the company id and company data are never on this page.
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle, Button } from "@nichols/ui";
import { describeCheck, parseCheckResult, type CheckResult } from "@/lib/connection-check-view";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "done"; result: CheckResult } | { kind: "failed" };

export function ConnectionCheckButton({ laneId }: { laneId: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "busy" });
    try {
      const res = await fetch(`/api/connection-test/qbo/check?lane=${encodeURIComponent(laneId)}`, { method: "POST", cache: "no-store" });
      const result = res.ok ? parseCheckResult(await res.json()) : null;
      setState(result ? { kind: "done", result } : { kind: "failed" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  const view = state.kind === "done" ? describeCheck(state.result.status) : null;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button variant="outline" onClick={run} disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "Checking" : "Check connection"}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {state.kind === "failed" ? (
          <Alert variant="alert" role="none">
            <AlertTitle>Could not check</AlertTitle>
            <AlertDescription>The check did not complete. Make sure you are signed in with your authenticator code, then try again.</AlertDescription>
          </Alert>
        ) : null}
        {state.kind === "done" && view ? (
          <Alert variant={view.variant} role="none">
            <AlertTitle>{view.title}</AlertTitle>
            <AlertDescription>
              {view.description} Checked at {new Date(state.result.checked_at).toLocaleTimeString()}.
              {state.result.intuit_tid ? ` Intuit request id: ${state.result.intuit_tid}.` : ""}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
