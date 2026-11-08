"use client";
// Assistant chat UI (T-106 demo scope). Streams /api/lanes/:laneId/assistant (server-sent events). Answers are shown
// as plain text (React escapes everything); source chips link only to in-app paths. The conversation lives in this
// component's state and is gone on reload.
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, cn } from "@nichols/ui";

type Citation = { kind: string; label: string; url: string | null; asOf: string; freshness: "live" | "cached" | "stale" };
type Turn = {
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  citations?: Citation[];
  grounding?: { status: string; unverified: string[] };
  error?: string;
  pending?: boolean;
};

const TOOL_LABEL: Record<string, string> = { list_recent_mail: "Checking mail", list_meetings: "Checking the calendar" };
const ERRORS: Record<string, string> = {
  not_configured: "The assistant is not set up yet.",
  rate_limited: "The assistant is busy. Try again in a moment.",
  aborted: "Stopped.",
  unavailable: "Something went wrong. Try again.",
  invalid_request: "That message could not be sent.",
};
const SUGGESTIONS = ["What needs my attention today?", "What's on my calendar today?", "Any important email I haven't read?"];
const KIND_LABEL: Record<string, string> = { email: "Email", calendar: "Calendar" };
const AS_OF = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

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

const inApp = (u: string | null): u is string => typeof u === "string" && /^\/[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(u);

export function AssistantChat({ laneId, sources }: { laneId: string; sources: string[] }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

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
    // History sent as plain text only; failed answers are left out so turns keep alternating.
    const history = turns.filter((t) => !t.error && t.text).map((t) => ({ role: t.role, text: t.text.slice(0, 4000) }));
    const clean: { role: "user" | "assistant"; text: string }[] = [];
    for (const t of history) if (clean.length === 0 ? t.role === "user" : clean[clean.length - 1]?.role !== t.role) clean.push(t);
    if (clean[clean.length - 1]?.role === "user") clean.pop();
    const messages = [...clean.slice(-18), { role: "user" as const, text: question }];
    setTurns((all) => [...all, { role: "user", text: question }, { role: "assistant", text: "", tools: [], pending: true }]);
    setInput("");
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: messages[0]?.role === "user" ? messages : messages.slice(1) }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "unavailable";
        update((t) => ({ ...t, pending: false, error: ERRORS[code] ?? ERRORS.unavailable }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as { type: string; [k: string]: unknown };
          if (e.type === "text.delta") update((t) => ({ ...t, text: t.text + String(e.text) }));
          else if (e.type === "tool.start") update((t) => ({ ...t, tools: [...(t.tools ?? []), String(e.tool)] }));
          else if (e.type === "citations") update((t) => ({ ...t, citations: e.citations as Citation[] }));
          else if (e.type === "grounding") update((t) => ({ ...t, grounding: e.grounding as Turn["grounding"] }));
          else if (e.type === "error") update((t) => ({ ...t, error: ERRORS[String(e.code)] ?? ERRORS.unavailable }));
          else if (e.type === "message.done") update((t) => ({ ...t, pending: false }));
        }
      }
    } catch {
      update((t) => ({ ...t, error: ctl.signal.aborted ? ERRORS.aborted : ERRORS.unavailable }));
    } finally {
      update((t) => ({ ...t, pending: false }));
      setBusy(false);
      abort.current = null;
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="assistant-chat">
      <p className="text-sm text-muted-foreground">
        Reads {sources.join(" and ").toLowerCase()} for this company. It can explain and summarise; it cannot send, reply or change anything.
      </p>
      {turns.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void send(s)}
              className="rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <ol className="flex flex-col gap-4" aria-live="polite">
          {turns.map((t, i) => (
            <li key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
              {t.role === "user" ? (
                <div className="max-w-[85%] rounded-card bg-primary px-4 py-2 text-sm text-primary-foreground whitespace-pre-wrap">{t.text}</div>
              ) : (
                <div className="flex max-w-[95%] flex-col gap-2 rounded-card border border-border bg-card px-4 py-3 text-sm">
                  {t.pending && !t.text ? (
                    <p className="text-muted-foreground" data-testid="assistant-progress">
                      {t.tools?.length ? `${TOOL_LABEL[t.tools[t.tools.length - 1] ?? ""] ?? "Working"}…` : "Thinking…"}
                    </p>
                  ) : null}
                  {t.text ? (
                    <div className="whitespace-pre-wrap leading-relaxed text-foreground">
                      <Rich text={t.text} />
                    </div>
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
                      {t.citations.slice(0, 8).map((c, j) => {
                        const chip = (
                          <span className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-control border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{KIND_LABEL[c.kind] ?? c.kind}</span>
                            <span className="truncate">{c.label}</span>
                            <span>· {AS_OF.format(new Date(c.asOf))}</span>
                          </span>
                        );
                        return <li key={j}>{inApp(c.url) ? <Link href={c.url}>{chip}</Link> : chip}</li>;
                      })}
                    </ul>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={onSubmit} className="sticky bottom-0 flex gap-2 bg-background py-2">
        <label htmlFor="assistant-input" className="sr-only">
          Ask the assistant
        </label>
        <input
          id="assistant-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={4000}
          placeholder="Ask about your mail or calendar…"
          className="min-w-0 flex-1 rounded-control border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={busy}
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
        {turns.length > 0 && !busy ? (
          <Button type="button" variant="ghost" onClick={() => setTurns([])}>
            New chat
          </Button>
        ) : null}
      </form>
    </div>
  );
}
