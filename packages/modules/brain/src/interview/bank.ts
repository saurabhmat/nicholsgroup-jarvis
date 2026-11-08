// The interview question bank as data (T-216). Source: docs/specs/brain-interview.md; keep ids stable. Nothing here is
// company-specific: lane names, mailboxes and KPIs come from lane_config at run time. A unit test checks that every
// `config.*` target is a path of employeeConfigSchema.
import type { DocTarget, Field, Group, Question } from "./types";

export const PA_SECTIONS = {
  role: "1. Role and objective",
  priority: "2. Priority order",
  leaveOut: "3. What to leave out",
  calendar: "4. Calendar",
  drafting: "5. Drafting rules",
  rules: "7. Rules",
} as const;

export const NOT_PROVIDED = "Not provided.";

const about = (section: string): DocTarget => ({ doc: "about_me", section });
const prefs = (section: string): DocTarget => ({ doc: "preferences", section });
const work = (section: string): DocTarget => ({ doc: "work", section });
const pa = (section: string, line?: string): DocTarget => (line === undefined ? { doc: "pa", section } : { doc: "pa", section, line });

const text = (key: string, label: string, into: DocTarget, extra: Partial<Field> = {}): Field => ({ key, label, kind: "text", max: 200, into, ...extra });
const longtext = (key: string, label: string, into: DocTarget, extra: Partial<Field> = {}): Field => ({ key, label, kind: "longtext", max: 1500, into, ...extra });

export const SCOPE_OPTIONS = [
  { value: "work", label: "Work" },
  { value: "personal", label: "Personal" },
  { value: "both", label: "Both work and personal" },
] as const;

export const DAY_OPTIONS = [
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
  { value: "0", label: "Sun" },
] as const;

export const EXCLUDE_OPTIONS = [
  { value: "newsletters", label: "Newsletters" },
  { value: "promotions", label: "Promotions" },
  { value: "social", label: "Social" },
  { value: "automated", label: "Automated messages" },
] as const;

export const WORD_OPTIONS = [
  { value: "250", label: "Short (about 250 words)" },
  { value: "500", label: "Standard (about 500 words)" },
  { value: "800", label: "Long (about 800 words)" },
] as const;

export const FINANCE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "all", label: "All of the company's numbers" },
  { value: "pick", label: "Only the ones I pick" },
] as const;

export const DELIVERY_OPTIONS = [
  { value: "in_app", label: "In the app" },
  { value: "push", label: "Phone notification" },
] as const;

export const QUESTIONS: readonly Question[] = [
  // ---- Part A: brain setup (once per user) ----
  {
    id: "A1",
    part: "A",
    group: "A-1",
    prompt: "What should Jarvis call you?",
    fields: [text("name", "Name", about("Name and how to address me"), { max: 100, required: true })],
    targets: [about("Name and how to address me")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A2",
    part: "A",
    group: "A-1",
    prompt: "Is this brain for work, personal, or both?",
    fields: [{ key: "scope", label: "Scope", kind: "select", options: SCOPE_OPTIONS, required: true, into: about("Scope of this brain") }],
    targets: [about("Scope of this brain")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A3",
    part: "A",
    group: "A-1",
    prompt: "What's the first thing you want Jarvis to help with?",
    fields: [longtext("first_task", "First task", about("First task for Jarvis"))],
    targets: [about("First task for Jarvis")],
    configTargets: [],
    skip: "none",
  },
  {
    id: "A4",
    part: "A",
    group: "A-2",
    prompt: "Which timezone do you work in?",
    hint: "Also used for when your briefing arrives.",
    fields: [{ key: "timezone", label: "Timezone", kind: "select", optionsFrom: "timezones", required: true, into: about("Timezone") }],
    targets: [about("Timezone")],
    configTargets: ["config.timezone"],
    skip: "known",
  },
  {
    id: "A7",
    part: "A",
    group: "A-2",
    prompt: "What does a good week look like for you? Any fixed routines (meetings, travel days, no-work times)?",
    fields: [longtext("routine", "Routine", about("Routine and constraints"))],
    targets: [about("Routine and constraints")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A5",
    part: "A",
    group: "A-3",
    prompt: "What is your role at this company?",
    hint: "Asked once per company. To describe another company, open the assistant in that company.",
    fields: [text("role", "Your role", work("My role here"))],
    targets: [work("My role here")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A6",
    part: "A",
    group: "A-3",
    prompt: "What does this company do, and who are the key people you deal with?",
    hint: "Names and roles only. No client or matter details, account numbers or passwords.",
    fields: [longtext("company", "What the company does", work("What the company does")), longtext("people", "Key people (name, role)", work("Key people"))],
    targets: [work("What the company does"), work("Key people")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A8",
    part: "A",
    group: "A-4",
    prompt: "How do you like messages written: length, tone, formality?",
    fields: [longtext("writing", "Writing", prefs("Writing"))],
    targets: [prefs("Writing")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A9",
    part: "A",
    group: "A-4",
    prompt: "How do you like information delivered: summary first, bullets, detail level?",
    fields: [longtext("delivery", "Delivery", prefs("Delivery of information"))],
    targets: [prefs("Delivery of information")],
    configTargets: [],
    skip: "known",
  },
  {
    id: "A10",
    part: "A",
    group: "A-4",
    prompt: "Anything Jarvis should never do or always check with you first?",
    hint: "These can only narrow what the company already allows, never widen it.",
    fields: [longtext("ask_first", "Always check with me first", prefs("Always ask me first")), longtext("never", "Never do", prefs("Never do"))],
    targets: [prefs("Always ask me first"), prefs("Never do")],
    configTargets: [],
    skip: "known",
  },
  // ---- Part B: Personal Assistant setup (per employee) ----
  {
    id: "B1",
    part: "B",
    group: "B-1",
    prompt: "When you start your day, what do you spend most time checking, or worry about missing?",
    fields: [longtext("objective", "What matters", pa(PA_SECTIONS.role))],
    targets: [pa(PA_SECTIONS.role)],
    configTargets: [],
    skip: "none",
  },
  {
    id: "B2",
    part: "B",
    group: "B-1",
    prompt: "Which mailboxes should the assistant watch, and in what priority?",
    hint: "Pick from the company's mailboxes, highest priority first. Connecting a mailbox is done in Settings → Connections.",
    fields: [{ key: "mailboxes", label: "Mailboxes, highest priority first", kind: "mailbox_order", optionsFrom: "mailboxes" }],
    targets: [pa(PA_SECTIONS.priority)],
    configTargets: ["config.sources.mail[].lane", "config.sources.mail[].mailbox", "config.sources.mail[].priority", "config.lanes"],
    skip: "none",
  },
  {
    id: "B3",
    part: "B",
    group: "B-1",
    prompt: "For each mailbox: what counts as important?",
    hint: "For example: my team is waiting on me, deadlines, invoices. One rule per line.",
    fields: [{ key: "include", label: "What counts as important", kind: "mailbox_text", optionsFrom: "mailboxes" }],
    targets: [pa(PA_SECTIONS.priority)],
    configTargets: ["config.sources.mail[].include"],
    skip: "none",
  },
  {
    id: "B4",
    part: "B",
    group: "B-2",
    prompt: "Who are your VIP senders?",
    hint: "Email addresses or @domains, separated by commas or new lines. The company's own priority senders are already set.",
    fields: [{ key: "vip", label: "VIP senders", kind: "list", max: 2000 }],
    targets: [pa(PA_SECTIONS.priority)],
    configTargets: ["config.sources.vip_senders"],
    skip: "none",
  },
  {
    id: "B5",
    part: "B",
    group: "B-2",
    prompt: "What should always be left out?",
    fields: [
      { key: "exclude", label: "Leave out", kind: "multiselect", options: EXCLUDE_OPTIONS },
      longtext("exceptions", "Exceptions", pa(PA_SECTIONS.leaveOut), { required: false }),
    ],
    targets: [pa(PA_SECTIONS.leaveOut)],
    configTargets: ["config.exclude"],
    skip: "none",
  },
  {
    id: "B6",
    part: "B",
    group: "B-3",
    prompt: "Calendar: how many days ahead should it look, and which meetings need prep?",
    fields: [{ key: "days_ahead", label: "Days ahead (0 to 14)", kind: "number", min: 0, max: 14, required: true }, longtext("prep", "Meetings that need prep", pa(PA_SECTIONS.calendar))],
    targets: [pa(PA_SECTIONS.calendar)],
    configTargets: ["config.sources.calendar.days_ahead"],
    skip: "none",
  },
  {
    id: "B7",
    part: "B",
    group: "B-3",
    prompt: "Which finance numbers should appear in the briefing?",
    hint: "Figures come from the company's books, never from the assistant.",
    fields: [
      { key: "show", label: "Finance numbers", kind: "select", options: FINANCE_OPTIONS, required: true },
      { key: "kpis", label: "Pick numbers", kind: "multiselect", optionsFrom: "kpis" },
    ],
    targets: [],
    configTargets: ["config.sources.finance_alerts", "config.sources.finance_kpis", "config.output.sections"],
    skip: "no_finance",
  },
  {
    id: "B8",
    part: "B",
    group: "B-3",
    prompt: "Should pending approvals appear in the briefing?",
    fields: [{ key: "approvals", label: "Show pending approvals", kind: "boolean" }],
    targets: [],
    configTargets: ["config.sources.approvals_pending", "config.output.sections"],
    skip: "none",
  },
  {
    id: "B9",
    part: "B",
    group: "B-4",
    prompt: "Any outside news to follow? Which topics?",
    hint: "One topic per line, for example an industry or regulation you track.",
    fields: [{ key: "topics", label: "Topics", kind: "list", max: 1000 }],
    targets: [],
    configTargets: ["config.sources.external[].kind", "config.sources.external[].topics", "config.output.sections"],
    skip: "no_web",
  },
  {
    id: "B10",
    part: "B",
    group: "B-4",
    prompt: "What time, and which days, should the briefing arrive?",
    hint: "Leave the time empty to use the company's default. The default days are Monday to Friday.",
    fields: [
      { key: "time", label: "Time (24-hour, in your timezone)", kind: "time" },
      { key: "days", label: "Days", kind: "multiselect", options: DAY_OPTIONS, required: true },
    ],
    targets: [],
    configTargets: ["config.schedule.time", "config.schedule.days"],
    skip: "none",
  },
  {
    id: "B11",
    part: "B",
    group: "B-4",
    prompt: "Where do you want it?",
    hint: "An email digest is not part of the pilot.",
    fields: [{ key: "delivery", label: "Delivery", kind: "multiselect", options: DELIVERY_OPTIONS, required: true }],
    targets: [],
    configTargets: ["config.delivery"],
    skip: "none",
  },
  {
    id: "B12",
    part: "B",
    group: "B-5",
    prompt: "How long should it be, and which sections?",
    fields: [
      { key: "target_words", label: "Length", kind: "select", options: WORD_OPTIONS, required: true },
      { key: "max_attention", label: "Most items needing attention (1 to 10)", kind: "number", min: 1, max: 10, required: true },
      { key: "sections", label: "Sections", kind: "multiselect", optionsFrom: "sections" },
    ],
    targets: [],
    configTargets: ["config.output.target_words", "config.output.max_attention_items", "config.output.sections"],
    skip: "none",
  },
  {
    id: "B13",
    part: "B",
    group: "B-5",
    prompt: "Should the assistant suggest replies for emails that need you? How many at most?",
    hint: "Each one becomes a draft only when you tap Draft reply, and you approve the exact text first. 0 turns it off.",
    fields: [{ key: "max_drafts", label: "Most suggested replies (0 to 5)", kind: "number", min: 0, max: 5, required: true }],
    targets: [],
    configTargets: ["config.output.max_drafts", "config.permissions.propose"],
    skip: "no_drafts",
  },
  {
    id: "B14",
    part: "B",
    group: "B-5",
    prompt: "How should drafts sound?",
    hint: "Describe your voice in a few words. Do not paste emails: only this note is stored.",
    fields: [text("voice", "Voice", pa(PA_SECTIONS.drafting, "- Voice:"), { max: 400 })],
    targets: [pa(PA_SECTIONS.drafting, "- Voice:")],
    configTargets: [],
    skip: "none",
  },
  {
    id: "B15",
    part: "B",
    group: "B-6",
    prompt: "What must the assistant never do?",
    hint: "This can only narrow what the company allows, never widen it.",
    fields: [longtext("rules", "Additional rules", pa(PA_SECTIONS.rules, "- Additional rules:"), { max: 600 })],
    targets: [pa(PA_SECTIONS.rules, "- Additional rules:")],
    configTargets: [],
    skip: "none",
  },
];

export const GROUPS: readonly Group[] = [
  { id: "A-1", part: "A", title: "About you", saves: "Context/About-Me.md", questionIds: ["A1", "A2", "A3"] },
  { id: "A-2", part: "A", title: "Your time", saves: "Context/About-Me.md", questionIds: ["A4", "A7"] },
  { id: "A-3", part: "A", title: "This company", saves: "Context/Work.md", questionIds: ["A5", "A6"] },
  { id: "A-4", part: "A", title: "How you like things", saves: "Context/Preferences.md", questionIds: ["A8", "A9", "A10"] },
  { id: "B-1", part: "B", title: "What matters and which mailboxes", saves: "Personal Assistant profile", questionIds: ["B1", "B2", "B3"] },
  { id: "B-2", part: "B", title: "VIPs and what to leave out", saves: "Personal Assistant profile", questionIds: ["B4", "B5"] },
  { id: "B-3", part: "B", title: "Calendar, finance and approvals", saves: "Personal Assistant profile", questionIds: ["B6", "B7", "B8"] },
  { id: "B-4", part: "B", title: "News, schedule and delivery", saves: "Personal Assistant profile", questionIds: ["B9", "B10", "B11"] },
  { id: "B-5", part: "B", title: "Length, sections and drafts", saves: "Personal Assistant profile", questionIds: ["B12", "B13", "B14"] },
  { id: "B-6", part: "B", title: "Rules", saves: "Personal Assistant profile", questionIds: ["B15"] },
];

/** The brief's hard cap per step. */
export const MAX_QUESTIONS_PER_GROUP = 3;

export const questionById = (id: string): Question | undefined => QUESTIONS.find((q) => q.id === id);
export const groupById = (id: string): Group | undefined => GROUPS.find((g) => g.id === id);
export const questionsOf = (g: Group): Question[] => g.questionIds.flatMap((id) => questionById(id) ?? []);

/**
 * Test briefing (spec brain-interview.md Part C step 3) needs the daily briefing (T-213), which is not built. Until it
 * is, the step shows this message and activation does not wait for it. Flip to true when T-213 lands.
 */
export const TEST_BRIEFING_AVAILABLE = false;
export const TEST_BRIEFING_PENDING_MESSAGE = "Your test briefing arrives with the daily briefing (T-213).";

/** The assistant's display name and role key for the first employee. */
export const PA_ROLE_KEY = "personal_assistant";
export const PA_NAME = "Jarvis";
