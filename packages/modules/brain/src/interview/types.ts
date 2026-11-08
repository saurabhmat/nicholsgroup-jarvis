// Interview types (T-216, spec brain-and-employees §7, question bank docs/specs/brain-interview.md). Pure and client-safe.

/** The document or profile an answer lands in. `section` is the exact `## ` heading; `line` replaces one line of it. */
export type DocTarget = { doc: "about_me" | "preferences" | "work" | "pa"; section: string; line?: string };

export type FieldKind = "text" | "longtext" | "select" | "multiselect" | "number" | "time" | "boolean" | "mailbox_order" | "mailbox_text" | "list";

/** Options that depend on the user's lanes or the runtime and are resolved by the server per call. */
export type OptionsFrom = "timezones" | "mailboxes" | "kpis" | "sections";

/** `note` on a mailbox option: whether a live connection exists for it (unknown = could not be read). */
export type FieldOption = { value: string; label: string; note?: "connected" | "not_connected" | "unknown" };

export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  required?: boolean;
  max?: number;
  min?: number;
  options?: readonly FieldOption[];
  optionsFrom?: OptionsFrom;
  /** For a plain text, select or list field: the document section the answer replaces. */
  into?: DocTarget;
};

/** Declarative skip rules (spec brain-interview.md `skip_if`). `known`: every `into` target is already filled. */
export type SkipRule = "known" | "no_finance" | "no_web" | "no_drafts" | "none";

export type Question = {
  id: string;
  part: "A" | "B";
  group: string;
  prompt: string;
  hint?: string;
  fields: readonly Field[];
  /** Document targets, for the diff card and the "Already set" check. */
  targets: readonly DocTarget[];
  /** Structured targets in the employee config, as dotted paths into `employeeConfigSchema` (`[]` marks an array). */
  configTargets: readonly string[];
  skip: SkipRule;
};

export type Group = {
  id: string;
  part: "A" | "B";
  title: string;
  /** What the group saves to, in words: shown on the diff card. */
  saves: string;
  questionIds: readonly string[];
};

export type Answers = Record<string, unknown>;

export type DiffLine = { type: "same" | "add" | "del"; text: string };
