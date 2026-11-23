// Navigation as data (T-023; T-024 adjusts this table, not the components). Labels are generic: no company names.
// T-271 (Saurabh, Nov 23, 2026): one side menu for every company, in the order Home, Inbox, Calendar, Claude, ChatGPT, Finance, Tasks,
// Contacts, Messages, Settings. "Tasks" is the Projects page renamed (its URL segment stays `projects`). Get started / AI brain,
// Approvals and Assistant keep their pages but have no menu entry: they are reached from Settings (SETTINGS_PAGES) until their final
// place is decided. Claude and ChatGPT open the vendors' own chat; Contacts and Messages are placeholders (Messages = Teams, later).
// Search and Commitments stay hidden in the pilot, so they have no entry here and no route.

export type NavKey = "home" | "inbox" | "calendar" | "claude" | "chatgpt" | "finance" | "projects" | "contacts" | "messages" | "settings" | "onboarding" | "approvals" | "assistant";

export type NavItem = {
  key: NavKey;
  label: string;
  /** Path segment after the lane; "" is the lane home. */
  segment: string;
  /** Shown by the placeholder page until the real module replaces it. */
  placeholder: { title: string; description: string };
  /** Page title: `lead`, then `accent` in the serif italic (the prototype's accent word). Home is built by `homeHeading`. */
  heading: { lead: string; accent?: string };
};

/** Every page of a lane: the side menu entries in menu order, then the pages reached from Settings. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "Home", segment: "", placeholder: { title: "Home is not set up yet", description: "Your daily briefing will appear here once the company is connected." }, heading: { lead: "Good morning" } },
  { key: "inbox", label: "Inbox", segment: "inbox", placeholder: { title: "Inbox is not set up yet", description: "Priority mail appears here once a mailbox is connected." }, heading: { lead: "Inbox" } },
  { key: "calendar", label: "Calendar", segment: "calendar", placeholder: { title: "Calendar is not set up yet", description: "Upcoming events appear here once a calendar is connected." }, heading: { lead: "Calendar" } },
  { key: "claude", label: "Claude", segment: "claude", placeholder: { title: "Claude is not set up yet", description: "Claude opens from here." }, heading: { lead: "Claude" } },
  { key: "chatgpt", label: "ChatGPT", segment: "chatgpt", placeholder: { title: "ChatGPT is not set up yet", description: "ChatGPT opens from here." }, heading: { lead: "ChatGPT" } },
  { key: "finance", label: "Finance", segment: "finance", placeholder: { title: "Finance is not set up yet", description: "Figures appear here once the accounting, payments and subscriber sources are connected." }, heading: { lead: "Finance", accent: "at a glance" } },
  { key: "projects", label: "Tasks", segment: "projects", placeholder: { title: "Tasks are not set up yet", description: "Tasks appear here, read-only, once the project board is connected." }, heading: { lead: "Tasks" } },
  { key: "contacts", label: "Contacts", segment: "contacts", placeholder: { title: "Contacts are not set up yet", description: "Your contacts will appear here once a contacts source is connected." }, heading: { lead: "Contacts" } },
  { key: "messages", label: "Messages", segment: "messages", placeholder: { title: "Messages are not set up yet", description: "Microsoft Teams messages will appear here once Teams is connected." }, heading: { lead: "Messages" } },
  { key: "settings", label: "Settings", segment: "settings", placeholder: { title: "Settings are not set up yet", description: "Preferences and connection health will appear here." }, heading: { lead: "Settings" } },
  { key: "onboarding", label: "Get started", segment: "onboarding", placeholder: { title: "Setup is not available", description: "The guided setup is for the owner of this company." }, heading: { lead: "Set up your", accent: "brain" } },
  { key: "approvals", label: "Approvals", segment: "approvals", placeholder: { title: "Approvals are not set up yet", description: "Nothing is sent or changed until you approve it." }, heading: { lead: "Approvals", accent: "waiting for you" } },
  { key: "assistant", label: "Assistant", segment: "assistant", placeholder: { title: "Assistant is not set up yet", description: "Ask questions about this company once its sources are connected." }, heading: { lead: "Assistant" } },
];

/** Desktop side menu, in order (T-271). The same list for every company; a company's lane_config can still hide a module it does not use. */
export const SIDE_MENU: readonly NavKey[] = ["home", "inbox", "calendar", "claude", "chatgpt", "finance", "projects", "contacts", "messages", "settings"];

/** Pages with no menu entry of their own, reached from Settings (T-271). While one of them is open, Settings is the selected entry. */
export const SETTINGS_PAGES: readonly NavKey[] = ["onboarding", "approvals", "assistant"];

/** Rows listed on the iPhone "More" page: the side menu entries that have no tab of their own, in menu order. */
export const MORE_ITEMS: readonly NavKey[] = ["chatgpt", "finance", "projects", "contacts", "messages", "settings"];

export type TabIconName = "home" | "mail" | "calendar" | "chat" | "more";

export type MobileTab = { key: NavKey | "more"; label: string; segment: string; icon: TabIconName; covers: readonly NavKey[] };

/** iPhone bottom tabs (T-271): the first four side menu entries, then "More" for the rest and the pages under Settings. No back link on tabs. */
export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "home", label: "Home", segment: "", icon: "home", covers: ["home"] },
  { key: "inbox", label: "Inbox", segment: "inbox", icon: "mail", covers: ["inbox"] },
  { key: "calendar", label: "Calendar", segment: "calendar", icon: "calendar", covers: ["calendar"] },
  { key: "claude", label: "Claude", segment: "claude", icon: "chat", covers: ["claude"] },
  { key: "more", label: "More", segment: "more", icon: "more", covers: [...MORE_ITEMS, ...SETTINGS_PAGES] },
];

/** The side menu entry that is selected for a page: its own, or Settings for a page reached from Settings. */
export function menuKeyFor(key: NavKey | "more" | null): NavKey | "more" | null {
  return key !== null && key !== "more" && SETTINGS_PAGES.includes(key) ? "settings" : key;
}

const EASTERN_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** "Good morning" before 12:00, "Good afternoon" from 12:00 to 16:59, "Good evening" from 17:00, by America/New_York time whatever the viewer's zone (T-240). */
export function greetingFor(now: Date): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = Number(EASTERN_HOUR.formatToParts(now).find((p) => p.type === "hour")?.value ?? "0") % 24;
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** Home page title. The name is optional: without one the title is just the greeting ("Good morning"). The greeting follows Eastern time of day (T-240). */
export function homeHeading(firstName: string | undefined, now: Date): { lead: string; accent?: string } {
  const name = firstName?.trim();
  const greeting = greetingFor(now);
  return name ? { lead: `${greeting},`, accent: name } : { lead: greeting };
}

/** Title for the iPhone header band: the heading of the active module, "More" for the More tab. */
export function pageHeading(key: NavKey | "more" | null, firstName?: string, now?: Date): { lead: string; accent?: string } {
  if (key === "more") return { lead: "More" };
  // T-243: this never reads the clock itself (a default `new Date()` ran on every page, in a component that can be prerendered): the
  // server passes the time. Without it Home's title is the neutral nav heading.
  if (key === "home") return now ? homeHeading(firstName, now) : navItem("home").heading;
  return key ? navItem(key).heading : { lead: "" };
}

export function navItem(key: NavKey): NavItem {
  const item = NAV_ITEMS.find((i) => i.key === key);
  if (!item) throw new Error(`unknown nav key ${key}`);
  return item;
}

/** `/PKG` or `/PKG/finance`. The lane code is the URL segment; callers pass a code from the validated lane list. */
export function laneHref(laneId: string, segment = ""): string {
  return segment === "" ? `/${laneId}` : `/${laneId}/${segment}`;
}

/** The module key of a path inside a lane (`/PKG/finance/x` → "finance"; `/PKG` → "home"; `/PKG/more` → "more"). */
export function activeKey(laneId: string, pathname: string): NavKey | "more" | null {
  const prefix = `/${laneId}`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const segment = pathname.slice(prefix.length).split("/")[1] ?? "";
  if (segment === "more") return "more";
  return NAV_ITEMS.find((i) => i.segment === segment)?.key ?? null;
}
