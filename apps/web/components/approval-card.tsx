"use client";
// One email waiting for approval (T-232). Shows exactly what will go out and from which address ("Sends as ..."), lets the
// owner edit recipients, subject and text (plain text; Save changes makes a NEW proposal and the old one is withdrawn),
// then approve it, or reject it. Approve needs a fresh authenticator code: when the server answers step_up_required the
// page sends the owner to /mfa?reauth=1 and back. The approve button is disabled, with the reason, while the mailbox cannot
// send or approvals are not live, and while there are unsaved edits (what you approve is exactly what is saved).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, cn } from "@nichols/ui";
import type { PendingCard } from "@/lib/approvals";

const control =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

const splitList = (s: string): string[] => s.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x !== "");
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** The capability message with its trailing "Settings" as the link (the text itself is the exact message). */
export function CapabilityMessage({ message, href }: { message: string; href: string | null }) {
  if (href && message.endsWith("Settings")) {
    return (
      <>
        {message.slice(0, -"Settings".length)}
        <Link href={href} className="underline">
          Settings
        </Link>
      </>
    );
  }
  return <>{message}</>;
}

export function ApprovalCard({ laneId, card, canAct }: { laneId: string; card: PendingCard; canAct: boolean }) {
  const router = useRouter();
  const [to, setTo] = useState(card.to.join(", "));
  const [cc, setCc] = useState(card.cc.join(", "));
  const [bcc, setBcc] = useState(card.bcc.join(", "));
  const [subject, setSubject] = useState(card.subject);
  const [body, setBody] = useState(card.bodyText);
  const [busy, setBusy] = useState<"save" | "approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const dirty =
    JSON.stringify(splitList(to)) !== JSON.stringify(card.to) ||
    JSON.stringify(splitList(cc)) !== JSON.stringify(card.cc) ||
    JSON.stringify(splitList(bcc)) !== JSON.stringify(card.bcc) ||
    subject !== card.subject ||
    body !== card.bodyText;
  const isSend = card.actionType === "email.send";
  const url = `/api/lanes/${encodeURIComponent(laneId)}/approvals`;

  type Resp = { status: number; data: Record<string, unknown> };
  async function call(payload: Record<string, unknown>): Promise<Resp> {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  }
  const fail = (data: Record<string, unknown>) => setError(typeof data.message === "string" ? data.message : "That did not work. Reload the page and try again.");

  async function save() {
    setBusy("save");
    setError(null);
    const { status, data } = await call({ action: "save", id: card.id, to: splitList(to), cc: splitList(cc), bcc: splitList(bcc), subject, bodyText: body }).catch((): Resp => ({ status: 0, data: {} }));
    setBusy(null);
    if (status === 200) return router.refresh();
    fail(data);
  }
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
      setDone(data.status === "verified" ? (isSend ? "Sent and checked in the mailbox." : "Saved as a Gmail draft and checked.") : data.status === "failed" ? "It could not be completed. Check the mailbox before trying again." : "Already being carried out.");
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
  const approveDisabled = !canAct || !cap.enabled || dirty || busy !== null;
  const label = isSend ? "Approve & send" : "Save as Gmail draft";
  const id = `a-${card.id}`;

  return (
    <article data-testid="approval-card" aria-label={card.subject} className="flex flex-col gap-4 rounded-card border border-border bg-card p-5 text-card-foreground shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isSend ? "default" : "secondary"}>{isSend ? "Email to send" : "Gmail draft"}</Badge>
          {card.replyThread ? <Badge variant="muted">Reply</Badge> : null}
        </div>
        <p className="text-small text-muted-foreground">
          Expires {WHEN.format(new Date(card.expiresAt))} · <span className="font-mono" title="Short fingerprint of exactly what you are approving">#{card.shortHash}</span>
        </p>
      </div>
      <p data-testid="sends-as" className="text-body font-medium text-foreground">
        Sends as {card.mailbox}
      </p>
      {card.derivedFromRetrieved ? (
        <Alert variant="alert">
          <AlertTitle>Recipients came from an email</AlertTitle>
          <AlertDescription>Check the recipients before approving. Text inside an email never approves anything.</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3">
        <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${id}-to`}>
          To
          <input id={`${id}-to`} className={control} value={to} onChange={(e) => setTo(e.target.value)} disabled={!canAct} inputMode="email" autoComplete="off" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${id}-cc`}>
            Cc
            <input id={`${id}-cc`} className={control} value={cc} onChange={(e) => setCc(e.target.value)} disabled={!canAct} autoComplete="off" />
          </label>
          <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${id}-bcc`}>
            Bcc
            <input id={`${id}-bcc`} className={control} value={bcc} onChange={(e) => setBcc(e.target.value)} disabled={!canAct} autoComplete="off" />
          </label>
        </div>
        <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${id}-subject`}>
          Subject
          <input id={`${id}-subject`} className={control} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canAct} maxLength={998} />
        </label>
        <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${id}-body`}>
          Message (plain text)
          <textarea id={`${id}-body`} className={cn(control, "min-h-40 font-mono")} rows={8} value={body} onChange={(e) => setBody(e.target.value)} disabled={!canAct} maxLength={100000} />
        </label>
      </div>
      {card.rationale ? (
        <p className="text-small text-muted-foreground">
          <span className="font-medium text-foreground">Assistant&apos;s note (not verified):</span> {card.rationale}
        </p>
      ) : null}
      {!cap.enabled && cap.message ? (
        <p data-testid="approve-disabled-reason" role="status" className="text-small text-alert-foreground">
          <CapabilityMessage message={cap.message} href={cap.settingsHref} />
        </p>
      ) : null}
      {dirty && canAct ? <p className="text-small text-muted-foreground">Save your changes first: you approve exactly what is saved.</p> : null}
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
              {busy === "approve" ? "Working..." : label}
            </Button>
            <Button variant="outline" disabled={!dirty || busy !== null} onClick={save} data-testid="save-changes">
              {busy === "save" ? "Saving..." : "Save changes"}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        )
      ) : (
        <p className="text-small text-muted-foreground">Only the owner can approve or change this.</p>
      )}
    </article>
  );
}
