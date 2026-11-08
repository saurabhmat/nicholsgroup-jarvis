// Read tools for the assistant demo scope (T-105, Nov 8, 2026): mail and calendar METADATA the portal already shows
// (Inbox, Home). Each tool reads through the signed-in user's lane client (`ctx.client`), via the SECURITY INVOKER
// functions core.inbox_messages and core.home_meetings, so RLS applies (AAL2 + lane + comms/calendar view). No bodies
// are read (rule 6), nothing is written (rule 5). Subjects, senders, titles and locations are external text: they are
// not in trustedFields, so the loop wraps them as untrusted data. Only tool-formatted times are trusted.
// Moves to the comms/calendar modules with T-123/T-133.
import { z } from "zod";
import type { ToolDescriptor, ToolRegistry } from "./registry";

const TZ = "America/New_York";
const DAY_MS = 86_400_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });

/** Midnight in New York for the calendar day containing `at`, plus `addDays`. */
export function nyMidnight(at: Date, addDays = 0): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const midnightUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + addDays);
  // Local midnight = UTC midnight minus the offset in force AT that instant. On a DST change day the offset at noon
  // differs, so re-read it at the candidate and correct once.
  const first = midnightUtc - offsetMinutes(new Date(midnightUtc + 12 * 3_600_000)) * 60_000;
  const second = midnightUtc - offsetMinutes(new Date(first)) * 60_000;
  return new Date(second);
}

function offsetMinutes(at: Date): number {
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(off ?? "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.slice(0, 300) : null);
const iso = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export function mailTool(now: () => Date = () => new Date()): ToolDescriptor<{ filter: "important" | "unread" | "all"; limit: number }> {
  return {
    name: "list_recent_mail",
    description:
      "List recent inbox email metadata (sender, subject, received time, read/important flags) for this company. " +
      "No message bodies. Use for 'what came in', 'anything important', 'who emailed me'.",
    category: "email",
    effect: "read",
    requiredView: "comms",
    args: z.strictObject({
      filter: z.enum(["important", "unread", "all"]).default("important"),
      limit: z.number().int().min(1).max(25).default(10),
    }),
    resultStore: "refs_only",
    trustedFields: ["messages[].received_display", "messages[].received_at", "filter"],
    async run(ctx, args) {
      const { data, error } = await ctx.client.schema("core").rpc("inbox_messages", { p_lane: ctx.laneId, p_filter: args.filter, p_limit: args.limit });
      if (error) throw new Error("mail unavailable");
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      const messages = rows.flatMap((r) => {
        const at = iso(r.received_at);
        if (!at || typeof r.message_id !== "string" || !MESSAGE_ID.test(r.message_id)) return [];
        return [
          {
            id: r.message_id,
            from: str(r.from_name) ?? str(r.from_address) ?? "(unknown sender)",
            from_address: str(r.from_address),
            subject: str(r.subject) ?? "(no subject)",
            received_at: at,
            received_display: DATE_TIME.format(new Date(at)),
            unread: r.is_read !== true,
            important: r.is_important === true,
          },
        ];
      });
      return {
        data: { filter: args.filter, count: messages.length, messages },
        sources: messages.map((m) => ({ kind: "email", id: m.id, label: m.subject, url: `/${ctx.laneId}/inbox/${m.id}` })),
        asOf: now().toISOString(),
        freshness: "cached",
        notes: [],
      };
    },
  };
}

export function meetingsTool(now: () => Date = () => new Date()): ToolDescriptor<{ range: "today" | "tomorrow" | "next_7_days" }> {
  return {
    name: "list_meetings",
    description: "List calendar meetings for this company: today, tomorrow or the next 7 days (New York time). Titles, times, locations.",
    category: "calendar",
    effect: "read",
    requiredView: "calendar",
    args: z.strictObject({ range: z.enum(["today", "tomorrow", "next_7_days"]).default("today") }),
    // Titles and locations are external content: store references only (T-103).
    resultStore: "refs_only",
    trustedFields: ["range", "meetings[].day", "meetings[].start", "meetings[].end", "meetings[].start_at", "meetings[].end_at"],
    async run(ctx, args) {
      const t = now();
      const from = nyMidnight(t, args.range === "tomorrow" ? 1 : 0);
      // next_7_days: exactly 7 × 24 h (the RPC caps the window at 7 days), so it can end an hour off local midnight
      // when a DST change falls inside.
      const to = args.range === "next_7_days" ? new Date(from.getTime() + 7 * DAY_MS) : nyMidnight(t, args.range === "tomorrow" ? 2 : 1);
      const { data, error } = await ctx.client
        .schema("core")
        .rpc("home_meetings", { p_lane: ctx.laneId, p_from: from.toISOString(), p_to: to.toISOString() });
      if (error) throw new Error("calendar unavailable");
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      const meetings = rows.slice(0, 50).flatMap((r) => {
        const allDay = r.all_day === true;
        const s = iso(r.start_at);
        const e = iso(r.end_at);
        // All-day events: the calendar date itself (their instants are midnight in the event's own zone).
        const date = typeof r.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.start_date) ? r.start_date : null;
        if (allDay && date) {
          return [
            {
              title: str(r.title) ?? "(No title)",
              day: DAY.format(new Date(`${date}T12:00:00Z`)),
              start: "all day",
              end: "all day",
              start_at: s ?? `${date}T00:00:00.000Z`,
              end_at: e ?? `${date}T00:00:00.000Z`,
              all_day: true,
              location: str(r.location),
            },
          ];
        }
        if (!s || !e) return [];
        return [
          {
            title: str(r.title) ?? "(No title)",
            day: DAY.format(new Date(s)),
            start: allDay ? "all day" : TIME.format(new Date(s)),
            end: allDay ? "all day" : TIME.format(new Date(e)),
            start_at: s,
            end_at: e,
            all_day: allDay,
            location: str(r.location),
          },
        ];
      });
      return {
        data: { range: args.range, count: meetings.length, meetings },
        sources: [{ kind: "calendar", id: `calendar_${args.range}`, label: "Calendar", url: `/${ctx.laneId}/calendar` }],
        asOf: t.toISOString(),
        freshness: "cached",
        notes: [],
      };
    },
  };
}

/** The tools the chat route offers (the gate and the lane's categories decide which are usable). */
export function registerAssistantTools(registry: ToolRegistry, now?: () => Date): ToolRegistry {
  registry.register(mailTool(now));
  registry.register(meetingsTool(now));
  return registry;
}
