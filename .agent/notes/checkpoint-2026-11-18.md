# Checkpoint for Nov 18, 2026

**Where things stand:**
- Checkout: `~/dev/pubk-projects/jarvis/pilot-build`, branch **`docs/microsoft-connector-plan`**, ahead of origin/main, **not pushed** (Saurabh pushes).
- origin/main = `fef3dae`, with T-249 merged.
- Today was planning only. No code, no migrations, nothing approved.

## What was planned today: Microsoft 365 connector
- **Spec:** `docs/specs/microsoft.md` (status proposed). **PR body:** `.agent/pr/plan-microsoft.md`.
- **Tasks (all `status: proposed`)**, in the new backlog section "Phase B9 — Microsoft 365 mail and calendar", in build order:

| Step | Tasks |
|---|---|
| Groundwork (provider per lane, multi-tenant settings, Google-only SQL and sync code made generic) | T-250, T-251, T-254, T-252, T-253, T-255 |
| Connect ("Connect Microsoft", admin-approval message, Settings + Disconnect) | T-256, T-066, T-257 |
| Mail | T-258, T-259, T-260 |
| Calendar | T-067, T-261 |
| Drafts and sending (approvals only) | T-262, T-263 |
| Go live (enable `NC` lane; PKG cut-over from Google) | T-265, T-266 |
| Notifications | T-068, T-264 |
| Only if needed (GCC High; shared mailboxes) | T-267, T-268 |

- T-066, T-067 and T-068 keep their ids but were rewritten and moved from Phase A5 to Phase B9.
- **Every Microsoft fact in the spec is from memory**, listed as V-1 to V-22 in spec §15, each tied to a task. Check each against Microsoft's documentation before building that task.

## Facts from Saurabh (Nov 18)
- Four domains stay in use: pub-k.org, pubkgroup.com, nichols.law, nichols.capital. Robert will have four addresses.
- nichols.law is on Microsoft GCC today, Microsoft 365 G3 licence. GCC or GCC High is not confirmed (H-064).
- The other three will move to GCC. The date is not known, and it is not known whether they join the nichols.law tenant or get their own.
- nichols.capital is on a standard (commercial) Microsoft 365 licence today.
- Saurabh has his own nichols.law account.

## Decisions
| Id | State | What |
|---|---|---|
| D-48 | decided | Native Microsoft Graph connector in scope now; provider per lane; PKG stays on Google until its mailboxes move; each domain's mail in its own lane (PKG, NC, NL) |
| D-50 | decided | First live Microsoft test: Nichols Capital, mail and calendar only |
| D-54 | decided | One mail provider per lane |
| D-55 | decided | Microsoft Disconnect is local, without approvals |
| D-49 | open, Robert | GCC content through commercial services. Saurabh said "no legal constraints"; Robert has not confirmed |
| D-51 | open, Robert | Nichols Law mail in the portal (in scope, separate database, AI may read it, who connects). CLAUDE.md rule 13 is unchanged until decided |
| D-52 | open, Robert | Teams in the portal; open point is the lane of a chat when companies share a tenant |
| D-53 | open, Robert | Claude and ChatGPT in the app; recommended: chat section with a model picker plus launch buttons; OpenAI would be a new data recipient |
| D-56 | open | Where the first live test runs (see below) |

## Human items added
- H-062 register the Microsoft app (`GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` in `.env.local`).
- H-063 nichols.capital tenant admin, admin approval, test mailbox.
- H-064 GCC or GCC High for the nichols.law tenant (Outlook on the web address ends in `.com` or `.us`).
- H-065 migration team: tenant layout, how Robert's four addresses are set up, dates, whether Drive files move.
- H-066 to H-073 (from the planner): synthetic Microsoft test tenant, publisher verification (optional), production setup, enabling `NC`, and the live checks.

## Waiting on Saurabh (start here tomorrow)
1. **Approve tasks?** Suggested first batch: T-250 through T-257 (groundwork and connect). They are built on fakes and need no Microsoft account. T-250's only open need (D-54) is now decided.
2. **D-56, the live test.** Saurabh proposed testing with his own nichols.law account. Not recorded as decided, because it needs:
   - Robert's decision that a nichols.law mailbox may be connected at all (D-51, rule 13);
   - Robert's confirmation on GCC content (D-49);
   - the Nichols Law tenant admin (Integris, per the docs) approving the app, if users cannot;
   - the cloud (H-064): GCC High is not built until T-267.
   The options that need nobody else: the synthetic test tenant (H-066), then nichols.capital (D-50). Saurabh to say which, or take the nichols.law test to Robert.
3. **H-064** can be answered now from Saurabh's nichols.law account.
4. **Push** the branch `docs/microsoft-connector-plan`.

## Notes
- `node scripts/next-task.mjs --explain` reports T-105 and T-106 as malformed (`- approved:` lines). This is already on main and was not touched.
- The planner noted that T-244 to T-247 have no entries in `docs/backlog.md` (only `.agent` files), so the new tasks depend on earlier done tasks instead.
- Teams and the AI chat section have no spec or tasks yet. They wait for D-52 and D-53.
