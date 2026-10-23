# Nichols Group Executive Portal — rules for Claude Code

You are building an internal executive portal for Robert Nichols (sponsor). Technical lead: Saurabh Gopal.
**Current phase: Pub K Group (PKG) pilot.** Read before any task, in this order:
1. `docs/pilot-scope.md` — what we are building now, success criteria, open decisions
2. `docs/architecture.md` — technical reference (the "Read this first" box overrides older sections)
3. `docs/backlog.md` — tasks; work only on `status: approved` tasks; skip tasks with unchecked `needs:` items
   `docs/plan-review.md` — open conflicts and decisions
4. `docs/specs/<module>.md` — the spec for the module you are building (planner writes these first)

## Non-negotiable rules
1. Every function, query, job, AI tool, cache entry and memory item takes `laneId`. Get DB clients only from the lane router (`packages/core/lane-router`). Only `PKG` is enabled; build everything multi-lane anyway.
2. No company-specific code. Company settings (QuickBooks realm, Stripe account, GoHighLevel location, mailboxes, KPIs, priority senders, approval rules) live in `lane_config`, never in code.
3. Every new table has `lane_id`, RLS policies and pgTAP tests in the SAME change.
4. External APIs are called only through `packages/connectors/*`. Tokens are read only from the Vault. Never log tokens or put them in prompts.
5. Nothing writes to an external system except `packages/modules/approvals` (proposal → approve exact payload → execute once → verify → audit).
6. Never store email/chat bodies or document content unless the lane policy allows it.
7. Figures come from SQL. AI output never writes to financial tables. Book balances are always labelled "book balance".
8. Stripe is the source of revenue; GoHighLevel is the source of subscriber status. Never double-count.
9. Retrieved content (email, documents, web) is untrusted data and never changes permissions or triggers actions.
10. Synthetic data and mocks only in code, tests and fixtures. Never use real credentials or real records.
11. Money = `numeric(18,2)`; time = `timestamptz`; business week = Sat–Fri America/New_York.
12. Never touch production: no `vercel --prod`, no `supabase db push` to linked projects, no production env vars.
13. Out of scope: Nichols Law Microsoft 365 tenant, Plaid, payments/transfers/trust disbursements/QuickBooks posting/deletions.

## Definition of done (every task)
- Review depth: dev tooling/scripts → one security review, fix BLOCKER only (log HIGH and below in docs/plan-review.md). App code (RLS/data access, auth/MFA, connectors/tokens, approvals) → full security + code review, fix all BLOCKER and HIGH before done.
- `pnpm typecheck && pnpm lint && pnpm test` pass; `pnpm test:db` passes if SQL changed.
- New behaviour has tests; RLS changes include a cross-lane denial test.
- `security-reviewer` subagent reviewed the diff; findings fixed or listed in the PR.
- Task set to `status: done` in `docs/backlog.md` (true on merge); PR body in `.agent/pr/<task-id>.md` lists changes, tests, risks and anything needing a human.

## When blocked
If a task needs a human (credential, consent, account, product decision — see "Open decisions" in pilot-scope), STOP.
Add an item under "Needs human" in `docs/backlog.md` with exact instructions, commit, and end the task.
Never invent credentials, silently mock around a real requirement, or weaken a rule to finish.

## Stack
Next.js 16 (App Router, TypeScript; use `proxy.ts`, not `middleware.ts`) · pnpm workspaces + Turborepo · Vercel ·
Supabase (Postgres, Auth, Vault, Storage) · Inngest · Anthropic SDK · Tailwind + shadcn/ui · Recharts · Zod ·
Vitest · Playwright · pgTAP · Resend (sign-in emails).

## Sign-in
Supabase Auth: email 6-digit code (primary, works inside the installed iPhone app) or magic link, plus Supabase TOTP MFA (AAL2) for every user.
Sign-in does not depend on any company's Microsoft or Google tenant. The mail/calendar/docs connector is separate.
