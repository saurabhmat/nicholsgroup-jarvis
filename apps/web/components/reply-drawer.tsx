"use client";
// The Reply drawer (T-234 part 3): opened from "Reply" on a Needs-your-attention item. A right-hand drawer (about 480 px) on a
// desktop, a full-screen sheet below the md breakpoint. It shows the thread preview (plain text, untrusted, read live, never
// stored), the AI draft (the T-231d draft if one is pending, otherwise drafted on demand), editable To, Cc and Body, the fixed
// subject "Re: ..." and "Sends as <mailbox>". Everything about the thread, subject and mailbox comes from the server's
// metadata; this component sends the message id and the three editable fields, nothing else.
//   Send       = the approval: save the exact edited text as the email.send proposal, approve that hash (a fresh authenticator
//              code is needed: the fields are kept in sessionStorage across the step-up), the server sends it once and reads it back.
//   Save draft keeps it in Approvals for later.   Copy always works.
// While sending is not enabled (or the company does not store drafts) the buttons are off with the exact message.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Alert, AlertDescription, Badge, Button, cn } from "@nichols/ui";
import { callApprovals, errorText, invalidAddresses, splitAddresses, stepUpHref, type DraftResult, type ReplyContext } from "@/lib/reply-client";
import { flagRecipients } from "@/lib/reply-flags";
import { DRAFTS_OFF_MESSAGE, REPLY_MESSAGES, resultMessage, UNKNOWN_MESSAGE, type ReplyOutcome } from "@/lib/reply-messages";
import { clearReplyDraft, loadReplyDraft, saveReplyDraft, type ReplyDraftFields } from "@/lib/reply-draft-store";
import { CapabilityMessage } from "./approval-card";
import { CopyTextButton } from "./copy-text-button";

const control =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Source = "restored" | "briefing" | "saved" | "ai" | "blank";
type Loaded =
  | { ok: false; message: string }
  | { ok: true; ctx: ReplyContext; fields: ReplyDraftFields; source: Source; awaiting: boolean; aiMessage: string | null };

// One load per message at a time, so a double effect run (React strict mode) never asks the AI twice.
const loading = new Map<string, Promise<Loaded>>();

function loadReply(laneId: string, messageId: string): Promise<Loaded> {
  const k = `${laneId}:${messageId}`;
  let p = loading.get(k);
  if (!p) {
    p = doLoad(laneId, messageId).finally(() => loading.delete(k));
    loading.set(k, p);
  }
  return p;
}

async function doLoad(laneId: string, messageId: string): Promise<Loaded> {
  const r = await callApprovals(laneId, { action: "reply_context", messageId });
  const ctx = r.status === 200 ? (r.data.context as ReplyContext | undefined) : undefined;
  if (!ctx || typeof ctx !== "object") return { ok: false, message: errorText(r) };
  // Unsent edits kept in this tab (a step-up or a reload) win over everything else.
  const stored = loadReplyDraft(laneId, messageId);
  if (stored) return { ok: true, ctx, fields: stored, source: "restored", awaiting: false, aiMessage: null };
  if (ctx.proposal) {
    return { ok: true, ctx, fields: { to: ctx.proposal.to.join(", "), cc: ctx.proposal.cc.join(", "), body: ctx.proposal.bodyText }, source: ctx.proposal.origin === "briefing" ? "briefing" : "saved", awaiting: false, aiMessage: null };
  }
  const blank = { to: ctx.defaults.to.join(", "), cc: ctx.defaults.cc.join(", "), body: "" };
  if (!ctx.aiAllowed || ctx.blocked) return { ok: true, ctx, fields: blank, source: "blank", awaiting: false, aiMessage: null };
  // No proposal and no stored edits: draft on demand (never stored; the owner saves or sends it).
  const d = await callApprovals(laneId, { action: "draft_reply", messageId });
  const draft = d.status === 200 ? (d.data.draft as DraftResult | undefined) : undefined;
  if (draft && (draft.status === "ready" || draft.status === "awaiting_input")) {
    return { ok: true, ctx, fields: { ...blank, body: draft.status === "ready" ? draft.text : "" }, source: draft.status === "ready" ? "ai" : "blank", awaiting: draft.status === "awaiting_input", aiMessage: null };
  }
  return { ok: true, ctx, fields: blank, source: "blank", awaiting: false, aiMessage: errorText(d) };
}

const SOURCE_NOTE: Record<Source, string | null> = {
  restored: "Your unsent edits were restored.",
  briefing: "Draft prepared by the AI briefing. Read it before you send it.",
  saved: "Your saved draft.",
  ai: "Drafted by AI from the message. Read it and change anything before you send it.",
  blank: null,
};

export function ReplyDrawer({ laneId, messageId, onClose }: { laneId: string; messageId: string; onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: ReplyOutcome; text: string } | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    let alive = true;
    void loadReply(laneId, messageId).then((l) => {
      if (!alive) return;
      setLoaded(l);
      if (l.ok) {
        setTo(l.fields.to);
        setCc(l.fields.cc);
        setBody(l.fields.body);
      }
    });
    return () => {
      alive = false;
    };
  }, [laneId, messageId]);

  // Focus moves in, the page behind does not scroll, and focus is trapped while the dialog is open (returned by the trigger).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const close = useCallback(() => {
    if (!sending.current) onClose();
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  // Autosave of unsent edits (per message, sessionStorage): only what the owner changed, so an untouched AI draft is not "restored".
  const edit = (field: keyof ReplyDraftFields, value: string) => {
    const next = { to, cc, body, [field]: value };
    if (field === "to") setTo(value);
    else if (field === "cc") setCc(value);
    else setBody(value);
    setSaved(null);
    saveReplyDraft(laneId, messageId, next);
  };

  const ctx = loaded?.ok ? loaded.ctx : null;
  const toList = splitAddresses(to);
  const ccList = splitAddresses(cc);
  const flags = ctx ? flagRecipients({ to: toList, cc: ccList, bcc: ctx.proposal?.bcc ?? [] }, ctx.internalDomains) : [];
  const finished = result !== null && result.outcome !== "failed";
  const refused = ctx ? (!ctx.storesDrafts ? DRAFTS_OFF_MESSAGE : ctx.blocked ? REPLY_MESSAGES.check_sent_first : null) : null;
  const saveDisabled = !ctx || busy !== null || refused !== null || finished;
  const sendDisabled = saveDisabled || !ctx.send.enabled;

  function invalid(): string | null {
    if (toList.length === 0) return "Add at least one recipient in To.";
    const bad = invalidAddresses([...toList, ...ccList]);
    if (bad.length > 0) return "One of the addresses is not valid. Check To and Cc.";
    if (body.trim() === "") return "Write the reply first.";
    return null;
  }

  async function persist(): Promise<{ id: string; hash: string } | null> {
    const r = await callApprovals(laneId, { action: "propose_reply", messageId, to: toList, cc: ccList, bodyText: body });
    if (r.status === 200 && typeof r.data.id === "string" && typeof r.data.hash === "string") return { id: r.data.id, hash: r.data.hash };
    setError(errorText(r));
    return null;
  }

  async function saveDraft() {
    const bad = invalid();
    if (bad) return setError(bad);
    setBusy("save");
    setError(null);
    const p = await persist();
    setBusy(null);
    if (!p) return;
    clearReplyDraft(laneId, messageId); // the server holds it now
    setSaved(p.id);
    router.refresh();
  }

  async function send() {
    if (sending.current) return;
    const bad = invalid();
    if (bad) return setError(bad);
    sending.current = true;
    setBusy("send");
    setError(null);
    try {
      // 1. The exact edited text becomes the proposal (a new version if it changed, the same one if not): its hash is what is approved.
      const p = await persist();
      if (!p) return;
      // 2. Approve that hash and carry it out once.
      const a = await callApprovals(laneId, { action: "approve", id: p.id, hashSeen: p.hash });
      if (a.status === 403 && a.data.error === "step_up_required") {
        saveReplyDraft(laneId, messageId, { to, cc, body });
        router.push(stepUpHref(laneId, messageId));
        return;
      }
      if (a.status === 200 && (a.data.outcome === "sent" || a.data.outcome === "failed" || a.data.outcome === "unknown")) {
        const outcome = a.data.outcome;
        setResult({ outcome, text: resultMessage(outcome, typeof a.data.failureCode === "string" ? a.data.failureCode : null) });
        if (outcome === "sent") clearReplyDraft(laneId, messageId);
        router.refresh();
        return;
      }
      // No answer (network, a timeout) or a server error: the request may have reached Gmail. Never a blind retry.
      if (a.status === 0 || a.status >= 500) {
        setResult({ outcome: "unknown", text: UNKNOWN_MESSAGE });
        return;
      }
      setError(errorText(a));
    } finally {
      sending.current = false;
      setBusy(null);
    }
  }

  const note = loaded?.ok ? SOURCE_NOTE[loaded.source] : null;

  const node = (
    <div className="fixed inset-0 z-50" data-testid="reply-overlay">
      <div aria-hidden className="absolute inset-0 bg-foreground/40" onClick={close} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy !== null || loaded === null}
        data-testid="reply-drawer"
        onKeyDown={onKeyDown}
        className="absolute inset-0 flex flex-col bg-background text-foreground shadow-card md:left-auto md:right-0 md:w-[480px] md:max-w-full md:border-l md:border-border"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-card-title font-semibold">
            Reply
          </h2>
          <Button variant="ghost" size="sm" onClick={close} disabled={busy === "send"} aria-label="Close reply">
            Close
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {loaded === null ? (
            <p role="status" className="text-body text-muted-foreground">
              Loading the message...
            </p>
          ) : !loaded.ok ? (
            <Alert variant="alert" role="alert">
              <AlertDescription>{loaded.message}</AlertDescription>
            </Alert>
          ) : ctx ? (
            <>
              <section aria-label="Message you are replying to" className="flex flex-col gap-1">
                <p className="text-small font-medium text-muted-foreground">Replying to {ctx.replyingTo}</p>
                {ctx.preview ? (
                  <>
                    <pre data-testid="reply-preview" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-card p-3 font-sans text-small text-foreground">
                      {ctx.preview.text}
                    </pre>
                    {ctx.preview.truncated ? <p className="text-small text-muted-foreground">Only the start of the message is shown. Open the thread to read all of it.</p> : null}
                  </>
                ) : (
                  <p data-testid="reply-preview-missing" className="text-small text-muted-foreground">
                    The message could not be shown right now.
                  </p>
                )}
              </section>
              <p data-testid="sends-as" className="text-body font-medium text-foreground">
                Sends as {ctx.mailbox}
              </p>
              {note ? (
                <p data-testid="reply-source-note" className="text-small text-muted-foreground">
                  {note}
                </p>
              ) : null}
              {loaded.awaiting ? (
                <p data-testid="reply-awaiting" role="status" className="text-small font-medium text-alert-foreground">
                  Awaiting your input: the draft needed a figure or date that is not in the message, so it is left for you to write.
                </p>
              ) : null}
              {loaded.aiMessage ? (
                <p data-testid="reply-ai-message" role="status" className="text-small text-muted-foreground">
                  {loaded.aiMessage}
                </p>
              ) : null}
              {ctx.proposal?.rationale ? (
                <p className="text-small text-muted-foreground">
                  <span className="font-medium text-foreground">Assistant&apos;s note (not verified):</span> {ctx.proposal.rationale}
                </p>
              ) : null}
              <div className="grid gap-3">
                <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${titleId}-to`}>
                  To
                  <input id={`${titleId}-to`} data-testid="reply-to" className={control} value={to} onChange={(e) => edit("to", e.target.value)} disabled={finished} inputMode="email" autoComplete="off" />
                </label>
                <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${titleId}-cc`}>
                  Cc
                  <input id={`${titleId}-cc`} data-testid="reply-cc" className={control} value={cc} onChange={(e) => edit("cc", e.target.value)} disabled={finished} autoComplete="off" />
                </label>
                {ctx.proposal && ctx.proposal.bcc.length > 0 ? <p className="text-small text-muted-foreground">Hidden copy (Bcc): {ctx.proposal.bcc.join(", ")}</p> : null}
                {flags.length > 0 ? (
                  <ul data-testid="recipient-flags" aria-label="Recipients to check" className="flex flex-col gap-1 text-small">
                    {flags.map((f) => (
                      <li key={`${f.field}:${f.address}`} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words font-medium text-foreground">{f.address}</span>
                        {f.flags.includes("external") ? <Badge variant="alert">Outside your company</Badge> : null}
                        {f.flags.includes("bcc") ? <Badge variant="alert">Hidden copy (Bcc)</Badge> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${titleId}-subject`}>
                  Subject
                  <input id={`${titleId}-subject`} data-testid="reply-subject" className={control} value={ctx.subject} readOnly aria-describedby={`${titleId}-subject-note`} />
                  <span id={`${titleId}-subject-note`} className="text-small font-normal text-muted-foreground">
                    A reply keeps its subject so it stays in the same conversation.
                  </span>
                </label>
                <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${titleId}-body`}>
                  Message (plain text)
                  <textarea id={`${titleId}-body`} data-testid="reply-body" className={cn(control, "min-h-48 font-mono")} rows={10} value={body} onChange={(e) => edit("body", e.target.value)} disabled={finished} maxLength={100000} />
                </label>
              </div>
              {!ctx.send.enabled && ctx.send.message ? (
                <p data-testid="send-disabled-reason" role="status" className="text-small text-alert-foreground">
                  <CapabilityMessage message={ctx.send.message} href={ctx.send.settingsHref} />
                </p>
              ) : null}
              {refused ? (
                <p data-testid="reply-refused" role="status" className="text-small text-alert-foreground">
                  {refused}
                </p>
              ) : null}
              {error ? (
                <Alert variant="alert" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {result ? (
                <p data-testid="reply-result" data-outcome={result.outcome} role="status" className={cn("text-small font-medium", result.outcome === "sent" ? "text-success" : "text-alert-foreground")}>
                  {result.text}
                </p>
              ) : null}
              {saved ? (
                <p data-testid="reply-saved" role="status" className="text-small text-success">
                  Saved. It is waiting in{" "}
                  <Link href={`/${laneId}/approvals#action-${saved}`} className="underline">
                    Approvals
                  </Link>
                  .
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        {ctx ? (
          <footer className="flex flex-col gap-2 border-t border-border bg-background px-4 py-3 md:flex-row md:flex-wrap md:items-center">
            <Button data-testid="reply-send" disabled={sendDisabled} onClick={() => void send()}>
              {busy === "send" ? "Sending..." : "Send"}
            </Button>
            <Button variant="outline" data-testid="reply-save" disabled={saveDisabled} onClick={() => void saveDraft()}>
              {busy === "save" ? "Saving..." : "Save draft"}
            </Button>
            <CopyTextButton text={body} />
          </footer>
        ) : null}
      </div>
    </div>
  );
  return createPortal(node, document.body);
}
