"use client";
// "Disconnect" for YOUR Teams account (T-280, spec 5). Local only: it deletes what the portal stored and tells Microsoft nothing; the text says to remove the app at Microsoft. A confirm
// step first; then POST to the Teams disconnect route (owner only, AAL2, checked on the server) and back to Settings with a fixed result text. The text shown for an error is chosen
// here by the HTTP status, never taken from the server's reply.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, Button } from "@nichols/ui";
import { teamsDisconnectErrorText } from "@/lib/teams-disconnect-text";
import { TEAMS_REMOVE_ACCESS_TEXT } from "@/lib/teams-wording";

export function TeamsDisconnectButton({ laneId, connectionId, account }: { laneId: string; connectionId: string; account: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (open) heading.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);
  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/connections/${encodeURIComponent(connectionId)}/disconnect-teams`, { method: "POST" });
      if (res.ok) {
        router.replace(`/${encodeURIComponent(laneId)}/settings?connect=disconnected&provider=microsoft_teams`);
        router.refresh();
        return;
      }
      setError(teamsDisconnectErrorText(res.status));
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button ref={trigger} variant="outline" aria-label={`Disconnect ${account}`} onClick={() => setOpen(true)}>
        Disconnect
      </Button>
    );
  }
  return (
    <div role="dialog" aria-modal="false" aria-label={`Disconnect ${account}?`} data-testid="teams-disconnect-confirm" onKeyDown={(e) => { if (e.key === "Escape" && !busy) close(); }} className="flex max-w-md flex-col gap-3 rounded-card border border-border bg-card p-4 text-small text-card-foreground">
      <p ref={heading} tabIndex={-1} className="text-body font-medium text-foreground outline-none">
        Disconnect this Teams account?
      </p>
      <p>{TEAMS_REMOVE_ACCESS_TEXT} You can connect the account again later.</p>
      {error ? (
        <Alert variant="alert" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void confirm()} disabled={busy}>
          {busy ? "Disconnecting" : "Disconnect"}
        </Button>
        <Button variant="ghost" onClick={close} disabled={busy}>
          Keep it connected
        </Button>
      </div>
    </div>
  );
}
