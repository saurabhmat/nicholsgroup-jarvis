"use client";
// "Disconnect" for one of YOUR Microsoft accounts (T-257, D-55). Local only: it deletes what the portal stored and tells Microsoft nothing. A confirm
// step first; then POST to the disconnect route (owner only, AAL2, checked on the server) and back to Settings with a fixed result text. The text
// shown for an error is chosen here by the HTTP status, never taken from the server's reply.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert, AlertDescription, Button } from "@nichols/ui";

const BY_STATUS: Record<number, string> = {
  401: "You are signed out. Sign in again and retry.",
  403: "Only the person who connected this account can disconnect it, with your authenticator code entered recently.",
  404: "That account was not found. Reload the page.",
};
const GENERIC = "That did not work. Reload the page and try again.";
export const microsoftDisconnectErrorText = (status: number): string => BY_STATUS[status] ?? GENERIC;

export function MicrosoftDisconnectButton({ laneId, connectionId, mailbox }: { laneId: string; connectionId: string; mailbox: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/connections/${encodeURIComponent(connectionId)}/disconnect`, { method: "POST" });
      if (res.ok) {
        router.replace(`/${encodeURIComponent(laneId)}/settings?connect=disconnected&provider=microsoft`);
        router.refresh();
        return;
      }
      setError(microsoftDisconnectErrorText(res.status));
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button ref={trigger} variant="outline" aria-label={`Disconnect ${mailbox}`} onClick={() => setOpen(true)}>
        Disconnect
      </Button>
    );
  }
  return (
    <div role="dialog" aria-modal="false" aria-label={`Disconnect ${mailbox}?`} data-testid="microsoft-disconnect-confirm" onKeyDown={(e) => { if (e.key === "Escape" && !busy) setOpen(false); }} className="flex max-w-md flex-col gap-3 rounded-card border border-border bg-card p-4 text-small text-card-foreground">
      <p className="text-body font-medium text-foreground">Disconnect this Microsoft account?</p>
      <p>
        The portal deletes the access it saved and stops syncing this account. Nothing is sent to Microsoft, so Microsoft may still list the app: you or your Microsoft 365 administrator can remove the app&apos;s access in your Microsoft account or in the
        Entra admin center (Enterprise apps → the app → Permissions). You can connect the account again later.
      </p>
      {error ? (
        <Alert variant="alert" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void confirm()} disabled={busy}>
          {busy ? "Disconnecting" : "Disconnect"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Keep it connected
        </Button>
      </div>
    </div>
  );
}
