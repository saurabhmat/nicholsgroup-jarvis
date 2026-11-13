"use client";
// "Disconnect QuickBooks" (T-197). Disconnecting tells Intuit to end the portal's access, so it is an approval (D-24, rule 5): this
// button only ASKS (propose_qbo_disconnect on the approvals route, owner or admin_technical at AAL2); someone then approves the
// exact request on the Approvals page with a fresh authenticator code. While one is waiting, a link replaces the button.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, Button } from "@nichols/ui";
import type { QuickBooksDisconnectView } from "@/lib/quickbooks-connection";

// Fixed client text by the server's error CODE (or the HTTP status); the server's own message string is never shown (T-197 review).
const BY_CODE: Record<string, string> = {
  disconnect_pending: "A disconnect is already waiting for approval for this QuickBooks company.",
  qbo_not_enabled: "Disconnecting QuickBooks isn't enabled for this company yet. Ask your administrator to allow it.",
  forbidden: "Only an owner or technical administrator can ask for this, with your authenticator code entered recently.",
  not_found: "That QuickBooks connection was not found. Reload the page.",
  invalid_request: "That did not work. Reload the page and try again.",
  unavailable: "Approvals are unavailable right now. Try again in a minute.",
};
const BY_STATUS: Record<number, string> = { 401: "You are signed out. Sign in again and retry.", 403: BY_CODE.forbidden as string, 404: BY_CODE.not_found as string };
const GENERIC = "That did not work. Reload the page and try again.";
export const disconnectErrorText = (status: number, code: unknown): string => (typeof code === "string" && Object.hasOwn(BY_CODE, code) ? (BY_CODE[code] as string) : (BY_STATUS[status] ?? GENERIC));

export function QuickBooksDisconnectButton({ laneId, connectionId, disconnect }: { laneId: string; connectionId: string; disconnect: QuickBooksDisconnectView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approvalsHref = `/${encodeURIComponent(laneId)}/approvals`;
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const pendingLink = useRef<HTMLAnchorElement>(null);
  const focusTrigger = useRef(false); // focus goes back to the trigger after the panel closes
  const focusPending = useRef(false); // ... or, after a successful ask, to the "waiting for approval" link once it is drawn

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open && focusTrigger.current) {
      focusTrigger.current = false;
      trigger.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (disconnect.pendingId && focusPending.current) {
      focusPending.current = false;
      pendingLink.current?.focus();
    }
  }, [disconnect.pendingId]);
  const close = () => {
    focusTrigger.current = true;
    setOpen(false);
  };

  if (disconnect.pendingId) {
    return (
      <div data-testid="qbo-disconnect-pending" className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">Disconnect waiting for approval</span>
        <a ref={pendingLink} href={approvalsHref} className="underline underline-offset-4">
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
        focusPending.current = true;
        setOpen(false);
        router.refresh(); // the row now shows "Disconnect waiting for approval"
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      setError(disconnectErrorText(res.status, data.error));
      if (data.error === "disconnect_pending") router.refresh(); // one is already waiting: show it
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
        Disconnect QuickBooks
      </Button>
    );
  }
  return (
    <div role="dialog" aria-modal="false" onKeyDown={(e) => { if (e.key === "Escape" && !busy) close(); }} aria-labelledby={`qbo-disc-${connectionId}`} data-testid="qbo-disconnect-confirm" className="flex max-w-md flex-col gap-3 rounded-card border border-border bg-card p-4 text-small text-card-foreground">
      <p ref={heading} tabIndex={-1} id={`qbo-disc-${connectionId}`} className="text-body font-medium text-foreground outline-none">
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
        <Button variant="ghost" onClick={close} disabled={busy}>
          Keep it connected
        </Button>
      </div>
    </div>
  );
}
