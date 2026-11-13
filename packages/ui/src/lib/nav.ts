// Navigation as data (T-023; T-024 adjusts this table, not the components). Labels are generic: no company names.
// Signed-off structure: docs/design/README.md "Navigation", plus Projects (Release A, read-only from monday.com;
// Saurabh, Nov 4). Search and Commitments stay hidden in the pilot, so they have no entry here and no route.

export type NavKey = "onboarding" | "home" | "finance" | "inbox" | "calendar" | "approvals" | "assistant" | "projects" | "settings";

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

/** Desktop side menu, in order. "Get started" is first and drawn only for users with the brain view (the app passes `onboarding`). */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "onboarding", label: "Get started", segment: "onboarding", placeholder: { title: "Setup is not available", description: "The guided setup is for the owner of this company." }, heading: { lead: "Set up your", accent: "brain" } },
  { key: "home", label: "Home", segment: "", placeholder: { title: "Home is not set up yet", description: "Your daily briefing will appear here once the company is connected." }, heading: { lead: "Good morning" } },
  { key: "finance", label: "Finance", segment: "finance", placeholder: { title: "Finance is not set up yet", description: "Figures appear here once the accounting, payments and subscriber sources are connected." }, heading: { lead: "Finance", accent: "at a glance" } },
  { key: "inbox", label: "Inbox", segment: "inbox", placeholder: { title: "Inbox is not set up yet", description: "Priority mail appears here once a mailbox is connected." }, heading: { lead: "Inbox" } },
  { key: "calendar", label: "Calendar", segment: "calendar", placeholder: { title: "Calendar is not set up yet", description: "Upcoming events appear here once a calendar is connected." }, heading: { lead: "Calendar" } },
  { key: "approvals", label: "Approvals", segment: "approvals", placeholder: { title: "Approvals are not set up yet", description: "Nothing is sent or changed until you approve it." }, heading: { lead: "Approvals", accent: "waiting for you" } },
  { key: "assistant", label: "Assistant", segment: "assistant", placeholder: { title: "Assistant is not set up yet", description: "Ask questions about this company once its sources are connected." }, heading: { lead: "Assistant" } },
  { key: "projects", label: "Projects", segment: "projects", placeholder: { title: "Projects are not set up yet", description: "Projects appear here, read-only, once the project board is connected." }, heading: { lead: "Projects" } },
  { key: "settings", label: "Settings", segment: "settings", placeholder: { title: "Settings are not set up yet", description: "Preferences and connection health will appear here." }, heading: { lead: "Settings" } },
];

/** Menu entries listed on the iPhone "More" page (everything that has no tab of its own). */
export const MORE_ITEMS: readonly NavKey[] = ["onboarding", "finance", "calendar", "projects", "settings"];

export type TabIconName = "home" | "check" | "mail" | "chat" | "more";

export type MobileTab = { key: NavKey | "more"; label: string; segment: string; icon: TabIconName; covers: readonly NavKey[] };

/** iPhone bottom tabs, in order. "Ask" opens the assistant; "More" covers MORE_ITEMS. No back link on tabs. */
export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "home", label: "Home", segment: "", icon: "home", covers: ["home"] },
  { key: "approvals", label: "Approvals", segment: "approvals", icon: "check", covers: ["approvals"] },
  { key: "inbox", label: "Inbox", segment: "inbox", icon: "mail", covers: ["inbox"] },
  { key: "assistant", label: "Ask", segment: "assistant", icon: "chat", covers: ["assistant"] },
  { key: "more", label: "More", segment: "more", icon: "more", covers: MORE_ITEMS },
];

/** Setup progress shown on the "Get started" entry: completed sections out of the bank's section count (`done` null = could not be read). */
export type OnboardingProgress = { done: number | null; total: number };

/** What the "Get started" entry shows: "3 of 10" badge until every section is done, then "AI brain" with a check. */
export function onboardingEntry(progress: OnboardingProgress): { label: string; badge?: string; complete: boolean } {
  const complete = progress.done !== null && progress.total > 0 && progress.done >= progress.total;
  if (complete) return { label: "AI brain", complete: true };
  return progress.done === null ? { label: "Get started", complete: false } : { label: "Get started", badge: `${String(progress.done)} of ${String(progress.total)}`, complete: false };
}

const EASTERN_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** "Good morning" before 12:00, "Good afternoon" from 12:00 to 16:59, "Good evening" from 17:00, by America/New_York time whatever the viewer's zone (T-240). */
export function greetingFor(now: Date = new Date()): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = Number(EASTERN_HOUR.formatToParts(now).find((p) => p.type === "hour")?.value ?? "0") % 24;
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** Home page title. The name is optional: without one the title is just the greeting ("Good morning"). The greeting follows Eastern time of day (T-240). */
export function homeHeading(firstName?: string, now: Date = new Date()): { lead: string; accent?: string } {
  const name = firstName?.trim();
  const greeting = greetingFor(now);
  return name ? { lead: `${greeting},`, accent: name } : { lead: greeting };
}

/** Title for the iPhone header band: the heading of the active module, "More" for the More tab. */
export function pageHeading(key: NavKey | "more" | null, firstName?: string, now: Date = new Date()): { lead: string; accent?: string } {
  if (key === "more") return { lead: "More" };
  if (key === "home") return homeHeading(firstName, now);
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
