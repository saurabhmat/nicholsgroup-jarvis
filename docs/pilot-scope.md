# Pilot scope — Pub K Group lane

**Owner:** Saurabh Gopal · **Sponsor:** Robert Nichols · **Release A (pilot) live:** Nov 25, 2026 · **Robert testing:** Nov 30 – Dec 4 · **Release B + rollout to other companies:** Dec 7 – 31 · **All functionality complete:** Dec 31

## Goal
Build the complete Executive Portal for **one lane, Pub K Group (PKG)**, as a reusable template. Every later company (Ask Pub K, Pub K Institute, Nichols Capital, Nichols Law finance) must be onboarded by **configuration only**, not new code.

## Hard rules for the pilot
- Multi-lane by design: every table, query, job, AI tool, cache and memory item carries `lane_id`. Only `PKG` is enabled.
- No company-specific code. QuickBooks realm, Stripe account, GoHighLevel location, mailboxes, KPIs, priority senders and approval rules live in lane configuration.
- Synthetic data and sandboxes during development; real Pub K Group data only in staging/prod via connectors.
- Every figure comes from SQL over synced source data. Claude explains and drafts; it never produces numbers.
- No write to any external system except through the Approval Center (proposal → Robert approves exact content → execute once → verify → audit).

## Releases
- **Release A — live Nov 25 (Pub K Group):** platform core (sign-in + MFA, lanes, roles, audit), connectors (QuickBooks, Stripe, GoHighLevel, mail/calendar), finance, assistant, priority inbox + reply drafts, calendar (view), daily briefing, admin/health, Approval Center for **email send and monday.com updates**. Approvals switch on for PKG only after the pilot security test passes.
- **Release B — Dec 7 – 31:** federated search + opt-in indexing, meeting prep packs, calendar actions, Notion writes, commitments, memory, projects view, notification polish; then onboarding of the other companies.

## Modules (all 13 across Releases A and B)
| Module | Pilot content |
|---|---|
| Platform core | Sign-in + MFA, lanes, roles (owner, finance, viewer, admin), audit log, settings |
| Connector gateway | QuickBooks (PKG file), Stripe, GoHighLevel, mail/calendar/documents for pub-k.org, monday.com, Notion |
| Finance | Cash (book balance), AR/AP aging, P&L MTD/YTD, MRR and churn (Stripe), paid subscribers (GoHighLevel), controls panel, weekly cash report (Sat–Fri), monthly snapshot |
| Assistant | Q&A over PKG data with source citations; read-only tools |
| Communications | Priority inbox (metadata + AI priority), reply drafts → Approval Center |
| Calendar & Meetings | Unified calendar, meeting prep pack |
| Documents & Search | Live federated search; opt-in folder indexing |
| Daily Briefing | Morning summary (time configurable, default 6:30 am ET) |
| Notifications | Web push to Mac and iPhone PWA; no sensitive text in push payloads |
| Admin & Observability | Connection health, sync runs, audit viewer |
| Approval Center | Email send, calendar changes, monday.com and Notion updates |
| Commitments | Extract promises from mail/meetings; match to monday.com/Notion tasks |
| Memory & Preferences | Per-lane, explicit-only, viewable and deletable |

## Data sources for PKG
| Source | Use | Auth | Notes |
|---|---|---|---|
| QuickBooks Online (PubKGroup file) | Ledger, reports, AR/AP, book balances, reconciliation info | OAuth 2.0 (Intuit app) | Sandbox until Intuit production approval |
| Stripe | Revenue: subscriptions, invoices, charges, payouts, MRR, churn | Restricted read-only key | Source of truth for revenue |
| GoHighLevel | Paid subscribers, new/cancelled, trial→paid, failed payments, by product | Private Integration token (read-only scopes) | Subscriber view only; do not count revenue from GHL |
| Mail / calendar / documents (pub-k.org) | Inbox, calendar, search | **Google Workspace or Microsoft 365 — see open decision 1** | Bodies fetched live, never stored |
| monday.com | Projects, tasks, commitments matching | API token | IT workspace boards; shared Company + Exec Priority columns exist |
| Notion | Report pages, search | Internal integration | Pages must be shared with the integration |

## Explicitly out of the pilot
- Nichols Law Microsoft 365 tenant (no access; NL email/docs via Claude Enterprise)
- Plaid / live bank balances
- Payments, transfers, trust disbursements, QuickBooks posting, deletions, permission changes
- Paychex

## Success criteria
1. PKG finance figures tie out to QuickBooks reports and the weekly cash report for **two consecutive weeks**.
2. Robert uses the briefing and approvals **daily for one week** (Nov 30 – Dec 4).
3. Internal security test passes with **no open blocker/high findings**.
4. Ask Pub K onboarded from the playbook in **under 3 days** without code changes.

## Decided
- Sign-in: Supabase email code / magic link + Supabase TOTP MFA (AAL2); independent of any tenant. Email delivery via Resend.
- Approvals: live for PKG on Nov 25 after the pilot security test; Dec 29 applies to other lanes.
- Next.js 16 + pnpm workspaces + Turborepo.
- PKG figures exclude Ask Pub K and Pub K Institute via `lane_config` mapping (QuickBooks classes, Stripe products, GoHighLevel tags/products).
- GoHighLevel subscriber counts also exclude Ask Pub K and Pub K Institute (D-17).
- Shared bank accounts (D-18): cash book balance is shown per account under the entity that legally owns the account; no allocation. A shared account is flagged in the controls panel (the SOP requires separate accounts per entity). P&L and aging are split by QuickBooks class where available, otherwise by customer mapping in `lane_config`. Stripe payouts are shown at account level; revenue is split by product from charges/invoices.
- Federated search (D-16): Release B.

## Open decisions (Claude Code: ask before assuming)
1. pub-k.org email/calendar/docs provider: Google Workspace or Microsoft 365. **Build both connectors behind the same interface; enable the confirmed one.**
2. Pilot KPI list (default: cash book balance, AR >30 days, AP due 14 days, P&L MTD/YTD, MRR, churn, paid subscribers, controls).
3. GoHighLevel definition of "paid subscriber" (tag / pipeline stage / product).
4. Pilot users and roles: Robert owner, Saurabh admin, **Sophie finance operator** (generates and signs off reports). — DECIDED
5. Production domain (default: `portal.pub-k.org`).
6. Design sign-off (D-20, PL-26): Robert signs off the Claude Design prototype Nov 5–6. **Do not build the app shell or screens until then**; provisional tokens and layout are in `docs/plan-review.md` §7.
