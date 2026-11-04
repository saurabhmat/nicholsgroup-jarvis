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
};

/** Desktop side menu, in order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "Home", segment: "", placeholder: { title: "Home is not set up yet", description: "Your daily briefing will appear here once the company is connected." } },
  { key: "finance", label: "Finance", segment: "finance", placeholder: { title: "Finance is not set up yet", description: "Figures appear here once the accounting, payments and subscriber sources are connected." } },
  { key: "inbox", label: "Inbox", segment: "inbox", placeholder: { title: "Inbox is not set up yet", description: "Priority mail appears here once a mailbox is connected." } },
  { key: "calendar", label: "Calendar", segment: "calendar", placeholder: { title: "Calendar is not set up yet", description: "Upcoming events appear here once a calendar is connected." } },
  { key: "approvals", label: "Approvals", segment: "approvals", placeholder: { title: "Nothing waiting for approval", description: "Nothing is sent or changed until you approve it." } },
  { key: "assistant", label: "Assistant", segment: "assistant", placeholder: { title: "Assistant is not set up yet", description: "Ask questions about this company once its sources are connected." } },
  { key: "projects", label: "Projects", segment: "projects", placeholder: { title: "Projects are not set up yet", description: "Projects appear here, read-only, once the project board is connected." } },
  { key: "settings", label: "Settings", segment: "settings", placeholder: { title: "Settings are not set up yet", description: "Preferences and connection health will appear here." } },
];

export type MobileTab = { key: NavKey | "more"; label: string; segment: string; covers: readonly NavKey[] };

/** iPhone bottom tabs, in order. "Ask" opens the assistant; "More" lists the rest of the menu. No back link on tabs. */
export const MOBILE_TABS: readonly MobileTab[] = [
  { key: "home", label: "Home", segment: "", covers: ["home"] },
  { key: "approvals", label: "Approvals", segment: "approvals", covers: ["approvals"] },
  { key: "inbox", label: "Inbox", segment: "inbox", covers: ["inbox"] },
  { key: "assistant", label: "Ask", segment: "assistant", covers: ["assistant"] },
  { key: "more", label: "More", segment: "more", covers: ["finance", "calendar", "projects", "settings"] },
];

/** Menu entries listed on the iPhone "More" page (everything that has no tab of its own). */
export const MORE_ITEMS: readonly NavKey[] = ["finance", "calendar", "projects", "settings"];

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
