# Brain interview — question bank

Status: proposed (Nov 7, 2026). Companion to `brain-and-employees.md` §7. The setup UI reads this bank as data (`packages/modules/brain/interview/*.ts`); keep ids stable. The interview runs **in the assistant chat first**, with Settings → AI brain as the fallback (decided Nov 7, 2026).

## Rules for the interviewer
- Ask **up to 3 related questions at a time**, then wait.
- **Skip** a question when `skip_if` is already true (known from confirmed brain documents, `lane_config`, or connected sources). Show the known answer as "Already set: … (edit)".
- After each group, propose the exact text change to the `target` document; save only on the user's click.
- Unknown stays unknown: never fill a field with a guess. "Not provided" is a valid saved value.
- Never ask for passwords, codes, API keys, account numbers or full financial details.
- Nichols Law client or matter details are out of scope; if given, don't save them and say why.
- Interview answers never auto-save (they are not "remember" statements, spec §6); each group is saved on the user's tap.
- Never connect an account from the chat; when a source is missing, link to Settings → Connections (spec §8.2).

Targets: `Context/About-Me.md`, `Context/Work.md` (one per enabled core-plane lane; never NL), `Context/Preferences.md`, `Employees/Personal-Assistant.md` (prose) and `config.*` = the employee's `config` (structured, `employeeConfigSchema` in `brain-and-employees.md` §3). Every `config.*` target below is a field of that schema (checked by a unit test over this bank). The interview never writes `lane_config` or `lane_policies`; lane settings are shown read-only as "Set for the company: … (owner can change in Settings)". Reviewed Nov 7, 2026 (B2, B4, B7, B9, B10, B11, B13 corrected).

## Part A — Brain setup (once per user)

| id | Question | Target | skip_if | Answer type |
|---|---|---|---|---|
| A1 | What should Jarvis call you? | About-Me › Name | name confirmed | text |
| A2 | Is this brain for work, personal, or both? | About-Me › Scope | scope confirmed | choice |
| A3 | What's the first thing you want Jarvis to help with? | About-Me › First task | — | text |
| A4 | Which timezone do you work in? | About-Me › Timezone; `config.timezone` | timezone confirmed | IANA picker |
| A5 | Which companies are you involved in, and what's your role in each? | Work (per lane) › Role | lanes + role known | per lane text |
| A6 | For each company: what does it do, and who are its key people you deal with? | Work (per lane) › Company, People | Work doc filled | per lane text |
| A7 | What does a good week look like for you? Any fixed routines (meetings, travel days, no-work times)? | About-Me › Routine | routine confirmed | text |
| A8 | How do you like messages written: length, tone, formality? | Preferences › Writing | confirmed | text + examples |
| A9 | How do you like information delivered: summary first, bullets, detail level? | Preferences › Delivery | confirmed | text |
| A10 | Anything Jarvis should never do or always check with you first? | Preferences › Boundaries | confirmed | text (can only narrow lane policy) |

## Part B — Personal Assistant setup (per employee)

| id | Question | Target | skip_if | Answer type |
|---|---|---|---|---|
| B1 | When you start your day, what do you spend most time checking, or worry about missing? | PA › Role and objective | — | text |
| B2 | Which mailboxes should the assistant watch, and in what priority? (pick from connected) | `config.sources.mail[]` (`lane`, `mailbox`, `priority`); `config.lanes` | — | ordered multi-select of the `lane_config.mailboxes` of the user's enabled lanes |
| B3 | For each mailbox: what counts as important? (e.g. team waiting on you, deadlines, invoices) | `config.sources.mail[].include`; PA › Priority order | — | per mailbox text |
| B4 | Who are your VIP senders? | `config.sources.vip_senders` + PA › Priority order (the lane's `priority_senders` are shown as already set, read-only) | — | email/@domain list |
| B5 | What should always be left out? (newsletters, promotions, social, automated) | `config.exclude` | — | multi-select + exceptions text |
| B6 | Calendar: how many days ahead to look, and which meetings need prep? | `config.sources.calendar.days_ahead`; PA › Calendar | — | number + text |
| B7 | Which finance numbers should appear in the briefing? | `config.sources.finance_alerts`; `config.sources.finance_kpis`; section `finance_kpis` in `config.output.sections` | no `finance` view in any selected lane → skip | multi-select of the lane's `lane_config.kpis` (none = all) |
| B8 | Should pending approvals appear in the briefing? | `config.sources.approvals_pending` | — | yes/no |
| B9 | Any outside news to follow? (e.g. FAR/GovCon updates, AI news) Which topics? | `config.sources.external` | no selected lane has `web` in `llm_allowed_categories` → skip (D-31 decided yes; the category is per lane) | topics |
| B10 | What time, and which days, should the briefing arrive? | `config.schedule.time`, `config.schedule.days` | — | time (default: the lane's `briefing.time`, 06:30) + days (default Mon–Fri, D-32) |
| B11 | Where do you want it? (in app, phone notification) | `config.delivery` | — | multi-select (`in_app`, `push`; no email digest in the pilot) |
| B12 | How long should it be, and which sections? | `config.output.target_words`, `config.output.max_attention_items`, `config.output.sections` | — | choice + section order |
| B13 | Should the assistant suggest replies for emails that need you? How many at most? (each one becomes a draft only when you tap "Draft reply") | `config.output.max_drafts`; `config.permissions.propose` | no selected lane has `email_send` in `write_actions_allowed` with `store_outbound_drafts` on → skip | number |
| B14 | How should drafts sound? Paste one or two replies you've sent that sound like you (optional). | PA › Drafting rules (voice notes only, no copied email bodies stored) | — | text |
| B15 | What must the assistant never do? | PA › Rules (can only narrow lane policy) | — | text |

## Part C — Review and test (fixed steps, not questions)
1. Summary of all answers grouped by section; each with "edit".
2. Confirm → save `Employees/Personal-Assistant.md` + `config` (status `draft`).
3. Run test briefing on the last 48 hours (needs T-213; until then this step is hidden).
4. Ask one question: "What was missing, unnecessary or ranked wrong?" → proposed profile edit.
5. Activate (status `active`); schedule starts.

## Mapping of Saurabh's current brain (for the production test, §8a, D-33)
His existing `Employees/My-AI-Personal-Assistant.md` already answers B1 – B15 for his own use (Skool and AI news are his personal sources). Import it with the brain .zip (T-217); the interview should then skip everything except anything the app needs that the file doesn't say.

## Section completion (T-227)
Completion per section is stored (`brain.section_completions`; Save, even with every value a kept default, or "Nothing to add"). The section ids are the bank's group ids and `brain.valid_section` in SQL lists them: **adding, renaming or removing a bank group needs a new migration that replaces `brain.valid_section`** (a unit test, `bank.test.ts`, compares the list with the migration file of T-227 and must be pointed at the newest one).

