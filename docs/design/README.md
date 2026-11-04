# Design record

The signed-off screens that screen tasks build to. Tokens live as CSS variables in `packages/ui` (T-022); this file says which values are final and what each screen must show.

## Batch 1 — signed off Nov 4, 2026 (D-20)

- **Source:** `Jarvis_Pilot_Prototype_Batch1_v2` (PDF, 7 pages; to be saved here, H-030). Canvas: https://claude.ai/artifact/FuyFYrgeWUsgCscdB3tsgA
- **Approved by:** Saurabh Gopal for Robert Nichols, Nov 4, 2026, together with every change below.
- **Figures in the prototype are placeholders** ("Sample data"). The live app never shows the "Sample data" label; synthetic previews may.

| Page | Screen | Built in |
|---|---|---|
| 2 | Sitemap and navigation | T-023, T-024 |
| 3 | Home, daily briefing (desktop) | T-163 |
| 4 | Finance at a glance (desktop) | T-095 |
| 5 | Approvals (desktop) | T-115 |
| 6 | Home (iPhone) | T-163 |
| 7 | Approvals (iPhone) | T-115 |

### Tokens (final)
The v2 tokens in `docs/plan-review.md` §7 "Provisional design tokens" are final: Source Serif 4 headings with an italic accent word, Inter body with tabular numbers, cream ground `#F7F4EC`, white cards, navy `#0E2A47`, gold `#D4AF5A` for decoration only, radius 8px controls / 12px cards, navy side menu with a 3px gold edge on the active item.

- **Light only** in the pilot. No dark mode until Release B.
- **Chart palette** (Recharts), in this order. Each colour is at least 4.5:1 on white and on cream:

| Use | Colour |
|---|---|
| Primary / positive series (Current, New) | navy `#0E2A47` |
| Secondary positive (1–30 days, Expansion) | blue `#3B6EA5` |
| Warning (31–60 days, Contraction) | orange `#B45309` |
| Worst (60+ days, Churned) | brown `#7C2D12` |

Every bar has a text label and value, so colour is never the only cue. Prototype pages 4 and 3 used two similar oranges; the palette above replaces them.

### Navigation (T-023, T-024)
- **Desktop:** navy side menu. "Pub K" wordmark with a gold star, then "Jarvis · Executive Portal", then the company switcher, then Home · Finance · Inbox · Calendar · Approvals (count badge) · Assistant · Settings. Content max-width 1200px.
- **iPhone:** navy header band with the company switcher; bottom tabs Home · Approvals · Inbox · Ask · More. Tabs have no back link (drop page 7's "‹ Home"); a back link appears only on pages pushed from another page.
- **Company switcher:** lists only lanes that are enabled and allowed for the user. In the pilot that is Pub K Group. Ask Pub K, Pub K Institute, Nichols Capital and Nichols Law (finance) appear when their lanes switch on. **"All companies (owner)" is after the pilot** and needs its own decision (a view across lanes).
- **Projects is hidden in the pilot** (Release B, T-150): no menu entry and no "Projects at a glance" on Home. Search and Commitments are Release B too.
- The approvals badge counts the selected lane only.

### Required changes to the prototype
1. **Book balance in full (rule 7).** iPhone Home says "Cash (book)". Use "Cash (book balance)" everywhere; the abbreviated figure ("$[000k]") is fine.
2. **Approve the exact payload (rule 5).** The approval card shows everything that will be sent or changed:
   - Email: from (sending mailbox), to, cc, bcc, subject and the body with its line breaks exactly as it will be sent. No attachments in Release A. On iPhone the body is not reflowed into one paragraph; long bodies scroll inside the card.
   - monday.com: board, item, field, and the value before → after.
3. **Edit on iPhone.** iPhone approvals get Edit next to Reject and Approve & send, as on desktop. An edit creates a new payload that is approved on its own.
4. **Freshness on every figure.** Each figure card on Home and Finance carries the source chip from `packages/ui` (source, as-of time, live/cached/stale). A disconnected feed marks its figures stale. The briefing keeps "Sources … updated 6:30 am ET".
5. **Finance period toggle.** "This week" is the Sat–Fri business week (shown as "This week (Sat–Fri)" or with dates on hover). The toggle drives the cards that depend on a period (net income, MRR movement); "Bills due in 14 days" and the aging card are point-in-time and say so.

### Rules the prototype already follows (keep)
- "Nothing is sent or changed until you approve it" on Approvals; approving asks for the authenticator code (step-up, T-021).
- "Cash · book balance — Per QuickBooks, not the bank" and a "Book balance" column on Finance.
- Subscriptions card: "Revenue: Stripe · Subscribers: GoHighLevel" (rule 8).
- Weekly cash report Sat–Fri awaiting Sophie's sign-off; month-end snapshot "Signed off · locked".
- "Why Jarvis suggests this" shows its sources; it is explanation only and never triggers anything (rule 9).

### Not in batch 1 (build with the existing `packages/ui` states, restyle later if needed)
- Empty, loading, error and "connection lost" states: use T-022's components.
- Sign-in and authenticator pages (T-018, T-019): restyle to these tokens, no layout change.
- App icon: H-029 (blocks T-025).
- Meeting provider label ("Teams" on page 3) is sample text; D-1 is open.

## Batch 2 — pending (D-21)
Inbox, Calendar, Assistant, Projects, Settings (connections and health, sync/audit viewer, lane config), Finance detail and weekly report pages.
