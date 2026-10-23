# Nichols Executive Portal — Technical Architecture

**Version:** 0.2 technical reference + pilot amendments · **Owner:** Saurabh (technical lead) · **Product owner:** Robert Nichols
**Hosting:** Vercel · **Database/Auth/Storage:** Supabase · **AI:** Claude (Anthropic) · **Jobs:** Inngest
**Lanes:** Nichols Law (NL), Nichols Capital (NC), Pub K Group (PKG), Ask Pub K (APK), Pub K Institute (PKI), Personal (P)

> **Read this first — changes agreed after v0.2 (these override the sections below where they conflict).**
>
> 1. **Pilot first.** Build the Pub K Group (PKG) lane end-to-end as a reusable lane template; other lanes are switched on later by configuration. See `docs/pilot-scope.md`.
> 2. **Nichols Law Microsoft tenant is not accessible.** NL finance (QuickBooks, TimeSolv) stays in scope; NL email, Teams and SharePoint are handled in Claude Enterprise and linked from the portal. No Graph connector for the NL tenant. Calendar sharing to a pub-k.org account may be added if Integris allows it.
> 3. **Supabase NL data plane deferred.** The pilot uses one Supabase project per environment (staging, prod). Keep the lane router and `lane_id` everywhere so the separate NL project can be added later without refactoring.
> 4. **All 13 modules are in scope for 2026**, including Approval Center, Commitments and Memory (no longer 2027).
> 5. **GoHighLevel added** as a source for paid subscribers. Stripe remains the source of revenue figures; never double-count.
> 6. **Bank balances:** QuickBooks book balances only for the pilot, always labelled "book balance". Plaid is optional later.
> 7. **Sign-in:** Supabase email code / magic link + Supabase TOTP MFA for all users (no tenant dependency). Resend for sign-in emails. Next.js 16 (`proxy.ts`) with pnpm workspaces + Turborepo.
> 8. **Releases:** Release A (PKG) live Nov 25 incl. Approval Center for email + monday.com after the pilot security test; Release B Dec 7–31 (search, meeting prep, calendar actions, Notion writes, commitments, memory, projects view) and rollout to other lanes.
> 9. **Roles:** Sophie is finance operator (generates and signs off reports).
> 10. **Sponsor-facing version:** `docs/architecture-v0.3-sponsor.pdf` (summary, decisions, scope). This file is the technical reference.

---

## 1. What the system is

The portal is a single installable app (a PWA for Mac and iPhone) that acts as Robert's AI chief of staff across five companies and his personal life. It reads mail, calendars, chats, documents, tasks and financials. It produces briefings, meeting prep, commitment tracking, search results, financial dashboards and drafts. It **executes nothing without Robert's individual approval**. Each company and the personal workspace is a separate **lane**, with its own credentials, storage, AI context and access rules.

### Modules

| # | Module | Purpose | Phase |
|---|---|---|---|
| M1 | **Platform core** | Identity, lanes, permissions, connections, audit, settings | 1 |
| M2 | **Connector gateway** | Authorized access to every account (M365 ×N, Google, QBO, Stripe, TimeSolv, monday, Notion) | 1–2 |
| M3 | **Business Performance (Finance)** | Per-firm and consolidated financial dashboards, controls, reports | 2 (priority) |
| M4 | **Assistant** | Conversational Claude across permitted lanes, with tools and citations | 2 |
| M5 | **Communications** | Priority inbox across Outlook, Gmail and Teams; summaries; reply drafts | 3 |
| M6 | **Calendar & Meetings** | Unified calendar; meeting prep packs; scheduling proposals | 3 |
| M7 | **Commitments** | Extract commitments from communications; reconcile with monday/Notion | 4 |
| M8 | **Documents & Search** | Federated search across SharePoint, OneDrive, Drive and Notion, with citations | 3 |
| M9 | **Daily Briefing / Home** | Morning briefing, attention queue, lane overview | 4 |
| M10 | **Approval Center** | Proposed actions, approve/edit/reject, execution and verification | 4 |
| M11 | **Notifications** | Web push, email digest, in-app alerts | 2–4 |
| M12 | **Memory & Preferences** | Lane-scoped durable assistant memory, user-reviewable | 4 |
| M13 | **Admin & Observability** | Connection health, sync status, audit log, policy settings | 1–5 |

---

## 2. Architecture principles

1. **Lanes are a hard boundary.** Every row, cache entry, embedding, tool call, conversation and memory item carries a `lane_id`. Postgres Row Level Security (RLS) and a server-side policy gate enforce it. Prompts are never the boundary.
2. **Sensitive lanes are physically separate.** Nichols Law runs on its own Supabase project, its own Inngest environment keys and its own Vault (Section 5).
3. **Live retrieval first, minimal storage.** Content such as email bodies and documents is fetched live and not stored by default. Only metadata, identifiers, approved summaries and, for finance, structured data are persisted.
4. **Numbers come from SQL, never from the model.** Claude explains and drafts; it doesn't produce figures.
5. **Read, analyze and draft freely; act only through the Approval Center.** There's no write path to any external system outside the approval engine.
6. **Every claim is traceable.** Answers cite their source (message, event, document, report) with an `as_of` time and a live/cached/stale label.
7. **Few moving parts and portable seams.** Vercel, Supabase, Inngest and Anthropic. The AI provider, the connectors and the job runner sit behind interfaces.

---

## 3. System context

```mermaid
flowchart LR
  subgraph Clients
    MAC[Mac PWA]
    IOS[iPhone PWA]
  end

  subgraph Vercel
    WEB[Next.js app<br/>UI + API routes]
    ORCH[AI orchestration<br/>+ policy gate]
    HOOK[Webhook receivers]
  end

  subgraph Inngest
    JOBS[Sync · Briefings · Extraction<br/>Reports · Action executor]
  end

  subgraph Supabase_Core[Supabase — Core project]
    CAUTH[Auth + MFA]
    CDB[(Control plane +<br/>NC · PKG · APK · PKI · P lanes)]
    CV[Vault]
    CS[Storage]
  end

  subgraph Supabase_NL[Supabase — NL project]
    NDB[(NL lane data)]
    NV[Vault]
  end

  CLAUDE[Claude API]

  subgraph Sources
    M365[M365 tenants<br/>Outlook · Teams · SharePoint · OneDrive · Calendar]
    GOO[Google<br/>Gmail · Calendar · Drive]
    FIN[QuickBooks · Stripe · TimeSolv]
    WORK[monday.com · Notion]
  end

  MAC & IOS --> WEB
  WEB --> CAUTH
  WEB --> CDB
  WEB --> ORCH --> CLAUDE
  ORCH --> CDB
  ORCH --> NDB
  WEB -- events --> JOBS
  JOBS --> CDB & NDB
  JOBS --> CV & NV
  JOBS --> Sources
  Sources -- webhooks --> HOOK --> JOBS
```

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 15 (App Router), TypeScript, React Server Components | UI and API in one deployable |
| Hosting | Vercel Pro | Preview deployments, cron, firewall/WAF, env management |
| PWA | Serwist service worker, Web App Manifest, Web Push (VAPID) | iOS push works for installed PWAs |
| UI | Tailwind CSS, shadcn/ui, Recharts, TanStack Table | Dashboards, inbox lists, aging tables |
| Database | Supabase Postgres ×2 projects (Core, NL) | RLS, views, pg_cron, Realtime, pgvector |
| Auth | Supabase Auth on the Core project: Microsoft SSO + enforced MFA (AAL2) | One login; NL project trusts Core-issued identity via server-side calls only |
| Secrets | Supabase Vault per project | OAuth refresh tokens, API keys |
| Files | Supabase Storage (private, per lane) | Generated reports, exports, temporary attachments |
| Jobs / workflows | Inngest | Durable steps, retries, schedules, per-connection concurrency keys, `waitForEvent` for approvals |
| AI | Claude via Anthropic API, behind an `LLMProvider` interface | Analysis model (Opus/Sonnet class) + fast model (Haiku class) |
| Embeddings (phase 3+) | pgvector in each lane's project; embedding provider behind an interface | Only for opted-in, selectively indexed content |
| Validation | Zod | All inputs, connector payloads and AI tool arguments |
| Monorepo | pnpm + Turborepo | Packages per module |
| Testing | Vitest, Playwright, pgTAP (RLS), prompt-injection suite | Run in CI |
| Observability | Sentry, Vercel Log Drains, Supabase logs, Inngest dashboard | Alerting to admin |
| CI/CD | GitHub Actions + Vercel Git + Supabase CLI migrations | Nichols-owned GitHub org |
| Dev tooling | VS Code + Claude Code | CLAUDE.md rules (Section 15) |

---

## 5. Lanes, data planes and tenancy

### 5.1 Lane registry

| Lane | Code | Data plane | Sources (expected — confirm in discovery) |
|---|---|---|---|
| Nichols Law | `NL` | **NL project (isolated)** | M365 GCC tenant, QBO, TimeSolv, monday, Notion |
| Nichols Capital | `NC` | Core | M365 tenant (nicholscapital), QBO?, monday, Notion |
| Pub K Group | `PKG` | Core | M365/Google tenant, QBO, Stripe, monday, Notion |
| Ask Pub K | `APK` | Core | Stripe, QBO file or class |
| Pub K Institute | `PKI` | Core | QBO file or class, Stripe? |
| Personal | `P` | Core (owner-only) | Personal Gmail/Outlook, calendars, personal QBO |
| Downeaster | `DE` | Core | **Confirm whether in scope** |

### 5.2 Two data planes

- **Core project.** Holds the **control plane** (users, memberships, lane registry, connection registry, approval index, audit) and the data for NC, PKG, APK, PKI and P.
- **NL project.** Holds all NL lane data, including its synced finance data, metadata caches, summaries, embeddings, NL conversations and memory, and the NL Vault with NL OAuth tokens. It has its own backups and its own service key, which exists only in the server environment.

A **lane router** in `packages/core` returns the correct database client for a `lane_id`. Application code never chooses a database directly.

### 5.3 Lane policy

Each lane has a policy record that the policy gate enforces at runtime:

| Field | Example (NL, at launch) | Example (PKG) |
|---|---|---|
| `llm_allowed_categories` | `finance_summary` only, until the NL data classification is signed off | `email, calendar, docs, finance, tasks` |
| `store_content_bodies` | false | false (metadata + summaries only) |
| `indexing_enabled` | false | false → true per source when justified |
| `retention_days` (derived data) | 30 | 90 |
| `cross_lane_summary_allowed` | status-level only | yes (owner only) |
| `write_actions_allowed` | none | email draft/send, calendar, monday, Notion |

**NL security gate.** NL email, documents and Teams content stay blocked from Claude until privilege, CUI, client restrictions, export controls and subprocessor terms are documented and approved. The rest of the portal works normally while NL categories are blocked.

### 5.4 Permissions

| Role | Access |
|---|---|
| `owner` (Robert) | All lanes, consolidated views, Approval Center, settings |
| `finance_operator` (Sophie) | Finance module for assigned lanes; can propose finance actions |
| `viewer` (Management Committee etc.) | Named views in named lanes (e.g. NL weekly cash) |
| `admin_technical` (Saurabh) | Connections, health, jobs, config. **No content access by default.** Break-glass access is time-boxed and logged. NL admin access requires a separate review, and a US-person admin is recommended. |

The core RLS pattern applies to every lane-scoped table in both projects:

```sql
using (
  (auth.jwt() ->> 'aal') = 'aal2'
  and lane_id = any (core.allowed_lanes(auth.uid(), '<view_name>'))
)
```

The NL project isn't queried with user JWTs from the browser. All NL reads go through server routes, which verify the Core session and memberships and then query NL with a scoped server role. Every one of those reads is audited.

---

## 6. Module architecture

Each module is a package with a fixed structure: `domain/`, `tools/` (AI tools), `jobs/` (Inngest functions), `ui/`, and `spec.md`.

### M1 · Platform core
- **Tables:** `core.users`, `core.lanes`, `core.lane_policies`, `core.memberships`, `core.connections`, `core.sync_runs`, `audit.events`.
- **Responsibilities:** session → allowed lanes; lane router; feature flags per lane; audit write API.
- **Audit:** append-only (insert-only grants plus a trigger that blocks update/delete), mirrored to log drains.

### M2 · Connector gateway
One contract for every provider:

```ts
interface Connector {
  provider: Provider;
  connect(laneId, authCode): Promise<Connection>;
  health(conn): Promise<HealthStatus>;
  read<T>(conn, op: ReadOp): Promise<SourceResult<T>>;         // live retrieval
  sync?(conn, cursor): AsyncIterable<RawRecord>;               // metadata/finance sync
  subscribe?(conn): Promise<Subscription>;                     // webhooks / push
  prepareWrite?(conn, intent): Promise<ProposedPayload>;       // never executes
  executeWrite?(conn, action: ApprovedAction): Promise<ExecResult>; // approval engine only
}
```

| Provider | Auth | Live read | Sync / push | Writes (phase 4) | Key caveats |
|---|---|---|---|---|---|
| **Microsoft 365** (per tenant) | One multi-tenant Entra app; admin consent per tenant; delegated tokens per account | Graph: mail, calendarView, Teams chats, SharePoint/OneDrive, Search API | Delta queries for mail and calendar metadata; change notifications (expire within days, so a renewal job is needed) | Draft/send mail, events, Teams reply, file upload | Confirm whether NL is GCC or GCC High (GCC High uses separate Graph endpoints). Graph throttling is per tenant. |
| **Google** (Gmail/Calendar/Drive) | OAuth client, app in **Production** status | Gmail, Calendar, Drive APIs | Gmail history API + Pub/Sub watch (renew weekly); Calendar sync tokens | Draft/send, events, Drive updates | Gmail scopes are restricted; for a single owner the unverified-app warning is acceptable. Testing-mode tokens expire in 7 days. |
| **QuickBooks Online** (per company file) | OAuth 2.0, rotating refresh tokens | Reports API | CDC + webhooks | Draft-only, held in the Approval Center | Intuit production approval |
| **Stripe** (per account) | Restricted read-only key | Events/objects | Webhooks | none | — |
| **TimeSolv** | Verify API | Aged invoices, receipts | Daily pull or emailed-report ingestion | none | API availability unconfirmed |
| **monday.com** | OAuth app | GraphQL boards and items | Webhooks | Create/update items and status | — |
| **Notion** | OAuth integration per workspace | Search, pages, databases | Polling | Create/update pages | — |

Tokens are read from the correct project's Vault inside the connector. Each connection has its own Inngest **concurrency key**, so one tenant's throttling never blocks another tenant.

### M3 · Business Performance (Finance)
Built on the Financial Management System SOP (Notion: *Finance & Operations*).

- **Data:** sync, then serve. Data flows `raw.source_records` → `fin.*` normalized tables (accounts, transactions, invoices, payments, bills, report_cache, subscriptions, budgets, intercompany) → metric views → immutable `fin.snapshots`.
- **Views:** per-firm dashboards; a consolidated owner view (summary table only); a controls-health panel (stale reconciliations over 30 days, disconnected feeds, uncategorized transactions, period locks, NL trust reconciliation *status only*); AR/AP aging; MRR for the Pub K entities; NL↔PK intercompany.
- **Jobs:** `fin.sync`, `fin.qbo_reports`, `fin.weekly_cash` (Sat–Fri, Friday run, approval-gated distribution), `fin.monthly_close`, `fin.intercompany_quarterly`, `fin.controls_daily`.
- **Rules:**
  - Money is stored as `numeric`.
  - Book balances are never labeled as bank balances.
  - No account or routing numbers, compensation tables or client trust ledgers are stored.
  - Entities can map to a QBO file or to a `(file, class)` pair, so Ask Pub K and Pub K Institute can be modeled either way.

### M4 · Assistant
- **Flow:** chat request → lane selection (explicit lane chip; default is the current lane) → Claude tool loop → policy gate on every tool call → streamed answer with source chips.
- **Tools** are registered by each module and are all lane-scoped and read-only:
  - Communications: `search_email`, `read_email`, `list_priority_threads`
  - Calendar: `get_calendar`, `get_meeting_context`
  - Documents: `search_documents`, `read_document`
  - Tasks and commitments: `get_tasks`, `get_commitments`
  - Finance: `get_cash_position`, `get_ar_aging`, `get_pnl`, `get_mrr`, `get_controls_status`
  - Drafting: `prepare_email`, `prepare_event`, `prepare_task_update`, `prepare_document_change`, which create proposals only.
- **Multi-lane questions** use per-lane sub-calls; a composer step sees only the summaries the lane policies allow.
- **Untrusted content** (email bodies, documents, web pages) is wrapped as data, and the system prompt states it has no authority. A prompt-injection suite runs in CI.
- **Conversations** are stored in the lane's own project. A consolidated conversation stores only the composer-level summary.

### M5 · Communications
- **Sources:** Outlook (each tenant), Gmail, Teams chats and channels.
- **Storage:** `comms.message_index` holds metadata only (id, thread, from, to, subject, received_at, flags, lane, source link) plus `priority_score` and an optional approved `summary`. Bodies are fetched live when opened or analyzed.
- **Pipeline:**
  1. Delta sync and push notifications update the index.
  2. The fast model classifies each item: priority, needs-reply, category (finance categories feed M3/monday), and commitment candidate (feeds M7).
- **UI:** a unified priority inbox filterable by lane, thread view, and "draft reply," which creates a proposal in M10.
- **Finance hook:** an email in an entity's Admin inbox that's classified as AP/AR/Tax can create a Monday Finance Intake item (as a proposal, or automatically if Robert approves a standing rule). This replaces the Power Automate step in Sophie's SOP.

### M6 · Calendar & Meetings
- **Storage:** `cal.event_index` holds event metadata (time, attendees, location, lane, source link), synced via Graph delta and Google sync tokens.
- **Meeting prep pack (on demand, or 60 minutes before):** attendee context from recent threads, related documents found by search, open commitments involving the attendees, and agenda suggestions. Generated per lane and cited.
- **Writes (phase 4):** create, move or decline events and propose times, all through M10.

### M7 · Commitments
- **Extraction:** the fast model scans sent mail, Teams messages and meeting notes for statements like "I'll send…" or "we'll deliver by…", and writes `commit.candidates` with source citations.
- **Reconciliation:** each candidate is matched against monday and Notion tasks. Claude proposes "create task," "link to existing" or "dismiss." Nothing is created silently.
- **Tracking:** `commit.commitments` (owner, counterparty, due, status, source refs) feeds the briefing ("3 commitments due this week, 1 overdue").

### M8 · Documents & Search
- **Phase 3, federated live search:** a query fans out in parallel to Graph Search (SharePoint/OneDrive), Drive search and Notion search, only within allowed lanes. Results are merged, de-duplicated and reranked (by Claude or heuristics) and returned with links. Nothing is stored except the query log.
- **Phase 5, selective indexing:** for named folders that Robert opts in, chunk and embed into `docs.chunks` (pgvector) in that lane's project. Store document id, chunk, embedding and an ACL snapshot, and re-check source permissions at read time.
- **Rule:** Notion stays the place for policies and reports, and SharePoint the place for official records. The portal links to them and doesn't duplicate them.

### M9 · Daily Briefing / Home
- **Job:** `briefing.daily` runs at 6:30am ET and on demand.
  1. Fan out per lane (in parallel, each lane's model call within its own policy): calendar today, priority mail, overdue commitments, finance alerts, pending approvals.
  2. A composer call merges the lane summaries into one briefing, with confirmed facts kept separate from recommendations.
- **Storage:** `brief.briefings` holds the rendered briefing plus source references, and expires per the retention policy.
- **Home:** briefing, attention queue, today's meetings, approvals waiting, lane tiles (per-lane KPIs; consolidated for the owner).

### M10 · Approval Center
- **Table:** `act.proposed_actions`, stored in the **lane's own project**, with an index row in the Core control plane (id, lane, type, status only).
- **State machine:** proposed → approved (step-up MFA, payload SHA-256 recorded) → executing (Inngest revalidates hash, access and target state) → verified or failed. A proposal can also be rejected, expire, or be invalidated by an edit.
- **Execution** happens only in `action.execute` (Inngest), with idempotency key = action id, and a read-back to verify the result.
- **UI:** the exact content, sender account, recipients and target, the consequences, and Claude's rationale. Approve, edit (which creates a new proposal), reject or defer. Approval works on iPhone, triggered by a push notification.
- **Excluded until separately designed:** payments, transfers, trust disbursements, QBO posting, deletions and permission changes.

### M11 · Notifications
- **Channels:** web push to installed PWAs, in-app (Supabase Realtime), and an optional email digest.
- **Events:** approval needed, briefing ready, finance red flag, connection failing, commitment due.
- **Content rule:** push payloads contain no sensitive content (e.g. "1 approval waiting — PKG"). Details open in the app after authentication.

### M12 · Memory & Preferences
- **Table:** `mem.items` in the lane's project, holding the lane, the fact or preference, its source, created_at and an expiry date. Global UI preferences live in Core.
- **Rules:** memory is written only from explicit user statements or user-confirmed suggestions. It's viewable and deletable in Settings, and never read across lanes.

### M13 · Admin & Observability
- Connection health board (status, last sync, token expiry, errors), sync run history, job failures, audit log viewer, lane policy editor (owner only), and a feature-flag console.
- Alerts go to the admin for token expiry, webhook subscription failures, sync lag and error-rate spikes.

---

## 7. Data storage policy

| Data | Stored? | Where | Retention |
|---|---|---|---|
| OAuth tokens / API keys | Yes, encrypted | Vault (per project) | Until revoked |
| Email/chat bodies | **No** (fetched live) | — | — |
| Email/chat metadata + priority | Yes | `comms.message_index` (lane project) | 90 days (NL 30) |
| Approved summaries | Yes | Lane project | Per lane policy |
| Calendar metadata | Yes | `cal.event_index` | 180 days |
| Document content | No (federated search); opt-in chunks later | `docs.chunks` | Until source deleted or opt-out |
| Finance structured data | Yes | `fin.*` | 7 years for snapshots |
| Conversations | Yes | `ai.*` (lane project) | 180 days, user-deletable |
| Approvals + audit | Yes, immutable | `act.*`, `audit.*` | 7 years |
| Bank/account numbers, SSNs, compensation, trust client ledgers | **Never** | — | — |

---

## 8. Background jobs (Inngest)

| Area | Functions |
|---|---|
| Connectors | `conn.sync` (per connection), `conn.subscriptions_renew` (Graph/Gmail), `conn.token_health` |
| Communications | `comms.ingest_delta`, `comms.classify`, `comms.finance_intake` |
| Calendar | `cal.ingest_delta`, `cal.meeting_prep` (T-60 min) |
| Commitments | `commit.extract`, `commit.reconcile` |
| Finance | `fin.sync`, `fin.qbo_reports`, `fin.weekly_cash`, `fin.monthly_close`, `fin.intercompany_quarterly`, `fin.controls_daily` |
| Briefing | `briefing.daily` |
| Actions | `action.execute`, `action.expire` |
| Maintenance | `retention.purge`, `index.rebuild` |

Every function takes `lane_id`, uses that lane's database client and Vault, and runs under a per-connection concurrency key.

---

## 9. Security architecture

| Area | Control |
|---|---|
| Identity | Microsoft SSO, MFA enforced in RLS, passkeys where supported, short sessions, step-up MFA for approvals |
| Isolation | Lane RLS in both projects, plus a separate NL project and Vault. The policy gate runs on every tool call. pgTAP and e2e tests prove cross-lane access fails. |
| AI | Entity-locked tools, server-side gate, untrusted-content wrapping, injection test suite, zero-data-retention terms requested from Anthropic |
| Secrets | Vault per project; service keys only in server environment variables; no `NEXT_PUBLIC_` secrets |
| Network | Vercel WAF and rate limits; webhook signature validation (Graph clientState, Stripe, Intuit, monday) |
| Writes | Approval engine only; payment and deletion classes excluded |
| Ops | Named admins, no shared accounts, PITR backups with quarterly restore tests, incident runbook |
| Ownership | GitHub, Vercel, Supabase, Inngest, Anthropic, Intuit, Google Cloud and Entra apps all owned by a Nichols entity |

> **Sign-off required:** Robert's memo assumed Azure, and NL operates in Microsoft GCC. This design uses Vercel, Supabase and Inngest, which are commercial cloud services. The mitigations are a physically separate NL data plane, a policy that blocks NL content from Claude by default, and no storage of bodies. Robert and the NL data classification must approve before any NL email, document or Teams content is enabled.

---

## 10. Repository structure

```
nichols-portal/
├─ apps/web/                       Next.js PWA, route handlers, webhook receivers, Inngest endpoint
├─ packages/
│  ├─ core/                        lanes, lane router, policies, memberships, audit API
│  ├─ connectors/                  contract + m365/ google/ qbo/ stripe/ timesolv/ monday/ notion/
│  ├─ ai/                          LLMProvider, tool registry, policy gate, composer, prompts
│  ├─ modules/
│  │  ├─ finance/  comms/  calendar/  commitments/  documents/
│  │  ├─ briefing/  approvals/  notifications/  memory/  admin/
│  │  └─ (each: domain/ tools/ jobs/ ui/ spec.md)
│  └─ ui/                          design system: KPI card, source chip, lane chip, approval card
├─ supabase/
│  ├─ core/   migrations/ tests/ seed/
│  └─ nl/     migrations/ tests/ seed/
├─ docs/   architecture.md · adr/ · specs/ · runbooks/
├─ CLAUDE.md
└─ .github/workflows/
```

---

## 11. Environments

| Env | Vercel | Supabase | Connectors | Data |
|---|---|---|---|---|
| Local | `next dev` | CLI (Core + NL) | Mock connector server | Synthetic |
| Preview | Per PR | Staging Core + Staging NL | Mocks / sandboxes | Synthetic |
| Staging | `staging` | Staging projects | M365 dev tenant, Google test account, QBO sandbox, Stripe test | Synthetic + sandbox |
| Production | `main` | Prod Core + Prod NL (PITR) | Real accounts | Real |

---

## 12. Delivery phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 · Discovery** (wk 1–2) | Account inventory, lane policies, entity/QBO mapping, sign-offs, developer accounts | Decisions in Section 14 closed |
| **1 · Platform** (wk 2–4) | M1, M2 skeleton, PWA, auth/MFA, both Supabase projects, audit, admin health | Mac/iPhone install, login, lane isolation tests pass |
| **2 · Finance + Assistant** (wk 4–9) | M3 all firms, M4 with finance tools, M11 basics | Figures tie out to Sophie's reports for 2–3 weeks |
| **3 · Comms, Calendar, Search** (wk 8–14) | M5, M6, M8 (federated), connectors for M365/Google | Source-grounded read-only answers across allowed lanes |
| **4 · Briefing, Commitments, Approvals** (wk 13–18) | M9, M7, M10, M12; first writes (drafts, monday, Notion, calendar) | Unapproved actions cannot execute; edits invalidate approval |
| **5 · Hardening + indexing** (wk 18–22) | Pen test, injection suite, restore drill, selective indexing, NL gate review | Production acceptance |

---

## 13. Key risks

| Risk | Mitigation |
|---|---|
| Commercial cloud vs NL GCC | Separate NL plane, content blocked by default, formal sign-off |
| Consent across 5+ M365 tenants and Google | Start in week 1; consent tracker in M13 |
| Graph/Gmail subscription expiry and throttling | Renewal jobs, delta fallback, per-tenant concurrency |
| Prompt injection via email/docs | Tools read-only by default; approval engine; CI injection suite |
| Vendor API gaps (TimeSolv, Paychex, QBO reconciliation) | Fallbacks documented per connector |
| Over-collection of sensitive data | Storage policy (Section 7); no bodies stored; retention purge job |
| Single developer | ADRs, specs, Nichols-owned accounts, reproducible environments |

---

## 14. Decisions needed

1. Exact account inventory per lane: M365 tenants (and GCC vs GCC High for NL), Google accounts, QBO files, Stripe accounts, monday and Notion workspaces.
2. APK / PKI / NC mapping: own QBO file or class. Is Downeaster in scope?
3. Sign-off on Vercel + Supabase + Inngest, and on the NL data-plane approach.
4. Initial lane policies (Section 5.3), especially which categories are allowed for Claude per lane.
5. Access matrix (Section 5.4) and the NL administrator arrangement.
6. Whether true bank balances (Plaid) are needed or book balances are sufficient.
7. Ownership of all production accounts.

---

## 15. CLAUDE.md — rules for Claude Code

1. Every function, query, job and tool takes `laneId`. Get database clients only from the lane router.
2. Any new table needs `lane_id`, RLS policies and pgTAP tests in the same PR, in both projects where applicable.
3. External APIs are called only through `packages/connectors`. Tokens are read only from Vault.
4. Nothing writes to an external system except `packages/modules/approvals`.
5. Never store email or chat bodies or document content unless the lane policy explicitly allows it.
6. Figures come from SQL. AI output never writes to financial tables.
7. Retrieved content is untrusted data. It never changes tool permissions.
8. Use synthetic data and mocks only. Never put real credentials or records in code, tests or prompts.
9. Money is `numeric`; time is `timestamptz`; the business week is Sat–Fri America/New_York.

**Next step:** finalize the app's sections, pages and navigation, then write one spec per module in `docs/specs/` for Claude Code to build from.
