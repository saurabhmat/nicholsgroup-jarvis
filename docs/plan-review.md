# Pilot plan review — Pub K Group

Planning pass over `CLAUDE.md`, `docs/architecture.md` (v0.2 + amendments), `docs/architecture-v0.3-sponsor.pdf` and `docs/pilot-scope.md`, done on Oct 23, 2026. The task list is in `docs/backlog.md`.

## 1. Pilot scope in one page

- **What:** the full Executive Portal (all 13 modules) for one lane, **Pub K Group (PKG)**, built as a template so the other lanes (APK, PKI, NC, NL finance, P) are switched on by `lane_config` only.
- **When:** build Oct 26 – Nov 25 · Robert tests Nov 30 – Dec 4 · rollout to other companies Dec 7 – 18 · everything complete Dec 31.
- **Sources:** QuickBooks (PKG file), Stripe (revenue), GoHighLevel (subscriber status, no revenue), pub-k.org mail/calendar/docs (Google **or** Microsoft, both built behind one interface), monday.com, Notion.
- **Invariants:** `lane_id` + RLS everywhere; figures only from SQL; no stored bodies; tokens only in Vault via connectors; external writes only through the Approval Center; synthetic data in dev.
- **Out:** Nichols Law M365 tenant, Plaid, payments/transfers/trust/QBO posting/deletions, Paychex.
- **Success:** (1) figures tie out to QBO + the weekly cash report for 2 consecutive weeks; (2) Robert uses briefing + approvals daily for a week; (3) no open blocker/high security findings; (4) Ask Pub K onboarded in <3 days with no code changes.

## 2. Repo state vs. the docs

| Docs say | Repo has | Effect |
|---|---|---|
| Next.js 15 | Next.js **16.4.3** (`AGENTS.md` warns about breaking changes, e.g. `proxy.ts` replaces `middleware.ts`) | D-7. Recommend staying on 16 and updating CLAUDE.md. |
| pnpm + Turborepo, `apps/web` | Single npm app at the root with `package-lock.json` | T-001 converts it. |
| `.claude/` agents (planner, builder, …), `/build-task`, `.agent/`, `.github/`, `scripts/`, `CLAUDE.md`, `docs/*` | **None of them are in the repo** | H-015. `run-backlog.sh` and `/build-task` cannot run until they are added. |
| `next-task.mjs` gates on dependencies | It only parses `T-xxx` IDs | Human items and decisions are in a separate `needs:` field that the script ignores. Approve tasks only when their `needs` are closed, or extend the script. |

## 3. Contradictions between the docs

1. **Sponsor PDF (v0.3, Oct 18) is behind the amendments in `architecture.md`.** The PDF still has Nichols Law fully in scope through Integris (M365 email, Teams, SharePoint) and a separate NL Supabase project. The amendments say the NL tenant is not accessible and the NL data plane is deferred. The PDF also leaves out GoHighLevel and the PKG-first pilot. Robert would be signing a document that no longer matches the plan.
2. **Dates.** PDF: design sign-off Nov 11, platform ready Nov 20, finance complete Dec 4, go-live Dec 22, actions Dec 29 after a Dec 17–23 security test. Pilot scope: build by Nov 25, and Robert uses **approvals daily** Nov 30 – Dec 4. So either the Approval Center goes live before its own security test, or success criterion 2 can't be met (D-11).
3. **Sign-in.** The architecture says Microsoft SSO for everyone; T-006 in the old backlog said "the confirmed provider" for pub-k.org. These are two separate decisions: the portal identity (one IdP for Robert across all lanes) vs. the PKG mail provider (D-6).
4. **MFA.** Supabase RLS checks `aal2`, which comes only from **Supabase MFA** (TOTP/phone) and not from MFA done at the IdP. Users will need to enrol a Supabase factor on top of SSO (D-6).
5. **Roles.** Pilot scope uses "owner, finance, viewer, admin" and lists Sophie as "finance viewer". The architecture uses `finance_operator` (generates and signs off reports) and `admin_technical`. If Sophie is a viewer, nobody can sign off the weekly snapshots (D-4, D-14).
6. **monday.com / Notion auth.** Pilot scope: API token / internal integration. Architecture §6: OAuth app / OAuth per workspace. The backlog follows the pilot (token/internal) and keeps the connector behind the same contract.
7. **"Projects" module.** It is in the requested module list and old T-039, but it isn't one of the 13 modules. Planned as a monday.com rollup in the Projects package (T-150).
8. **Admin sees no figures, but Saurabh drives the tie-out.** Tie-out (success criterion 1) needs someone with finance access. That should be Sophie, or Saurabh with time-boxed, logged break-glass access.
9. **Scheduling proposals / email digest.** The PDF and architecture list these (calendar scheduling proposals, M11 email digest); pilot scope doesn't. Scheduling proposals are included (T-133); the email digest is left out.
10. **Downeaster** appears in architecture §5.1 only. It isn't seeded.

## 4. Gaps

- **Entity boundary (D-8).** If Ask Pub K / Pub K Institute are classes inside the PKG QuickBooks file, or share PKG's Stripe account, PKG figures must exclude them. `lane_config` supports `(file, class)` mapping, but someone has to state which applies before the tie-out.
- **Metric definitions (D-9, D-3).** MRR/churn rules and the GHL paid-subscriber rule aren't written down. These drive success criterion 1.
- **Tie-out reference data.** Nobody has said where Sophie's manual weekly cash report comes from, or in what format. T-094 assumes manual entry of reference figures.
- **Real data timing.** Tie-out for two consecutive weeks inside the window means real PKG data in staging by about Nov 7. That needs **Intuit production approval** (sandbox data can't tie out), live Stripe/GHL keys in staging and a staging Supabase project. This is the critical path.
- **Meeting notes source (D-12)** for Commitments and prep packs isn't defined for pub-k.org.
- **Embeddings (D-13).** Anthropic has no embeddings API, so opt-in indexing needs another provider. That is a new subprocessor and needs sign-off.
- **Migrations to staging.** Rule 12 forbids agents from running `supabase db push`. Staging migrations need a human or CI step (T-171).
- **iOS push** works only for an installed PWA on iOS 16.4+. Robert's device needs checking.
- **Gmail restricted scopes.** Using an Internal-type OAuth app inside the pub-k.org Workspace avoids Google verification. That only works if D-1 = Google.

## 5. Schedule risk

*Updated Oct 23 after D-10.* The backlog is now split into **Release A (119 tasks, due Nov 25)** and **Release B (17 tasks, Dec 7 – 31)**. Release A alone is still about **5× the ~22 working days** in the pilot window (Oct 26 – Nov 25). The D-10 cut moved out modules that were already small; the bulk is platform, connectors and finance, which are all must-haves.

The security test (T-170) also has to finish before Nov 25, so in practice Release A needs to be feature-complete around **Nov 18–20**.

More ways to cut Release A, roughly by size:
1. **Build only the confirmed mail provider** (−3 tasks, and less test/review load). This needs D-1 soon.
2. **Defer federated search** (D-16): −2 tasks, and meeting prep (T-132) loses its related-docs section.
3. **Merge small tasks during the build.** Many platform tasks (e.g. T-014/T-015, T-016/T-017, T-030/T-034) will take less than half a day each with Claude Code. Sizes will firm up after T-001 – T-020, and the forecast should be re-run then.
4. **Accept a later approvals go-live for PKG** (e.g. at the start of Robert's test week, Nov 30) if T-170 slips. This keeps success criterion 2 without skipping the test.

## 6. Everything needed from you

Listed in `docs/backlog.md` → **Needs human**. As of Oct 23 the most urgent are:
1. **H-015** — the planning pack is still not in this repo (see §8). This blocks T-000 and the `/build-task` workflow.
2. **D-1** — the pub-k.org mail provider. Deciding it frees about three Release A tasks.
3. **D-8 / D-17 / D-18** — entity mapping for excluding APK/PKI, before finance tie-out.
4. **H-016** — an SMTP sender for magic-link/OTP email in staging.
5. **D-15** — design sign-off; navigation work (T-024) waits on it.

## 7. Decisions recorded (Oct 23, 2026)

| # | Decision | Backlog effect |
|---|---|---|
| D-7 | Keep Next.js 16 (`proxy.ts`), pnpm workspaces + Turborepo | T-001 has no open needs → ready for approval |
| D-6 | Supabase email magic link + Supabase TOTP (AAL2) for all users; sign-in separate from mail | T-018/T-019/T-021 rewritten; H-016 (SMTP) added |
| D-10 | Release A by Nov 25 / Release B Dec 7–31 | Backlog split into two releases; new T-180 – T-185 for the split-off parts |
| D-11 | PKG approvals live Nov 25 after the pilot security test; Dec 29 for other lanes | T-119 go-live flag; T-170 is the gate; T-184 covers other lanes |
| D-4 (part) | Sophie = finance_operator | T-012, T-089 updated |
| D-8 (part) | PKG excludes APK and PKI via lane_config mapping; IDs pending Sophie | T-011 mapping; T-082 – T-086, T-172 need D-8 |
| H-005 | Intuit production assessment submitted | H-017 added for the approval itself |
| — | `next-task.mjs` should honour `needs:` | T-000 added |

## 8. Further conflicts and risks after the Oct 23 decisions

1. **The planning pack is not in this repo.** The Oct 23 message said it had been copied in, but the working tree at `/home/saurabh/dev/pubk-projects/nicholsgroup-jarvis` has no `CLAUDE.md`, `.claude/`, `.agent/`, `.github/`, `scripts/` or `docs/pilot-scope.md`, and nothing similar exists in sibling folders. It may have gone to another path or not been saved. So the updated CLAUDE.md stack line couldn't be checked, and T-000 has no `scripts/next-task.mjs` to modify.
2. **Sign-in contradicts the architecture and sponsor PDF.** Both say Microsoft sign-in. D-6 (email magic link + TOTP) should be reflected in `docs/architecture.md` §4/§9 and the sponsor PDF before Robert signs.
3. **Magic links and the installed iPhone PWA.** On iOS, an emailed link opens in Safari, not the installed PWA, which has separate storage. So the user ends up signed in in the wrong place. T-018 therefore also supports entering the 6-digit email OTP code (the same Supabase flow).
4. **Account security depends on the mailbox.** With magic links, whoever controls the inbox gets AAL1. TOTP is the real second factor, so a TOTP reset must not be self-service. T-019 requires an audited, admin-assisted reset; decide whether the owner must approve it, since admin_technical shouldn't be able to take over Robert's account alone.
5. **Pilot scope vs. D-10:**
   - pilot-scope.md lists all 13 modules in the pilot, including Commitments and Memory (now Release B).
   - It lists Approval Center targets as email, calendar, monday.com and Notion (now email + monday.com only).
   - It has Sophie as "finance viewer" (now finance_operator).

   `pilot-scope.md` is unchanged as instructed, so it is now out of date on these points.
6. **Sponsor PDF dates vs. D-11.** The PDF says the action modules switch on Dec 29 for everyone. D-11 brings PKG forward to Nov 25.
7. **Search and basic notifications are not in either D-10 list.** Both are placed in Release A (D-16; notifications are needed for approval alerts on iPhone).
8. **Excluding by class is clean only for P&L.** QBO classes split income and expense well, but not balance-sheet items:
   - Cash book balance (D-18) can't be split by class reliably.
   - AR/AP aging may not be class-filterable through the Reports API; verify in T-052. If it isn't, compute aging from class-tagged invoices/bills (T-083/T-084 already use `fin.*`) and tie out to a class-filtered report Sophie runs in QBO.
   - Stripe payouts and balance are per account, not per product, so only MRR/churn/revenue can exclude APK/PKI products.
9. **GoHighLevel exclusion isn't specified** (D-17). Subscriber counts could include APK/PKI subscribers while MRR excludes them, which would make the Stripe-vs-GHL control (T-088) report false mismatches.
10. **The tie-out window is tight.** Two consecutive weeks before Nov 25 means the live QuickBooks file must be in staging by about Nov 7–10 (H-017). If Intuit approval is late, criterion 1 moves past the pilot window.
