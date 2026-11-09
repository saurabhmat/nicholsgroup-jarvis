"use client";
// Assistant chat UI (T-106 demo scope). Streams /api/lanes/:laneId/assistant (server-sent events). Answers are shown
// as React text with **bold** only (never HTML); source chips link only to in-app paths and are not prefetched. The
// conversation lives in this component's state and is gone on reload. Pure logic: lib/assistant-client.ts (tested).
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, cn, FreshnessBadge } from "@nichols/ui";
import { asOfLabel, buildMessages, createSseParser, groupCitations, isInAppPath, type Citation } from "@/lib/assistant-client";
import { isInterviewRequest } from "@/lib/brain-interview-client";
import { BrainInterview } from "@/components/brain-interview";

type Turn = {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  citations?: Citation[];
  grounding?: { status: string; unverified: string[] };
  error?: string;
  pending?: boolean;
  /** An in-app link shown under the text (the import request, T-220). */
  link?: { href: string; label: string };
};

const TOOL_LABEL: Record<string, string> = { list_recent_mail: "Checking mail", list_meetings: "Checking the calendar" };
const ERRORS: Record<string, string> = {
  not_configured: "The assistant is not set up yet.",
  rate_limited: "Too many questions in a minute. Try again shortly.",
  forbidden: "The assistant is not available for your role here.",
  session: "Your session has expired. Reload the page and sign in again.",
  too_long: "This conversation is too long. Start a new chat.",
  aborted: "Stopped.",
  cut_off: "The answer was cut off. Try again.",
  unavailable: "Something went wrong. Try again.",
  invalid_request: "That message could not be sent.",
};
const SUGGESTIONS = ["What needs my attention today?", "What's on my calendar today?", "Any important email I haven't read?"];
const KIND_LABEL: Record<string, string> = { email: "Email", calendar: "Calendar" };

/** Plain text with **bold** only: React elements, never HTML, so nothing in the answer can inject markup. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const IMPORT_INTRO = "You can bring in what Claude or ChatGPT already knows about you. You choose what to keep, and nothing is saved until you tick it and click Save.";

const INTERVIEW_INTRO = "Let's set up your brain. I'll ask a few questions at a time and show you the exact change before anything is saved.";

export function AssistantChat({ laneId, sources, brainSetup = false }: { laneId: string; sources: string[]; brainSetup?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  // The setup interview runs in this thread (T-216). It is not a model call: the questions come from the question bank.
  const [interview, setInterview] = useState<"setup" | "assistant" | null>(null);
  const [interviewKey, setInterviewKey] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest answer in view while it streams.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns]);

  const update = (fn: (t: Turn) => Turn) =>
    setTurns((all) => {
      const copy = [...all];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") copy[copy.length - 1] = fn(last);
      return copy;
    });

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const kind = brainSetup ? isInterviewRequest(question) : null;
    if (kind === "import") {
      // Answered with a link, not a model call (T-220).
      setTurns((all) => [...all, { role: "user", text: question }, { role: "assistant", text: IMPORT_INTRO, link: { href: `/${encodeURIComponent(laneId)}/onboarding/import`, label: "Import memories" } }]);
      setInput("");
      return;
    }
    if (kind) {
      setTurns((all) => [...all, { role: "user", text: question }, { role: "assistant", text: INTERVIEW_INTRO }]);
      setInput("");
      setInterview(kind);
      setInterviewKey((k) => k + 1); // remount, so a second request restarts from the saved state
      return;
    }
    const messages = buildMessages(turns, question);
    setTurns((all) => [...all, { role: "user", text: question }, { role: "assistant", text: "", tools: [], pending: true }]);
    setInput("");
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    let finished = false;
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const code = res.status === 401 ? "session" : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "unavailable";
        update((t) => ({ ...t, error: ERRORS[code] ?? ERRORS.unavailable }));
        finished = true;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      const apply = (e: { type: string; [k: string]: unknown }) => {
        if (e.type === "text.delta") update((t) => ({ ...t, text: t.text + String(e.text) }));
        else if (e.type === "tool.start") update((t) => ({ ...t, tools: [...(t.tools ?? []), String(e.tool)] }));
        else if (e.type === "citations") update((t) => ({ ...t, citations: e.citations as Citation[] }));
        else if (e.type === "grounding") update((t) => ({ ...t, grounding: e.grounding as Turn["grounding"] }));
        else if (e.type === "error") {
          finished = true;
          update((t) => ({ ...t, error: ERRORS[String(e.code)] ?? ERRORS.unavailable }));
        } else if (e.type === "message.done") {
          finished = true;
          update((t) => ({ ...t, pending: false }));
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true })).forEach(apply);
      }
      parser.push(decoder.decode()).forEach(apply);
      parser.end().forEach(apply);
      if (!finished) update((t) => ({ ...t, error: ERRORS.cut_off }));
    } catch {
      if (!finished) update((t) => ({ ...t, error: ctl.signal.aborted ? ERRORS.aborted : ERRORS.unavailable }));
    } finally {
      update((t) => ({ ...t, pending: false }));
      setBusy(false);
      abort.current = null;
      inputRef.current?.focus();
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const now = new Date();

  return (
    <div className="flex flex-col gap-4" data-testid="assistant-chat">
      <div className="flex items-start justify-between gap-3">
        <p className="text-body text-muted-foreground">
          Reads {sources.join(" and ").toLowerCase()} for this company. It can explain and summarise; it cannot send, reply or change anything.
        </p>
        {(turns.length > 0 || interview) && !busy ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => (setTurns([]), setInterview(null))}>
            New chat
          </Button>
        ) : null}
      </div>
      {turns.length === 0 && !interview ? (
        <div className="flex flex-wrap gap-2">
          {brainSetup
            ? (["setup", "assistant"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => void send(k === "setup" ? "Set up my brain" : "Set up my Personal Assistant")}
                  className="rounded-full border border-primary bg-primary-tint px-4 py-2 text-body text-foreground transition-colors hover:bg-muted"
                >
                  {k === "setup" ? "Set up my brain" : "Set up my Personal Assistant"}
                </button>
              ))
            : null}
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void send(s)}
              className="rounded-full border border-border bg-card px-4 py-2 text-body text-foreground transition-colors hover:bg-muted"
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <ol className="flex flex-col gap-4">
          {turns.map((t, i) => (
            <li key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
              {t.role === "user" ? (
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-card bg-primary px-4 py-2 text-body text-primary-foreground">{t.text}</div>
              ) : (
                <div className="flex w-full max-w-[95%] flex-col gap-2 rounded-card border border-border bg-card px-4 py-3 text-body">
                  {t.pending && !t.text ? (
                    <p className="text-muted-foreground" data-testid="assistant-progress" aria-live="polite">
                      {t.tools?.length ? `${TOOL_LABEL[t.tools[t.tools.length - 1] ?? ""] ?? "Working"}…` : "Thinking…"}
                    </p>
                  ) : null}
                  {t.text ? (
                    <div className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
                      <Rich text={t.text} />
                    </div>
                  ) : null}
                  {t.link ? (
                    <Link href={t.link.href} prefetch={false} className="inline-flex min-h-11 w-fit items-center rounded-control bg-primary px-4 text-body font-medium text-primary-foreground">
                      {t.link.label}
                    </Link>
                  ) : null}
                  {t.error ? (
                    <Alert variant="alert">
                      <AlertDescription>{t.error}</AlertDescription>
                    </Alert>
                  ) : null}
                  {t.grounding?.status === "failed" ? (
                    <Badge variant="alert" className="self-start">
                      Unverified figure: {t.grounding.unverified.join(", ")}
                    </Badge>
                  ) : null}
                  {t.citations?.length ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label="Sources">
                      {groupCitations(t.citations).map((c, j) => {
                        const chip = (
                          <span className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-border bg-background px-2 py-1 text-small text-muted-foreground">
                            <span className="font-medium text-foreground">{KIND_LABEL[c.kind] ?? c.kind}</span>
                            <span className="max-w-48 truncate">{c.label}</span>
                            {c.more ? null : (
                              <>
                                <span>· {asOfLabel(c.asOf, now)}</span>
                                <FreshnessBadge freshness={c.freshness} className="text-[10px]" />
                              </>
                            )}
                          </span>
                        );
                        return (
                          <li key={j} className="max-w-full">
                            {isInAppPath(c.url) ? (
                              <Link href={c.url} prefetch={false}>
                                {chip}
                              </Link>
                            ) : (
                              chip
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {interview ? <BrainInterview key={interviewKey} laneId={laneId} mode="chat" startAt={interview} /> : null}
      <div ref={endRef} />
      <form onSubmit={onSubmit} className="sticky bottom-0 flex gap-2 bg-background py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <label htmlFor="assistant-input" className="sr-only">
          Ask the assistant
        </label>
        <input
          id="assistant-input"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={4000}
          enterKeyHint="send"
          placeholder="Ask about your mail or calendar…"
          className="min-w-0 flex-1 rounded-control border border-border bg-card px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-body"
          readOnly={busy}
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            Ask
          </Button>
        )}
      </form>
    </div>
  );
}
