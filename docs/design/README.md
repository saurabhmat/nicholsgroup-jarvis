# Design record

The signed-off screens that screen tasks build to. Tokens live as CSS variables in `packages/ui` (T-022); this file says which values are final and what each screen must show.

## Batch 1 — signed off Nov 4, 2026 (D-20)

- **Source:** `Jarvis_Pilot_Prototype_Batch1_v2` (PDF, 7 pages). Screenshots of every page are in [`batch1/`](batch1/) (from Saurabh, Nov 4, 2026); the PDF itself is H-030. Canvas: https://claude.ai/artifact/FuyFYrgeWUsgCscdB3tsgA
- **Approved by:** Saurabh Gopal for Robert Nichols, Nov 4, 2026, together with every change below. Saurabh's answers the same day: Projects is shown (Release A, from monday.com), "All companies" comes after the pilot, the tokens are final, and the app has light and dark mode.
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

- **Chart palette** (Recharts, tokens `--chart-1` … `--chart-4`), in this order. Light colours are at least 4.5:1 on white and cream; dark colours at least 3:1 on dark cards (the WCAG level for graphics):

| Use | Light | Dark |
|---|---|---|
| Primary / positive series (Current, New) | navy `#0E2A47` | `#9DB9DC` |
| Secondary positive (1–30 days, Expansion) | blue `#3B6EA5` | `#5B8FCB` |
| Warning (31–60 days, Contraction) | orange `#B45309` | `#F0A35E` |
| Worst (60+ days, Churned) | brown `#7C2D12` | `#E8590C` |

Every bar has a text label and value, so colour is never the only cue. Prototype pages 4 and 3 used two similar oranges; the palette above replaces them.

### Light and dark mode
Both modes ship in Release A. The app follows the device setting; the user can override it (a `data-theme` attribute on `<html>`, set before first paint, the choice kept in the browser, never in lane data). The prototype only shows light, so the dark set below is derived from it: same structure, navy-black ground, the navy side menu darker than the page, gold kept for accents. Every text pair is at least 4.5:1 (checked in `packages/ui/src/styles/tokens.test.ts`). Robert can adjust any value; only `theme.css` changes.

| Token | Dark value |
|---|---|
| Ground / card | `#0B1626` / `#13233A` |
| Border / divider | `#2A3D57` / `#1B2D47` |
| Text / muted text | `#F3F4F6` / `#A9B8CC` |
| Primary button | `#D5DEEA` with navy `#0E2A47` text; selected tint `#1F3A5C` |
| Accent italic | `#9DB9DC` |
| Gold | `#D4AF5A` (text allowed on dark grounds) |
| Alert | `#F0A35E`; alert text `#F5C08A` on `#3A2512` |
| Success | `#86EFAC` on `#12321F` |
| Side menu | `#081322`; active item `#1F4A7A` with the gold edge; switcher `#10223A` |

### Navigation (T-023, T-024)
- **Desktop:** navy side menu. "Jarvis" wordmark with a gold star, then "Executive Portal" (D-22: Jarvis is the product name for every company; the prototype's "Pub K" wordmark is replaced, and the company name appears only in the switcher), then the company switcher, then **Get started** (T-226: first entry, owner with the brain view only; gold "N of 10" badge = completed setup sections out of the bank's section count, and when all are done the label becomes "AI brain" with a check and stays first), then Home · Finance · Inbox · Calendar · Approvals (count badge) · Assistant · Projects · Settings. Content max-width 1440px, left-aligned next to the menu (T-230 B, see "Layout and type scale" below).
- **iPhone:** navy header band with the company switcher; bottom tabs Home · Approvals · Inbox · Ask · More (Finance, Calendar, Projects and Settings are under More). **Get started has no tab of its own (T-226):** it is the first row of More (same badge), plus a Home banner "Finish setting up Jarvis (N of 10) →" (gold left edge) while setup is incomplete. Tabs have no back link (drop page 7's "‹ Home"); a back link appears only on pages pushed from another page.
- **Company switcher:** lists only lanes that are enabled and allowed for the user. In the pilot that is Pub K Group. Ask Pub K, Pub K Institute, Nichols Capital and Nichols Law (finance) appear when their lanes switch on. **"All companies (owner)" is after the pilot** and needs its own decision (a view across lanes).
- **Projects is in Release A**, pulled from monday.com (read-only): a menu entry, a Projects page (T-150; page design in batch 2) and "Projects at a glance" on Home (T-163). Changes to monday.com items still go through Approvals. The sitemap's dashed (Release B) border on Projects is superseded. Search and Commitments stay in Release B.
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

## Layout and type scale (T-230 B, Nov 9, 2026)

Approved by Saurabh from production screenshots of Robert's 2000px screen (content was a ~600px column with small text). Screenshots before and after: [`t-230/`](t-230/) (`before/` is Home and Settings at 1440 on the old layout). Tokens and utilities live in `packages/ui/src/styles/theme.css`; use them, not ad hoc sizes.

**Widths and spacing**
- Side menu 240px (`--sidebar-width`), labels 14px (Tailwind `text-sm`, the only place it is still used). Main area `max-width: 1440px` (`--content-max-width`), 32px side padding (`md:px-8`), **left-aligned** next to the menu: no centred margins, so on a 2000px screen the free space is on the right. iPhone: 16px padding, unchanged.
- Page rhythm: 16px (`gap-4`) between header, rows and cards; 8px extra under the page header.

**Type scale** (defined once in `theme.css`, classes `text-body`, `text-small`, `text-card-title`, `text-page-title`; `cn()` knows them)

| Use | Size | Face |
|---|---|---|
| Body, controls, list rows | 15px (`text-body`, also the `<body>` default) | Inter |
| Secondary ("small"): eyebrow, notes, chips, source lines | 13px (`text-small`) | Inter |
| Card title (h2/h3), empty-state title | 18px (`text-card-title`) | Source Serif 4, semibold |
| Page title (h1), KPI figure | 32px (`text-page-title`) | Source Serif 4, italic accent word |

**Cards** (`Card`, `PageSection`, `KpiCard` in `@nichols/ui`; every page gets the same look): 12px radius, 1px border, subtle shadow (`shadow-card`, `--card-shadow`), padding 20px (24px from `sm`), 16px gap in grids, equal heights in a row (grid items stretch). Fewer, bigger cards: a section is one card, not a card per sub-item. Placeholders that carry no information (for example "Projects at a glance" with no board) are one line, not a card.

**Home** (desktop): header; briefing card full width; the four figure cards in one row (2 x 2 on iPhone); "Needs your attention" 2/3 and "Today's meetings" 1/3 (stacked on iPhone); "Projects at a glance" one line until a board is connected. The skeleton uses the same grid. The phone-only "Finish setting up" banner has a reserved 52px slot while it loads.

**Settings** (desktop): two columns, a 200px sub-nav on the left (Connections, AI brain, Developer tools; in-page anchors; only the sections the user may see) and the sections on the right. iPhone: the sub-nav is a wrapping row of 44px chips above the content. *Connections* is one compact list with the columns Provider, Account, Status chip, Last sync, Actions (Google rows, Composio rows; each row stacks with labelled cells on iPhone). With no Composio project key on the server a single line replaces the Composio rows: "Composio not configured on this server (COMPOSIO_API_KEY not set)"; with the key set but a toolkit's id missing that row says "Not configured: X is not set". Setting names only, never values. *Developer tools* holds "Temporary: connection test", collapsed by default.

**Get started** (`/onboarding`, `/onboarding/import`): a 280px step rail and a panel filling the rest. The intro is two columns on desktop: what Jarvis learns (with the primary **Start**) and the import card (primary **Import**, secondary Skip). The import page uses the same wide layout.

**Accessibility**: every text pair is at least 4.5:1 in light and dark (`tokens.test.ts`). `--sidebar-strong` (white in both modes) is the text colour on the navy side menu and header band; `--primary-foreground` turns navy in dark mode and must not be used there. 44px touch targets on iPhone (buttons, tabs, chips, switcher); no horizontal scroll at 390px.

## Batch 2 — pending (D-21)
Inbox, Calendar, Assistant, Projects, Settings (connections and health, sync/audit viewer, lane config), Finance detail and weekly report pages.
