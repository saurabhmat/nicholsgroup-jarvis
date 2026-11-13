"use client";
// One QuickBooks disconnect waiting for approval (T-195, D-24). Disconnecting is an external write (we tell Intuit to revoke our
// access), so it waits here like an email: the card says exactly what will happen and for which company (its QuickBooks realm
// id; no company name is stored in the proposal), who asked, and then it is approved with a fresh authenticator code or rejected.
// Nothing is edited (there is no content). The approve button is off, with the reason, while the lane policy does not allow it
// or approvals are not live.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, Badge, Button } from "@nichols/ui";
import type { DisconnectCard } from "@/lib/approvals";

const control =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export function DisconnectApprovalCard({ laneId, card, canAct }: { laneId: string; card: DisconnectCard; canAct: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const url = `/api/lanes/${encodeURIComponent(laneId)}/approvals`;

  type Resp = { status: number; data: Record<string, unknown> };
  async function call(payload: Record<string, unknown>): Promise<Resp> {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  }
  const fail = (data: Record<string, unknown>) => setError(typeof data.message === "string" ? data.message : "That did not work. Reload the page and try again.");

  async function approve() {
    setBusy("approve");
    setError(null);
    const { status, data } = await call({ action: "approve", id: card.id, hashSeen: card.hash }).catch((): Resp => ({ status: 0, data: {} }));
    setBusy(null);
    if (status === 403 && data.error === "step_up_required") {
      router.push(`/mfa?reauth=1&next=${encodeURIComponent(`/${laneId}/approvals`)}`);
      return;
    }
    if (status === 200) {
      setDone(
        data.outcome === "disconnected"
          ? "QuickBooks was disconnected and checked. Reconnect it in Settings when you are ready."
          : data.outcome === "unknown"
            ? "It may have gone through, but it could not be confirmed. Check Settings before asking again."
            : "It could not be completed. QuickBooks is still connected; you can ask again.",
      );
      return router.refresh();
    }
    if (status === 409 && data.error === "hash_mismatch") router.refresh();
    fail(data);
  }
  async function reject() {
    setBusy("reject");
    setError(null);
    const { status, data } = await call({ action: "reject", id: card.id, reason }).catch((): Resp => ({ status: 0, data: {} }));
    setBusy(null);
    if (status === 200) return router.refresh();
    fail(data);
  }

  const cap = card.capability;
  const approveDisabled = !canAct || !cap.enabled || busy !== null;
  const id = `d-${card.id}`;

  return (
    <article id={`action-${card.id}`} data-testid="disconnect-card" aria-label="Disconnect QuickBooks" className="flex flex-col gap-4 rounded-card border border-border bg-card p-5 text-card-foreground shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="alert">Disconnect QuickBooks</Badge>
        <p className="text-small text-muted-foreground">
          Expires {WHEN.format(new Date(card.expiresAt))} · <span className="font-mono" title="Short fingerprint of exactly what you are approving">#{card.shortHash}</span>
        </p>
      </div>
      <div className="grid gap-2 text-body text-foreground">
        <p data-testid="disconnect-company" className="font-medium">
          QuickBooks company ID <span className="font-mono">{card.realmId}</span>
        </p>
        <p>
          If you approve, Jarvis tells QuickBooks to end its access to this company and deletes the saved connection. Jarvis stops
          reading this company&apos;s figures until someone reconnects it in Settings. Nothing inside QuickBooks is changed or deleted.
        </p>
        <p className="text-small text-muted-foreground">{card.proposedByYou ? "Asked for by you." : "Asked for by another administrator of this company."}</p>
      </div>
      {!cap.enabled && cap.message ? (
        <p data-testid="approve-disabled-reason" role="status" className="text-small text-alert-foreground">
          {cap.message}
        </p>
      ) : null}
      {error ? (
        <Alert variant="alert" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {done ? <p role="status" className="text-small text-success">{done}</p> : null}
      {canAct ? (
        rejecting ? (
          <div className="grid gap-2">
            <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${id}-reason`}>
              Why are you rejecting this?
              <input id={`${id}-reason`} className={control} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="max-md:w-full" disabled={busy !== null || reason.trim() === ""} onClick={reject}>
                Reject
              </Button>
              <Button variant="ghost" className="max-md:w-full" onClick={() => setRejecting(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button disabled={approveDisabled} onClick={approve} data-testid="approve">
              {busy === "approve" ? "Working..." : "Approve and disconnect"}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        )
      ) : (
        <p className="text-small text-muted-foreground">Only an owner or administrator can approve or reject this.</p>
      )}
    </article>
  );
}
