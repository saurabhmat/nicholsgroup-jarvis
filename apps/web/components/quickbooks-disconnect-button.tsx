"use client";
// "Disconnect QuickBooks" (T-197). Disconnecting tells Intuit to end the portal's access, so it is an approval (D-24, rule 5): this
// button only ASKS (propose_qbo_disconnect on the approvals route, owner or admin_technical at AAL2); someone then approves the
// exact request on the Approvals page with a fresh authenticator code. While one is waiting, a link replaces the button.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Button } from "@nichols/ui";
import type { QuickBooksDisconnectView } from "@/lib/quickbooks-connection";

const MESSAGES: Record<number, string> = {
  401: "You are signed out. Sign in again and retry.",
  403: "Only an owner or technical administrator can ask for this, with your authenticator code entered recently.",
  404: "That QuickBooks connection was not found. Reload the page.",
};

export function QuickBooksDisconnectButton({ laneId, connectionId, disconnect }: { laneId: string; connectionId: string; disconnect: QuickBooksDisconnectView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvalsHref = `/${encodeURIComponent(laneId)}/approvals`;

  if (disconnect.pendingId) {
    return (
      <div data-testid="qbo-disconnect-pending" className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">Disconnect waiting for approval</span>
        <a href={approvalsHref} className="underline underline-offset-4">
          Open Approvals
        </a>
        {disconnect.gate && !disconnect.gate.enabled && disconnect.gate.message ? <span className="text-muted-foreground">{disconnect.gate.message}</span> : null}
      </div>
    );
  }

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose_qbo_disconnect", connectionId }),
      });
      if (res.ok) {
        setOpen(false);
        router.refresh(); // the row now shows "Disconnect waiting for approval"
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { message?: unknown };
      setError(typeof data.message === "string" ? data.message : (MESSAGES[res.status] ?? "That did not work. Reload the page and try again."));
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Disconnect QuickBooks
      </Button>
    );
  }
  return (
    <div role="dialog" aria-modal="false" aria-labelledby={`qbo-disc-${connectionId}`} data-testid="qbo-disconnect-confirm" className="flex max-w-md flex-col gap-3 rounded-card border border-border bg-card p-4 text-small text-card-foreground">
      <p id={`qbo-disc-${connectionId}`} className="text-body font-medium text-foreground">
        Disconnect QuickBooks?
      </p>
      <p>
        If it is approved, Jarvis tells QuickBooks to end its access, deletes the saved connection and stops syncing. Nothing inside
        QuickBooks is changed or deleted. Pressing the button below only asks: someone with the owner or technical administrator role
        then has to approve it on the Approvals page with a fresh authenticator code.
      </p>
      {disconnect.gate && !disconnect.gate.enabled && disconnect.gate.message ? <p className="text-muted-foreground">{disconnect.gate.message}</p> : null}
      {error ? (
        <Alert variant="alert" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={ask} disabled={busy}>
          {busy ? "Asking" : "Ask to disconnect"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Keep it connected
        </Button>
      </div>
    </div>
  );
}
