# Spec — AI Brain and AI Employees (Personal Assistant)

Status: proposed (Saurabh, Nov 7, 2026; updated the same day for Composio, the in-app interview, context import, the chat-first brain, Composio tools through the registry, the Nov 25 scope and the revised D-33 – D-38). Adds the "AI Brain" pattern (from the AI Employee Course starter) to Jarvis without changing any rule in `CLAUDE.md`. Refines T-162 (briefing.daily), T-155/T-156 (memory) and T-124 (reply drafts). New tasks are in §10, all `status: proposed`. Decisions are in §11 (D-28 – D-38, all decided Nov 7, 2026). Reviewed Nov 7, 2026 against the code and the other specs: findings in `docs/plan-review.md` → "AI Brain + AI Employees spec review (Nov 7, 2026)"; edits from that review are marked "(review)".

## 1. Why this fits now

The brain template and the Personal Assistant (PA) guide map almost one-to-one onto modules that are still placeholders:

| Already built (done) | Placeholder or proposed (where the brain lands) |
|---|---|
| Lanes, lane policies, `lane_config`, RLS, audit, AAL2 | `packages/ai` (only `PACKAGE_ID`) |
| Vault tokens, OAuth framework, connector contract | `packages/modules/briefing` (empty) |
| Google: OAuth, Gmail metadata sync, live body, Calendar sync (T-061 – T-064, T-130) | `packages/modules/memory` (empty) |
| QuickBooks: OAuth, CDC sync, Reports, normalizer → `fin.*` (T-050 – T-056, T-090) | `packages/modules/comms` classify (T-121), drafts (T-124) |
| Home v1, Inbox (T-200 – T-202) | Assistant (T-100 – T-106), Approvals (T-110 – T-119) |

So the brain is not a new subsystem. It is the **content layer** that the assistant, the briefing and memory read from: who Robert is, how each company works, what each AI employee does, and what he has confirmed. The connectors, lanes and approvals stay exactly as designed.

## 2. Concept mapping

| AI Brain (folder) | Jarvis equivalent | Notes |
|---|---|---|
| `AGENTS.md` (working rules) | Static, versioned system-prompt section in `packages/ai/prompts` | Rules already exist in assistant spec §4; keep the brain wording only where it adds something (e.g. "Not provided = unknown"). |
| `Context/About-Me.md`, `Preferences.md` | `brain.documents` in the user's home lane (`P` once enabled, see §3 "Home lane"), `kind = 'about_me' | 'preferences'`, readable by their author only | D-28 (decided): used in the owner's own calls in every lane. |
| `Context/Work.md` | `brain.documents` per lane (`kind = 'context'`) | One per enabled core-plane lane (PKG first; APK, PKI, NC, P later). **No NL documents** until the NL data plane exists (architecture §5.2; review). |
| `Employees/<role>.md` | `brain.employees` (prose instructions + Zod-validated config), per lane; Robert's cross-company PA lives in his home lane (`P` once enabled; PKG in the pilot, §3) | First employee: `personal_assistant`. Later: finance analyst, meeting prep, chief of staff. |
| `Employees/Employee-Profile-Template.md` | Seeded default profile + setup wizard (§7) | |
| `Skills/<skill>/SKILL.md` | `brain.skills` (method prompts the assistant can load by name) | `brain-maintenance` becomes the memory-suggestion flow (§6). `project-handoff` feeds the Projects view. |
| `Projects/<p>/BRIEF.md`, `HANDOFF.md` | `brain.documents` (`kind = 'project_brief' | 'project_handoff'`), per lane; linked to monday.com items when T-150 lands | |
| `Projects/Personal-Assistant-Setup/COVERAGE.md` | **Not needed.** `core.sync_runs` and mail/calendar cursors already record the reviewed-through time per source. | |
| PA "never send, never delete" rules | Enforced server-side: `effect: 'read' | 'propose'`, Approval Center; read-only Google scopes on the native connector. **For a Composio lane the scope guarantee must be re-established** (review: see plan-review finding on Composio scopes). | The brain's rules become documentation of what the server already guarantees. |
| PA output (6:30 AM briefing, D-32) | `briefing.daily` (T-162) + `brief.briefings` (both planned by T-162; T-213 extends them, it does not duplicate them) | Format from the employee profile; data from SQL and live reads. |
| PA reply drafts | Briefing lists "Suggested replies"; the user's **Draft reply** click starts the T-124 path (`userInitiated`, approvals spec §9) | Robert approves; nothing is sent from a draft without the Approval Center. No proposal is created by the scheduled job itself (review). |
| PA AI news / Skool | `sources.external` in the profile (D-31 decided: yes, FAR/GovCon + AI news) | Skool is browser-only and not part of Robert's portal. |

## 3. Data model

New schema `brain`. Every table has a non-null `lane_id` (rule 3: no lane-less rows; owner-wide content lives in the home lane, below), and pgTAP tests (cross-lane denial, other-user denial, AAL1 denial, `admin_technical` denial) in the same change (rule 3). Add `'brain'` to `MODULES` (`packages/core/src/lane-config`) **and** to `core.view_names()` (`create or replace`, the list `allowed_lanes()` intersects with); owners get it through `core.role_views('owner')`; it is not added to `viewer_view_names()` or to the finance_operator / admin_technical role lists. Add `'brain'` to PKG's `lane_config.enabled_modules` by configuration, not code.

**Home lane (review; replaces "lives in lane `P`" everywhere in this spec).** Owner-wide content (About-Me, Preferences, a cross-company employee, imports, its briefings) lives in lane `P` once `P` is enabled for the user. Until then, `allowed_lanes()` returns nothing for `P` (the lane is disabled) and the lane router refuses it (`ENABLED_LANES=PKG`), so that content lives in **the enabled lane the user picks in the setup wizard** (PKG in the pilot) and is written with that `lane_id`. No lane code is hard-coded (rule 2). When `P` is enabled, the brain editor offers "Move to Personal", an audited copy-then-delete per document. Seed templates are created lazily on first use in the home lane, never by a migration.

**RLS (review).** The standard lane policy alone lets every member with the `brain` view read every row in the lane, which is wrong for one user's About-Me, Preferences and imports. So:
- `brain.documents`, `brain.document_versions`: `aal2 AND lane_id = any(allowed_lanes(uid, 'brain')) AND (kind not in ('about_me','preferences') OR owner_user_id = auth.uid())` (versions carry `kind` and `owner_user_id` denormalised, set by trigger).
- `brain.imports`, `brain.import_candidates`: standard expression `AND user_id = auth.uid()`.
- `brain.employees`, `brain.skills`: the standard expression; additionally an employee is run only for its `owner_user_id`.
- These are custom policies, so each table goes on the catalog test's `custom_policy_ok` list (T-013, `050_catalog.test.sql`) with a reason. The catalog also forbids user DML: **every write goes through reviewed security-definer functions** (`brain.document_save(lane, path, body, if_version)`, `brain.employee_save(...)`, `brain.import_decide(...)`), each checking aal2, `core.has_lane_role(auth.uid(), lane, '{owner}')`, ownership and the secret scan, and each listed in `security_definer_ok` / `authenticated_exec_ok`. `brain` is not a PostgREST-exposed schema (H-026 exposes `core`, `audit` only): pages read through server code or `core.*` invoker functions, as Inbox does (T-202).

### `brain.documents`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `lane_id` | text not null | the home lane (above) for About-Me, Preferences and the owner's cross-company profile |
| `owner_user_id` | uuid | author/owner |
| `kind` | `'about_me' | 'preferences' | 'context' | 'project_brief' | 'project_handoff' | 'note'` | |
| `path` | text | brain-style path, e.g. `Context/Work.md`, `Projects/Ask-Pub-K/BRIEF.md`; unique per (lane_id, owner_user_id, path) |
| `body_md` | text | max 32 KB; secret-pattern scan on write (reuse `looksLikeSecretValue`) |
| `version` | int | optimistic concurrency (`if_version`), like the brain's "reread before saving" rule |
| `updated_by` | uuid | |
| `created_at`, `updated_at` | timestamptz | |

History: `brain.document_versions` (append-only, last 20 versions). The T-042 registry purges by age per class (`RETENTION_CLASSES`: comms, calendar, conversations, webhooks, policy), so "last 20" is enforced by `brain.document_save` pruning in the same transaction, not by T-042 (review). Rule 6 is not affected: this is owner-authored text, not email/chat/document bodies. A pgTAP or unit test asserts no connector path writes to `brain.*`.

### `brain.employees`
| Column | Type | Notes |
|---|---|---|
| `id`, `lane_id`, `owner_user_id` | as above | Robert's cross-company PA lives in his home lane and lists the lanes it reads in `config.lanes`; a single-company employee lives in that lane and `config.lanes` must equal `[lane_id]` |
| `role_key` | text | `personal_assistant`, later `finance_analyst`, `meeting_prep`, ... |
| `name` | text | display name ("Jarvis") |
| `instructions_md` | text | the prose part of the profile (role, tone, drafting rules, examples) |
| `config` | jsonb | validated by `employeeConfigSchema` (below); strict, secret-scanned |
| `status` | `'draft' | 'active' | 'paused'` | only `active` runs on a schedule |
| `version`, `updated_by`, timestamps | | |

`employeeConfigSchema` (Zod, in the new `packages/modules/brain/domain`). `laneCode`, `email`, `hhmm`, `KPI_IDS` and `ACTION_TYPES` come from `packages/core/src/lane-config`; the first three are module-private there today and must be exported, not copied (review):

```ts
const sender = z.union([email, z.string().regex(/^@[a-z0-9.-]+\.[a-z]{2,}$/)]); // same shape as lane_config.priority_senders
const employeeConfigSchema = z.strictObject({
  timezone: z.string().default("America/New_York"),             // IANA; Robert = ET
  lanes: z.array(laneCode).min(1),                               // which lanes this employee may read; ⊆ memberships (checked on save AND on every run)
  sources: z.strictObject({
    mail: z.array(z.strictObject({
      lane: laneCode,                                            // must be in `lanes`
      mailbox: email,                                            // must be in that lane's lane_config.mailboxes
      priority: z.int().min(1).max(9),                           // 1 = highest
      include: z.array(z.string().max(200)).max(20).default([]), // plain-language rules for the classifier
    })).max(30).default([]),
    vip_senders: z.array(sender).max(50).default([]),            // per person; adds to lane_config.priority_senders, never edits it (review, interview B4)
    calendar: z.strictObject({ days_ahead: z.int().min(0).max(14).default(7) }).prefault({}),
    finance_alerts: z.boolean().default(true),                   // from SQL views only (rule 7)
    finance_kpis: z.array(z.enum(KPI_IDS)).max(KPI_IDS.length).default([]), // ⊆ lane_config.kpis; [] = all of the lane's KPIs (review, interview B7)
    approvals_pending: z.boolean().default(true),
    external: z.array(z.strictObject({ kind: z.enum(["web_news"]), topics: z.array(z.string().max(100)).max(10) })).max(5).default([]), // D-31; runs only if the lane policy has `web`
  }).prefault({}),
  exclude: z.array(z.enum(["newsletters", "promotions", "social", "automated"])).default(["newsletters","promotions","social","automated"]),
  schedule: z.strictObject({
    time: hhmm.optional(),                                       // unset = lane_config.briefing.time of the employee's lane (default 06:30, D-32)
    days: z.array(z.int().min(0).max(6)).min(1).default([1,2,3,4,5]), // 0 = Sunday, in `timezone`; default Mon–Fri (D-32)
  }).prefault({}),
  output: z.strictObject({
    max_attention_items: z.int().min(1).max(10).default(5),
    max_drafts: z.int().min(0).max(5).default(3),                // number of "Suggested replies" (each needs the user's click, §5)
    target_words: z.int().min(150).max(1200).default(500),
    sections: z.array(z.enum(["coverage","attention","calendar","deadlines","money","finance_kpis","approvals","news","priorities","drafts","clarifications"]))
      .default(["coverage","attention","calendar","deadlines","finance_kpis","approvals","priorities","drafts","clarifications"]), // "coverage" is always rendered, listed or not
  }).prefault({}),
  delivery: z.array(z.enum(["in_app", "push"])).min(1).default(["in_app", "push"]), // email digest is out of the pilot (plan-review §1.3); sending it would be an external write (rule 5)
  permissions: z.strictObject({ propose: z.array(z.enum(ACTION_TYPES)).default(["email.save_draft"]) }).prefault({}), // never wider than lane_policies; see vocabulary below
});
```

**Permission ceiling.** The effective permission of an employee = `config.permissions` ∩ `lane_policies.write_actions_allowed` ∩ the user's role. The profile can only narrow what the lane allows, never widen it. Test: a profile listing `email.send` in a lane without `email_send` runs without it, and the setting is shown as "not allowed in this lane".

**Action-type vocabulary (review).** Three spellings exist today and the ceiling must map them explicitly, in one tested table in `packages/modules/brain/domain`:

| `lane_config` `ACTION_TYPES` (employee config) | `lane_policies.write_actions_allowed` (SQL check) | approvals action type (approvals spec §2) |
|---|---|---|
| `email.save_draft` (new, D-34; T-211 adds it) | `email_draft` | `email.save_draft`: an unsent Gmail draft in the right thread (itself an external write). **Default for "Draft reply" (D-34).** |
| `email.send` | `email_send` | `email.send`: a separate, explicit approval |
| `email.draft` (existing; alias of `email.save_draft`, kept until callers move) | `email_draft` | `email.save_draft` |
| `calendar.event` | `calendar` | `calendar.event.*` (Release B) |
| `monday.item` | `monday` | `monday.item.*` |
| `notion.page` | `notion` | `notion.page.*` (Release B) |

Email proposals additionally need `lane_policies.store_outbound_drafts = true` (D-19). The default is `["email.save_draft"]` (D-34): "Draft reply" saves an unsent draft in the right Gmail thread on approval; sending is a separate `email.send` approval. T-124's proposal type follows D-34.

Overlap with `lane_config`: `mailboxes`, `priority_senders` and `briefing.time` already exist; `mail_transport` does **not** exist yet (T-219 adds it, §8.3). **Rule:** `lane_config` stays the source of truth for what a lane *can* connect and its company priority senders; the employee config only selects from it and adds per-person preferences. `briefing.time` is the default for `schedule.time`. `laneConfigSchema` currently defaults it to `07:00`; pilot scope, T-162 and D-32 say 06:30 America/New_York, so the default changes to `06:30` (T-162 or T-213, with its lane-config test).

### `brain.skills`
`id, lane_id, owner_user_id, key, title, body_md, version`. Seeded with `brain-maintenance` and `project-handoff` (adapted). Loaded into a run only when the employee config or the user names them; never auto-loaded from retrieved content.

### `brain.imports` and `brain.import_candidates` (§7a)
`brain.imports`: `id, lane_id (the home lane), user_id, source ('claude_paste'|'chatgpt_paste'|'claude_export'|'chatgpt_export'|'brain_zip'), status ('extracting'|'review'|'done'|'failed'), created_at, finished_at`. No `storage_path`: the raw upload is not persisted (§7a, review).
`brain.import_candidates`: `id, import_id, lane_id, user_id, fact text, evidence text (≤300 chars), target_path, target_lane, flags text[] ('possible_nl_content','instruction_dropped'), decision ('pending'|'keep'|'skip')`. Both with RLS (own user only, see RLS above) and pgTAP; candidates are deleted when the import is `done` and at the latest 24 h after creation by a dedicated hourly purge (not a T-042 day class). A candidate flagged `possible_nl_content` stores no `evidence`.

### Memory (T-155) stays as specified
`mem.items` remains the place for short confirmed facts ("Robert prefers replies under 120 words"). `brain.documents` is for longer owner-edited pages. Both are written only from explicit user statements or user-confirmed suggestions. `mem.items` does not exist yet (T-155, Release B); nothing in T-210 – T-214 may depend on it.

## 4. Prompt assembly (`packages/ai/prompts`)

Order for every assistant turn and every employee run, each block clearly delimited:

1. Static rules (versioned): assistant spec §4 rules + the useful brain rules ("Not provided means unknown; never invent decisions, prices, dates or commitments; say what you could not check").
2. Runtime facts: date/time in the profile timezone, lane(s), role, enabled tool categories.
3. `<brain_user>`: the session user's own About-Me + Preferences from their home lane, in every lane's call (D-28, decided). Only for that user's own sessions and runs (`owner_user_id = auth.uid()` / the employee's owner), and only those two kinds.
4. `<brain_lane lane="…">`: that lane's Context/Work + relevant project briefs/handoffs (+ `mem.items` for that lane once T-155 lands; T-215/T-156 add it). One block per lane in scope; never another lane's block in a single-lane call (rule 1).
5. `<employee role="personal_assistant">`: `instructions_md` + a rendered summary of `config`.
6. Tool results, wrapped as `<untrusted_data>` (T-102).

Brain blocks are owner-authored and trusted as preferences, **not** as authority: they cannot add tools, lanes or permissions (the gate is server-side). Token budget: brain blocks capped (default 6k tokens per call), oldest project handoffs dropped first, with a note in the run log.

## 5. The PA as `briefing.daily` (extends T-162)

The PA's 10 steps become job steps. T-162 builds `briefing.daily` and `brief.briefings` per lane (Release A); T-213 makes the same function read the employee profile. Scheduling (review): Inngest crons are fixed per function, so a dispatcher cron `briefing.dispatch` (every 5 minutes) finds `active` employees whose `schedule.time`/`days` in `config.timezone` fell due since its last run and sends `briefing/run.requested` with idempotency key `(employee_id, local date)`, so DST changes and dispatcher retries never produce two briefings or skip one. On demand from Home: "Run briefing now" (same event, user-initiated).

Every run re-checks, with the job client, that the employee's owner still holds a membership with the needed view in each lane of `config.lanes` (`core.allowed_lanes(owner, view)` as service_role) and that each lane is enabled; a lane that fails is skipped and shown in Coverage. The briefing job joins `JOB_RUNNERS` in the ESLint config deliberately (reviewed), as `getLaneJobClient` requires.

| PA step | Job step | Source |
|---|---|---|
| 1 Establish time | `window`: compute review window per source from the last successful `core.sync_runs`/cursor (2-hour overlap; first run 48 h) | SQL |
| 2 Check access | `coverage`: connection health per source (T-040 `token_health`); a failed source marks the briefing `partial` | SQL |
| 3–4 Review email | `mail.collect` per lane: metadata from `comms.*` index, priority from T-121 classifier, then live body reads only for the top N (bodies not stored, rule 6) | the lane's Google mail provider, native or over Composio per `lane_config.mail_transport` (§8.3) |
| 5 Review calendar | `cal.collect` per lane: today + `days_ahead`, clashes, declined/cancelled removed | `cal.*` index |
| (new) Finance | `fin.alerts`: the selected `finance_kpis` and controls from SQL views (T-082 – T-088) through the T-104 finance tools; display strings only (rule 7) | `fin.*` |
| (new) Approvals | `approvals.pending` count and oldest | `core.action_index` (T-110) |
| 6–7 News / Skool | `external.collect`: only if the lane policy has the `web` category (D-31 decided yes; migration in T-218). Runs as a **separate model call with no Jarvis tools and no lane data**: Anthropic's server-side web search inserts page text straight into that call's context, outside the T-102 wrapper, so the call may only return schema-validated `{title, url, published_at, summary}` items, which the composer then receives wrapped as `<untrusted_data>` (review) | Anthropic web search tool behind `LLMProvider` |
| 8 Priorities | lane summarizer (fast model) per lane → composer (analysis model) | `packages/ai` |
| 9 Suggested replies | up to `max_drafts` threads that need a reply are listed with a one-line reason and a **Draft reply** button. The click is the T-124 user-initiated path (approvals spec §9: `userInitiated`, `derived_from_retrieved`), which creates the proposal; the job itself never calls `proposeAction` and stores no draft text (D-19 allows composed bodies only inside pending `act.*` proposals). "Awaiting your input" items say what is missing; nothing incomplete becomes an approvable proposal (review) | T-124, T-214 |
| 10 Quality check | server checks: numeric grounding (assistant spec), every item has a source ref, no duplicate thread ids, coverage section present | `packages/ai` |

Per-lane fan-out then a composer, as in architecture M9: each lane's model call runs under that lane's policy; the composer sees only lane summaries where `cross_lane_summary_allowed` permits.

Storage: `brief.briefings` (planned by T-162; T-213 adds the columns `employee_id, owner_user_id`): `id, lane_id` = the employee's lane (the home lane for a cross-company PA, which stores only composer-level text and source refs), `employee_id, owner_user_id, run_id, window jsonb, coverage jsonb, sections jsonb, rendered_md, source_refs jsonb, status 'complete'|'partial'|'failed', created_at` + RLS (standard expression AND `owner_user_id = auth.uid()` for employee briefings: a briefing is personal) + pgTAP + retention (T-042 class `policy`, the lane's `retention_days`). Push payload: "Your briefing is ready" only (no sensitive text, T-160/T-161 rule).

UI: Home shows the latest briefing at the top (T-163), each item with source chips and freshness; "Draft reply" buttons open the T-124 flow and then the Approval Center card; "Coverage" is always visible, so missing access is never shown as an empty inbox.

## 6. Keeping the brain current: chat-first (brain-maintenance → memory suggestions)

Decided Nov 7, 2026 (Saurabh): the brain fills itself from conversation; Settings is the full viewer, editor and history, and the fallback. Three ways in, with different rules:

| Way in | Example | Saves how | Task / release |
|---|---|---|---|
| **Explicit "remember"** in the user's **own typed message** | "Remember I want replies under 100 words." | **Auto-save**, then an **Undo chip** | T-215, Release B |
| **Inferred suggestion** by the model | "You always move Friday meetings. Treat Fridays as protected?" | **Always a tap** ("Save to brain?" with the exact diff) | T-215, Release B |
| **Briefing feedback** | "Ranked wrong", "missing" on a briefing item | Proposed edit to the employee profile, saved on a tap (bumps `version`) | T-215, Release B |

Rules (all tested in T-215):
- **Auto-save source.** Only text the user typed in the current composer message can auto-save. Never pasted text (the composer marks pasted spans), quoted email, imported text, tool results, briefing content or anything wrapped as `<untrusted_data>` (rule 9, T-155). Tests: "remember …" inside a quoted email, inside a paste, inside an import and inside a tool result never saves (at most it becomes a tap-to-save suggestion, and from untrusted content not even that).
- **Undo chip** shows exactly what was saved, to which document (path) and which lane. Undo restores the previous `version` (from `brain.document_versions`), audited.
- **Inferred suggestions** always need a tap, and are rate-limited to **at most one per conversation**.
- **Lane rule.** A save goes to the current lane's documents. Owner-wide preferences (About-Me, Preferences) go to the home lane (`P` once enabled; D-28). When the scope is unclear ("is this for Pub K or for you personally?"), the assistant asks before saving.
- **Mechanics.** The model returns a `suggest_memory` tool call (`effect: 'propose'`, category `drafting`): `{target: 'mem' | 'brain_document' | 'employee', path?, lane, change_md, reason, origin: 'typed_remember' | 'inferred' | 'feedback'}`. `origin` is set by the server from the message provenance, never by the model; only `typed_remember` may auto-save. `drafting` is in the assistant spec's category union but not in the SQL check on `core.lane_policies.llm_allowed_categories` (`email, calendar, docs, finance, finance_summary, tasks`), so one migration adds `drafting` and `web` (D-31) to the check, with pgTAP (review). `target: 'mem'` is available only after T-155.
- Writes go through the same security-definer functions as the editor (`brain.document_save`, `brain.employee_save`, §3); nothing in the chat path writes tables directly.

## 7. Setup interview: in the chat first, Settings as fallback

Decided Nov 7, 2026: the first-run interview runs **inside the assistant chat** ("Let's set up your brain"), with Settings → **AI brain** → "Set up my brain" / "Set up Personal Assistant" as the fallback and as the place to review, edit, version and restore. Each signed-in user with the `brain` view runs it for themself. In production that is Robert (owner); Saurabh stays `admin_technical` in PKG (D-4, D-36), a role with no content views; he uses the brain only in his separate test deployment (§8a). The question bank, the order, the skip rules and the file each answer lands in are in `docs/specs/brain-interview.md`; the UI reads that bank as data (`packages/modules/brain/interview/*.ts`), so questions change without code changes elsewhere.

Flow (same in chat and in Settings):
1. **Up to three related questions at a time** (brain-setup rule), skipped or pre-filled when the answer is already known from confirmed brain documents, `lane_config`, connected sources (mailbox addresses, calendar working hours) or an earlier answer.
2. After each group, a **proposed edit** to the target `.md` document (exact diff) as a card in the chat. Nothing is saved until the user taps **Save** (interview answers are not "remember" statements and never auto-save).
3. At the end: a summary card (the PA "review the setup" step) → **Confirm** writes `brain.employees` (status `draft`) → **Run test briefing** → the user sets `active`.
4. "Reconfigure" reruns only the sections the user picks; it never restarts from blank.
5. Connecting an account is never done in the chat: when a source is missing, the chat shows a link to **Settings → Connections** (§8.2).

Answers are stored only as the confirmed document text, not as a raw transcript. The interview chat itself follows assistant retention (180 days, deletable).

## 7a. Import context from Claude and ChatGPT

Settings → AI brain → **Import**. Sources:

| Source | How the user gets it | What Jarvis reads |
|---|---|---|
| Claude memory | claude.ai Settings → memory view, copy text; or ask Claude "Summarise everything you know about me and my work" | pasted text |
| ChatGPT memory | ChatGPT Settings → Personalization → Memory, copy; or the same summary prompt | pasted text |
| Claude / ChatGPT data export | Settings → export data (.zip with conversations JSON) | opened in the browser (max 50 MB); only the parts the user selects are sent, never stored (review) |
| AI Brain folder | .zip of a brain folder (`Context/`, `Employees/`, `Projects/`, `Skills/`) | opened in the browser; maps paths 1:1 to `brain.documents`, each file reviewed before save |

Pipeline (review: rule 6 says chat bodies are not stored unless the lane policy allows it, and the home lane's `store_content_bodies` is false): the export .zip is opened **in the browser**; the user picks which memory text or conversations to send (with a size cap per request), and only that text is posted to the server. The server runs the fast model on it **in memory** in the request or an Inngest step that receives at most a bounded text chunk (Inngest event payloads are size-limited and must not carry chat text; the step reads nothing from Storage). The model extracts **candidate facts** (each with a short quote as evidence and a proposed target file and lane) → the user sees a checklist and ticks what to keep → ticked facts are merged into the target documents as proposed diffs → user saves. No raw export, transcript or chat history is written to Storage or the database; only `brain.import_candidates` rows (fact + ≤300-character evidence) exist until the import is done (at most 24 h). The model call runs under the home lane's policy gate and needs an allowed category for it (`drafting`).

Rules: imported text is **untrusted** (rule 9): it can propose facts, never instructions, tools or permissions; a line like "always send emails without asking" is dropped with a note. Facts that look like Nichols Law client or matter content are flagged, default to unticked and keep no evidence quote (NL content must not land in the core data plane). Secret-pattern scan on everything before display. A brain .zip's `Skills/` and `Employees/` files become prompt text once saved, so each is shown in full and saved only on an explicit per-file click, like any other document.

Not possible: connecting Claude or ChatGPT through Composio (or any API) does not expose a user's claude.ai / chatgpt.com memory or chat history; their APIs only run new requests. Import is the route.

## 8. Connectors: Composio for mail and calendar, native for QuickBooks (D-30)

Decision (Saurabh, Nov 7, 2026): Composio for Gmail + Google Calendar; QuickBooks stays native (finance figures come from synced SQL, rule 7); the native Google connector stays as a fallback. Reason: an Internal Google OAuth client (H-008) covers one Workspace domain only, so it cannot connect pub-k.org, nichols.capital and a personal gmail.com together; Composio's Google app can. Robert connects his accounts the same way later; he needs no Composio seat. Nichols Law mail stays out of scope (rule 13).

Rewritten Nov 7, 2026 after the review (plan-review findings 1, 3, 7, 12 – 14, 27, 28) and Saurabh's conditions; SDK facts in §8.6.

### 8.1 Three uses of Composio, one guard

| Use | What | Task | Release |
|---|---|---|---|
| **Sync** | Gmail metadata delta + Calendar delta into the existing `comms.*` / `cal.*` indexes, which the briefing reads with its cursors | T-223 | B |
| **Live read tools** | Composio read tools exposed to the assistant **through Jarvis's tool registry** (T-101), each with a full reviewed `ToolDescriptor` | T-224 | B |
| **Writes** | Composio write tools used only by approvals executors (`email.save_draft`, `email.send`, `calendar.event`) | T-225 | B (after T-110 – T-113) |

**The guard is Jarvis's server-side allow-list, never Composio's own filtering.** A Composio tool slug that is not in our registry (reads) or in an approvals executor (writes) cannot be called, whatever `session.execute` would accept. Composio-side restrictions (session `toolkits`/`tools` filters, auth-config scopes, §8.6) are configured too, but only as defence in depth; tests prove that a non-allow-listed slug is refused by our code before any network call.

There is **no Composio MCP server in the model's context**. The model sees only Jarvis tools from the registry.

### 8.2 Connect, status, test, disconnect: Settings → Connections only

Settings → Connections stays the one place to manage accounts (T-219):
- **"Connect via Composio"** per lane and per toolkit: Gmail and Calendar now; more toolkits with T-222.
- Per account: status (`active`, `reconnect_required`, `revoked`, `failed`), mailbox address, last successful sync, **Test** (a read-only identity + one-page read, shown like the QuickBooks "Check connection"), and **Disconnect**, which is an external write and goes through the Approval Center (D-24).
- The chat may only **link to** this flow ("Connect Gmail in Settings → Connections"); it never starts a connection itself.

Flow: `composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })` → redirect to Composio-hosted Google consent → `/api/connect/composio/callback` → the server confirms with `connectedAccounts.get(id)` (`ACTIVE`, toolkit slug) and reads the identity (`GMAIL_GET_PROFILE` / `GOOGLECALENDAR_GET_CURRENT_USER`). The T-035 state/nonce (single use, bound to user + lane + toolkit) protects the callback, so a forged callback cannot attach an account to another lane.

### 8.3 Provider model (finding 1; D-35 decided: transport, confirmed by the spike)

The T-062 interfaces and SQL know `provider = 'google'` only (`CommsProviderId`, `PROVIDERS`, eight SQL provider checks, `comms_mail_apply_page`, `cal_events_apply_page`), and a connection becomes `active` only through `connection_token_store`, but Composio holds the Google tokens (§8.6). Composio's SDK has an authenticated proxy (`composio.tools.proxyExecute({ endpoint, method, connectedAccountId, parameters })`; credentials injected server-side; relative endpoints are appended to the toolkit's base URL, e.g. `https://www.googleapis.com/calendar/v3`). So (**D-35, decided Nov 7, 2026**, to be confirmed by the T-219 spike):
- **Composio is a transport for `provider = 'google'`**, not a new provider. `core.connections` gets `transport: 'native' | 'composio'` (and the Composio connected account id in `external_account_id`); Gmail/Calendar sync reuses the T-063/T-064/T-130 code and SQL unchanged, with the HTTP call going through `proxyExecute` instead of our token.
- A connection with `transport = 'composio'` is activated by a new security-definer function (no token row; it records the connected account id after the identity check), and its health comes from the Composio account status (§8.5).
- `lane_config` gets a new strict field `mail_transport: 'native' | 'composio'` per lane (default `native`; this replaces the earlier name `mail_provider`; `laneConfigSchema` is strict, so T-219 changes the schema and its tests).
If the proxy turns out not to support the Gmail/Calendar endpoints we need, D-35 falls back to "own provider" (new provider id + SQL), which is a larger T-223.

### 8.4 Composio read tools in the registry (T-224)

Every Composio read tool the assistant may call is a **full `ToolDescriptor`** (assistant spec §2), reviewed like any other tool:
- `category` mapped to `lane_policies.llm_allowed_categories` (`email` for Gmail, `calendar` for Calendar, `docs`/`tasks` for later toolkits); `effect: 'read'`; `requiredView` per module;
- `resultStore: 'refs_only'` for mail, docs and chat content (only ids, titles, dates and source refs are stored in `ai.tool_calls`; no bodies, rule 6);
- `untrustedFields` listing every content field, wrapped as `<untrusted_data>` (T-102);
- the snippet cap (`lane_config.assistant.max_snippet_chars`, default 300) on anything quoted into the stored assistant message;
- a strict Zod input schema (no free-form `arguments` pass-through), the lane's connected account id injected by the server (never chosen by the model), and the mailbox re-checked against `lane_config.mailboxes` on every call.

Initial read allow-list: Gmail `GMAIL_FETCH_EMAILS`, `GMAIL_LIST_THREADS`, `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`, `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, `GMAIL_LIST_LABELS`, `GMAIL_GET_PROFILE`, `GMAIL_SEARCH_PEOPLE`; Calendar `GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_EVENTS_GET`, `GOOGLECALENDAR_FIND_EVENT`, `GOOGLECALENDAR_FIND_FREE_SLOTS`, `GOOGLECALENDAR_FREE_BUSY_QUERY`, `GOOGLECALENDAR_LIST_CALENDARS`, `GOOGLECALENDAR_GET_CURRENT_USER`.

**Live reads feed the index.** Metadata of messages and events returned by a live read is upserted into `comms.*` / `cal.*` through the same apply functions as sync (metadata only), so the index gets fresher; the briefing still reads the index plus cursors (§5), never live tool output.

### 8.5 Writes and health

- **Writes only create proposals.** The assistant's write tools have `effect: 'propose'` and call `approvals.proposeAction` with the exact payload. Execution: approvals → `@nichols/connectors/write` → Composio executors for `email.save_draft` (`GMAIL_CREATE_EMAIL_DRAFT` with the thread id, D-34 default), `email.send` (`GMAIL_SEND_DRAFT` / `GMAIL_REPLY_TO_THREAD` / `GMAIL_SEND_EMAIL`) and `calendar.event` (`GOOGLECALENDAR_CREATE_EVENT` / `PATCH_EVENT` / `DELETE_EVENT`, Release B), with the **payload hash checked** exactly as the QuickBooks writer does (`contract/writer.ts`), executed once, verified and audited. Everything else (trash, delete, labels, filters, forwarding, settings, ACL, watch) is never allowed.
- **ESLint and packaging (finding 13).** The connector lives at `packages/connectors/src/composio`; `VENDORS` gets `@composio/core` → `["packages/connectors/src/composio/**"]` only; the writers are exported through the existing `@nichols/connectors/write` subpath (`src/write/index.ts`), which `WRITE_SUBPATHS` already restricts to approvals (a `composio/write` folder alone would not be covered); `scripts/dependency-allowlist.test.mjs` gets the new dependency. The SDK uses its own HTTP stack, not our `HttpClient`, so the connector wraps every call with a timeout/`AbortSignal`, our redaction and the connector log (accepted deviation, recorded in plan-review).
- **Health (findings 27, 28).** Sync is polled on the existing schedules (`comms.ingest_delta`, `cal.ingest_delta`); no Composio triggers or push at first. Account status `EXPIRED`/`REVOKED`/disabled → `reconnect_required` (T-040). `token_expires_at` is unknown for Composio connections, so health cannot warn before expiry; optionally subscribe to the `composio.connected_account.expired` webhook through the T-036 receiver (signature verified) to warn earlier.
- **Lane binding.** Each connected account id is stored on `core.connections.external_account_id` for exactly one lane (D-23, one account per lane per toolkit), taken only from that row at call time, and its address is checked against the lane's `lane_config.mailboxes` (fail closed).

### 8.6 Composio SDK facts (checked against docs.composio.dev and the npm registry, Nov 7, 2026)

Re-check at the start of T-219; Composio changes its API often (the `initiate()` path for Composio-managed OAuth was retired in 2026).

**Package and version**
- SDK: **`@composio/core`, pinned exactly to `0.27.0`** (published Oct 22, 2026), no `^`/`~`. `latest` is `0.28.0` (Nov 3, 2026), skipped until it is at least two weeks old and its changelog has been read. `@composio/slim` has the same API and dependencies, so no gain.
- No provider package (`@composio/openai-agents`, `@composio/vercel`, `@composio/claude-agent-sdk`): Jarvis never hands Composio tools to a model.
- ESM only; Node `>=22.22.3`. Local Node 24.19 and CI `node-version: 22` satisfy it; the Vercel runtime must be Node 22.22.3+ or 24.
- Transitive dependencies include `openai`, `pusher-js`, `undici`. Server-only: extend the `pnpm test:bundle` canary so no client bundle contains Composio code.

**Credential (finding 14).** `COMPOSIO_API_KEY` is a server env var read through `requireConnectorEnv` (local `.env.local`; the test deployment (H-040) has its own key from its own Composio project; production: Vercel Production env only, never Preview), passed explicitly as `new Composio({ apiKey })`. It is the only Composio secret Jarvis holds; never in prompts, logs or `NEXT_PUBLIC_*`. Rotation runbook in H-039.

**Toolkit versions.** Pin in the constructor, `toolkitVersions: { gmail: "<YYYYMMDD_NN>", googlecalendar: "<YYYYMMDD_NN>" }` (latest on Nov 7, 2026: `20261103_00` for both); T-219 pins the then-current version in code. Never `dangerouslySkipVersionCheck`: without a pin the SDK throws `ComposioToolVersionRequiredError` (fail closed).

**Identity.** Composio `userId` = the Jarvis user's UUID; never an email address, never `"default"` (Composio: it "exposes other users' data"). One user may hold several connected accounts per toolkit, so every call names the connected account explicitly.

**Execution.** Composio recommends sessions (`composio.create(userId, config)` → `session.execute(slug, args)`); direct `composio.tools.execute(slug, { userId, version, arguments })` is "legacy" but supported. Either way our allow-list runs first. Session config used: `toolkits: { enable: [<one toolkit>] }` (explicit; omitting it enables every toolkit), `tools: { <toolkit>: { enable: [<our allow-list>] } }`, `connectedAccounts: { <toolkit>: ["<lane's ca_ id>"] }`, `sandbox: { enable: false }` (removes the remote workbench/bash tools), `manageConnections: { enable: false }`. Composio's docs do not say `session.execute` refuses slugs outside the filter, which is why our allow-list is the guard. Sync uses `proxyExecute` (§8.3).

**Token custody and retention (rules 4 and 6; finding 7).** Composio holds the Google OAuth tokens (AES-256-GCM at rest), refreshes them and never returns them (API responses redact credentials). For Composio connections there is no Google token in our Vault: a documented exception to rule 4's "tokens only from the Vault" (the token is not ours to read at all), recorded in plan-review. Composio keeps tool **arguments and results** (email bodies) in its execution logs by default; **Zero Data Retention** must be on before any real mailbox is connected (H-039). The docs do not say whether `proxyExecute` bodies are logged; H-039 confirms with Composio.

**Scopes.** The docs do not list the default scopes of Composio-managed Gmail/Calendar auth configs. H-039 records them. If they include `gmail.modify`/`gmail.send`, the server-side allow-list is the only guard; a custom auth config with our own Google OAuth app (External, `gmail.readonly` is a restricted scope needing Google verification) is the way to read-only scopes.

Sources: docs.composio.dev (quickstart, authentication, configuring-sessions, reference/sdk-reference/typescript connected-accounts, tools, auth-configs, migration-guide/toolkit-versioning, security/token-custody, toolkits/gmail, toolkits/googlecalendar); registry.npmjs.org/@composio/core.

### 8.7 More toolkits by configuration (T-222, Release B)

"Config only" means, per new toolkit (Notion, monday.com, Slack, Drive, …):
- a `lane_config` toolkit entry for the lanes that may use it (one connected account per lane per toolkit, D-23);
- allow-listed **read** tools, each with a reviewed `ToolDescriptor` kept as a small data file (`packages/connectors/src/composio/toolkits/<toolkit>.ts`: slug, Zod input schema, category, `resultStore`, `untrustedFields`), not connector code;
- a **security-reviewer pass per toolkit** before it is enabled anywhere.
New toolkits start **read-only**. A write needs a new `ACTION_TYPE`, a lane policy entry and an approvals executor (code, reviewed like T-225).

## 8a. Real-account test (D-33, revised Nov 7, 2026)

Decided by Saurabh: the brain is tested **locally with synthetic data and MSW fakes** (rule 10) and with real accounts **only in a separate test deployment, never in Nichols production**. Saurabh's personal and SimpliAutomated mail must never enter Nichols production.

The test deployment (H-040) is staging-style and separate from everything Nichols:
- its own Supabase project (not `lxjhaxdkqtmkhloqaffb`), migrations applied by Saurabh, never linked from an agent worktree (H-022);
- its own Vercel project and URLs, with no Nichols production secrets;
- its own Composio project and `COMPOSIO_API_KEY`, Zero Data Retention on;
- Saurabh as `owner` of his own test lanes and their mailboxes in that project's `lane_config`. No Nichols lanes or data.

In Nichols production Saurabh stays `admin_technical` (D-36 resolved by D-33): no brain there for him.

The test (T-221) is done **by Saurabh through the test deployment's UI**: Composio connections in Settings → Connections (§8.2), his brain folder imported (§7a), the interview completed in the chat, two consecutive briefings reviewed, findings recorded in `docs/plan-review.md`. Agents never hold that project's keys, link the CLI to it or query it; they write the runbook (`docs/runbooks/brain-test-deployment.md`) and review the findings. Nothing real is committed.

**Composio spike (T-219):** local only, against a **throwaway test Gmail account**, never real mailboxes, until H-039 (including Zero Data Retention) is done. The key is never logged.

## 9. Example: Robert's PA profile (synthetic values only)

```json
{
  "timezone": "America/New_York",
  "lanes": ["PKG", "NC", "P"],
  "sources": {
    "mail": [
      { "lane": "PKG", "mailbox": "exec@pkg.example.test", "priority": 1, "include": ["subscriber or checkout issues", "anything from the team waiting on Robert"] },
      { "lane": "NC",  "mailbox": "exec@nc.example.test",  "priority": 2, "include": ["investor and bank correspondence"] },
      { "lane": "P",   "mailbox": "personal@p.example.test", "priority": 3, "include": ["bills", "replies from real people"] }
    ],
    "calendar": { "days_ahead": 7 },
    "finance_alerts": true,
    "approvals_pending": true,
    "external": []
  },
  "schedule": { "time": "06:30", "days": [1, 2, 3, 4, 5] },
  "output": { "max_attention_items": 5, "max_drafts": 3, "target_words": 400,
              "sections": ["coverage","attention","calendar","finance_kpis","approvals","deadlines","priorities","drafts"] },
  "delivery": ["in_app", "push"],
  "permissions": { "propose": ["email.save_draft"] }
}
```

Only `PKG` is enabled in the pilot, so the first live profile has `lanes: ["PKG"]`, lives in the home lane PKG (§3) and has only the PKG mail entry; the others switch on by configuration as lanes are enabled.

## 10. Tasks (all `status: proposed` unless noted; backlog: Phase A14 (Release A part) and Phase B8 (Release B part) in `docs/backlog.md`)

Scope (D-38, revised Nov 7, 2026): PKG uses native Google on Nov 25 (D-37), so the Composio tasks are Release B. T-219 is split per the review into T-219 (connect + Settings), T-223 (sync), T-224 (read tools) and T-225 (writers); T-222 is "more toolkits".

| Task | Title | Depends | Release |
|---|---|---|---|
| T-210 | `brain` module package + schema (**approved Nov 7, 2026**) | T-013, T-042 | **A (Nov 25)** |
| T-211 | `employeeConfigSchema` + permission ceiling + `email.save_draft` in `ACTION_TYPES` | T-210, T-011 | **A** |
| T-212 | Prompt assembly with brain blocks | T-100, T-102, T-210 | **A** |
| T-213 | `briefing.daily` from the employee profile (extends T-162) | T-162, T-211, T-212 | **A** |
| T-216 | Chat-first setup interview (Settings fallback) + test briefing | T-210, T-211, T-100, T-213 | **A if time allows**, else B |
| T-219 | Composio connect + Settings → Connections + lane binding + `mail_transport` switch (+ local spike, throwaway account) | T-062, T-035, T-032, T-040, T-199 | B |
| T-223 | Gmail + Calendar sync over Composio (transport for `google`, D-35) | T-219, T-063, T-064, T-130 | B |
| T-224 | Composio read tools in the assistant registry | T-219, T-101, T-102 | B |
| T-214 | Suggested replies → T-124 "Draft reply" (`email.save_draft`) → Approval Center | T-213, T-124 | B (after T-110 – T-113) |
| T-225 | Composio write executors (`email.save_draft`, `email.send`, `calendar.event`) | T-219, T-113, T-116 | B |
| T-215 | Chat-first memory: auto-save "remember", Undo, inferred suggestions | T-155, T-210, T-101 | B |
| T-217 | Brain editor, history, restore + folder import/export (.zip) | T-210 | B |
| T-218 | External news source (D-31) + `web`/`drafting` categories migration | T-213, T-102 | B |
| T-220 | Claude / ChatGPT context import | T-217, T-100, T-102 | B |
| T-221 | Real-account test in the separate test deployment (D-33, H-040) | T-223, T-224, T-216, T-220, T-213 | B |
| T-222 | More Composio toolkits by configuration | T-224 | B |

The `drafting`/`web` category migration is needed by T-215, T-218 and T-220 and by the `suggest_memory` tool; whichever of them lands first adds it.

Release timing: Release A already has more tasks than days (plan-review §4). T-162 stays the Release A briefing and does not wait for brain tasks; T-213 builds on T-100/T-102/T-162, which are Release A anyway.

## 11. Decisions

All decided Nov 7, 2026 by Saurabh:
- **D-28 — yes.** The owner's own About-Me and Preferences may be added to the owner's own calls in every lane: owner only, those two kinds only; never project or company content across lanes. They live in the home lane (§3): `P` once enabled, the user's chosen enabled lane (PKG) until then.
- **D-29 — Personal Assistant only at launch.** Later candidates: finance analyst (Sophie's weekly cash) and meeting prep.
- **D-30 — Composio for Gmail + Calendar; QuickBooks native; native Google connector kept** as a fallback, chosen per lane by `lane_config.mail_transport` (a new field, T-219; §8.3).
- **D-31 — yes.** Web news in briefings (FAR/GovCon and AI news). T-218 (Release B) adds the `web` category in `lane_policies.llm_allowed_categories` (migration), set per lane by configuration.
- **D-32 — 06:30 America/New_York, Mon–Fri** for Robert. `lane_config.briefing.time` default changes from `07:00` to `06:30`; `schedule.days` defaults to `[1,2,3,4,5]`.
- **D-33 (revised) — real-account tests only in a separate test deployment** with its own Supabase, Vercel and Composio projects, never Nichols production (§8a, H-040).
- **D-34 — "Draft reply" creates `email.save_draft`** (an unsent Gmail draft in the right thread) by default; `email.send` is a separate, explicit approval. `email.save_draft` joins `ACTION_TYPES` (T-211).
- **D-35 — Composio is a transport for the Google connector** through `proxyExecute` (§8.3); confirmed by the T-219 spike, reopened if the proxy does not cover the endpoints.
- **D-36 — resolved by D-33.** Saurabh stays `admin_technical` in production; he uses the brain only in his test deployment.
- **D-37 — native Google for PKG on Nov 25.**
- **D-38 — design and scope:** Composio tools only through the registry with Jarvis's allow-list as the guard (§8.1, §8.4); more toolkits by configuration (§8.7); chat-first brain (§6, §7); Settings → Connections the only place to connect/test/disconnect (§8.2); Nov 25 additions T-210 – T-213 (+ T-216 if time allows), Composio tasks in Release B; the Composio spike runs locally against a throwaway test Gmail account until H-039 is done.
