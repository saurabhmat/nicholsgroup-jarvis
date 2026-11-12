# T-234 Home v2 — brief from Saurabh (Nov 11, 2026), verbatim

New task T-234 (approved): Home v2 from my review of production. Branch agent/T-234 from agent/T-192 (after its latest fix commit). Build without asking me; log Needs-human items and keep going. Full reviews, commit per part, don't push, checkpoint at the end with any production SQL (guarded, with a check query).

0. RUN NOW FAILURE + ENV HARDENING
- Root cause found in prod logs: ANTHROPIC_MODEL_ANALYSIS had a trailing tab ("claude-sonnet-5-5\t") → invalid_request. Make the env schema trim all ANTHROPIC_* (and other connector) values, and validate model IDs against ^claude-[a-z0-9-]+$, so a bad value fails the env check with the variable name ("ANTHROPIC_MODEL_ANALYSIS: invalid model id") instead of at call time. Tests for leading/trailing whitespace and tabs.
- The briefing card shows a fixed, specific failure reason (names only, never values), plus an admin-only hint. If Run now depends on Inngest, make the manual Run now work without Inngest (inline in the server action, with a timeout); keep the schedule on Inngest.

1. LAYOUT (T-230 tokens; professional, aligned grid)
- Row 1: "Needs your attention" (2/3 width) | right column: Today's calendar, with Next 7 days collapsed below it (expand on click).
- Row 2: KPI strip of 5 equal compact cards in one row (Cash book balance, AR > 30 days, P&L MTD, MRR, Paid subscribers). Not-connected ones show a small "Not connected · Connect" line, same height as the rest.
- Row 3: GovCon news (2/3) | Projects at a glance (1/3, compact).
- Remove the separate "Today's briefing" card, the Money card and the Coverage card from Home. Coverage moves to Settings → Connections (per source: last sync, status, reason). On Home, show only a small status dot in the header if any source is stale or in error, linking to Settings.
- iPhone: single column in this order: Needs your attention, calendar, KPIs, GovCon news, projects.

2. NEEDS YOUR ATTENTION (merges the AI briefing)
- Top line: the AI summary (1–2 sentences) + "Prepared at <time> · Run now" + Top 3 priorities as a compact numbered row. When the AI briefing isn't available, show the rule-based list with "AI summary unavailable: <reason>".
- Items (top 5): title, AI "why it matters / next step" when available, sender, mailbox, age, status chip. Actions: "Reply" and "Open".
- "Open" opens the thread in Jarvis (/[laneId]/inbox/[messageId]). Fix the current bug where it opens the wrong Google page. Inside the thread view, "Open in Gmail" uses https://mail.google.com/mail/?authuser=<mailbox>#all/<gmail thread id> for the connected mailbox; test the URL format.
- Better exclusions (lane_config, no company code): bulk/marketing mail (List-Unsubscribe or Precedence bulk/list headers, the org's own newsletter senders), calendar invitations/updates (text/calendar parts, "Invitation:"/"Updated invitation:" subjects), auto-replies, OTPs, bot/CI noise. Tests with synthetic look-alikes of the two real false positives: a newsletter from an org address, and an "Updated invitation" email.

3. REPLY FROM THE DASHBOARD
- "Reply" opens a side drawer (full-screen sheet on iPhone): AI draft (the T-231d draft if one exists, otherwise generated on demand), editable To/Cc/Body, Subject fixed as "Re: …", "Sends as <mailbox>", thread preview above.
- "Send" = the approval: create or update the email.send proposal with the exact edited payload, approve it, execute once through the T-232 executor (with T-192 recovery). Show sent/failed/unknown states. "Save draft" keeps it in Approvals for later; the same item also appears in Approvals.
- While sending isn't enabled (H-047 not done), Send is disabled with the existing message; "Save draft" and "Copy" still work.

4. GOVCON NEWS CARD (T-218 brought forward; rule 9)
- 4–6 items daily from the last 48 h: headline, one-line "why it matters for Pub K", source name + date + link. Topics in lane_config: FAR/DFARS changes, CMMC, GSA/SAM.gov, small-business contracting, major protests/awards, federal IT acquisition. Prefer official sources (acquisition.gov, Federal Register, GSA, DoD) and reputable trade press.
- Anthropic web search tool via LLMProvider. Results untrusted, cited, cached per lane per day (fetched once a day plus a "Refresh" button limited to 1/hour), never on page auto-refresh.
- Needs the `web` category in lane_policies.llm_allowed_categories (migration + pgTAP + production SQL in the checkpoint) and a per-lane monthly spend cap. Empty state "News not configured" when off.

5. AUTO-REFRESH EVERY 5 MINUTES WITHOUT LOSING WORK
- Client interval calling router.refresh() only while the tab is visible; also refresh on tab focus if older than 5 min. Show "Updated 2 min ago" in the header.
- Never reset client state: the reply drawer, edited fields and expanded sections survive the refresh. Pause refresh while the drawer is open, an input is focused, or a send is in progress.
- Autosave reply edits to sessionStorage per thread (try/catch); restore after a reload; clear after a successful send.
- Refresh re-reads data only; it never triggers the AI briefing, news fetch or a sync.
- Tests: an edited draft survives router.refresh() and a full reload; no refresh while the drawer is open.

Tests + reviews as usual; pnpm e2e:brain at the end (local DB reset approved). Checkpoint .agent/notes/checkpoint-<date>.md: commits, results, production SQL, Needs-human items, push/merge order.
