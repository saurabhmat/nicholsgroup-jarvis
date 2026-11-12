# T-235 Home polish — brief from Saurabh (Nov 12, 2026), verbatim

Context: a production screenshot of Home (T-234) at desktop width. It shows "AI summary unavailable: The AI reply could not be read / The model's reply was not the expected format; try Run now again", the rule-based attention list with "to saurabh@pub-k.org" on every row, five empty "Not connected" KPI tiles, an unconfigured GovCon news card taking 2/3 of a row, and calendar events listing attendee emails.

New task T-235 (approved): Home polish from production review. Branch agent/T-235 from agent/T-234. Build without asking; full reviews; commit per part; don't push; checkpoint with any production SQL (schema-qualified, runs as one script).

1. AI SUMMARY — automatic, reliable, no Run button
- Fix "The model's reply was not the expected format": use tool use / JSON-schema structured output for the briefing, validate with Zod, retry once with the validation error, and log the failure reason (no content). Add tests with malformed, partial and fenced-JSON replies.
- Remove the Run now button from Home. The briefing generates automatically: on the daily schedule (06:30 America/New_York, Mon–Fri, H-046), and in the background when the owner opens Home and the latest briefing is older than 3 hours (max 6 runs/day per lane, never blocking the page, never from the 5-minute auto-refresh). While generating, show "Updating summary…" with the previous summary still visible.
- Keep a small "Regenerate" item in a ⋯ menu on the card for the owner (rate-limited to once per 30 min). Show "Summary at 9:12 AM" as small muted text.

2. NEEDS YOUR ATTENTION — scannable layout
- Top: a "Today at a glance" panel (subtle cream background, 3px gold left edge): 2–3 sentence AI summary, then "Top priorities" as a numbered list of 3 (bold action + muted reason). When AI is unavailable, one muted line with the reason; no stack of error text.
- Each item as a row with clear hierarchy:
  line 1: sender avatar (initials circle) + sender name (semibold) + company/domain (muted) + age right-aligned
  line 2: subject (medium weight, 1 line, ellipsis)
  line 3: AI "why it matters → next step" (muted, 1–2 lines, only when available)
  chips under it, max 2 (e.g. "Waiting on you", "Priority sender").
  Actions: "Reply" (secondary button) + "Open" (text link), right-aligned, vertically centred. Whole row clickable to Open. Hover background on desktop.
- Hide the mailbox ("to saurabh@pub-k.org") when the lane has only one mailbox.
- 16px row padding, a divider between rows, "View all in Inbox (31) →" at the bottom.

3. CALENDAR — compact
- Each event: time column (local time bold; sender/ET time small below), title, then attendees as names (not emails, "+2 more"), max 2 chips (Clash, RSVP pending). "Join" as a small button. Hide "Open in Calendar" behind the title link.
- Next 7 days stays collapsed, with a one-line summary ("12 meetings, 2 clashes").

4. KPI STRIP — only what's connected
- Show tiles only for connected sources. When none are connected, show one slim banner instead of 5 empty tiles: "Connect QuickBooks, Stripe and GoHighLevel to see cash, AR, P&L, MRR and subscribers → Settings".
- When some are connected, those tiles fill the row equally.

5. TYPOGRAPHY & SPACING (update docs/design/README.md)
- Source Serif only for the page title (32px) and card titles (20px, semibold). Everything else Inter: body 15px/1.55, secondary 13px, labels 12px uppercase tracking-wide only for KPI labels.
- One spacing scale (4/8/12/16/24/32). Card padding 24px, grid gap 20px. Cards: white, 12px radius, 1px border, very soft shadow.
- Muted text at AA contrast in light and dark. Max 2 text weights per row.
- GovCon news: when not configured, collapse to a slim one-line card ("GovCon news is off · Set up in Settings"), so it doesn't take half a row. Projects at a glance: slim one-liner when no board.

6. Tests + screenshots
- Unit/e2e updated; axe in light and dark; iPhone width with no sideways scroll.
- Give me before/after screenshots of Home at 1440px and 1920px and on iPhone.
- Production SQL in the checkpoint if any (auto-run tracking).
