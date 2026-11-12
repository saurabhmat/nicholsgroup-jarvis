# T-237 brief (verbatim from Saurabh, Nov 12, 2026)

Reference: docs/design/home/desktop.png, docs/design/home/reply-drawer.png, docs/design/home/iphone.png
(the PNGs show prototype sample data, not real records).

Redesign the Home page to match docs/design/home/*.png (desktop, reply drawer, iPhone).
Layout, in this order:
1. Header: "Good morning, {first name}" (Source Serif 4 title, Inter body), sync status, Ask Jarvis button.
2. Approvals banner (hide when 0).
3. KPI row, auto-fit grid of 5 tiles: Cash (book), AR > 30 days, Bills due 14 days, Net income MTD (QuickBooks), MRR. When QuickBooks isn't connected, show one "Connect QuickBooks" tile instead of the 4 QBO tiles.
4. Two columns (2:1, stacked on mobile): left = Needs your attention (Today at a glance panel with summary + 3 numbered priorities, then up to 5 items, one per row: avatar, sender · domain, age, subject, "why → next step", Reply / Open). Right = Today calendar (clash/RSVP chips, Join) then GovCon news (3 items with source links, updated time).
5. Finance section (QuickBooks): MTD revenue vs expenses bars + net income, AR aging bars, oldest unpaid invoices. Show "as of" time.
6. Slim Projects card.
Reply opens a 560px right-hand drawer (full screen on mobile) with the thread preview, To/Cc, editable draft, autosave, commitment warning, and Send / Save draft / Copy. Send still goes through the approvals flow.
Rules:
- Show all times in America/New_York with no "Z".
- Leave promotional and newsletter mail out of the top 5.
- Never show "[amount]"-style placeholders. Hide a field when there's no value.
- Don't show the same attendee name twice.
- The 5-minute auto-refresh must not reset an open draft.
- Tokens: navy #0E2A47, cream #F7F4EC, gold #D4AF5A. Contrast must be WCAG AA.
- Synthetic data only in tests and fixtures.
- Keep the existing e2e tests passing and add one for the drawer keeping a draft through a refresh.
