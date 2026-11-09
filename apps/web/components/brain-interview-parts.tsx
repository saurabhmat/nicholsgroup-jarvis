// Shared pieces of the setup interview (T-216, T-226): the field controls, the diff card and one question block, used by the
// chat/page flow (brain-interview.tsx) and the guided wizard (brain-wizard.tsx). All text is rendered as React text.
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle, Badge, Button, cn } from "@nichols/ui";
import type { FieldView, QuestionView, GroupView } from "@nichols/brain/interview";
import type { InterviewState, Proposal } from "@nichols/brain/server";
import type { FormValues } from "@/lib/brain-interview-client";

export const control =
  "min-h-11 w-full min-w-0 rounded-control border border-border bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm";
export const tap = "min-h-11 w-full sm:w-auto";

const NOTE_LABEL = { connected: "Connected", not_connected: "Not connected yet", unknown: "Connection unknown" } as const;
export const REASON_TEXT: Record<string, string> = {
  lane_policy: "not allowed in this company",
  role: "not allowed for your role",
  drafts_not_stored: "drafts are not stored in this company",
  unknown_type: "not allowed",
};
export const ACTION_TEXT: Record<string, string> = { "email.save_draft": "save a draft reply (after you approve it)", "email.send": "send email (after you approve it)", "calendar.event": "change calendar events (after you approve)", "monday.item": "update monday items (after you approve)", "notion.page": "update Notion pages (after you approve)" };

export function Field({ f, q, value, set, values, state }: { f: FieldView; q: QuestionView; value: unknown; set: (v: unknown) => void; values: FormValues; state: InterviewState }) {
  const id = `iv-${q.id}-${f.key}`;
  const label = (
    <label htmlFor={id} className="text-sm font-medium text-foreground">
      {f.label}
    </label>
  );
  switch (f.kind) {
    case "text":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} className={control} value={String(value ?? "")} maxLength={f.max} onChange={(e) => set(e.target.value)} />
        </div>
      );
    case "longtext":
    case "list":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <textarea id={id} className={cn(control, "min-h-24")} rows={3} value={String(value ?? "")} maxLength={f.max} onChange={(e) => set(e.target.value)} />
        </div>
      );
    case "time":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} type="time" className={control} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
        </div>
      );
    case "number":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <input id={id} type="number" inputMode="numeric" className={control} min={f.min} max={f.max} value={String(value ?? "")} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} />
        </div>
      );
    case "boolean":
      return (
        <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm text-foreground">
          <input id={id} type="checkbox" className="size-5" checked={value === true} onChange={(e) => set(e.target.checked)} />
          {f.label}
        </label>
      );
    case "select":
      return (
        <div className="flex flex-col gap-1">
          {label}
          <select id={id} className={control} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
            {f.required && value === "" ? <option value="">Choose…</option> : null}
            {(f.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "multiselect": {
      if (q.id === "B7" && f.key === "kpis" && values[q.id]?.show !== "pick") return null;
      const chosen = new Set(Array.isArray(value) ? (value as string[]) : []);
      const options = f.options ?? [];
      if (options.length === 0) return <p className="text-sm text-muted-foreground">{f.label}: nothing to pick for this company.</p>;
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-foreground">{f.label}</legend>
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const on = chosen.has(o.value);
              return (
                <label key={o.value} className={cn("inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border px-3 text-sm", on ? "border-primary bg-primary-tint text-foreground" : "border-border bg-card text-muted-foreground")}>
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={on}
                    onChange={() => {
                      const next = new Set(chosen);
                      if (on) next.delete(o.value);
                      else next.add(o.value);
                      set(options.filter((x) => next.has(x.value)).map((x) => x.value));
                    }}
                  />
                  {o.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      );
    }
    case "mailbox_order": {
      const options = f.options ?? [];
      const picked = Array.isArray(value) ? (value as string[]) : [];
      const move = (i: number, d: number) => {
        const next = [...picked];
        const [x] = next.splice(i, 1);
        next.splice(i + d, 0, x as string);
        set(next);
      };
      const byValue = new Map(options.map((o) => [o.value, o]));
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-foreground">{f.label}</p>
          {options.length === 0 ? (
            <Alert>
              <AlertDescription>
                No mailbox is set up for this company yet.{" "}
                <Link href={state.sources.find((s) => s.laneId === state.currentLane)?.settingsPath ?? "/"} prefetch={false} className="underline">
                  Open Settings → Connections
                </Link>
                .
              </AlertDescription>
            </Alert>
          ) : null}
          <ol className="flex flex-col gap-2" aria-label="Chosen mailboxes">
            {picked.map((v, i) => {
              const o = byValue.get(v);
              return (
                <li key={v} className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-card px-3 py-2 text-sm">
                  <span className="font-medium">{i + 1}.</span>
                  <span className="min-w-0 flex-1 break-all">{o?.label ?? v}</span>
                  {o?.note ? <Badge variant={o.note === "connected" ? "success" : "muted"}>{NOTE_LABEL[o.note]}</Badge> : null}
                  <Button size="sm" variant="outline" className="min-h-11" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${o?.label ?? v} up`}>
                    Up
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-11" disabled={i === picked.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${o?.label ?? v} down`}>
                    Down
                  </Button>
                  <Button size="sm" variant="ghost" className="min-h-11" onClick={() => set(picked.filter((x) => x !== v))} aria-label={`Remove ${o?.label ?? v}`}>
                    Remove
                  </Button>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-col gap-2">
            {options
              .filter((o) => !picked.includes(o.value))
              .map((o) => (
                <button key={o.value} type="button" onClick={() => set([...picked, o.value])} className="flex min-h-11 flex-wrap items-center gap-2 rounded-control border border-dashed border-border px-3 py-2 text-left text-sm text-foreground hover:bg-muted">
                  <span className="min-w-0 flex-1 break-all">Add {o.label}</span>
                  {o.note ? <Badge variant={o.note === "connected" ? "success" : "muted"}>{NOTE_LABEL[o.note]}</Badge> : null}
                </button>
              ))}
          </div>
        </div>
      );
    }
    case "mailbox_text": {
      const b2 = values.B2?.mailboxes;
      const picked = Array.isArray(b2) ? (b2 as string[]) : [];
      const map = (typeof value === "object" && value !== null ? value : {}) as Record<string, string>;
      if (picked.length === 0) return <p className="text-sm text-muted-foreground">Pick a mailbox above first, then say what counts as important in it.</p>;
      const byValue = new Map((state.groups.flatMap((g) => g.questions).find((x) => x.id === "B2")?.fields[0]?.options ?? []).map((o) => [o.value, o.label]));
      return (
        <div className="flex flex-col gap-3">
          {picked.map((v) => (
            <div key={v} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${v}`} className="text-sm font-medium text-foreground break-all">
                {byValue.get(v) ?? v}
              </label>
              <textarea id={`${id}-${v}`} className={cn(control, "min-h-20")} rows={2} maxLength={2000} value={map[v] ?? ""} onChange={(e) => set({ ...map, [v]: e.target.value })} />
            </div>
          ))}
        </div>
      );
    }
  }
}

export function DiffCard({ proposal }: { proposal: Proposal }) {
  return (
    <div className="flex flex-col gap-3" data-testid="interview-diff">
      {proposal.changes.map((c, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-card border border-border bg-background p-3">
          <p className="text-sm font-medium text-foreground">
            {c.kind === "document" ? `${c.path} (${c.lane})` : `${c.name}, Personal Assistant profile (${c.lane}), stays ${c.status}`}
          </p>
          {c.kind === "employee" && c.resetsInvalid ? (
            <Alert variant="alert" data-testid="interview-reset-warning">
              <AlertTitle>The stored assistant profile is not valid</AlertTitle>
              <AlertDescription>Saving replaces its settings with the ones below, starting from the defaults. Check them before you save.</AlertDescription>
            </Alert>
          ) : null}
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-control bg-card p-2 text-xs leading-relaxed">
            {c.diff.map((l, j) => (
              <span key={j} className={cn("block", l.type === "add" && "bg-success-surface text-foreground", l.type === "del" && "bg-alert-surface text-alert-foreground line-through")}>
                {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
                {l.text}
              </span>
            ))}
          </pre>
          {c.kind === "employee" && c.settings.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Settings that change">
              {c.settings.map((s) => (
                <li key={s.path} className="break-words">
                  <span className="font-medium text-foreground">{s.path}</span>: {s.before} → {s.after}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The notices that belong above a group's questions: a mailbox that is not connected (B2) and the per-company hint (A5). */
export function GroupNotices({ group, state }: { group: GroupView; state: InterviewState }) {
  const missing = state.sources.filter((s) => s.noMailboxes || s.mailboxes.some((m) => m.state === "not_connected"));
  return (
    <>
      {group.questions.some((q) => q.id === "B2") && missing.length > 0 ? (
        <Alert data-testid="interview-missing-source">
          <AlertTitle>A mailbox is not connected yet</AlertTitle>
          <AlertDescription>
            {missing.map((s) => (
              <span key={s.laneId} className="block">
                {s.noMailboxes ? `${s.laneName} has no mailbox set up.` : `${s.laneName}: ${s.mailboxes.filter((m) => m.state === "not_connected").map((m) => m.address).join(", ")} not connected.`}{" "}
                <Link href={s.settingsPath} prefetch={false} className="underline">
                  Open Settings → Connections
                </Link>
              </span>
            ))}
            You can still choose a mailbox now; it is read once it is connected. Connecting is done only in Settings.
          </AlertDescription>
        </Alert>
      ) : null}
      {group.questions.some((q) => q.id === "A5") && state.sources.length > 1 ? (
        <p className="text-xs text-muted-foreground" data-testid="interview-other-companies">
          This covers {state.sources.find((s) => s.laneId === state.currentLane)?.laneName ?? "this company"} only. Open the assistant in each other company to answer these for it too.
        </p>
      ) : null}
    </>
  );
}

/** One question: skipped note, "Already set: …" with Edit, or its prompt, hint and fields. */
export function QuestionBlock({
  q,
  state,
  values,
  editing,
  onEdit,
  onChange,
}: {
  q: QuestionView;
  state: InterviewState;
  values: FormValues;
  editing: Set<string>;
  onEdit: (id: string) => void;
  onChange: (qid: string, key: string, v: unknown) => void;
}) {
  if (q.status === "skipped")
    return (
      <p className="text-sm text-muted-foreground" data-testid={`q-${q.id}-skipped`}>
        Skipped: {q.prompt}{" "}
        {q.skipReason === "no_finance" ? "(no finance view in this company)" : q.skipReason === "no_web" ? "(outside news is not allowed here)" : q.skipReason === "no_drafts" ? "(reply drafts are not allowed here)" : ""}
      </p>
    );
  if (q.status === "known" && !editing.has(q.id))
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-control border border-border bg-background p-3 text-sm" data-testid={`q-${q.id}-known`}>
        <span className="min-w-0 flex-1 break-words">
          <span className="block font-medium text-foreground">{q.prompt}</span>
          <span className="text-muted-foreground">Already set: {q.known}</span>
        </span>
        <Button size="sm" variant="outline" className="min-h-11" onClick={() => onEdit(q.id)}>
          Edit
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-3" data-testid={`q-${q.id}`}>
      <p className="text-sm font-medium text-foreground">{q.prompt}</p>
      {q.hint ? <p className="text-xs text-muted-foreground">{q.hint}</p> : null}
      {q.fields.map((f) => (
        <Field key={f.key} f={f} q={q} state={state} values={values} value={values[q.id]?.[f.key]} set={(v) => onChange(q.id, f.key, v)} />
      ))}
    </div>
  );
}
