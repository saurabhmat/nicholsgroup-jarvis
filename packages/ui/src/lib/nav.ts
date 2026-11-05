// Navigation as data (T-023; T-024 adjusts this table, not the components). Labels are generic: no company names.
// Signed-off structure: docs/design/README.md "Navigation", plus Projects (Release A, read-only from monday.com;
// Saurabh, Nov 4). Search and Commitments stay hidden in the pilot, so they have no entry here and no route.

export type NavKey = "home" | "finance" | "inbox" | "calendar" | "approvals" | "assistant" | "projects" | "settings";

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

/** Desktop side menu, in order. */
export const NAV_ITEMS: readonly NavItem[] = [
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
export const MORE_ITEMS: readonly NavKey[] = ["finance", "calendar", "projects", "settings"];

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

/** Home page title. The name is optional: without one the title is just "Good morning". */
export function homeHeading(firstName?: string): { lead: string; accent?: string } {
  const name = firstName?.trim();
  return name ? { lead: "Good morning,", accent: name } : { lead: "Good morning" };
}

/** Title for the iPhone header band: the heading of the active module, "More" for the More tab. */
export function pageHeading(key: NavKey | "more" | null, firstName?: string): { lead: string; accent?: string } {
  if (key === "more") return { lead: "More" };
  if (key === "home") return homeHeading(firstName);
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
