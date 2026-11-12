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
// Unsent edits and the generated AI draft are kept in sessionStorage only when the company stores outbound drafts (rule 6, D-19).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, AlertDescription, AlertTitle, Badge, Button, cn } from "@nichols/ui";
import { callApprovals, errorText, invalidAddresses, splitAddresses, stepUpHref, type DraftResult, type ReplyContext } from "@/lib/reply-client";
import { flagRecipients } from "@/lib/reply-flags";
import { DRAFTS_OFF_MESSAGE, REPLY_MESSAGES, resultMessage, UNKNOWN_MESSAGE, type ReplyOutcome } from "@/lib/reply-messages";
import { holdRefresh } from "@/lib/refresh-gate";
import { aiDrafts, debounced, replyDrafts, type ReplyDraftFields } from "@/lib/reply-draft-store";
import { CapabilityMessage } from "./approval-card";
import { CopyTextButton } from "./copy-text-button";

const control =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const STALE_NOTE = "Your earlier unsaved edits were discarded because the draft changed.";
const WRITE_DELAY_MS = 500;

type Source = "restored" | "briefing" | "saved" | "ai" | "blank";
type Loaded =
  | { ok: false; message: string }
  | { ok: true; ctx: ReplyContext; fields: ReplyDraftFields; base: ReplyDraftFields; source: Source; awaiting: boolean; aiMessage: string | null; staleDiscarded: boolean };

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

const versionOf = (ctx: ReplyContext): string => ctx.proposal?.hash ?? "none";

/** Asks for the AI draft. A success is kept for 30 minutes (only when the company stores drafts). */
async function fetchDraft(laneId: string, ctx: ReplyContext): Promise<{ draft: DraftResult } | { message: string }> {
  const d = await callApprovals(laneId, { action: "draft_reply", messageId: ctx.messageId });
  const draft = d.status === 200 ? (d.data.draft as DraftResult | undefined) : undefined;
  if (draft && (draft.status === "ready" || draft.status === "awaiting_input")) {
    if (ctx.storesDrafts) aiDrafts.write(laneId, ctx.userId, ctx.messageId, { text: draft.status === "ready" ? draft.text : "", awaiting: draft.status === "awaiting_input" });
    return { draft };
  }
  return { message: errorText(d) };
}

async function doLoad(laneId: string, messageId: string): Promise<Loaded> {
  const r = await callApprovals(laneId, { action: "reply_context", messageId });
  const ctx = r.status === 200 ? (r.data.context as ReplyContext | undefined) : undefined;
  if (!ctx || typeof ctx !== "object") return { ok: false, message: errorText(r) };
  const blank = { to: ctx.defaults.to.join(", "), cc: ctx.defaults.cc.join(", "), body: "" };
  const fromProposal = ctx.proposal ? { to: ctx.proposal.to.join(", "), cc: ctx.proposal.cc.join(", "), body: ctx.proposal.bodyText } : null;
  const base = fromProposal ?? blank;
  // Unsent edits kept in this tab (a step-up or a reload) win, but only if they were made against the draft the server still has.
  let staleDiscarded = false;
  if (ctx.storesDrafts) {
    const stored = replyDrafts.read(laneId, ctx.userId, messageId);
    if (stored) {
      if (stored.serverVersion === versionOf(ctx)) return { ok: true, ctx, fields: { to: stored.to, cc: stored.cc, body: stored.body }, base, source: "restored", awaiting: false, aiMessage: null, staleDiscarded: false };
      replyDrafts.remove(laneId, ctx.userId, messageId);
      staleDiscarded = true;
    }
  } else {
    replyDrafts.remove(laneId, ctx.userId, messageId); // nothing is kept when the company does not store drafts
    aiDrafts.remove(laneId, ctx.userId, messageId);
  }
  if (fromProposal && ctx.proposal) {
    return { ok: true, ctx, fields: fromProposal, base, source: ctx.proposal.origin === "briefing" ? "briefing" : "saved", awaiting: false, aiMessage: null, staleDiscarded };
  }
  if (!ctx.aiAllowed || ctx.blocked) return { ok: true, ctx, fields: blank, base, source: "blank", awaiting: false, aiMessage: null, staleDiscarded };
  // The generated draft of the last 30 minutes is reused: reopening does not ask the AI again.
  const cached = ctx.storesDrafts ? aiDrafts.read(laneId, ctx.userId, messageId) : null;
  const got = cached ? { draft: { status: cached.awaiting ? ("awaiting_input" as const) : ("ready" as const), text: cached.text } } : await fetchDraft(laneId, ctx);
  if ("draft" in got) {
    const ready = got.draft.status === "ready";
    const fields = { ...blank, body: ready ? got.draft.text : "" };
    return { ok: true, ctx, fields, base: fields, source: ready ? "ai" : "blank", awaiting: !ready, aiMessage: null, staleDiscarded };
  }
  return { ok: true, ctx, fields: blank, base, source: "blank", awaiting: false, aiMessage: got.message, staleDiscarded };
}

const SOURCE_NOTE: Record<Source, string | null> = {
  restored: "Your unsent edits were restored.",
  briefing: "Draft prepared by the AI briefing. Read it before you send it.",
  saved: "Your saved draft.",
  ai: "Drafted by AI from the message. Read it and change anything before you send it.",
  blank: null,
};

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === (b[i] ?? "").toLowerCase());
const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an earlier date" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
};
const whenTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "soon" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function ReplyDrawer({ laneId, messageId, onClose }: { laneId: string; messageId: string; onClose: () => void }) {
  const router = useRouter();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState<ReplyDraftFields>({ to: "", cc: "", body: "" });
  const [info, setInfo] = useState<{ source: Source; awaiting: boolean; aiMessage: string | null; staleDiscarded: boolean }>({ source: "blank", awaiting: false, aiMessage: null, staleDiscarded: false });
  const [busy, setBusy] = useState<"save" | "send" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [result, setResult] = useState<{ outcome: ReplyOutcome; text: string } | null>(null);
  const [ask, setAsk] = useState<"send" | "save" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const sending = useRef(false);
  const working = useRef(false);
  const pendingRefresh = useRef(false);
  const refreshFn = useRef(router.refresh);
  // Where the local copy of the edits goes: set after the load (user id and version come from the server's context).
  const [target] = useState<{ current: { userId: string; version: string; keep: boolean } | null }>(() => ({ current: null }));
  const [writer] = useState(() =>
    debounced((f: ReplyDraftFields) => {
      const t = target.current;
      if (t?.keep) replyDrafts.write(laneId, t.userId, messageId, { ...f, serverVersion: t.version });
    }, WRITE_DELAY_MS),
  );

  useEffect(() => {
    let alive = true;
    void loadReply(laneId, messageId).then((l) => {
      if (!alive) return;
      setLoaded(l);
      if (l.ok) {
        target.current = { userId: l.ctx.userId, version: versionOf(l.ctx), keep: l.ctx.storesDrafts };
        setTo(l.fields.to);
        setCc(l.fields.cc);
        setBody(l.fields.body);
        setBase(l.base);
        setInfo({ source: l.source, awaiting: l.awaiting, aiMessage: l.aiMessage, staleDiscarded: l.staleDiscarded });
      }
    });
    return () => {
      alive = false;
    };
  }, [laneId, messageId, target]);

  // The Home auto-refresh stays paused while this drawer is open (T-234 part 5) and, separately, while a send is in progress.
  useEffect(() => holdRefresh("drawer"), []);
  const sendingNow = busy === "send";
  useEffect(() => (sendingNow ? holdRefresh("sending") : undefined), [sendingNow]);

  // Focus moves in, the page behind does not scroll (focus is returned by the trigger). Edits not yet written are flushed on close,
  // and a refresh that was held back while the drawer was open runs once it is gone.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      writer.flush();
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        refreshFn.current();
      }
    };
  }, [writer]);

  // After the load: the cursor goes to the message, or to To when there is no recipient yet.
  const ctxLoaded = loaded?.ok ? loaded.ctx : null;
  useEffect(() => {
    if (!ctxLoaded) return;
    const empty = splitAddresses(to).length === 0;
    (empty ? toRef.current : bodyRef.current)?.focus();
    // Only when the load completes (not on every keystroke).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxLoaded]);

  // A result (sent, failed, unknown) or a saved draft: focus goes to that message so a screen reader reads it and a keyboard user is not lost.
  useEffect(() => {
    if (result || saved) (resultRef.current ?? closeRef.current)?.focus();
  }, [result, saved]);

  const close = useCallback(() => {
    if (sending.current) return;
    if (pendingRefresh.current) {
      pendingRefresh.current = false;
      refreshFn.current();
    }
    onClose();
  }, [onClose]);
  const closeLatest = useRef(close);
  useEffect(() => {
    closeLatest.current = close;
    refreshFn.current = router.refresh;
  });

  // Esc and the Tab trap live on the document while the drawer is open (focus may be on the body after a button turns off).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLatest.current(); // ignored while a send is in progress
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
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Autosave of unsent edits: only what the owner changed, written 500 ms after the last keystroke, and never when the company does not store drafts.
  const edit = (field: keyof ReplyDraftFields, value: string) => {
    const next = { to, cc, body, [field]: value };
    if (field === "to") setTo(value);
    else if (field === "cc") setCc(value);
    else setBody(value);
    setSaved(null);
    writer.call(next);
  };

  const dropLocalCopy = () => {
    writer.cancel();
    const t = target.current;
    if (t) replyDrafts.remove(laneId, t.userId, messageId);
  };

  function discardEdits() {
    dropLocalCopy();
    setTo(base.to);
    setCc(base.cc);
    setBody(base.body);
    setError(null);
    const source: Source = ctx?.proposal ? (ctx.proposal.origin === "briefing" ? "briefing" : "saved") : base.body === "" ? "blank" : "ai";
    setInfo((i) => ({ ...i, source, staleDiscarded: false }));
  }

  const ctx = loaded?.ok ? loaded.ctx : null;
  const toList = splitAddresses(to);
  const ccList = splitAddresses(cc);
  const flags = ctx ? flagRecipients({ to: toList, cc: ccList, bcc: ctx.proposal?.bcc ?? [] }, ctx.internalDomains) : [];
  const finished = result !== null && result.outcome !== "failed";
  const refused = ctx ? (!ctx.storesDrafts ? DRAFTS_OFF_MESSAGE : ctx.blocked ? REPLY_MESSAGES.check_sent_first : null) : null;
  const saveDisabled = !ctx || busy !== null || refused !== null || finished;
  const sendDisabled = saveDisabled || !ctx.send.enabled;
  // The same banner as the approval card: the recipients came from the email unless the owner changed them (recomputed as To changes).
  const fromEmail = ctx ? (ctx.proposal ? ctx.proposal.derivedFromRetrieved && sameList(toList, ctx.proposal.to) : toList.length > 0 && sameList(toList, ctx.defaults.to)) : false;
  const dirty = to !== base.to || cc !== base.cc || body !== base.body;
  const canDraftAgain = !!ctx && ctx.aiAllowed && !ctx.proposal && !ctx.blocked && !finished && (info.source === "ai" || info.awaiting || info.aiMessage !== null);

  function invalid(): string | null {
    if (toList.length === 0) return "Add at least one recipient in To.";
    const bad = invalidAddresses([...toList, ...ccList]);
    if (bad.length > 0) return "One of the addresses is not valid. Check To and Cc.";
    if (body.trim() === "") return "Write the reply first.";
    return null;
  }

  async function persist(confirmResend: boolean): Promise<{ id: string; hash: string } | null> {
    const r = await callApprovals(laneId, { action: "propose_reply", messageId, to: toList, cc: ccList, bodyText: body, ...(confirmResend ? { confirmResend: true } : {}) });
    if (r.status === 200 && typeof r.data.id === "string" && typeof r.data.hash === "string") {
      if (target.current) target.current.version = r.data.hash; // later edits are made against this version
      return { id: r.data.id, hash: r.data.hash };
    }
    setError(errorText(r));
    return null;
  }

  function requestSave() {
    if (ctx?.alreadySent && !confirmed) return setAsk("save");
    void saveDraft(confirmed);
  }
  function requestSend() {
    if (ctx?.alreadySent && !confirmed) return setAsk("send");
    void send(confirmed);
  }

  async function saveDraft(confirmResend: boolean) {
    if (working.current) return;
    const bad = invalid();
    if (bad) return setError(bad);
    working.current = true;
    setBusy("save");
    setError(null);
    try {
      const p = await persist(confirmResend);
      if (!p) return;
      dropLocalCopy(); // the server holds it now
      setBase({ to, cc, body });
      setSaved(p.id);
      pendingRefresh.current = true; // re-read the page once the drawer is closed, so this message is never unmounted
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  async function send(confirmResend: boolean) {
    if (sending.current || working.current) return;
    const bad = invalid();
    if (bad) return setError(bad);
    sending.current = true;
    working.current = true;
    setBusy("send");
    setError(null);
    try {
      // 1. The exact edited text becomes the proposal (a new version if it changed, the same one if not): its hash is what is approved.
      const p = await persist(confirmResend);
      if (!p) return;
      // 2. Approve that hash and carry it out once.
      const a = await callApprovals(laneId, { action: "approve", id: p.id, hashSeen: p.hash });
      if (a.status === 403 && a.data.error === "step_up_required") {
        // The server already holds exactly this text; the local copy matches that version.
        writer.cancel();
        if (target.current?.keep) replyDrafts.write(laneId, target.current.userId, messageId, { to, cc, body, serverVersion: p.hash });
        router.push(stepUpHref(laneId, messageId));
        return;
      }
      if (a.status === 200 && (a.data.outcome === "sent" || a.data.outcome === "failed" || a.data.outcome === "unknown")) {
        const outcome = a.data.outcome;
        setResult({ outcome, text: resultMessage(outcome, typeof a.data.failureCode === "string" ? a.data.failureCode : null) });
        if (outcome !== "failed") dropLocalCopy();
        pendingRefresh.current = true;
        return;
      }
      // No answer (network, a timeout) or a server error: the request may have reached Gmail. Never a blind retry.
      if (a.status === 0 || a.status >= 500) {
        setResult({ outcome: "unknown", text: UNKNOWN_MESSAGE });
        dropLocalCopy();
        pendingRefresh.current = true;
        return;
      }
      setError(errorText(a));
    } finally {
      sending.current = false;
      working.current = false;
      setBusy(null);
    }
  }

  async function draftAgain() {
    if (!ctx || working.current) return;
    working.current = true;
    setBusy("draft");
    setError(null);
    try {
      const got = await fetchDraft(laneId, ctx);
      if ("draft" in got) {
        const ready = got.draft.status === "ready";
        setBody(ready ? got.draft.text : "");
        setBase((b) => ({ ...b, body: ready ? got.draft.text : "" }));
        setInfo((i) => ({ ...i, source: ready ? "ai" : "blank", awaiting: !ready, aiMessage: null }));
      } else {
        setInfo((i) => ({ ...i, aiMessage: got.message }));
      }
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  const note = loaded?.ok ? SOURCE_NOTE[info.source] : null;
  // One persistent live region: its text changes, so a screen reader announces each step (errors have their own role=alert).
  const live = result
    ? result.text
    : saved
      ? "Draft saved in Approvals."
      : busy === "send"
        ? "Sending."
        : busy === "save"
          ? "Saving the draft."
          : busy === "draft"
            ? "Drafting a reply."
            : loaded === null
              ? "Loading the message."
              : loaded.ok
                ? "The reply is ready to edit."
                : "";

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
        className="absolute inset-0 flex flex-col bg-background text-foreground shadow-card md:left-auto md:right-0 md:w-[480px] md:max-w-full md:border-l md:border-border"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-card-title font-semibold">
            Reply
          </h2>
          <Button ref={closeRef} variant="ghost" size="sm" onClick={close} disabled={busy === "send"} aria-label="Close reply">
            Close
          </Button>
        </header>
        <div data-testid="reply-live" role="status" aria-live="polite" className="sr-only">
          {live}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          {loaded === null ? (
            <p className="text-body text-muted-foreground">Loading the message...</p>
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
              {ctx.alreadySent ? (
                <Alert variant="alert" role="note" data-testid="reply-already-sent">
                  <AlertTitle>You already replied to this conversation on {when(ctx.alreadySent.at)}</AlertTitle>
                  <AlertDescription>Sending again needs a second click to confirm.</AlertDescription>
                </Alert>
              ) : null}
              {ctx.proposal ? (
                <p data-testid="reply-proposal-meta" className="text-small text-muted-foreground">
                  Version {ctx.proposal.hash.slice(0, 8)} · Expires {whenTime(ctx.proposal.expiresAt)}
                </p>
              ) : null}
              {note ? (
                <p data-testid="reply-source-note" className="text-small text-muted-foreground">
                  {note}
                </p>
              ) : null}
              {info.staleDiscarded ? (
                <p data-testid="reply-stale-note" className="text-small text-alert-foreground">
                  {STALE_NOTE}
                </p>
              ) : null}
              {info.awaiting ? (
                <p data-testid="reply-awaiting" className="text-small font-medium text-alert-foreground">
                  Awaiting your input: the draft needed a figure or date that is not in the message, so it is left for you to write.
                </p>
              ) : null}
              {info.aiMessage ? (
                <p data-testid="reply-ai-message" className="text-small text-muted-foreground">
                  {info.aiMessage}
                </p>
              ) : null}
              {canDraftAgain ? (
                <div>
                  <Button variant="outline" size="sm" data-testid="reply-draft-again" disabled={busy !== null} onClick={() => void draftAgain()}>
                    {busy === "draft" ? "Drafting..." : "Draft again"}
                  </Button>
                </div>
              ) : null}
              {ctx.proposal?.rationale ? (
                <p className="text-small text-muted-foreground">
                  <span className="font-medium text-foreground">Assistant&apos;s note (not verified):</span> {ctx.proposal.rationale}
                </p>
              ) : null}
              <div className="grid gap-3">
                <label className="grid gap-1 text-small font-medium text-foreground" htmlFor={`${titleId}-to`}>
                  To
                  <input id={`${titleId}-to`} ref={toRef} data-testid="reply-to" className={control} value={to} onChange={(e) => edit("to", e.target.value)} disabled={finished} inputMode="email" autoComplete="off" />
                </label>
                {fromEmail ? (
                  <Alert variant="alert" role="note" data-testid="reply-derived-banner">
                    <AlertTitle>Recipients came from an email</AlertTitle>
                    <AlertDescription>Check the recipients before sending. Text inside an email never approves anything.</AlertDescription>
                  </Alert>
                ) : null}
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
                  <textarea id={`${titleId}-body`} ref={bodyRef} data-testid="reply-body" className={cn(control, "min-h-48 font-mono")} rows={10} value={body} onChange={(e) => edit("body", e.target.value)} disabled={finished} maxLength={100000} />
                </label>
                {dirty && !finished ? (
                  <div>
                    <Button variant="ghost" size="sm" data-testid="reply-discard" onClick={discardEdits} disabled={busy !== null}>
                      Discard my edits
                    </Button>
                  </div>
                ) : null}
              </div>
              {!ctx.send.enabled && ctx.send.message ? (
                <p data-testid="send-disabled-reason" className="text-small text-alert-foreground">
                  <CapabilityMessage message={ctx.send.message} href={ctx.send.settingsHref} />
                </p>
              ) : null}
              {refused ? (
                <p data-testid="reply-refused" className="text-small text-alert-foreground">
                  {refused}
                </p>
              ) : null}
              {ask ? (
                <Alert variant="alert" role="note" data-testid="reply-confirm-resend">
                  <AlertTitle>You already replied to this conversation</AlertTitle>
                  <AlertDescription>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        data-testid="reply-confirm-resend-button"
                        onClick={() => {
                          const what = ask;
                          setAsk(null);
                          setConfirmed(true);
                          if (what === "send") void send(true);
                          else void saveDraft(true);
                        }}
                      >
                        {ask === "send" ? "Send another reply" : "Save another reply"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setAsk(null)}>
                        Cancel
                      </Button>
                    </span>
                  </AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <Alert variant="alert" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {result ? (
                <p ref={resultRef} tabIndex={-1} data-testid="reply-result" data-outcome={result.outcome} className={cn("text-small font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", result.outcome === "sent" ? "text-success" : "text-alert-foreground")}>
                  {result.text}
                </p>
              ) : null}
              {saved ? (
                <p ref={resultRef} tabIndex={-1} data-testid="reply-saved" className="text-small text-success outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
            <Button data-testid="reply-send" disabled={sendDisabled} onClick={requestSend}>
              {busy === "send" ? "Sending..." : "Send"}
            </Button>
            <Button variant="outline" data-testid="reply-save" disabled={saveDisabled} onClick={requestSave}>
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
